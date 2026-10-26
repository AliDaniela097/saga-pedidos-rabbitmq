import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { createServer } from 'node:http';
import { AppModule } from './app.module.js';

async function bootstrap() {
  let conectado = false;

  // En la nube (Render) un servicio gratis debe abrir un puerto HTTP, y conviene
  // abrirlo pronto. Solo se abre si existe la variable PORT: en local no cambia nada.
  // Responde 200 cuando ya escucha la cola y 503 mientras se conecta a RabbitMQ.
  if (process.env.PORT) {
    createServer((_req, res) => {
      res.writeHead(conectado ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          estado: conectado ? 'ok' : 'conectando',
          servicio: 'NotificacionesService',
        }),
      );
    }).listen(Number(process.env.PORT), () => {
      console.log('Comprobación de salud en el puerto ' + process.env.PORT);
    });
  }

  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue: 'notificaciones_queue',
      queueOptions: { durable: false },
    },
  });
  app.enableShutdownHooks(); // en un despliegue (SIGTERM) cierra las conexiones con orden
  await app.listen();
  conectado = true;
  console.log('NotificacionesService escuchando en notificaciones_queue');
}
await bootstrap();
