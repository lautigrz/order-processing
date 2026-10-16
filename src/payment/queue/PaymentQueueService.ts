import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Queue } from 'bullmq';
import { EventPayload, ObjectFailed } from '../types/payment.types.js';

@Injectable()
export class PaymentQueueService implements OnModuleDestroy {
    private readonly logger = new Logger(PaymentQueueService.name);
    private readonly retryQueue: Queue<EventPayload>;
    private readonly refundQueue: Queue<EventPayload>;
    private readonly dlqQueue: Queue<ObjectFailed>;
    private readonly connection: ConnectionOptions;

    constructor(
        @Optional()
        @Inject(ConfigService)
        private readonly configService?: ConfigService,
    ) {
        this.connection = {
            host: this.configService?.get<string>('REDIS_HOST') ?? process.env.REDIS_HOST ?? 'localhost',
            port: Number(this.configService?.get<number>('REDIS_PORT') ?? process.env.REDIS_PORT ?? 6379),
        };

        this.retryQueue = new Queue<EventPayload>('payment-retry', {
            connection: this.connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
            },
        });

        this.refundQueue = new Queue<EventPayload>('payment-refund', {
            connection: this.connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
            },
        });

        this.dlqQueue = new Queue<ObjectFailed>('payment-retry-dlq', {
            connection: this.connection,
        });
    }

    getRedisConnection(): ConnectionOptions {
        return this.connection;
    }

    async enqueuePaymentRetry(data: EventPayload) {
        return this.retryQueue.add('payment-retry', data, {
            jobId: data.eventId,
            removeOnComplete: true,
        });
    }

    async enqueuePaymentRefund(data: EventPayload) {
        return this.refundQueue.add('payment-refund', data, {
            jobId: `refund-${data.eventId}`,
            removeOnComplete: true,
        });
    }

    async enqueuePaymentDLQ(objectFailed: ObjectFailed) {
        return this.dlqQueue.add('failed-payment', objectFailed, {
            jobId: objectFailed.payload.eventId,
        });
    }

    async reprocessPayment(jobId: string) {
        const job = await this.dlqQueue.getJob(jobId);

        if (!job) {
            throw new NotFoundException(`Job with id "${jobId}" not found in payment DLQ`);
        }

        await job.updateData({
            ...job.data,
            reprocessCount: (job.data.reprocessCount ?? 0) + 1,
        });

        await this.enqueuePaymentRetry({
            ...job.data.payload,
            isFromDLQ: true,
        });
    }

    async removeDLQJob(jobId: string): Promise<boolean> {
        const dlqJob = await this.dlqQueue.getJob(jobId);
        if (dlqJob) {
            await dlqJob.remove();
            return true;
        }
        return false;
    }

    async onModuleDestroy() {
        this.logger.log('Closing BullMQ queues...');
        await Promise.allSettled([
            this.retryQueue.close(),
            this.refundQueue.close(),
            this.dlqQueue.close(),
        ]);
    }
}
