import { BadRequestException, Controller, Headers, Inject, Logger, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import { PaymentService } from "./PaymentService.js";
import type { EventPayload } from "./types/payment.types.js";
import type { Request } from "express";

@Controller({ path: "/api/payment" })
export class PaymentController {
    private readonly logger = new Logger(PaymentController.name);

    constructor(
        @Inject(PaymentService)
        private readonly paymentService: PaymentService) { }

    @EventPattern("orders")
    async handleOrderEvents(@Payload() data: EventPayload) {
        this.logger.log(`[PaymentController] Received Kafka event ${JSON.stringify(data)}`);
        if (data.event === 'StockReserved') {
            this.logger.log(`[PaymentController] Received Kafka StockReserved for order ${data.orderId} — proceeding to payment`);
            await this.paymentService.enqueuePaymentProcess(data);
        } else if (data.event === 'StockReservationFailed') {
            this.logger.log(`[PaymentController] Received Kafka StockReservationFailed for order ${data.orderId}`);
            await this.paymentService.handleRefundRequest(data);
        } else if (data.event === 'RefundPending') {
            this.logger.log(`[PaymentController] Received Kafka RefundPending for order ${data.orderId}`);
            await this.paymentService.refundEnqueue(data);
        }
    }

    @Post('webhook')
    async handleWebhook(
        @Req() req: RawBodyRequest<Request>,
        @Headers('stripe-signature') signature: string,
    ) {
        if (!req.rawBody) {
            throw new BadRequestException('Raw body is missing for Stripe webhook');
        }
        if (!signature) {
            throw new BadRequestException('Stripe signature header is missing');
        }
        return this.paymentService.handleWebhook(req.rawBody, signature);
    }

    @Post('dlq/:jobId/reprocess')
    async reprocess(@Param('jobId') jobId: string) {
        this.logger.log(`Reprocess request for DLQ job ${jobId}`);
        return this.paymentService.reprocessEvent(jobId);
    }
}