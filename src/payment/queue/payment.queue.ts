import 'dotenv/config';
import { Queue } from 'bullmq';
import { EventPayload, ObjectFailed } from '../types/payment.types.js';

const redisConnection = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
};

export const queueJob = new Queue<EventPayload>('payment-retry', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
    },
});

export const dqueue = new Queue<ObjectFailed>('payment-retry-dlq', {
    connection: redisConnection,
});

export async function enqueuePaymentRetry(data: EventPayload) {
    const job = await queueJob.add('payment-retry', data);
    return job;
}

export async function enqueuePaymentDLQ(objectFailed: ObjectFailed) {
    const job = await dqueue.add('failed-payment', objectFailed, {
        jobId: objectFailed.payload.eventId,
    });
    return job;
}

export async function reprocessPayment(jobId: string) {
    const job = await dqueue.getJob(jobId);

    if (!job) {
        throw new Error(`Job with id ${jobId} not found`);
    }

    await job.updateData({
        ...job.data,
        reprocessCount: (job.data.reprocessCount ?? 0) + 1,
    });

    await enqueuePaymentRetry({
        ...job.data.payload,
        isFromDLQ: true,
    });
}
