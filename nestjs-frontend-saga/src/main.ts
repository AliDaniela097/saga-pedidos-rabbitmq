import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // La página web (carpeta public) se sirve desde este mismo servidor.
  app.useStaticAssets(join(process.cwd(), 'public'));
  // Además de HTTP, escucha las trazas que publican los demás servicios.
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: ['amqp://localhost:5672'],
      queue: 'trazas_queue',
      queueOptions: { durable: false },
    },
  });
  await app.startAllMicroservices();
  await app.listen(3003);
  console.log('FrontendSaga: abre http://localhost:3003 (y escucha trazas_queue)');
}
await bootstrap();
