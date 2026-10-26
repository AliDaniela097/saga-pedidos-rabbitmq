import { AppController } from './app.controller.js';

// El almacén se sustituye por uno en memoria: la prueba no lee ni escribe data/inventario.json.
vi.mock('./almacen.js', () => ({
  cargar: () => ({
    siguienteId: 2,
    productos: [{ id: 1, nombre: 'Teclado', stock: 10 }],
    reservas: {},
  }),
  guardar: vi.fn(),
}));

const cliente = () => ({ emit: vi.fn() }) as any;

// El estado del inventario vive a nivel de módulo (como en producción): cada prueba compara contra el stock previo.
describe('InventarioService', () => {
  let controller: AppController;
  let pedido: ReturnType<typeof cliente>;
  const stock = () => controller.listarProductos()[0].stock;

  beforeEach(() => {
    pedido = cliente();
    controller = new AppController(cliente(), pedido, cliente());
  });

  it('descuenta el stock al reservar', () => {
    const antes = stock();
    controller.reservarStockOrquestado({ correlationId: 'cid-00000001', productoId: 1, cantidad: 3 });
    expect(stock()).toBe(antes - 3);
  });

  it('es idempotente: el mismo pedido dos veces descuenta una sola vez', () => {
    const datos = { correlationId: 'cid-00000002', productoId: 1, cantidad: 3 };
    const antes = stock();
    controller.reservarStockOrquestado(datos);
    controller.reservarStockOrquestado(datos);
    expect(stock()).toBe(antes - 3);
  });

  it('liberar devuelve el stock una sola vez', () => {
    const datos = { correlationId: 'cid-00000003', productoId: 1, cantidad: 4 };
    const antes = stock();
    controller.reservarStockOrquestado(datos);
    controller.liberarStockOrquestado({ correlationId: datos.correlationId });
    controller.liberarStockOrquestado({ correlationId: datos.correlationId });
    expect(stock()).toBe(antes);
  });

  it('sin stock suficiente rechaza y avisa a Pedido (coreografía)', () => {
    const antes = stock();
    controller.reservarStock({ correlationId: 'cid-00000004', productoId: 1, cantidad: 999 });
    expect(pedido.emit).toHaveBeenCalledWith(
      'inventario_rechazado',
      expect.objectContaining({ correlationId: 'cid-00000004', error: 'stock insuficiente' }),
    );
    expect(stock()).toBe(antes);
  });
});
