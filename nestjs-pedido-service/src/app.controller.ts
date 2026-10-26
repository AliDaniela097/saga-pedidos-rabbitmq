import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

const PEDIDOS: Record<string, any> = {};
const MAXIMO_PEDIDOS = 1000; // los más antiguos se descartan para que la memoria no crezca sin fin

// Si INTERNAL_TOKEN existe, solo quien lo conoce (el frontend) puede crear pedidos.
function exigirToken(token?: string) {
  const esperado = process.env.INTERNAL_TOKEN;
  if (esperado && token !== esperado) throw new UnauthorizedException();
}

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
  crearPedido(
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

  @Get(':id')
  consultar(@Param('id') id: string) {
    const pedido = PEDIDOS[id];
    if (!pedido) throw new NotFoundException('El pedido no existe');
    return pedido;
  }

  // Inventario no pudo reservar (sin stock, producto inexistente...): estado final.
  @EventPattern('inventario_rechazado')
  rechazarPedido(@Payload() data: { correlationId: string; error?: string }) {
    if (PEDIDOS[data.correlationId]) PEDIDOS[data.correlationId].estado = 'Rechazado';
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'PedidoService',
        event_received: 'InventarioRechazado',
        correlation_id: data.correlationId,
        status: 'rejected',
      }),
    );
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
