import { LogLevel, VersioningType } from '@nestjs/common';
import 'dotenv/config';
import { AppModule } from './app.module.js';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestFactory } from '@nestjs/core';

async function bootstrap() {
  const logLevels = (process.env.LOG_LEVELS ?? 'log,warn,error')
    .split(',')
    .map((l) => l.trim()) as LogLevel[];

  const app = await NestFactory.create(AppModule, {
    logger: logLevels,
  });

  app.enableVersioning({ type: VersioningType.URI });

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
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
