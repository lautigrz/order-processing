import { Inject, Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../../prisma/PrismaService.js";
import { PaymentStatus } from "../../generated/prisma/enums.js";
import { StripeService } from "../stripe/StripeService.js";
import { emitOutboxEvent } from "../utils/payment.util.js";
import { Prisma } from "../../generated/prisma/client.js";

@Injectable()
export class PaymentWebhookService {
    private readonly logger = new Logger(PaymentWebhookService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService,
        @Inject(StripeService)
        private readonly stripeService: StripeService,
    ) { }

    async handleWebhook(rawBody: Buffer, signature: string): Promise<{ received: boolean }> {
        const event = this.stripeService.constructWebhookEvent(rawBody, signature);
        this.logger.log(`[Stripe Webhook] Event received: ${event.type}`);

        switch (event.type) {
            case 'checkout.session.completed':
                await this.handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
                break;

            case 'payment_intent.payment_failed':
                await this.handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
                break;

            case 'checkout.session.expired':
            case 'checkout.session.async_payment_failed':
                await this.handleCheckoutSessionFailed(event.data.object as Stripe.Checkout.Session, event.type);
                break;

            default:
                this.logger.debug(`[Stripe Webhook] Unhandled event type: ${event.type}`);
        }

        return { received: true };
    }

    private async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
        const orderId = Number(session.metadata?.orderId ?? session.client_reference_id);
        const paymentId = session.metadata?.paymentId ? Number(session.metadata.paymentId) : undefined;
        const customerId = session.metadata?.customerId ? Number(session.metadata.customerId) : 0;
        const paymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;

        this.logger.log(`[Stripe Webhook] Checkout completed for order #${orderId}`);

        await this.prisma.$transaction(async (tx) => {
            const payment = await this.findPayment(tx, paymentId, orderId);

            if (payment) {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: PaymentStatus.PAID,
                        stripePaymentIntentId: paymentIntentId ?? null,
                    },
                });
            }

            const total = payment?.amount
                ? String(payment.amount)
                : String(session.amount_total ? session.amount_total / 100 : 0);

            await emitOutboxEvent(tx, 'PaymentSucceeded', {
                orderId,
                customerId,
                total,
            });
        });
    }

    private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
        const orderId = Number(paymentIntent.metadata?.orderId);
        const paymentId = paymentIntent.metadata?.paymentId ? Number(paymentIntent.metadata.paymentId) : undefined;
        const customerId = paymentIntent.metadata?.customerId ? Number(paymentIntent.metadata.customerId) : 0;
        const failureReason = paymentIntent.last_payment_error?.message ?? 'Payment attempt failed';
        const declineCode = paymentIntent.last_payment_error?.decline_code ?? paymentIntent.last_payment_error?.code ?? 'card_declined';

        this.logger.warn(`[Stripe Webhook] Payment failed for order #${orderId}. Reason: ${failureReason} (${declineCode})`);

        if (!orderId) return;

        await this.prisma.$transaction(async (tx) => {
            const payment = await this.findPayment(tx, paymentId, orderId);

            if (payment && payment.status !== PaymentStatus.PAID) {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: PaymentStatus.FAILED,
                        stripePaymentIntentId: paymentIntent.id,
                    },
                });
            }

            await emitOutboxEvent(tx, 'PaymentFailed', {
                orderId,
                customerId,
                reason: failureReason,
                code: declineCode,
            });
        });
    }

    private async handleCheckoutSessionFailed(session: Stripe.Checkout.Session, eventType: string): Promise<void> {
        const orderId = Number(session.metadata?.orderId ?? session.client_reference_id);
        const customerId = session.metadata?.customerId ? Number(session.metadata.customerId) : 0;
        const paymentId = session.metadata?.paymentId ? Number(session.metadata.paymentId) : undefined;

        this.logger.warn(`[Stripe Webhook] Checkout session ${eventType} for order #${orderId}`);

        if (!orderId) return;

        await this.prisma.$transaction(async (tx) => {
            const payment = await this.findPayment(tx, paymentId, orderId);

            if (payment && payment.status === PaymentStatus.PENDING) {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: { status: PaymentStatus.FAILED },
                });

                await emitOutboxEvent(tx, 'PaymentFailed', {
                    orderId,
                    customerId,
                    reason: eventType === 'checkout.session.expired'
                        ? 'Checkout session expired'
                        : 'Async payment failed',
                    code: eventType,
                });
            }
        });
    }

    private async findPayment(tx: Prisma.TransactionClient, paymentId?: number, orderId?: number) {
        if (paymentId) {
            return tx.payment.findUnique({ where: { id: paymentId } });
        }
        if (orderId) {
            return tx.payment.findFirst({ where: { orderId } });
        }
        return null;
    }
}
