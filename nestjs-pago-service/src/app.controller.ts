import { Controller, Inject } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';

const ERROR_PAGO = 'timeout de la pasarela de pago (simulado)';

@Controller()
export class AppController {
  constructor(
    @Inject('NOTIFICACIONES_SERVICE')
    private readonly notiClient: ClientProxy,
    @Inject('INVENTARIO_SERVICE')
    private readonly inventarioClient: ClientProxy,
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
        service: 'PagoService',
        event,
        correlation_id: correlationId,
        status,
        detalle,
      });
    } catch {
      /* una traza nunca debe romper el flujo del negocio */
    }
  }

  // ---------- Saga COREOGRAFIADA (eventos) ----------

  @EventPattern('inventario_reservado')
  procesarPago(
    @Payload()
    data: { correlationId: string; productoId: number; cantidad: number },
  ) {
    const inicio = Date.now();
    const pagoExitoso = Math.random() > 0.4; // ~60% de éxito

    if (pagoExitoso) {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'PagoService',
          event_received: 'InventarioReservado',
          event_emitted: 'PagoProcesado',
          correlation_id: data.correlationId,
          status: 'processed',
          duration_ms: Date.now() - inicio,
        }),
      );
      this.traza('PagoProcesado', data.correlationId, 'processed');
      this.notiClient.emit('pago_procesado', data);
    } else {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'PagoService',
          event_received: 'InventarioReservado',
          event_emitted: 'PagoFallido',
          correlation_id: data.correlationId,
          status: 'error',
          error: ERROR_PAGO,
          duration_ms: Date.now() - inicio,
        }),
      );
      this.traza('PagoFallido', data.correlationId, 'error', ERROR_PAGO);
      this.inventarioClient.emit('pago_fallido', data);
    }
  }

  // ---------- Saga ORQUESTADA (request-response) ----------

  @MessagePattern('orq_procesar_pago')
  procesarPagoOrquestado(@Payload() data: { correlationId: string }) {
    const pagoExitoso = Math.random() > 0.4; // ~60% de éxito
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'PagoService',
        event_received: 'orq_procesar_pago',
        correlation_id: data.correlationId,
        status: pagoExitoso ? 'processed' : 'error',
        error: pagoExitoso ? undefined : ERROR_PAGO,
      }),
    );
    if (pagoExitoso) {
      this.traza(
        'PagoProcesado',
        data.correlationId,
        'processed',
        'a pedido del orquestador',
      );
      return { ok: true };
    }
    this.traza('PagoFallido', data.correlationId, 'error', ERROR_PAGO);
    return { ok: false, error: ERROR_PAGO };
  }
}
