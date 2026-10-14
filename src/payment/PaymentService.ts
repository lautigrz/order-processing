import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { PaymentStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "./types/payment.types.js";
import { enqueuePaymentRefund, enqueuePaymentRetry, reprocessPayment } from "./queue/payment.queue.js";
import { StripeService } from "./stripe/StripeService.js";
import Stripe from "stripe";

@Injectable()
export class PaymentService {
    private readonly logger = new Logger(PaymentService.name);

    constructor(
        @Inject(PrismaService)
        private prisma: PrismaService,
        @Inject(StripeService)
        private stripeService: StripeService,
    ) { }

    async processPayment(data: EventPayload) {
        this.logger.debug(`Processing payment for event ${data.eventId}`);

        const idempotencyKey = `${data.eventId}:payment`;

        // 1. Verificar idempotencia de evento
        const processExist = await this.prisma.processedEvent.findUnique({
            where: { eventId: idempotencyKey },
        });
        if (processExist) {
            this.logger.warn(`Event ${data.eventId} already processed — skipping`);
            return;
        }

        // 2. Verificar estado en el dominio propio de Payments (sin consultar tabla orders)
        const existingPayment = await this.prisma.payment.findFirst({
            where: { orderId: data.orderId },
        });

        if (existingPayment?.status === PaymentStatus.REFUNDED || existingPayment?.status === PaymentStatus.PAID) {
            this.logger.warn(`Payment for order ${data.orderId} is already ${existingPayment.status} — skipping charge`);
            await this.prisma.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });
            return;
        }

        if (existingPayment?.checkoutUrl) {
            this.logger.log(`[Stripe] Checkout Session already exists for order ${data.orderId}: ${existingPayment.checkoutUrl}`);
            return;
        }

        // Simular error de pasarela (para testing de reintentos BullMQ y DLQ)
        const simulateGatewayError = false;
        if (simulateGatewayError) {
            this.logger.error(`Error connecting to Payment Gateway (Timeout)`);
            throw new Error("Payment Gateway Timeout (504)");
        }

        // 3. Crear registro Payment PENDING usando datos que viajaron en el evento (Event-Carried State Transfer)
        const payment = await this.prisma.payment.create({
            data: {
                orderId: data.orderId,
                amount: data.total,
                currency: 'usd',
                status: PaymentStatus.PENDING,
            },
        });

        // 4. Crear Stripe Checkout Session
        const session = await this.stripeService.createCheckoutSession({
            paymentId: payment.id,
            orderId: data.orderId,
            customerId: data.customerId,
            amount: Math.round(Number(data.total) * 100),
            currency: 'usd',
        });

        // 5. Guardar la URL y session ID en el pago
        await this.prisma.payment.update({
            where: { id: payment.id },
            data: {
                stripeCheckoutSessionId: session.id,
                checkoutUrl: session.url,
            },
        });

        // 6. Registrar evento como procesado en la tabla de idempotencia
        try {
            await this.prisma.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });
        } catch (err: any) {
            if (err?.code !== 'P2002') {
                throw err;
            }
        }

        this.logger.log(`\n========================================================================\n💳 [Stripe] Checkout Session creada para orden #${data.orderId}!\n👉 URL de pago: ${session.url}\n========================================================================\n`);
    }

    async handleRefundRequest(data: EventPayload) {
        this.logger.log(`Refund requested for order ${data.orderId}`);
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment-refund-req`;
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: idempotencyKey },
            });
            if (processExist) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            // Consultar exclusivamente la tabla de pagos con lock
            const paymentList = await tx.$queryRaw<{ id: number; status: PaymentStatus; amount: any }[]>`
                SELECT id, status, amount
                FROM "payments"
                WHERE "orderId" = ${data.orderId}
                FOR UPDATE
            `;
            const payment = paymentList[0];

            if (!payment) {
                this.logger.log(`No payment record found for order ${data.orderId} — nothing to refund`);
            } else if (payment.status === PaymentStatus.PAID) {
                this.logger.log(`Payment for order ${data.orderId} is PAID, enqueuing refund`);
                await tx.payment.update({
                    where: { id: payment.id },
                    data: { status: PaymentStatus.REFUNDING_PENDING },
                });
                await tx.outboxEvent.create({
                    data: {
                        eventId: crypto.randomUUID(),
                        eventType: 'RefundPending',
                        topic: 'orders',
                        payload: {
                            orderId: data.orderId,
                        },
                    },
                });
            } else if (payment.status === PaymentStatus.PENDING) {
                this.logger.log(`Payment for order ${data.orderId} was PENDING, setting REFUNDED`);
                await tx.payment.update({
                    where: { id: payment.id },
                    data: { status: PaymentStatus.REFUNDED },
                });
            }

            await tx.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });
        });
    }

    async processRefundPayment(data: EventPayload) {
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment-refund-proc`;
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: idempotencyKey },
            });

            if (processExist) {
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
                try {
                    await this.stripeService.createRefund({
                        paymentIntentId: payment.stripePaymentIntentId,
                    });
                    this.logger.log(`[Stripe] Refund successful for PaymentIntent ${payment.stripePaymentIntentId}`);
                } catch (stripeErr: any) {
                    this.logger.warn(`[Stripe] Warning creating refund: ${stripeErr?.message}`);
                }
            }

            await tx.payment.update({
                where: { id: payment.id },
                data: { status: PaymentStatus.REFUNDED },
            });

            this.logger.log(`Processing refund payment for order ${data.orderId}`);

            // Emitir evento PaymentRefunded para que OrdersService actualice su orden
            await tx.outboxEvent.create({
                data: {
                    eventId: crypto.randomUUID(),
                    eventType: 'PaymentRefunded',
                    topic: 'orders',
                    payload: {
                        orderId: data.orderId,
                    },
                },
            });

            await tx.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });
        });
    }

    async handleWebhook(rawBody: Buffer, signature: string) {
        const event = this.stripeService.constructWebhookEvent(rawBody, signature);
        this.logger.log(`[Stripe Webhook] Event received: ${event.type}`);

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object as Stripe.Checkout.Session;
            const orderId = Number(session.metadata?.orderId ?? session.client_reference_id);
            const paymentId = session.metadata?.paymentId ? Number(session.metadata.paymentId) : undefined;
            const customerId = session.metadata?.customerId ? Number(session.metadata.customerId) : 0;
            const paymentIntentId = typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id;

            this.logger.log(`[Stripe Webhook] Checkout completed for order ${orderId}`);

            await this.prisma.$transaction(async (tx) => {
                const payment = paymentId
                    ? await tx.payment.findUnique({ where: { id: paymentId } })
                    : await tx.payment.findFirst({ where: { orderId } });

                if (payment) {
                    await tx.payment.update({
                        where: { id: payment.id },
                        data: {
                            status: PaymentStatus.PAID,
                            stripePaymentIntentId: paymentIntentId ?? null,
                        },
                    });
                }
                await tx.outboxEvent.create({
                    data: {
                        eventId: crypto.randomUUID(),
                        eventType: 'PaymentSucceeded',
                        topic: 'orders',
                        payload: {
                            orderId,
                            customerId,
                            total: payment?.amount ? String(payment.amount) : String(session.amount_total ? session.amount_total / 100 : 0),
                        },
                    },
                });
            });
        }

        return { received: true };
    }

    async refundEnqueue(data: EventPayload) {
        await enqueuePaymentRefund(data);
    }

    async enqueuePaymentProcess(data: EventPayload) {
        this.logger.debug(`Enqueuing event ${data.eventId} for order ${data.orderId}`);
        await enqueuePaymentRetry(data);
    }

    async reprocessEvent(jobId: string) {
        await reprocessPayment(jobId);
    }
}