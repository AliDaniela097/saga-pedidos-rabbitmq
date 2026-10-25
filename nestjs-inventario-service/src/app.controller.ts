import { Controller, Inject } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';

const STOCK: Record<number, number> = { 1: 10, 2: 15, 3: 5 };
const RESERVAS: Record<string, { productoId: number; cantidad: number }> = {};

@Controller()
export class AppController {
  constructor(
    @Inject('PAGO_SERVICE') private readonly pagoClient: ClientProxy,
    @Inject('PEDIDO_SERVICE') private readonly pedidoClient: ClientProxy,
  ) {}

  @EventPattern('pedido_creado')
  reservarStock(
    @Payload()
    data: { correlationId: string; productoId: number; cantidad: number },
  ) {
    const inicio = Date.now();
    const disponible = (STOCK[data.productoId] ?? 0) >= data.cantidad;

    if (disponible) {
      STOCK[data.productoId] -= data.cantidad;
      RESERVAS[data.correlationId] = {
        productoId: data.productoId,
        cantidad: data.cantidad,
      };
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'InventarioService',
          event_received: 'PedidoCreado',
          event_emitted: 'InventarioReservado',
          correlation_id: data.correlationId,
          status: 'processed',
          duration_ms: Date.now() - inicio,
        }),
      );
      this.pagoClient.emit('inventario_reservado', data);
    } else {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'InventarioService',
          event_received: 'PedidoCreado',
          event_emitted: 'InventarioRechazado',
          correlation_id: data.correlationId,
          status: 'rejected',
          duration_ms: Date.now() - inicio,
        }),
      );
    }
  }

  @EventPattern('pago_fallido')
  revertirReserva(@Payload() data: { correlationId: string }) {
    const reserva = RESERVAS[data.correlationId];
    if (reserva) {
      STOCK[reserva.productoId] += reserva.cantidad;
      delete RESERVAS[data.correlationId];
    }
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'InventarioService',
        event_received: 'PagoFallido',
        event_emitted: 'InventarioLiberado (compensación)',
        correlation_id: data.correlationId,
        status: 'compensated',
      }),
    );
    this.pedidoClient.emit('inventario_liberado', data);
  }

  // --- Versión ORQUESTADA (request-response): responde al orquestador ---
  @MessagePattern('orq_reservar_inventario')
  reservarStockOrquestado(
    @Payload()
    data: { correlationId: string; productoId: number; cantidad: number },
  ) {
    const disponible = (STOCK[data.productoId] ?? 0) >= data.cantidad;
    if (!disponible) {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'InventarioService',
          event_received: 'orq_reservar_inventario',
          correlation_id: data.correlationId,
          status: 'rejected',
        }),
      );
      return { ok: false, error: 'stock insuficiente' };
    }
    STOCK[data.productoId] -= data.cantidad;
    RESERVAS[data.correlationId] = {
      productoId: data.productoId,
      cantidad: data.cantidad,
    };
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'InventarioService',
        event_received: 'orq_reservar_inventario',
        correlation_id: data.correlationId,
        status: 'processed',
      }),
    );
    return { ok: true };
  }

  @MessagePattern('orq_liberar_inventario')
  liberarStockOrquestado(@Payload() data: { correlationId: string }) {
    const reserva = RESERVAS[data.correlationId];
    if (reserva) {
      STOCK[reserva.productoId] += reserva.cantidad;
      delete RESERVAS[data.correlationId];
    }
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'InventarioService',
        event_received: 'orq_liberar_inventario',
        correlation_id: data.correlationId,
        status: 'compensated',
      }),
    );
    return { ok: true };
  }
}
