import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');
  app.enableShutdownHooks();
  // Ruta de salud: sirve para comprobar (y despertar) el servicio en la nube.
  app
    .getHttpAdapter()
    .get('/health', (_req: any, res: any) =>
      res.json({ estado: 'ok', servicio: 'PedidoService' }),
    );
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue: 'pedido_queue',
      queueOptions: { durable: false },
    },
  });
  await app.startAllMicroservices();
  const puerto = Number(process.env.PORT ?? 3000);
  await app.listen(puerto);
  console.log('PedidoService: HTTP en :' + puerto + ' + escuchando pedido_queue');
}
await bootstrap();
