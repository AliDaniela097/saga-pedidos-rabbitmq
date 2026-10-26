import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy, RmqRecordBuilder } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';

// desconocido = no hubo respuesta a tiempo: el paso pudo haberse aplicado o no.
type Resultado = { ok: boolean; error?: string; desconocido?: boolean };

// Cuánto espera el orquestador la respuesta de cada servicio (en la nube, si un
// servicio está dormido, conviene subirlo con la variable TIMEOUT_MS).
const TIEMPO_ESPERA_MS = Number(process.env.TIMEOUT_MS ?? 5000);

const PEDIDOS: Record<string, any> = {};
const MAXIMO_PEDIDOS = 1000; // los más antiguos se descartan para que la memoria no crezca sin fin
const INTENTOS_COMPENSACION = 3;

// Si INTERNAL_TOKEN existe, solo quien lo conoce (el frontend) puede crear pedidos.
function exigirToken(token?: string) {
  const esperado = process.env.INTERNAL_TOKEN;
  if (esperado && token !== esperado) throw new UnauthorizedException();
}

function registrar(data: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'OrquestadorPedidos',
      ...data,
    }),
  );
}

@Controller('pedidos-orquestados')
export class AppController {
  constructor(
    @Inject('INVENTARIO_SERVICE')
    private readonly inventarioClient: ClientProxy,
    @Inject('PAGO_SERVICE') private readonly pagoClient: ClientProxy,
    @Inject('NOTIFICACIONES_SERVICE')
    private readonly notiClient: ClientProxy,
    @Inject('TRAZAS_SERVICE') private readonly trazasClient: ClientProxy,
  ) {}

  // Envía una traza al frontend para que muestre el recorrido del pedido.
  private traza(
    event: string,
    correlationId: string,
    status: string,
    detalle?: string,
  ) {
    try {
      this.trazasClient.emit('traza', {
        timestamp: new Date().toISOString(),
        service: 'OrquestadorPedidos',
        event,
        correlation_id: correlationId,
        status,
        detalle,
      });
    } catch {
      /* una traza nunca debe romper el flujo del negocio */
    }
  }

  // send() = preguntar y ESPERAR la respuesta del servicio destino.
  // Si el servicio no responde a tiempo o falla, se trata como un paso fallido.
  // El mensaje caduca en la cola al mismo tiempo que la espera del orquestador: así un
  // servicio dormido no lo procesa tarde, cuando el pedido ya se dio por terminado.
  private async llamar(
    client: ClientProxy,
    patron: string,
    data: unknown,
  ): Promise<Resultado> {
    try {
      const mensaje = new RmqRecordBuilder(data)
        .setOptions({ expiration: String(TIEMPO_ESPERA_MS) })
        .build();
      return await firstValueFrom(
        client.send<Resultado>(patron, mensaje).pipe(timeout(TIEMPO_ESPERA_MS)),
      );
    } catch (e) {
      // El detalle técnico queda en el log; al cliente solo llega un texto genérico.
      registrar({ paso: patron, status: 'error', error: String(e) });
      return e instanceof TimeoutError
        ? { ok: false, desconocido: true, error: 'el servicio no respondió a tiempo' }
        : { ok: false, error: 'el servicio no está disponible' };
    }
  }

  // Compensación con reintentos: liberar es idempotente, así que repetirla es seguro.
  private async liberarInventario(correlationId: string): Promise<Resultado> {
    let ultimo: Resultado = { ok: false };
    for (let i = 0; i < INTENTOS_COMPENSACION && !ultimo.ok; i++) {
      ultimo = await this.llamar(this.inventarioClient, 'orq_liberar_inventario', {
        correlationId,
      });
    }
    return ultimo;
  }

  @Post()
  async crearPedidoOrquestado(
    @Body() body: { productoId: number; cantidad: number },
    @Headers('x-internal-token') token?: string,
  ) {
    exigirToken(token);
    if (
      !Number.isInteger(body?.productoId) ||
      !Number.isInteger(body?.cantidad) ||
      body.productoId < 1 ||
      body.cantidad < 1 ||
      body.cantidad > 1000
    ) {
      throw new BadRequestException(
        'productoId debe ser un entero positivo y cantidad un entero entre 1 y 1000',
      );
    }
    const { productoId, cantidad } = body;
    const correlationId = 'cid-' + randomUUID().slice(0, 8);
    const pedido = { pedidoId: correlationId, productoId, cantidad, estado: 'Creado' };
    PEDIDOS[correlationId] = pedido;
    const ids = Object.keys(PEDIDOS);
    if (ids.length > MAXIMO_PEDIDOS) delete PEDIDOS[ids[0]];
    const datos = { correlationId, productoId, cantidad };
    this.traza(
      'PedidoCreado',
      correlationId,
      'ok',
      `producto ${productoId} x${cantidad} (orquestada)`,
    );

    // PASO 1: reservar inventario
    const reserva = await this.llamar(
      this.inventarioClient,
      'orq_reservar_inventario',
      datos,
    );
    registrar({
      correlation_id: correlationId,
      paso: 'reservar_inventario',
      status: reserva.ok ? 'ok' : 'error',
      error: reserva.error,
    });
    this.traza(
      'OrqReservarInventario',
      correlationId,
      reserva.ok ? 'ok' : 'error',
      reserva.error,
    );
    if (!reserva.ok) {
      // Si no hubo respuesta, la reserva pudo aplicarse: se libera por si acaso (idempotente).
      if (reserva.desconocido) await this.liberarInventario(correlationId);
      pedido.estado = 'Rechazado';
      this.traza('PedidoRechazado', correlationId, 'error', reserva.error);
      return pedido;
    }

    // PASO 2: procesar pago
    const pago = await this.llamar(this.pagoClient, 'orq_procesar_pago', datos);
    registrar({
      correlation_id: correlationId,
      paso: 'procesar_pago',
      status: pago.ok ? 'ok' : 'error',
      error: pago.error,
    });
    this.traza(
      'OrqProcesarPago',
      correlationId,
      pago.ok ? 'ok' : 'error',
      pago.error,
    );
    if (!pago.ok) {
      // El ORQUESTADOR decide la compensación del paso anterior.
      const liberar = await this.liberarInventario(correlationId);
      registrar({
        correlation_id: correlationId,
        paso: 'compensar_inventario',
        status: liberar.ok ? 'compensated' : 'error',
        error: liberar.error,
      });
      this.traza(
        'OrqCompensarInventario',
        correlationId,
        liberar.ok ? 'compensated' : 'error',
        liberar.error,
      );
      if (!liberar.ok) {
        // No se pudo devolver el stock: no se declara Cancelado, queda para reconciliar.
        pedido.estado = 'CompensacionPendiente';
        this.traza('CompensacionPendiente', correlationId, 'error', liberar.error);
        return pedido;
      }
      pedido.estado = 'Cancelado';
      this.traza(
        'PedidoCancelado',
        correlationId,
        'cancelled',
        'el pago falló y el orquestador liberó el inventario',
      );
      return pedido;
    }

    // PASO 3: notificar
    const noti = await this.llamar(this.notiClient, 'orq_notificar', {
      correlationId,
    });
    registrar({
      correlation_id: correlationId,
      paso: 'notificar',
      status: noti.ok ? 'ok' : 'error',
      error: noti.error,
    });
    this.traza('OrqNotificar', correlationId, noti.ok ? 'ok' : 'error', noti.error);
    if (!noti.ok) {
      this.traza('NotificacionFallida', correlationId, 'error', noti.error);
    }
    pedido.estado = noti.ok ? 'Confirmado' : 'PagadoSinNotificar';
    return pedido;
  }
}
