import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import { firstValueFrom, timeout } from 'rxjs';

type Resultado = { ok: boolean; error?: string };

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
  ) {}

  // send() = preguntar y ESPERAR la respuesta del servicio destino.
  // Si el servicio no responde en 5 s o falla, se trata como un paso fallido.
  private async llamar(
    client: ClientProxy,
    patron: string,
    data: unknown,
  ): Promise<Resultado> {
    try {
      return await firstValueFrom(
        client.send<Resultado>(patron, data).pipe(timeout(5000)),
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  @Post()
  async crearPedidoOrquestado(
    @Body() body: { productoId: number; cantidad: number },
  ) {
    const correlationId = 'cid-' + randomUUID().slice(0, 8);
    const pedido = { pedidoId: correlationId, ...body, estado: 'Creado' };
    PEDIDOS[correlationId] = pedido;
    const datos = { correlationId, ...body };

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
    if (!reserva.ok) {
      pedido.estado = 'Rechazado'; // no hay nada que compensar todavía
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
      pedido.estado = 'Cancelado';
      return pedido;
    }

    // PASO 3: notificar
    const noti = await this.llamar(
      this.notiClient,
      'orq_notificar',
      { correlationId },
    );
    registrar({
      correlation_id: correlationId,
      paso: 'notificar',
      status: noti.ok ? 'ok' : 'error',
      error: noti.error,
    });
    pedido.estado = noti.ok ? 'Confirmado' : 'PagadoSinNotificar';
    return pedido;
  }
}
