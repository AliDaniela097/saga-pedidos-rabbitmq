// Comprobación de los servicios en la nube.
// En el plan gratis de Render, cada servicio se duerme tras 15 minutos sin uso.
// Una petición HTTP a su ruta /health lo despierta (tarda cerca de 1 minuto).
// Las direcciones llegan por variables de entorno; en local no se definen y
// este módulo no hace nada.

export type EstadoServicio = 'activo' | 'despertando' | 'sin respuesta';
export type Servicio = { nombre: string; estado: EstadoServicio; actualizado: string };

const CONFIGURADOS: { nombre: string; url?: string }[] = [
  { nombre: 'Pedido', url: process.env.SALUD_PEDIDO },
  { nombre: 'Orquestador', url: process.env.SALUD_ORQUESTADOR },
  { nombre: 'Inventario', url: process.env.SALUD_INVENTARIO },
  { nombre: 'Pago', url: process.env.SALUD_PAGO },
  { nombre: 'Notificaciones', url: process.env.SALUD_NOTIFICACIONES },
];

const TIEMPO_MS = Number(process.env.TIMEOUT_SALUD_MS ?? 90000);
const estados = new Map<string, Servicio>();

function marcar(nombre: string, estado: EstadoServicio): void {
  estados.set(nombre, { nombre, estado, actualizado: new Date().toISOString() });
}

export function listarServicios(): Servicio[] {
  return CONFIGURADOS.filter((c) => c.url).map(
    (c) =>
      estados.get(c.nombre) ?? { nombre: c.nombre, estado: 'sin respuesta', actualizado: '' },
  );
}

// Lanza las comprobaciones sin esperar: el estado se va actualizando solo.
export function despertarServicios(): void {
  for (const c of CONFIGURADOS) {
    if (!c.url) continue;
    if (estados.get(c.nombre)?.estado === 'despertando') continue;
    marcar(c.nombre, 'despertando');
    void fetch(c.url, { signal: AbortSignal.timeout(TIEMPO_MS) })
      .then((r) => marcar(c.nombre, r.ok ? 'activo' : 'sin respuesta'))
      .catch(() => marcar(c.nombre, 'sin respuesta'));
  }
}
