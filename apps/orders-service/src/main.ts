import { LogLevel, VersioningType } from '@nestjs/common';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { OrdersAppModule } from './OrdersAppModule.js';


async function bootstrap() {
  const logLevels = (process.env.LOG_LEVELS ?? 'log,warn,error')
    .split(',')
    .map((l) => l.trim()) as LogLevel[];

  const app = await NestFactory.create(OrdersAppModule, {
    logger: logLevels,
  });

  app.enableVersioning({ type: VersioningType.URI });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env.KAFKA_CLIENT_ID_ORDERS,
        brokers: [process.env.KAFKA_BROKERS!],
      },
      consumer: {
        groupId: process.env.KAFKA_GROUP_ID_ORDERS!,
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env.ORDERS_PORT ?? 3000);
}
await bootstrap();
