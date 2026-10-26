# Despliegue en la nube (gratis)

Objetivo: tener un enlace público del frontend para que el ingeniero lo abra desde el navegador.

## Qué se despliega

| Pieza | Dónde | Notas |
|---|---|---|
| RabbitMQ | CloudAMQP, plan gratis | Plan **Loyal Lemming** (LavinMQ, 40 conexiones, 2 M mensajes al mes) o **Little Lemur** (RabbitMQ, 20 conexiones, 1 M mensajes). Los 6 servicios usan unas 19 conexiones, así que Little Lemur queda al límite. |
| 6 servicios Node | Render, 6 *Web Services* con plan **Free** | Un solo repositorio, cada uno con su carpeta como *Root Directory* |

Los límites de los planes gratis cambian: confírmalos en las páginas de precios de [CloudAMQP](https://www.cloudamqp.com/plans.html) y de [Render](https://render.com/docs/free).

## Paso 0. Subir el código

Haz `git push` de todo el repositorio (ver README). Render despliega lo que haya en la rama `main`.

## Paso 1. RabbitMQ en CloudAMQP

1. Crea una cuenta en cloudamqp.com y una instancia con el plan gratis. Elige la región más cercana a la de Render (EE. UU. Este).
2. En los detalles de la instancia copia la **AMQP URL**. Tiene la forma `amqps://usuario:clave@servidor/vhost`.
3. **Esa URL lleva una contraseña.** Se pega solo en las variables de entorno de Render. Nunca en GitHub, en el README ni en un chat.

## Paso 2. Los servicios en Render

En Render: **New → Web Service → conectar el repositorio `saga-pedidos-rabbitmq`**. Repite para cada fila.

Valores iguales en los seis:

| Campo | Valor |
|---|---|
| Branch | `main` |
| Runtime | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `npm run start:prod` |
| Instance Type | Free |
| Variable `RABBITMQ_URL` | la AMQP URL del paso 1 |
| Variable `NODE_VERSION` | `24` |

Valores propios de cada servicio. Créalos en este orden:

| Nombre sugerido | Root Directory | Variables extra |
|---|---|---|
| `saga-inventario` | `nestjs-inventario-service` | — |
| `saga-pago` | `nestjs-pago-service` | — |
| `saga-notificaciones` | `nestjs-notificaciones-service` | — |
| `saga-pedido` | `nestjs-pedido-service` | — |
| `saga-orquestador` | `nestjs-orquestador-pedidos` | `TIMEOUT_MS` = `30000` |
| `saga-frontend` | `nestjs-frontend-saga` | ver la tabla siguiente |

Render muestra la URL de cada servicio arriba (por ejemplo `https://saga-pedido-xxxx.onrender.com`). Puede llevar un sufijo si el nombre ya existía. **Copia las URL reales.**

Variables del frontend (créalo al final, cuando ya tengas las demás URL):

| Variable | Valor |
|---|---|
| `PEDIDO_URL` | `https://<url de saga-pedido>/pedidos` |
| `ORQUESTADOR_URL` | `https://<url de saga-orquestador>/pedidos-orquestados` |
| `SALUD_PEDIDO` | `https://<url de saga-pedido>/health` |
| `SALUD_ORQUESTADOR` | `https://<url de saga-orquestador>/health` |
| `SALUD_INVENTARIO` | `https://<url de saga-inventario>/health` |
| `SALUD_PAGO` | `https://<url de saga-pago>/health` |
| `SALUD_NOTIFICACIONES` | `https://<url de saga-notificaciones>/health` |
| `TIMEOUT_INVENTARIO_MS` | `30000` |

## Paso 3. Probar

1. Espera a que los seis servicios digan **Live** (cada compilación tarda unos minutos).
2. Abre la URL de `saga-frontend`. La primera vez tarda cerca de 1 minuto.
3. En "Hacer pedido" verás el panel **Estado de los servicios**. Espera a que todos estén en *Activo*.
4. Crea un producto, haz pedidos de ambos tipos y abre el recorrido de uno cancelado.

## Para la presentación

- Abre el enlace **5 minutos antes**: los servicios gratis se duermen tras 15 minutos sin uso y tardan cerca de 1 minuto en despertar.
- La página despierta a los demás servicios al abrirse y cada 4 minutos mientras alguien la usa. Se pausa sola tras 20 minutos sin actividad, para no gastar las horas gratis (750 al mes, compartidas por los 6 servicios).
- Entrega al ingeniero el enlace del frontend y el del repositorio de GitHub.

## Límites que debes conocer

- **Los datos se pierden al reiniciar.** El disco de un servicio gratis es temporal, así que `data/inventario.json` y `data/pedidos.json` se reinician cuando el servicio se duerme y despierta o se vuelve a desplegar. Los productos iniciales reaparecen solos. En local sí se conservan.
- **Cualquiera con el enlace puede usarlo.** No hay inicio de sesión. No guardes datos personales ni reales.
- **Las colas no son durables** (como pide el taller): si RabbitMQ se reinicia, los mensajes pendientes se pierden.
- **Los pedidos que viajan mientras un servicio duerme** quedan "En proceso" hasta que despierte. Es consistencia eventual.

## Si algo falla

| Síntoma | Qué revisar |
|---|---|
| El despliegue falla con "No open ports detected" | En los *Logs* del servicio, busca errores de conexión a RabbitMQ. Casi siempre `RABBITMQ_URL` está mal copiada. |
| Un servicio aparece "Dormido o sin respuesta" | Pulsa "Despertar servicios" y espera un minuto. |
| Errores de límite de conexiones | Tu plan de CloudAMQP tiene un tope. Cambia a Loyal Lemming (40) o cierra instancias antiguas. |
| `PRECONDITION_FAILED` | Una cola ya existe con otros parámetros. Borra las colas desde el panel de CloudAMQP. |
| La página no muestra el panel de servicios | Faltan las variables `SALUD_*` del frontend. |
