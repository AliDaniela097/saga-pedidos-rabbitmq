import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

const PEDIDOS: Record<string, any> = {};

@Controller('pedidos')
export class AppController {
  constructor(
    @Inject('INVENTARIO_SERVICE') private readonly inventarioClient: ClientProxy,
  ) {}

  @Post()
  crearPedido(@Body() body: { productoId: number; cantidad: number }) {
    const correlationId = 'cid-' + randomUUID().slice(0, 8);
    const pedido = { pedidoId: correlationId, ...body, estado: 'Creado' };
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

    this.inventarioClient.emit('pedido_creado', { correlationId, ...body });
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
  }
}
