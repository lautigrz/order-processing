
import { Module } from "@nestjs/common";
import { PaymentController } from "./PaymentController.js";
import { PaymentService } from "./PaymentService.js";
import { PrismaModule } from "../prisma/PrismaModule.js";
import { dqueue, queueJob } from "./queue/payment.queue.js";
import { PaymentWorker } from "./worker/PaymentWorker.js";

@Module({
    controllers: [PaymentController],
    providers: [
        PaymentService,
        { provide: 'PAYMENT_QUEUE', useValue: queueJob },
        { provide: 'PAYMENT_DLQ', useValue: dqueue },
        PaymentWorker,

    ],
    imports: [PrismaModule]
})
export class PaymentModule { }