import { Controller, Inject, Logger, Param, Post } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import { PaymentService } from "./PaymentService.js";
import type { EventPayload } from "./types/payment.types.js";

@Controller({ path: "/api/payment" })
export class PaymentController {
    private readonly logger = new Logger(PaymentController.name);

    constructor(
        @Inject(PaymentService)
        private readonly paymentService: PaymentService) { }

    @EventPattern("orders")
    async handleOrderCreated(@Payload() data: EventPayload) {
        this.logger.log(`[PaymentController] Received Kafka event ${JSON.stringify(data)}`);
        if (data.event === 'OrderCreated') {
            this.logger.log(`[PaymentController] Received Kafka OrderCreated for order ${data.orderId}`);
            await this.paymentService.enqueuePaymentProcess(data);
        } else if (data.event === 'StockReservationFailed') {
            this.logger.log(`[PaymentController] Received Kafka StockReservationFailed for order ${data.orderId}`);
            await this.paymentService.handleRefundRequest(data);
        } else if (data.event === 'RefundPending') {
            this.logger.log(`[PaymentController] Received Kafka RefundPending for order ${data.orderId}`);
            await this.paymentService.refundEnqueue(data);

        }
    }

    @Post('dlq/:jobId/reprocess')
    async reprocess(@Param('jobId') jobId: string) {
        this.logger.log(`Reprocess request for DLQ job ${jobId}`);
        return this.paymentService.reprocessEvent(jobId);
    }
}