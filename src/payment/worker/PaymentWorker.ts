import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Worker } from "bullmq";
import { PaymentService } from "../PaymentService.js";
import { dqueue, enqueuePaymentDLQ } from "../queue/payment.queue.js";
import { ObjectFailed } from "../types/payment.types.js";

@Injectable()
export class PaymentWorker implements OnModuleDestroy {
    private readonly logger = new Logger(PaymentWorker.name);
    private paymentWorker: Worker;
    private refundWorker: Worker;

    constructor(
        @Inject(PaymentService)
        private readonly paymentService: PaymentService) {
        this.paymentWorker = new Worker('payment-retry', async (job) => {
            this.logger.debug(`Processing job ${job.id} — event ${job.data.eventId}`);
            await this.paymentService.processPayment(job.data);
        }, {
            connection: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
            },
            concurrency: 10,
            lockDuration: 60000
        });

        this.refundWorker = new Worker('payment-refund', async (job) => {
            this.logger.debug(`Processing job ${job.id} — event ${job.data.eventId}`);
            await this.paymentService.processRefundPayment(job.data);
        }, {
            connection: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
            },
            concurrency: 10,
            lockDuration: 60000
        });




        this.paymentWorker.on('failed', async (job, err) => {
            this.logger.warn(`Job ${job?.id} failed — attempt ${job?.attemptsMade}/${job?.opts.attempts}: ${err.message}`);

            if (job?.attemptsMade! >= job?.opts.attempts!) {
                if (!job) return;

                const objectFailed: ObjectFailed = {
                    jobId: job.id!,
                    payload: job.data,
                    failedReason: job.failedReason!,
                    stacktrace: job.stacktrace!,
                    attemptsMade: job.attemptsMade!,
                    attempts: job.opts.attempts!,
                    timestamp: job.timestamp!,
                    reprocessCount: 0,
                };

                await enqueuePaymentDLQ(objectFailed);
                this.logger.error(`Job ${job.id} exhausted all retries — moved to DLQ`);
            }
        });

        this.paymentWorker.on('completed', async (job) => {
            this.logger.debug(`Job ${job.id} completed`);

            if (job.data.isFromDLQ) {
                const dlqJob = await dqueue.getJob(job.data.eventId);
                if (dlqJob) {
                    await dlqJob.remove();
                    this.logger.log(`Job ${job.id} successfully removed from DLQ`);
                }
            }
        });
    }

    async onModuleDestroy() {
        this.logger.log('Closing worker...');
        await this.refundWorker.close();
        await this.paymentWorker.close();
    }
}