import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

export function createStripeClient(configService: ConfigService): Stripe {
    const secretKey =
        configService?.get<string>('STRIPE_SECRET_KEY') ??
        process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY is not configured');
    }

    return new Stripe(secretKey, {
        timeout: 10000,
        maxNetworkRetries: 2,
    });
}