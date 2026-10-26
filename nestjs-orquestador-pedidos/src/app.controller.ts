import { BadRequestException, Body, Controller, Inject, Post } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import { firstValueFrom, timeout } from 'rxjs';

type Resultado = { ok: boolean; error?: string };

// Cuánto espera el orquestador la respuesta de cada servicio (en la nube, si un
// servicio está dormido, conviene subirlo con la variable TIMEOUT_MS).
const TIEMPO_ESPERA_MS = Number(process.env.TIMEOUT_MS ?? 5000);

const PEDIDOS: Record<string, any> = {};

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
  private async llamar(
    client: ClientProxy,
    patron: string,
    data: unknown,
  ): Promise<Resultado> {
    try {
      return await firstValueFrom(
        client.send<Resultado>(patron, data).pipe(timeout(TIEMPO_ESPERA_MS)),
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  @Post()
  async crearPedidoOrquestado(
    @Body() body: { productoId: number; cantidad: number },
  ) {
    if (
      !Number.isInteger(body?.productoId) ||
      !Number.isInteger(body?.cantidad) ||
      body.cantidad < 1
    ) {
      throw new BadRequestException(
        'productoId y cantidad deben ser enteros, y cantidad mayor que 0',
      );
    }
    const { productoId, cantidad } = body;
    const correlationId = 'cid-' + randomUUID().slice(0, 8);
    const pedido = { pedidoId: correlationId, productoId, cantidad, estado: 'Creado' };
    PEDIDOS[correlationId] = pedido;
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
      pedido.estado = 'Rechazado'; // no hay nada que compensar todavía
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
      const liberar = await this.llamar(
        this.inventarioClient,
        'orq_liberar_inventario',
        { correlationId },
      );
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
