import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AppController } from './app.controller.js';

const cliente = () => ({ emit: vi.fn() }) as any;

describe('PedidoService', () => {
  let controller: AppController;
  let inventario: ReturnType<typeof cliente>;

  beforeEach(() => {
    delete process.env.INTERNAL_TOKEN;
    inventario = cliente();
    controller = new AppController(inventario, cliente());
  });

  it('crea el pedido y publica pedido_creado', () => {
    const pedido = controller.crearPedido({ productoId: 1, cantidad: 2 });
    expect(pedido.estado).toBe('Creado');
    expect(inventario.emit).toHaveBeenCalledWith(
      'pedido_creado',
      expect.objectContaining({ productoId: 1, cantidad: 2 }),
    );
  });

  it.each([
    { productoId: 0, cantidad: 1 },
    { productoId: 1, cantidad: 0 },
    { productoId: 1, cantidad: 1001 },
    { productoId: 1.5, cantidad: 1 },
    { productoId: '1', cantidad: 1 },
  ])('rechaza %j', (body) => {
    expect(() => controller.crearPedido(body as any)).toThrow(BadRequestException);
  });

  it('exige el token interno cuando está configurado', () => {
    process.env.INTERNAL_TOKEN = 'secreto';
    expect(() => controller.crearPedido({ productoId: 1, cantidad: 1 })).toThrow(UnauthorizedException);
    expect(() => controller.crearPedido({ productoId: 1, cantidad: 1 }, 'secreto')).not.toThrow();
  });

  it('marca Rechazado cuando Inventario no pudo reservar', () => {
    const { pedidoId } = controller.crearPedido({ productoId: 1, cantidad: 1 });
    controller.rechazarPedido({ correlationId: pedidoId });
    expect(controller.consultar(pedidoId).estado).toBe('Rechazado');
  });

  it('marca Cancelado cuando se libera el inventario', () => {
    const { pedidoId } = controller.crearPedido({ productoId: 1, cantidad: 1 });
    controller.cancelarPedido({ correlationId: pedidoId });
    expect(controller.consultar(pedidoId).estado).toBe('Cancelado');
  });
});
