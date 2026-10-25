import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3002);
  console.log('OrquestadorPedidos: HTTP en :3002 (POST /pedidos-orquestados)');
}
await bootstrap();
