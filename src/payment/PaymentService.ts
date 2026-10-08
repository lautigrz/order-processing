import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { Status as OrderStatus, PaymentStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "./types/payment.types.js";
import { enqueuePaymentRefund, enqueuePaymentRetry, reprocessPayment } from "./queue/payment.queue.js";

@Injectable()
export class PaymentService {
    private readonly logger = new Logger(PaymentService.name);

    constructor(
        @Inject(PrismaService)
        private prisma: PrismaService) { }

    async processPayment(data: EventPayload) {
        this.logger.debug(`Processing payment for event ${data.eventId}`);

        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment`;
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: idempotencyKey },
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

            // Si la orden ya fue cancelada o ya se solicitó reembolso antes de cobrar, no cobrar
            if (order.status === OrderStatus.CANCELLED || order.paymentStatus === PaymentStatus.REFUNDING_PENDING || order.paymentStatus === PaymentStatus.REFUNDED) {
                this.logger.warn(`Order ${data.orderId} is ${order.status}/${order.paymentStatus} — skipping charge`);
                await tx.order.update({
                    where: { id: data.orderId },
                    data: { paymentStatus: PaymentStatus.REFUNDED },
                });
                await tx.processedEvent.create({
                    data: {
                        eventId: idempotencyKey,
                        topic: 'orders',
                    },
                });
                return;
            }

            const simulateGatewayError = false;
            if (simulateGatewayError) {
                this.logger.error(`Error connecting to Payment Gateway (Timeout)`);
                throw new Error("Payment Gateway Timeout (504)");
            }

            const paymentSuccesful = true;

            if (!paymentSuccesful) {
                await tx.order.update({
                    where: { id: data.orderId },
                    data: {
                        status: OrderStatus.FAILED,
                        paymentStatus: PaymentStatus.FAILED,
                    },
                });
                await tx.outboxEvent.create({
                    data: {
                        eventId: crypto.randomUUID(),
                        eventType: 'PaymentFailed',
                        topic: 'orders',
                        payload: {
                            orderId: data.orderId,
                            customerId: order.customerId,
                            total: order.total,
                        },
                    },
                });
                await tx.processedEvent.create({
                    data: {
                        eventId: idempotencyKey,
                        topic: 'orders',
                    },
                });
                return;
            }

            await tx.order.update({
                where: { id: data.orderId },
                data: {
                    status: OrderStatus.PAYMENT_PROCESSING,
                    paymentStatus: PaymentStatus.PAID,
                },
            });

            await tx.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });

            await tx.outboxEvent.create({
                data: {
                    eventId: crypto.randomUUID(),
                    eventType: 'PaymentSucceeded',
                    topic: 'orders',
                    payload: {
                        orderId: data.orderId,
                        customerId: order.customerId,
                        total: order.total,
                    },
                },
            });

            this.logger.debug(`Order ${data.orderId} transitioned to PAID`);
        });
    }


    async handleRefundRequest(data: EventPayload) {
        this.logger.log(`Refund payment for order ${data.orderId}`);
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:payment-refund-req`;
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: idempotencyKey },
            });
            if (processExist) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const order = await tx.$queryRaw<{ paymentStatus: PaymentStatus; status: OrderStatus }[]>`
                SELECT "paymentStatus", "status"
                FROM "orders"
                WHERE id = ${data.orderId}
                FOR UPDATE
                `;
            if (!order[0]) {
                throw new NotFoundException(`Order with id ${data.orderId} not found`);
            }

            this.logger.log(`[handleRefundRequest] Order ${data.orderId} status: ${order[0].paymentStatus}`);

            if (order[0].paymentStatus === PaymentStatus.PAID) {
                this.logger.log(`Order ${data.orderId} already paid, triggering refund`);
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
            }

            else if (order[0].paymentStatus === PaymentStatus.PENDING || order[0].paymentStatus === PaymentStatus.REFUNDING_PENDING) {
                this.logger.log(`Order ${data.orderId} not paid yet, setting REFUNDED directly`);
                await tx.order.update({
                    where: { id: data.orderId },
                    data: { paymentStatus: PaymentStatus.REFUNDED },
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

            const order = await tx.order.findUnique({
                where: { id: data.orderId },
            });
            if (!order) {
                throw new NotFoundException(`Order with id ${data.orderId} not found`);
            }

            await tx.order.update({
                where: { id: data.orderId },
                data: { paymentStatus: PaymentStatus.REFUNDED },
            });

            this.logger.log(`Processing refund payment for order ${data.orderId}`);

            await tx.processedEvent.create({
                data: {
                    eventId: idempotencyKey,
                    topic: 'orders',
                },
            });
        });
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