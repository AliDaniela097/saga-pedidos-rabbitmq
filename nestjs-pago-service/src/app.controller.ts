import { Controller, Inject } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';

@Controller()
export class AppController {
  constructor(
    @Inject('NOTIFICACIONES_SERVICE')
    private readonly notiClient: ClientProxy,
    @Inject('INVENTARIO_SERVICE')
    private readonly inventarioClient: ClientProxy,
  ) {}

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
          error: 'timeout de la pasarela de pago (simulado)',
          duration_ms: Date.now() - inicio,
        }),
      );
      this.inventarioClient.emit('pago_fallido', data);
    }
  }

  // --- Versión ORQUESTADA (request-response): responde al orquestador ---
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
        error: pagoExitoso
          ? undefined
          : 'timeout de la pasarela de pago (simulado)',
      }),
    );
    return pagoExitoso
      ? { ok: true }
      : { ok: false, error: 'timeout de la pasarela de pago (simulado)' };
  }
}
