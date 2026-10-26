import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'INVENTARIO_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
          queue: 'inventario_queue',
          queueOptions: { durable: false },
        },
      },
    ]),
  ],
  controllers: [AppController],
})
export class AppModule {}
