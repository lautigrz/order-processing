import { LogLevel, VersioningType } from '@nestjs/common';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { InventoryAppModule } from './InventoryAppModule.js';


async function bootstrap() {
    const logLevels = (process.env.LOG_LEVELS ?? 'log,warn,error')
        .split(',')
        .map((l) => l.trim()) as LogLevel[];

    const app = await NestFactory.create(InventoryAppModule, {
        logger: logLevels,
    });

    app.enableVersioning({ type: VersioningType.URI });

    app.connectMicroservice<MicroserviceOptions>({
        transport: Transport.KAFKA,
        options: {
            client: {
                clientId: process.env.KAFKA_CLIENT_ID_INVENTORY,
                brokers: [process.env.KAFKA_BROKERS!],
            },
            consumer: {
                groupId: process.env.KAFKA_GROUP_ID_INVENTORY!,
                allowAutoTopicCreation: false,
            },
        },
    });

    await app.startAllMicroservices();
    await app.listen(process.env.INVENTORY_PORT ?? 3002);
}
await bootstrap();
