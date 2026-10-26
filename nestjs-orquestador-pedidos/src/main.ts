import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');
  app.enableShutdownHooks();
  // Ruta de salud: sirve para comprobar (y despertar) el servicio en la nube.
  app
    .getHttpAdapter()
    .get('/health', (_req: any, res: any) =>
      res.json({ estado: 'ok', servicio: 'OrquestadorPedidos' }),
    );
  const puerto = Number(process.env.PORT ?? 3002);
  await app.listen(puerto);
  console.log(
    'OrquestadorPedidos: HTTP en :' + puerto + ' (POST /pedidos-orquestados)',
  );
}
await bootstrap();
