import { BadRequestException, Controller, Headers, Inject, Logger, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import { PaymentService } from "./PaymentService.js";
import { PaymentWebhookService } from "./webhook/PaymentWebhookService.js";
import type { EventPayload } from "./types/payment.types.js";
import type { Request } from "express";

@Controller({ path: "/api/payment" })
export class PaymentController {
    private readonly logger = new Logger(PaymentController.name);

    private readonly eventHandlers: Record<string, (data: EventPayload) => Promise<void>> = {
        'StockReserved': (data) => this.paymentService.enqueuePaymentProcess(data),
        'StockReservationFailed': (data) => this.paymentService.handleRefundRequest(data),
        'RefundPending': (data) => this.paymentService.refundEnqueue(data),
    };

    constructor(
        @Inject(PaymentService)
        private readonly paymentService: PaymentService,
        @Inject(PaymentWebhookService)
        private readonly webhookService: PaymentWebhookService,
    ) { }

    @EventPattern("orders")
    async handleOrderEvents(@Payload() data: EventPayload) {
        this.logger.log(`[PaymentController] Received Kafka event "${data?.event}" for order ${data?.orderId}`);

        const handler = this.eventHandlers[data?.event];
        if (handler) {
            await handler(data);
        } else {
            this.logger.debug(`[PaymentController] No handler registered for event "${data?.event}" — skipping`);
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
        return this.webhookService.handleWebhook(req.rawBody, signature);
    }

    @Post('dlq/:jobId/reprocess')
    async reprocess(@Param('jobId') jobId: string) {
        this.logger.log(`Reprocess request for DLQ job ${jobId}`);
        return this.paymentService.reprocessEvent(jobId);
    }
}