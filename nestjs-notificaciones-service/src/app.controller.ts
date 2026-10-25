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
        service: 'NotificacionesService',
        event,
        correlation_id: correlationId,
        status,
        detalle,
      });
    } catch {
      /* una traza nunca debe romper el flujo del negocio */
    }
  }

  private confirmar(correlationId: string, evento: string, detalle?: string) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'NotificacionesService',
        event_received: evento,
        status: 'processed',
        correlation_id: correlationId,
      }),
    );
    console.log(`✅ Pedido ${correlationId} confirmado. Se notificó al cliente.`);
    this.traza('PedidoConfirmado', correlationId, 'processed', detalle);
  }

  // ---------- Saga COREOGRAFIADA (eventos) ----------

  @EventPattern('pago_procesado')
  notificar(@Payload() data: { correlationId: string }) {
    this.confirmar(data.correlationId, 'PagoProcesado');
  }

  // ---------- Saga ORQUESTADA (request-response) ----------

  @MessagePattern('orq_notificar')
  notificarOrquestado(@Payload() data: { correlationId: string }) {
    this.confirmar(data.correlationId, 'orq_notificar', 'a pedido del orquestador');
    return { ok: true };
  }
}
