# Saga de Pedidos (EDA) con NestJS + RabbitMQ

Semana 6 de Integración de Sistemas. Cuatro microservicios NestJS que cooperan **solo por eventos** a través de RabbitMQ, con compensación real cuando el pago falla, y una versión **orquestada** del mismo flujo para compararlas.

## Proyectos

| Carpeta | Rol | Puerto / cola |
|---|---|---|
| `nestjs-pedido-service` | Crea el pedido, publica `PedidoCreado` y lo cancela al recibir `InventarioLiberado`. App híbrida (HTTP + microservicio) | HTTP 3000 · `pedido_queue` |
| `nestjs-inventario-service` | Reserva stock y lo devuelve si el pago falla (compensación) | `inventario_queue` |
| `nestjs-pago-service` | Procesa el pago; falla ~40 % de las veces (simulado) | `pago_queue` |
| `nestjs-notificaciones-service` | Último paso: confirma el pedido al cliente | `notificaciones_queue` |
| `nestjs-orquestador-pedidos` | Versión orquestada: llama paso a paso con `send()` y decide la compensación | HTTP 3002 |

## Flujo de la Saga coreografiada

Camino feliz:

```
Pedido --pedido_creado--> Inventario --inventario_reservado--> Pago --pago_procesado--> Notificaciones
```

Compensación (el pago falla):

```
Pago --pago_fallido--> Inventario (devuelve el stock) --inventario_liberado--> Pedido (queda "Cancelado")
```

Cada servicio ejecuta una transacción local y publica un evento. Ningún servicio llama a otro por URL.

## Versión orquestada

`POST /pedidos-orquestados` en el orquestador ejecuta, en orden y esperando respuesta (`send()` + `@MessagePattern`): reservar inventario, procesar pago y notificar. Si el pago falla, el propio orquestador ordena liberar el inventario. Los servicios destino exponen para esto los patrones `orq_reservar_inventario`, `orq_liberar_inventario`, `orq_procesar_pago` y `orq_notificar`.

## Trazabilidad

El `correlation_id` (`cid-xxxxxxxx`) se genera una sola vez (en Pedido o en el Orquestador) y cada servicio lo copia en sus logs JSON y en el evento siguiente. Buscando ese valor se reconstruye todo el recorrido, incluida la compensación.

## Requisitos

- Node.js 18 o superior
- Docker Desktop (para RabbitMQ)

## Cómo ejecutarlo

1. Levantar RabbitMQ (solo la primera vez; luego `docker start rabbitmq-integracion`):

```
docker run -d --name rabbitmq-integracion -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

Consola de administración: http://localhost:15672 (usuario `guest`, contraseña `guest`; solo para uso local).

2. Instalar dependencias en cada proyecto:

```
cd nestjs-pedido-service && npm install
```

(repetir en las otras cuatro carpetas)

3. Arrancar cada proyecto en su propia terminal con `npm run start`, en este orden: inventario, pago, notificaciones, pedido y, si se quiere la versión orquestada, el orquestador.

4. Probar. Coreografiada:

```
Invoke-RestMethod -Method Post -Uri http://localhost:3000/pedidos -ContentType "application/json" -Body '{"productoId":2,"cantidad":1}'
```

Orquestada:

```
Invoke-RestMethod -Method Post -Uri http://localhost:3002/pedidos-orquestados -ContentType "application/json" -Body '{"productoId":2,"cantidad":1}'
```

Stock inicial (en memoria): producto 1 = 10, producto 2 = 15, producto 3 = 5. Al reiniciar Inventario vuelve a esos valores.

## Limitaciones conocidas

- El estado (pedidos y stock) vive en memoria; se pierde al reiniciar cada servicio.
- Las colas son no durables (`durable: false`), como pide la guía: si RabbitMQ se reinicia, los mensajes pendientes se pierden.
- Si falla Notificaciones no hay compensación del pago.
- No hay endpoint para consultar el estado de un pedido; se verifica por los logs.

## Tecnologías

Node.js, NestJS 12, `@nestjs/microservices` (Transport.RMQ), RabbitMQ, Docker.

## Comparación coreografía vs. orquestación

> Pendiente: completar con tus propias palabras (mínimo dos diferencias concretas de código y qué cambiarías en cada versión para agregar el paso "generar factura").

## Declaración de uso de IA

- Herramienta(s):
- Nivel de uso:
- Qué se le pidió:
- Qué se modificó/verificó manualmente:
