import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { listar, registrarPedido, registrarTraza } from './historial.js';
import { despertarServicios, listarServicios } from './servicios.js';
import type { Modo } from './historial.js';

type Producto = { id: number; nombre: string; stock: number };
type Respuesta = { ok: boolean; error?: string; producto?: Producto };

// Tiempos de espera (en la nube, un servicio dormido tarda cerca de 1 minuto en responder).
const ESPERA_INVENTARIO_MS = Number(process.env.TIMEOUT_INVENTARIO_MS ?? 5000);
// Debe superar el peor caso del orquestador: pasos × TIMEOUT_MS (3 × 30 s en la nube).
const ESPERA_PEDIDO_MS = Number(process.env.TIMEOUT_PEDIDO_MS ?? 120000);
// La lista de productos se reutiliza unos segundos para no preguntar a Inventario (y a RabbitMQ) en cada sondeo.
const VIDA_CACHE_MS = 3000;
let cacheProductos: { en: number; datos: Producto[] } | null = null;

// A dónde se envía el pedido según la forma de coordinar la Saga.
const URL_PEDIDO: Record<Modo, string> = {
  coreografiada: process.env.PEDIDO_URL ?? 'http://localhost:3000/pedidos',
  orquestada: process.env.ORQUESTADOR_URL ?? 'http://localhost:3002/pedidos-orquestados',
};

@Controller('api')
export class AppController {
  constructor(
    @Inject('INVENTARIO_SERVICE') private readonly inventario: ClientProxy,
  ) {}

  // El navegador nunca habla con RabbitMQ: habla con este backend por HTTP,
  // y este backend le pregunta a Inventario por RabbitMQ.
  private async consultar<T>(patron: string, data: unknown): Promise<T> {
    try {
      return await firstValueFrom(
        this.inventario.send<T>(patron, data).pipe(timeout(ESPERA_INVENTARIO_MS)),
      );
    } catch {
      throw new ServiceUnavailableException(
        'El servicio de Inventario no responde. ¿Está arrancado?',
      );
    }
  }

  private async listarProductos(): Promise<Producto[]> {
    if (cacheProductos && Date.now() - cacheProductos.en < VIDA_CACHE_MS) {
      return cacheProductos.datos;
    }
    const datos = await this.consultar<Producto[]>('listar_productos', {});
    cacheProductos = { en: Date.now(), datos };
    return datos;
  }

  @Get('productos')
  productos() {
    return this.listarProductos();
  }

  @Post('productos')
  async crearProducto(@Body() body: { nombre?: unknown; stock?: unknown }) {
    const r = await this.consultar<Respuesta>('crear_producto', {
      nombre: body?.nombre,
      stock: body?.stock,
    });
    if (!r.ok) throw new BadRequestException(r.error);
    cacheProductos = null;
    return r.producto;
  }

  @Post('productos/:id/reponer')
  async reponer(@Param('id') id: string, @Body() body: { cantidad?: unknown }) {
    if (!/^\d{1,9}$/.test(id)) throw new BadRequestException('Producto no válido');
    const r = await this.consultar<Respuesta>('reponer_stock', {
      id: Number(id),
      cantidad: body?.cantidad,
    });
    if (!r.ok) throw new BadRequestException(r.error);
    cacheProductos = null;
    return r.producto;
  }

  @Post('pedidos')
  async crearPedido(
    @Body() body: { productoId?: unknown; cantidad?: unknown; modo?: unknown },
  ) {
    // Solo números o texto numérico: Number(true), Number([2]) o Number(null) no son entradas válidas.
    const comoNumero = (v: unknown) =>
      typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
    const productoId = comoNumero(body?.productoId);
    const cantidad = comoNumero(body?.cantidad);
    const modo = body?.modo;
    if (!Number.isInteger(productoId) || productoId < 1) {
      throw new BadRequestException('Elige un producto');
    }
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 1000) {
      throw new BadRequestException('La cantidad debe ser un entero entre 1 y 1000');
    }
    if (modo !== 'coreografiada' && modo !== 'orquestada') {
      throw new BadRequestException('El modo debe ser coreografiada u orquestada');
    }

    const productos = await this.listarProductos();
    const producto = productos.find((p) => p.id === productoId);
    if (!producto) throw new BadRequestException('El producto no existe');

    let respuesta: { pedidoId?: unknown };
    try {
      const r = await fetch(URL_PEDIDO[modo], {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Si el entorno define INTERNAL_TOKEN, Pedido y Orquestador solo aceptan a quien lo conoce.
          ...(process.env.INTERNAL_TOKEN && { 'x-internal-token': process.env.INTERNAL_TOKEN }),
        },
        body: JSON.stringify({ productoId, cantidad }),
        signal: AbortSignal.timeout(ESPERA_PEDIDO_MS),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      respuesta = (await r.json()) as { pedidoId?: unknown };
    } catch {
      throw new BadGatewayException(
        modo === 'coreografiada'
          ? 'No responde PedidoService. ¿Está arrancado o todavía despertando?'
          : 'No responde el Orquestador. ¿Está arrancado o todavía despertando?',
      );
    }
    if (typeof respuesta.pedidoId !== 'string') {
      throw new BadGatewayException('Respuesta inesperada del servicio de pedidos');
    }

    registrarPedido({
      pedidoId: respuesta.pedidoId,
      productoId,
      productoNombre: producto.nombre,
      cantidad,
      modo,
    });
    return { pedidoId: respuesta.pedidoId };
  }

  // Estado de los servicios en la nube (vacío en local).
  @Get('servicios')
  servicios() {
    return listarServicios();
  }

  // Despierta a los servicios dormidos y devuelve el estado actual.
  @Post('servicios/despertar')
  despertar() {
    despertarServicios();
    return listarServicios();
  }

  @Get('pedidos')
  pedidos() {
    return listar();
  }

  // Los servicios publican aquí cada paso que dan (trazabilidad).
  @EventPattern('traza')
  recibirTraza(@Payload() traza: unknown) {
    registrarTraza(traza);
  }
}
