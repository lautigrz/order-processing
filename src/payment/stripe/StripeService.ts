import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { STRIPE_CLIENT } from './client.stripe.js';

@Injectable()
export class StripeService {
    private readonly logger = new Logger(StripeService.name);

    constructor(
        @Inject(STRIPE_CLIENT)
        private readonly stripe: Stripe,
        @Inject(ConfigService)
        private readonly configService: ConfigService,
    ) { }

    async createCheckoutSession(params: {
        paymentId: number;
        orderId: number;
        customerId?: number;
        amount: number;
        currency: string;
    }): Promise<Stripe.Checkout.Session> {
        return this.stripe.checkout.sessions.create(
            {
                mode: 'payment',
                success_url:
                    this.configService?.get<string>('STRIPE_SUCCESS_URL') ??
                    process.env.STRIPE_SUCCESS_URL ??
                    'http://localhost:3000/api/v1/orders/success',
                cancel_url:
                    this.configService?.get<string>('STRIPE_CANCEL_URL') ??
                    process.env.STRIPE_CANCEL_URL ??
                    'http://localhost:3000/api/v1/orders/cancel',
                client_reference_id: String(params.orderId),
                metadata: {
                    paymentId: String(params.paymentId),
                    orderId: String(params.orderId),
                    customerId: String(params.customerId ?? ''),
                },
                payment_intent_data: {
                    metadata: {
                        paymentId: String(params.paymentId),
                        orderId: String(params.orderId),
                        customerId: String(params.customerId ?? ''),
                    },
                },
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency: params.currency,
                            unit_amount: params.amount,
                            product_data: {
                                name: `Order #${params.orderId}`,
                            },
                        },
                    },
                ],
            },
            {
                idempotencyKey: `checkout-session-${params.orderId}-${params.paymentId}-${crypto.randomUUID()}`,
            },
        );
    }

    constructWebhookEvent(
        rawBody: Buffer,
        signature: string,
    ): Stripe.Event {
        const webhookSecret =
            this.configService?.get<string>('STRIPE_WEBHOOK_SECRET') ??
            process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret) {
            throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
        }

        try {
            return this.stripe.webhooks.constructEvent(
                rawBody,
                signature,
                webhookSecret,
            );
        } catch (err: any) {
            this.logger.error(`[Stripe Webhook] Invalid signature: ${err?.message}`);
            throw new BadRequestException(`Invalid Stripe signature: ${err?.message}`);
        }
    }

    async createRefund(params: {
        paymentIntentId: string;
        amount?: number;
    }): Promise<Stripe.Refund> {
        return this.stripe.refunds.create({
            payment_intent: params.paymentIntentId,
            ...(params.amount ? { amount: params.amount } : {}),
        });
    }

    getClient(): Stripe {
        return this.stripe;
    }
}
