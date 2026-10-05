import { Module } from "@nestjs/common";
import { OrdersController } from "./OrdersController.js";
import { OrdersService } from "./OrdersService.js";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { OutboxPublisher } from "./schedule/OutboxPublisher.js";
import { ConfigService } from "@nestjs/config";

@Module({
    imports: [ClientsModule.registerAsync([
        {
            name: 'KAFKA_SERVICE',
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                transport: Transport.KAFKA,
                options: {
                    client: {
                        clientId: config.get('KAFKA_CLIENT_ID_ORDERS'),
                        brokers: [config.get<string>('KAFKA_BROKERS')!],
                    },
                    producer: {
                        allowAutoTopicCreation: true,
                    },
                },
            }),
        },
    ])],
    controllers: [OrdersController],
    providers: [OrdersService, OutboxPublisher],
})
export class OrdersModule { }