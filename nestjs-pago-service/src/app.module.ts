import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppController } from './app.controller.js';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NOTIFICACIONES_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: ['amqp://localhost:5672'],
          queue: 'notificaciones_queue',
          queueOptions: { durable: false },
        },
      },
      {
        name: 'INVENTARIO_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: ['amqp://localhost:5672'],
          queue: 'inventario_queue',
          queueOptions: { durable: false },
        },
      },
    ]),
  ],
  controllers: [AppController],
})
export class AppModule {}
