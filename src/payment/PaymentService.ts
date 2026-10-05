import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { Status as OrderStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "./types/payment.types.js";
import { enqueuePaymentRetry, reprocessPayment } from "./queue/payment.queue.js";

@Injectable()
export class PaymentService {
    private readonly logger = new Logger(PaymentService.name);

    constructor(private prisma: PrismaService) { }

    async processPayment(data: EventPayload) {
        this.logger.debug(`Processing payment for event ${data.eventId}`);

        await this.prisma.$transaction(async (tx) => {
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: data.eventId },
            });
            if (processExist) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const order = await tx.order.findUnique({
                where: { id: data.orderId },
            });
            if (!order) {
                throw new NotFoundException(`Order with id ${data.orderId} not found`);
            }

            if (order.status !== OrderStatus.PENDING) {
                throw new BadRequestException(`Order ${data.orderId} is not in PENDING state (current: ${order.status})`);
            }

            await tx.order.update({
                where: { id: data.orderId },
                data: { status: OrderStatus.PAYMENT_PROCESSING },
            });

            await tx.processedEvent.create({
                data: {
                    eventId: data.eventId,
                    topic: 'orders',
                },
            });

            this.logger.debug(`Order ${data.orderId} transitioned to PAYMENT_PROCESSING`);
        });
    }

    async enqueueOrderCreated(data: EventPayload) {
        this.logger.debug(`Enqueuing event ${data.eventId} for order ${data.orderId}`);
        await enqueuePaymentRetry(data);
    }

    async reprocessEvent(jobId: string) {
        this.logger.log(`Reprocessing DLQ job ${jobId}`);
        await reprocessPayment(jobId);
    }
}