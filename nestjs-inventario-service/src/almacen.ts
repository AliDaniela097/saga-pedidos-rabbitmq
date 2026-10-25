import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Almacén en archivo JSON del InventarioService.
// El archivo se crea solo la primera vez, en la carpeta "data" del proyecto.

export type Producto = { id: number; nombre: string; stock: number };
export type Reserva = { productoId: number; cantidad: number };
export type Datos = {
  siguienteId: number;
  productos: Producto[];
  reservas: Record<string, Reserva>;
};

const CARPETA = join(process.cwd(), 'data');
const ARCHIVO = join(CARPETA, 'inventario.json');

function datosIniciales(): Datos {
  return {
    siguienteId: 4,
    productos: [
      { id: 1, nombre: 'Teclado mecánico', stock: 10 },
      { id: 2, nombre: 'Mouse inalámbrico', stock: 15 },
      { id: 3, nombre: 'Monitor 24"', stock: 5 },
    ],
    reservas: {},
  };
}

export function guardar(datos: Datos): void {
  try {
    mkdirSync(CARPETA, { recursive: true });
    // Se escribe en un archivo temporal y luego se renombra, para no dejar
    // el JSON a medias si el proceso se corta justo al guardar.
    const temporal = ARCHIVO + '.tmp';
    writeFileSync(temporal, JSON.stringify(datos, null, 2), 'utf-8');
    renameSync(temporal, ARCHIVO);
  } catch (e) {
    console.error('No se pudo guardar inventario.json:', e);
  }
}

export function cargar(): Datos {
  if (existsSync(ARCHIVO)) {
    try {
      return JSON.parse(readFileSync(ARCHIVO, 'utf-8')) as Datos;
    } catch {
      console.error('inventario.json está dañado: se guarda una copia y se reinicia.');
      try {
        renameSync(ARCHIVO, ARCHIVO + '.corrupto');
      } catch {
        /* si no se puede copiar, se sobrescribe */
      }
    }
  }
  const iniciales = datosIniciales();
  guardar(iniciales);
  return iniciales;
}
