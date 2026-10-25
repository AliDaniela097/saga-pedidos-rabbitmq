import { Controller, Inject } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import { cargar, guardar } from './almacen.js';

type DatosPedido = {
  correlationId: string;
  productoId: number;
  cantidad: number;
};

// Productos y reservas viven en data/inventario.json (se cargan al arrancar).
const datos = cargar();

@Controller()
export class AppController {
  constructor(
    @Inject('PAGO_SERVICE') private readonly pagoClient: ClientProxy,
    @Inject('PEDIDO_SERVICE') private readonly pedidoClient: ClientProxy,
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
        service: 'InventarioService',
        event,
        correlation_id: correlationId,
        status,
        detalle,
      });
    } catch {
      /* una traza nunca debe romper el flujo del negocio */
    }
  }

  // Transacción local: descuenta el stock y recuerda cuánto reservó.
  private reservar(data: DatosPedido): { ok: boolean; error?: string } {
    if (!Number.isInteger(data.cantidad) || data.cantidad < 1) {
      return { ok: false, error: 'cantidad inválida' };
    }
    const producto = datos.productos.find((p) => p.id === data.productoId);
    if (!producto) return { ok: false, error: 'producto inexistente' };
    if (producto.stock < data.cantidad) {
      return { ok: false, error: 'stock insuficiente' };
    }
    producto.stock -= data.cantidad;
    datos.reservas[data.correlationId] = {
      productoId: producto.id,
      cantidad: data.cantidad,
    };
    guardar(datos);
    return { ok: true };
  }

  // Compensación: devuelve el stock reservado (segura si se llama dos veces).
  private liberar(correlationId: string): void {
    const reserva = datos.reservas[correlationId];
    if (!reserva) return;
    const producto = datos.productos.find((p) => p.id === reserva.productoId);
    if (producto) producto.stock += reserva.cantidad;
    delete datos.reservas[correlationId];
    guardar(datos);
  }

  // ---------- Saga COREOGRAFIADA (eventos) ----------

  @EventPattern('pedido_creado')
  reservarStock(@Payload() data: DatosPedido) {
    const inicio = Date.now();
    const r = this.reservar(data);

    if (r.ok) {
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
      this.traza('InventarioReservado', data.correlationId, 'processed');
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
          error: r.error,
          duration_ms: Date.now() - inicio,
        }),
      );
      this.traza('InventarioRechazado', data.correlationId, 'rejected', r.error);
    }
  }

  @EventPattern('pago_fallido')
  revertirReserva(@Payload() data: { correlationId: string }) {
    this.liberar(data.correlationId);
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
    this.traza(
      'InventarioLiberado',
      data.correlationId,
      'compensated',
      'devolvió el stock porque el pago falló',
    );
    this.pedidoClient.emit('inventario_liberado', data);
  }

  // ---------- Saga ORQUESTADA (request-response) ----------

  @MessagePattern('orq_reservar_inventario')
  reservarStockOrquestado(@Payload() data: DatosPedido) {
    const r = this.reservar(data);
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'InventarioService',
        event_received: 'orq_reservar_inventario',
        correlation_id: data.correlationId,
        status: r.ok ? 'processed' : 'rejected',
        error: r.error,
      }),
    );
    if (r.ok) {
      this.traza(
        'InventarioReservado',
        data.correlationId,
        'processed',
        'a pedido del orquestador',
      );
    } else {
      this.traza('InventarioRechazado', data.correlationId, 'rejected', r.error);
    }
    return r;
  }

  @MessagePattern('orq_liberar_inventario')
  liberarStockOrquestado(@Payload() data: { correlationId: string }) {
    this.liberar(data.correlationId);
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'InventarioService',
        event_received: 'orq_liberar_inventario',
        correlation_id: data.correlationId,
        status: 'compensated',
      }),
    );
    this.traza(
      'InventarioLiberado',
      data.correlationId,
      'compensated',
      'a pedido del orquestador',
    );
    return { ok: true };
  }

  // ---------- Operaciones para el frontend (consultar y crear productos) ----------

  @MessagePattern('listar_productos')
  listarProductos() {
    return datos.productos;
  }

  @MessagePattern('crear_producto')
  crearProducto(@Payload() data: { nombre?: unknown; stock?: unknown }) {
    const nombre = typeof data?.nombre === 'string' ? data.nombre.trim() : '';
    const stock = data?.stock;
    if (nombre.length < 1 || nombre.length > 60) {
      return { ok: false, error: 'El nombre debe tener entre 1 y 60 caracteres' };
    }
    if (
      typeof stock !== 'number' ||
      !Number.isInteger(stock) ||
      stock < 0 ||
      stock > 100000
    ) {
      return { ok: false, error: 'El stock debe ser un entero entre 0 y 100000' };
    }
    if (datos.productos.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) {
      return { ok: false, error: 'Ya existe un producto con ese nombre' };
    }
    const producto = { id: datos.siguienteId++, nombre, stock };
    datos.productos.push(producto);
    guardar(datos);
    return { ok: true, producto };
  }

  @MessagePattern('reponer_stock')
  reponerStock(@Payload() data: { id?: unknown; cantidad?: unknown }) {
    const producto = datos.productos.find((p) => p.id === data?.id);
    if (!producto) return { ok: false, error: 'El producto no existe' };
    const cantidad = data?.cantidad;
    if (
      typeof cantidad !== 'number' ||
      !Number.isInteger(cantidad) ||
      cantidad < 1 ||
      cantidad > 100000
    ) {
      return { ok: false, error: 'La cantidad debe ser un entero entre 1 y 100000' };
    }
    producto.stock += cantidad;
    guardar(datos);
    return { ok: true, producto };
  }
}
