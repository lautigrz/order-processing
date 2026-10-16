import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Worker } from "bullmq";
import { PaymentService } from "../PaymentService.js";
import { PaymentQueueService } from "../queue/PaymentQueueService.js";
import { ObjectFailed } from "../types/payment.types.js";

@Injectable()
export class PaymentWorker implements OnModuleDestroy {
    private readonly logger = new Logger(PaymentWorker.name);
    private readonly paymentWorker: Worker;
    private readonly refundWorker: Worker;

    constructor(
        @Inject(PaymentService)
        private readonly paymentService: PaymentService,
        @Inject(PaymentQueueService)
        private readonly paymentQueueService: PaymentQueueService,
    ) {
        const redisConnection = this.paymentQueueService.getRedisConnection();

        this.paymentWorker = new Worker('payment-retry', async (job) => {
            this.logger.debug(`Processing payment-retry job ${job.id} — event ${job.data.eventId}`);
            await this.paymentService.processPayment(job.data);
        }, {
            connection: redisConnection,
            concurrency: 10,
            lockDuration: 60000,
        });

        this.refundWorker = new Worker('payment-refund', async (job) => {
            this.logger.debug(`Processing payment-refund job ${job.id} — event ${job.data.eventId}`);
            await this.paymentService.processRefundPayment(job.data);
        }, {
            connection: redisConnection,
            concurrency: 10,
            lockDuration: 60000,
        });

        this.registerWorkerListeners(this.paymentWorker, 'payment-retry');
        this.registerWorkerListeners(this.refundWorker, 'payment-refund');
    }

    private registerWorkerListeners(worker: Worker, queueName: string) {
        worker.on('failed', async (job, err) => {
            this.logger.warn(`[${queueName}] Job ${job?.id} failed — attempt ${job?.attemptsMade}/${job?.opts?.attempts}: ${err?.message}`);

            if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
                const objectFailed: ObjectFailed = {
                    jobId: job.id ?? '',
                    payload: job.data,
                    failedReason: job.failedReason ?? err?.message ?? 'Unknown reason',
                    stacktrace: job.stacktrace ?? [],
                    attemptsMade: job.attemptsMade,
                    attempts: job.opts?.attempts ?? 0,
                    timestamp: job.timestamp ?? Date.now(),
                    reprocessCount: 0,
                };

                try {
                    await this.paymentQueueService.enqueuePaymentDLQ(objectFailed);
                    this.logger.error(`[${queueName}] Job ${job.id} exhausted all retries — moved to DLQ`);
                } catch (dlqErr: any) {
                    this.logger.error(`[${queueName}] Failed to send job ${job.id} to DLQ: ${dlqErr?.message}`);
                }
            }
        });

        worker.on('completed', async (job) => {
            this.logger.debug(`[${queueName}] Job ${job.id} completed successfully`);

            if (job.data?.isFromDLQ && job.data?.eventId) {
                try {
                    const removed = await this.paymentQueueService.removeDLQJob(job.data.eventId);
                    if (removed) {
                        this.logger.log(`[${queueName}] Reprocessed job ${job.id} successfully removed from DLQ`);
                    }
                } catch (err: any) {
                    this.logger.error(`[${queueName}] Failed to remove reprocessed job ${job.id} from DLQ: ${err?.message}`);
                }
            }
        });
    }

    async onModuleDestroy() {
        this.logger.log('Closing BullMQ workers...');
        await Promise.allSettled([
            this.refundWorker.close(),
            this.paymentWorker.close(),
        ]);
    }
}