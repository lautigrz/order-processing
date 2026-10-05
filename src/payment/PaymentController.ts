import { Controller, Logger, Param, Post } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import { PaymentService } from "./PaymentService.js";
import type { EventPayload } from "./types/payment.types.js";

@Controller({ path: "/api/payment" })
export class PaymentController {
    private readonly logger = new Logger(PaymentController.name);

    constructor(private readonly paymentService: PaymentService) { }

    @EventPattern("orders")
    async handleOrderCreated(@Payload() data: EventPayload) {
        this.logger.debug(`Received Kafka event ${data.eventId} for order ${data.orderId}`);
        await this.paymentService.enqueueOrderCreated(data);
    }

    @Post('dlq/:jobId/reprocess')
    async reprocess(@Param('jobId') jobId: string) {
        this.logger.log(`Reprocess request for DLQ job ${jobId}`);
        return this.paymentService.reprocessEvent(jobId);
    }
}