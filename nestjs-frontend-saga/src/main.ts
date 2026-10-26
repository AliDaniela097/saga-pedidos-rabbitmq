import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { despertarServicios } from './servicios.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // La página web (carpeta public) se sirve desde este mismo servidor.
  app.useStaticAssets(join(process.cwd(), 'public'));
  // Ruta de salud: sirve para comprobar (y despertar) el servicio en la nube.
  app
    .getHttpAdapter()
    .get('/health', (_req: any, res: any) =>
      res.json({ estado: 'ok', servicio: 'FrontendSaga' }),
    );
  // Además de HTTP, escucha las trazas que publican los demás servicios.
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue: 'trazas_queue',
      queueOptions: { durable: false },
    },
  });
  await app.startAllMicroservices();
  const puerto = Number(process.env.PORT ?? 3003);
  await app.listen(puerto);
  console.log('FrontendSaga: abre http://localhost:' + puerto + ' (y escucha trazas_queue)');
  despertarServicios(); // en la nube, al arrancar despierta a los demás servicios
}
await bootstrap();
