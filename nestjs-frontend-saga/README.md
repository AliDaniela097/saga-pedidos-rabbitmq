# nestjs-frontend-saga

Interfaz web (SagaPedidos) para crear productos, hacer pedidos y ver el recorrido de cada evento de la Saga.

## Qué hace

- **Productos:** crea productos y repone su stock. Los guarda Inventario en `nestjs-inventario-service/data/inventario.json`.
- **Pedidos:** crea pedidos con la Saga **coreografiada** (puerto 3000) o **orquestada** (puerto 3002).
- **Recorrido:** muestra cada evento de un pedido, con el servicio que lo generó, la hora y el tiempo transcurrido.
- **Historial:** se guarda en `data/pedidos.json` de este proyecto.

## Cómo funciona

```
Navegador --HTTP /api--> nestjs-frontend-saga --RabbitMQ--> Inventario (productos)
                              |
                              +--HTTP--> PedidoService (3000)  o  Orquestador (3002)

Cada servicio publica una "traza" en trazas_queue con el mismo correlation_id.
Este proyecto escucha esa cola y arma el historial.
```

El navegador nunca habla con RabbitMQ. El estado del pedido (Confirmado, Cancelado, Rechazado) se **deduce** de los eventos que ya llegaron; mientras tanto aparece "En proceso".

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `src/app.controller.ts` | Rutas `/api/productos` y `/api/pedidos`; valida los datos y recibe las trazas |
| `src/historial.ts` | Guarda las trazas en JSON y deduce el estado de cada pedido |
| `src/main.ts` | Arranca HTTP en el puerto **3003** y escucha `trazas_queue` |
| `public/index.html` | Estructura de la página |
| `public/styles.css` | Diseño |
| `public/app.js` | Lógica de la página (consulta `/api` cada 2 segundos) |

## Cómo ejecutarlo

1. RabbitMQ encendido y los demás servicios arrancados (ver el README general).
2. En esta carpeta: `npm install` y luego `npm run start`.
3. Abrir http://localhost:3003

## Notas

- Si arrancas este proyecto después de hacer pedidos, las trazas pendientes se procesan al arrancar (esperan en `trazas_queue` mientras RabbitMQ siga encendido).
- Se conservan los 200 pedidos más recientes.
