import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppController } from './app.controller.js';

const cliente = (name: string, queue: string) => ({
  name,
  transport: Transport.RMQ as const,
  options: {
    urls: ['amqp://localhost:5672'],
    queue,
    queueOptions: { durable: false },
  },
});

@Module({
  imports: [
    ClientsModule.register([
      cliente('NOTIFICACIONES_SERVICE', 'notificaciones_queue'),
      cliente('INVENTARIO_SERVICE', 'inventario_queue'),
      cliente('TRAZAS_SERVICE', 'trazas_queue'),
    ]),
  ],
  controllers: [AppController],
})
export class AppModule {}
