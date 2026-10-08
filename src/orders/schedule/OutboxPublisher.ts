import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/PrismaService.js";
import { ClientKafka } from "@nestjs/microservices";
import { lastValueFrom } from "rxjs";

type OrderCreatedPayload = {
    orderId: number;
    customerId: number;
    total: string;
};

type PendingOutboxEvent = {
    id: number;
    eventId: string;
    eventType: string;
    topic: string;
    payload: OrderCreatedPayload;
    publishedAt: Date | null;
};

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_TICK = 10;

@Injectable()
export class OutboxPublisher {
    private readonly logger = new Logger(OutboxPublisher.name);
    private isProcessing = false;

    constructor(
        @Inject(PrismaService) private readonly prisma: PrismaService,
        @Inject('KAFKA_SERVICE') private readonly kafka: ClientKafka,
    ) { }

    @Cron('*/2 * * * * *')
    async publishPendingEvents() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            let totalPublished = 0;
            for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
                const batchCount = await this.processBatch();
                if (batchCount === 0) break;
                totalPublished += batchCount;


                if (batchCount < BATCH_SIZE) break;
            }

            if (totalPublished > 0) {
                this.logger.log(`Outbox cycle finished: published ${totalPublished} event(s) to Kafka`);
            }
        } catch (error: any) {
            this.logger.error(`Error processing outbox events: ${error?.message ?? error}`, error?.stack);
        } finally {
            this.isProcessing = false;
        }
    }

    private async processBatch(): Promise<number> {
        return await this.prisma.$transaction(async (tx) => {
            const events = await tx.$queryRaw<PendingOutboxEvent[]>`
                SELECT *
                FROM "outboxEvents"
                WHERE "publishedAt" IS NULL
                ORDER BY id
                LIMIT 100
                FOR UPDATE SKIP LOCKED
            `;

            if (events.length === 0) return 0;

            await Promise.all(
                events.map((event) =>
                    lastValueFrom(
                        this.kafka.emit(event.topic, {
                            key: event.payload.orderId.toString(),
                            value: {
                                eventId: event.eventId,
                                event: event.eventType,
                                orderId: event.payload.orderId,
                                customerId: event.payload.customerId,
                                total: event.payload.total,
                            },
                        }),
                    ),
                ),
            );

            const ids = events.map((e) => e.id);
            await tx.outboxEvent.updateMany({
                where: { id: { in: ids } },
                data: { publishedAt: new Date() },
            });

            return events.length;
        });
    }
}