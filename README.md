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

Se construyó el mismo flujo (reservar inventario, cobrar, notificar, con compensación si el pago falla) de dos maneras. La Saga coreografiada está repartida en cuatro proyectos; la orquestada está concentrada en `nestjs-orquestador-pedidos`.

### Diferencias concretas de código

| Aspecto | Coreografiada | Orquestada |
|---|---|---|
| Dónde está la compensación | Repartida en tres proyectos: `PagoService.procesarPago` emite `pago_fallido` en su `else`; `InventarioService.revertirReserva` (`@EventPattern('pago_fallido')`) devuelve el stock y emite `inventario_liberado`; `PedidoService.cancelarPedido` marca el pedido como Cancelado | Un solo bloque en `AppController.crearPedidoOrquestado`: el `if (!pago.ok)` llama a `orq_liberar_inventario` y cambia el estado a Cancelado |
| Cómo se comunican | `emit()`: publica el evento y sigue, sin esperar respuesta | `send()` con `firstValueFrom(...).pipe(timeout(5000))`: espera la respuesta, y los destinos responden con `@MessagePattern` devolviendo `{ ok }` |
| Qué recibe el cliente | `POST /pedidos` devuelve `estado: "Creado"` al instante y no se entera del resultado | `POST /pedidos-orquestados` devuelve el estado final: `Confirmado`, `Cancelado` o `Rechazado` |
| Quién conoce el flujo | Nadie lo ve completo; cada servicio solo conoce la cola del siguiente | El orquestador conoce el orden, las tres colas y los patrones `orq_...` |
| Servicio caído | El evento espera en la cola de RabbitMQ hasta que el servicio vuelva | El `timeout` de 5 s convierte la falta de respuesta en un paso fallido y dispara la compensación |

### Qué parte del código es más simple

- **Coreografiada:** cada servicio es muy simple, porque solo reacciona a un evento y publica el siguiente. Lo difícil es entender el flujo completo: hay que leer cuatro proyectos y seguir el `correlation_id` entre terminales.
- **Orquestada:** el flujo se lee de arriba abajo en un único archivo, con sus `if` de compensación. Es más fácil de entender, de auditar y de poner reintentos. A cambio, el orquestador conoce a todos los servicios y, si cae, no se procesan pedidos orquestados.

### Agregar el paso "generar factura"

- **Orquestada:** se crea un servicio de Facturación con un `@MessagePattern('orq_generar_factura')`, se registra su cliente en `app.module.ts` del orquestador y se agrega un bloque nuevo en `crearPedidoOrquestado` entre el pago y la notificación. Si la factura falla, el orquestador debe deshacer dos pasos en orden inverso: reembolsar el pago (un método que hoy no existe en Pago) y liberar el inventario. Cambian el orquestador, Pago y el servicio nuevo.
- **Coreografiada:** se crea el servicio de Facturación, pero hoy Pago emite `pago_procesado` directo a `notificaciones_queue`, una cola de un solo destinatario. Hay que modificar Pago para que su evento llegue a Facturación y luego Facturación emita `factura_generada` para Notificaciones. La compensación agrega eslabones: Facturación emitiría un evento de fallo, Pago tendría que reembolsar, Inventario liberar y Pedido cancelar. Cambian tres proyectos existentes más el nuevo.

### Evidencia de las pruebas

- Coreografiada, `cid-4edee0f7`: Pedido emitió `PedidoCreado`, Inventario reservó, Pago falló (`status: "error"`), Inventario compensó (`status: "compensated"`) y Pedido registró `status: "cancelled"`.
- Orquestada, `cid-ec753afc`: el orquestador registró `reservar_inventario` ok, `procesar_pago` error y `compensar_inventario` compensated. En un lote de 10 pedidos hubo 4 Confirmados y 6 Cancelados.

## Declaración de uso de IA

- Herramienta(s): Claude (Anthropic)
- Nivel de uso: 2-3 (borrador y revisión)
- Qué se le pidió: guía paso a paso del taller, explicación de conceptos (emit vs send, Saga, correlation_id), escritura del código de los pasos 2 a 8 a partir de la guía, interpretación de errores y de los logs, diagrama de arquitectura en FigJam, estructura del repositorio, y un borrador de la comparación de arriba
- Qué se modificó/verificó manualmente: levanté RabbitMQ con Docker, creé los proyectos, arranqué cada servicio en su propia terminal, ejecuté los pedidos, provoqué los fallos de pago y verifiqué en los logs de las terminales la compensación completa en ambas versiones, eliminé los `.git` internos y subí el repositorio a GitHub
