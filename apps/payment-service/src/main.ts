import { LogLevel } from '@nestjs/common';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PaymentAppModule } from './PaymentAppModule.js';


async function bootstrap() {
  const logLevels = (process.env.LOG_LEVELS ?? 'log,warn,error')
    .split(',')
    .map((l) => l.trim()) as LogLevel[];

  const app = await NestFactory.create(PaymentAppModule, {
    logger: logLevels,
  });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: process.env.KAFKA_CLIENT_ID_PAYMENT,
        brokers: [process.env.KAFKA_BROKERS!],
      },
      consumer: {
        groupId: process.env.KAFKA_GROUP_ID_PAYMENT!,
        allowAutoTopicCreation: false,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(process.env.PAYMENT_PORT ?? 3001);
}
await bootstrap();
