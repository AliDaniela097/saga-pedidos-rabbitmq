import { BadRequestException, Body, Controller, Inject, Post } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

const PEDIDOS: Record<string, any> = {};

@Controller('pedidos')
export class AppController {
  constructor(
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
        service: 'PedidoService',
        event,
        correlation_id: correlationId,
        status,
        detalle,
      });
    } catch {
      /* una traza nunca debe romper el flujo del negocio */
    }
  }

  @Post()
  crearPedido(@Body() body: { productoId: number; cantidad: number }) {
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

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'PedidoService',
        event_emitted: 'PedidoCreado',
        correlation_id: correlationId,
        status: 'ok',
      }),
    );
    this.traza(
      'PedidoCreado',
      correlationId,
      'ok',
      `producto ${productoId} x${cantidad} (coreografiada)`,
    );

    this.inventarioClient.emit('pedido_creado', {
      correlationId,
      productoId,
      cantidad,
    });
    return pedido;
  }

  @EventPattern('inventario_liberado')
  cancelarPedido(@Payload() data: { correlationId: string }) {
    if (PEDIDOS[data.correlationId]) PEDIDOS[data.correlationId].estado = 'Cancelado';
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'PedidoService',
        event_received: 'InventarioLiberado',
        correlation_id: data.correlationId,
        status: 'cancelled',
      }),
    );
    this.traza(
      'PedidoCancelado',
      data.correlationId,
      'cancelled',
      'el pago falló y se liberó el inventario',
    );
  }
}
