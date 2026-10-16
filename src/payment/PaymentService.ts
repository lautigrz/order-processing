import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { PaymentStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "./types/payment.types.js";
import { PaymentQueueService } from "./queue/PaymentQueueService.js";
import { StripeService } from "./stripe/StripeService.js";
import { emitOutboxEvent, isEventProcessed, markEventProcessed } from "./utils/payment.util.js";
import { Prisma } from "../generated/prisma/client.js";
import Stripe from "stripe";

interface LockedPaymentRecord {
    id: number;
    status: PaymentStatus;
    amount: any;
}

@Injectable()
export class PaymentService {
    private readonly logger = new Logger(PaymentService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService,
        @Inject(StripeService)
        private readonly stripeService: StripeService,
        @Inject(PaymentQueueService)
        private readonly paymentQueueService: PaymentQueueService,
    ) { }

    async processPayment(data: EventPayload): Promise<void> {
        this.logger.debug(`Processing payment for event ${data.eventId}`);
        const idempotencyKey = `${data.eventId}:payment`;

        if (await isEventProcessed(this.prisma, idempotencyKey)) {
            this.logger.warn(`Event ${data.eventId} already processed — skipping`);
            return;
        }

        const shouldSkip = await this.shouldSkipPaymentCreation(data, idempotencyKey);
        if (shouldSkip) return;

        const payment = await this.createPendingPaymentRecord(data);

        let session: Stripe.Checkout.Session;
        try {
            session = await this.createStripeCheckoutSession(payment.id, data);
        } catch (error: any) {
            this.logger.error(`[Stripe] Failed to create checkout session for order #${data.orderId}: ${error?.message}`);
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { status: PaymentStatus.FAILED },
            });
            throw error;
        }

        await this.prisma.$transaction(async (tx) => {
            await this.attachSessionToPayment(payment.id, session, tx);
            await markEventProcessed(tx, idempotencyKey);
        });

        this.logger.log(`[Stripe] Checkout Session creada para orden #${data.orderId}: ${session.url}`);
    }

    private async shouldSkipPaymentCreation(data: EventPayload, idempotencyKey: string): Promise<boolean> {
        const existingPayment = await this.prisma.payment.findFirst({
            where: { orderId: data.orderId },
        });

        if (existingPayment?.status === PaymentStatus.REFUNDED || existingPayment?.status === PaymentStatus.PAID) {
            this.logger.warn(`Payment for order ${data.orderId} is already ${existingPayment.status} — skipping charge`);
            await markEventProcessed(this.prisma, idempotencyKey);
            return true;
        }

        if (existingPayment?.checkoutUrl) {
            this.logger.log(`[Stripe] Checkout Session already exists for order ${data.orderId}: ${existingPayment.checkoutUrl}`);
            return true;
        }

        return false;
    }

    private async createPendingPaymentRecord(data: EventPayload) {
        return this.prisma.payment.create({
            data: {
                orderId: data.orderId,
                amount: data.total,
                currency: 'usd',
                status: PaymentStatus.PENDING,
            },
        });
    }

    private async createStripeCheckoutSession(paymentId: number, data: EventPayload): Promise<Stripe.Checkout.Session> {
        return this.stripeService.createCheckoutSession({
            paymentId,
            orderId: data.orderId,
            customerId: data.customerId,
            amount: Math.round(Number(data.total) * 100),
            currency: 'usd',
        });
    }

    private async attachSessionToPayment(
        paymentId: number,
        session: Stripe.Checkout.Session,
        client: Prisma.TransactionClient | PrismaService = this.prisma,
    ): Promise<void> {
        await client.payment.update({
            where: { id: paymentId },
            data: {
                stripeCheckoutSessionId: session.id,
                checkoutUrl: session.url,
            },
        });
    }

    async handleRefundRequest(data: EventPayload): Promise<void> {
        this.logger.log(`Refund requested for order ${data.orderId}`);

        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment-refund-req`;
            if (await isEventProcessed(tx, idempotencyKey)) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const payment = await this.findPaymentForUpdate(tx, data.orderId);
            if (!payment) {
                this.logger.log(`No payment record found for order ${data.orderId} — nothing to refund`);
            } else if (payment.status === PaymentStatus.PAID) {
                await this.applyPaidRefund(tx, payment.id, data.orderId);
            } else if (payment.status === PaymentStatus.PENDING) {
                await this.applyPendingRefund(tx, payment.id, data.orderId);
            }

            await markEventProcessed(tx, idempotencyKey);
        });
    }

    private async findPaymentForUpdate(tx: Prisma.TransactionClient, orderId: number): Promise<LockedPaymentRecord | undefined> {
        const paymentList = await tx.$queryRaw<LockedPaymentRecord[]>`
            SELECT id, status, amount
            FROM "payments"
            WHERE "orderId" = ${orderId}
            FOR UPDATE
        `;
        return paymentList[0];
    }

    private async applyPaidRefund(tx: Prisma.TransactionClient, paymentId: number, orderId: number): Promise<void> {
        this.logger.log(`Payment for order ${orderId} is PAID, enqueuing refund`);
        await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.REFUNDING_PENDING },
        });

        await emitOutboxEvent(tx, 'RefundPending', { orderId });
    }

    private async applyPendingRefund(tx: Prisma.TransactionClient, paymentId: number, orderId: number): Promise<void> {
        this.logger.log(`Payment for order ${orderId} was PENDING, setting REFUNDED`);
        await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.REFUNDED },
        });
    }

    async processRefundPayment(data: EventPayload): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment-refund-proc`;
            if (await isEventProcessed(tx, idempotencyKey)) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const payment = await tx.payment.findFirst({
                where: { orderId: data.orderId },
            });

            if (!payment) {
                this.logger.warn(`Payment for order ${data.orderId} not found for refund`);
                return;
            }

            if (payment.stripePaymentIntentId) {
                await this.executeStripeRefund(payment.stripePaymentIntentId);
            }

            await this.finalizeRefund(tx, payment.id, data.orderId);
            await markEventProcessed(tx, idempotencyKey);
        });
    }

    private async executeStripeRefund(paymentIntentId: string): Promise<void> {
        try {
            await this.stripeService.createRefund({ paymentIntentId });
            this.logger.log(`[Stripe] Refund successful for PaymentIntent ${paymentIntentId}`);
        } catch (stripeErr: any) {
            this.logger.error(`[Stripe] Error creating refund for PaymentIntent ${paymentIntentId}: ${stripeErr?.message}`);
            throw stripeErr;
        }
    }

    private async finalizeRefund(tx: Prisma.TransactionClient, paymentId: number, orderId: number): Promise<void> {
        await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.REFUNDED },
        });

        this.logger.log(`Processing refund payment for order ${orderId}`);
        await emitOutboxEvent(tx, 'PaymentRefunded', { orderId });
    }


    // =========================================================================
    // Queue Enqueue Methods
    // =========================================================================

    async enqueuePaymentProcess(data: EventPayload): Promise<void> {
        this.logger.debug(`Enqueuing event ${data.eventId} for order ${data.orderId}`);
        await this.paymentQueueService.enqueuePaymentRetry(data);
    }

    async refundEnqueue(data: EventPayload): Promise<void> {
        await this.paymentQueueService.enqueuePaymentRefund(data);
    }

    async reprocessEvent(jobId: string): Promise<void> {
        await this.paymentQueueService.reprocessPayment(jobId);
    }
}