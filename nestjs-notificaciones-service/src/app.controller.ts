import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class AppController {
  @EventPattern('pago_procesado')
  notificar(@Payload() data: { correlationId: string }) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'NotificacionesService',
        event_received: 'PagoProcesado',
        status: 'processed',
        correlation_id: data.correlationId,
      }),
    );
    console.log(
      `✅ Pedido ${data.correlationId} confirmado. Se notificó al cliente.`,
    );
  }

  // --- Versión ORQUESTADA (request-response): responde al orquestador ---
  @MessagePattern('orq_notificar')
  notificarOrquestado(@Payload() data: { correlationId: string }) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'NotificacionesService',
        event_received: 'orq_notificar',
        status: 'processed',
        correlation_id: data.correlationId,
      }),
    );
    console.log(
      `✅ Pedido ${data.correlationId} confirmado. Se notificó al cliente.`,
    );
    return { ok: true };
  }
}
