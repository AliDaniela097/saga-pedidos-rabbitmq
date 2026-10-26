import { describe, expect, it } from "vitest";
import { estadoDe } from './historial.js';
import type { Paso } from './historial.js';

const pasos = (...eventos: string[]): Paso[] =>
  eventos.map((event, i) => ({
    timestamp: new Date(2026, 0, 1, 10, 0, i).toISOString(),
    service: 'X',
    event,
    status: 'ok',
  }));

describe('estadoDe', () => {
  it.each([
    [['PedidoCreado'], 'En proceso'],
    [['PedidoCreado', 'PedidoConfirmado'], 'Confirmado'],
    [['PedidoCreado', 'InventarioRechazado'], 'Rechazado'],
    [['PedidoCreado', 'PedidoRechazado'], 'Rechazado'],
    [['PedidoCreado', 'PagoFallido', 'PedidoCancelado'], 'Cancelado'],
    [['PedidoCreado', 'NotificacionFallida'], 'Pagado sin notificar'],
    [['PedidoCreado', 'PagoFallido', 'CompensacionPendiente'], 'Compensación pendiente'],
  ])('%j → %s', (eventos, esperado) => {
    expect(estadoDe(pasos(...eventos))).toBe(esperado);
  });
});
