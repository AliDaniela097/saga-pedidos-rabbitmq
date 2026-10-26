import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Historial de pedidos guardado en data/pedidos.json.
// Se arma a partir de las "trazas" que cada servicio publica en trazas_queue:
// todas llevan el mismo correlation_id, y así se reconstruye el recorrido.

export type Modo = 'coreografiada' | 'orquestada';

export type Paso = {
  timestamp: string;
  service: string;
  event: string;
  status: string;
  detalle?: string;
};

type PedidoGuardado = {
  pedidoId: string;
  productoId?: number;
  productoNombre?: string;
  cantidad?: number;
  modo?: Modo;
  creadoEn: string;
  pasos: Paso[];
};

export type PedidoVista = PedidoGuardado & { estado: string; modo: Modo };

const CARPETA = join(process.cwd(), 'data');
const ARCHIVO = join(CARPETA, 'pedidos.json');
const MAXIMO = 200; // se conservan los 200 pedidos más recientes
const ID_VALIDO = /^cid-[0-9a-f]{8}$/;

function cargar(): Record<string, PedidoGuardado> {
  if (existsSync(ARCHIVO)) {
    try {
      return JSON.parse(readFileSync(ARCHIVO, 'utf-8')) as Record<
        string,
        PedidoGuardado
      >;
    } catch {
      console.error('pedidos.json está dañado: se guarda una copia y se reinicia.');
      try {
        renameSync(ARCHIVO, ARCHIVO + '.corrupto');
      } catch {
        /* si no se puede copiar, se sobrescribe */
      }
    }
  }
  return {};
}

let pedidos: Record<string, PedidoGuardado> = cargar();

function guardar(): void {
  const ids = Object.keys(pedidos);
  if (ids.length > MAXIMO) {
    ids.sort((a, b) => pedidos[a].creadoEn.localeCompare(pedidos[b].creadoEn));
    for (const id of ids.slice(0, ids.length - MAXIMO)) delete pedidos[id];
  }
  try {
    mkdirSync(CARPETA, { recursive: true });
    const temporal = ARCHIVO + '.tmp';
    writeFileSync(temporal, JSON.stringify(pedidos, null, 2), 'utf-8');
    renameSync(temporal, ARCHIVO);
  } catch (e) {
    console.error('No se pudo guardar pedidos.json:', e);
  }
}

function obtener(id: string, creadoEn?: string): PedidoGuardado {
  if (!pedidos[id]) {
    pedidos[id] = {
      pedidoId: id,
      creadoEn: creadoEn ?? new Date().toISOString(),
      pasos: [],
    };
  }
  return pedidos[id];
}

// Guarda los datos que solo conoce el frontend (producto elegido y modo).
export function registrarPedido(meta: {
  pedidoId: string;
  productoId: number;
  productoNombre: string;
  cantidad: number;
  modo: Modo;
}): void {
  if (!ID_VALIDO.test(meta.pedidoId)) return;
  const p = obtener(meta.pedidoId);
  p.productoId = meta.productoId;
  p.productoNombre = meta.productoNombre;
  p.cantidad = meta.cantidad;
  p.modo = meta.modo;
  guardar();
}

// Recibe una traza de cualquier servicio. Se valida porque viene de una cola.
export function registrarTraza(entrada: unknown): void {
  if (typeof entrada !== 'object' || entrada === null) return;
  const t = entrada as Record<string, unknown>;
  const id = t.correlation_id;
  if (typeof id !== 'string' || !ID_VALIDO.test(id)) return;
  if (
    typeof t.event !== 'string' ||
    typeof t.service !== 'string' ||
    typeof t.status !== 'string' ||
    typeof t.timestamp !== 'string'
  ) {
    return;
  }
  const paso: Paso = {
    timestamp: t.timestamp.slice(0, 40),
    service: t.service.slice(0, 40),
    event: t.event.slice(0, 60),
    status: t.status.slice(0, 20),
    detalle: typeof t.detalle === 'string' ? t.detalle.slice(0, 200) : undefined,
  };
  const p = obtener(id, paso.timestamp);
  const repetido = p.pasos.some(
    (x) =>
      x.timestamp === paso.timestamp &&
      x.service === paso.service &&
      x.event === paso.event,
  );
  if (repetido) return;
  p.pasos.push(paso);
  if (paso.timestamp < p.creadoEn) p.creadoEn = paso.timestamp;
  guardar();
}

// El estado se DEDUCE de los eventos que ya ocurrieron (consistencia eventual).
export function estadoDe(pasos: Paso[]): string {
  const hay = (...eventos: string[]) => pasos.some((p) => eventos.includes(p.event));
  if (hay('CompensacionPendiente')) return 'Compensación pendiente';
  if (hay('PedidoCancelado')) return 'Cancelado';
  if (hay('InventarioRechazado', 'PedidoRechazado')) return 'Rechazado';
  if (hay('NotificacionFallida')) return 'Pagado sin notificar';
  if (hay('PedidoConfirmado')) return 'Confirmado';
  return 'En proceso';
}

export function listar(): PedidoVista[] {
  return Object.values(pedidos)
    .map((p) => {
      const pasos = [...p.pasos].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const modo: Modo =
        p.modo ??
        (pasos.some((x) => x.event.startsWith('Orq')) ? 'orquestada' : 'coreografiada');
      return { ...p, pasos, modo, estado: estadoDe(pasos) };
    })
    .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn))
    .slice(0, 100);
}
