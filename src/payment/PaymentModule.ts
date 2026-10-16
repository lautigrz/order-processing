import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PaymentController } from "./PaymentController.js";
import { PaymentService } from "./PaymentService.js";
import { PaymentWebhookService } from "./webhook/PaymentWebhookService.js";
import { PrismaModule } from "../prisma/PrismaModule.js";
import { PaymentQueueService } from "./queue/PaymentQueueService.js";
import { PaymentWorker } from "./worker/PaymentWorker.js";
import { STRIPE_CLIENT, createStripeClient } from "./stripe/client.stripe.js";
import { StripeService } from "./stripe/StripeService.js";

@Module({
    imports: [PrismaModule, ConfigModule],
    controllers: [PaymentController],
    providers: [
        PaymentQueueService,
        {
            provide: STRIPE_CLIENT,
            useFactory: (configService: ConfigService) => createStripeClient(configService),
            inject: [ConfigService],
        },
        StripeService,
        PaymentWebhookService,
        PaymentService,
        PaymentWorker,
    ],
    exports: [PaymentService, PaymentWebhookService, PaymentQueueService],
})
export class PaymentModule { }