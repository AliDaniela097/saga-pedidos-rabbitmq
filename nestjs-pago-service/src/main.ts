import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: ['amqp://localhost:5672'],
      queue: 'pago_queue',
      queueOptions: { durable: false },
    },
  });
  await app.listen();
  console.log('PagoService escuchando en pago_queue');
}
await bootstrap();
