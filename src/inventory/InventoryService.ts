import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { ReservationStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "../payment/types/payment.types.js";

@Injectable()
export class InventoryService {
    private readonly logger = new Logger(InventoryService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService) { }

    async deductStock(data: EventPayload) {

        await this.prisma.$transaction(
            async (tx) => {

                const idempotencyKey = `${data.eventId}:inventory`;
                const processExist = await tx.processedEvent.findUnique({
                    where: { eventId: idempotencyKey },
                });
                if (processExist) {
                    this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                    return;
                }

                const orderItems = await tx.orderItem.findMany({
                    where: {
                        orderId: data.orderId
                    }, select: {
                        productId: true,
                        quantity: true
                    }
                });

                const products = await tx.product.findMany({
                    where: {
                        id: {
                            in: orderItems.map(item => item.productId)
                        }
                    }, select: {
                        id: true,
                        stock: true
                    }
                });

                const productMap = new Map(products.map(p => [p.id, p]));

                const itemWithoutStock = orderItems.find(item => {
                    const product = productMap.get(item.productId);
                    return !product || product.stock < item.quantity;
                });
                if (itemWithoutStock) {
                    await tx.outboxEvent.create({
                        data: {
                            eventId: crypto.randomUUID(),
                            eventType: 'StockReservationFailed',
                            topic: 'orders',
                            payload: { orderId: data.orderId, productId: itemWithoutStock.productId, reason: 'Insufficient stock' }
                        }
                    });
                    await tx.processedEvent.create({ data: { eventId: idempotencyKey, topic: 'orders' } });
                    return;
                }

                for (const item of orderItems) {
                    await tx.product.update({
                        where: {
                            id: item.productId,
                        },
                        data: {
                            stock: {
                                decrement: item.quantity,
                            },
                        },
                    });

                    await tx.stockReservation.create({
                        data: {
                            orderId: data.orderId,
                            productId: item.productId,
                            quantity: item.quantity,
                            status: ReservationStatus.RESERVED
                        }
                    })


                }

                await tx.processedEvent.create({
                    data: {
                        eventId: idempotencyKey,
                        topic: 'orders',
                    },
                });

                await tx.outboxEvent.create({
                    data: {
                        eventId: crypto.randomUUID(),
                        eventType: 'StockReserved',
                        topic: 'orders',
                        payload: {
                            orderId: data.orderId,
                        },
                    }
                })


            }
        )

    }

    async refundStock(data: EventPayload) {
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:inventory-refund`;
            const processExist = await tx.processedEvent.findUnique({
                where: { eventId: idempotencyKey },
            });
            if (processExist) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const orderItems = await tx.orderItem.findMany({
                where: {
                    orderId: data.orderId
                },
                select: {
                    productId: true,
                    quantity: true
                }
            });

            for (const item of orderItems) {

                const reservation = await tx.stockReservation.findUnique({
                    where: {
                        orderId_productId: {
                            orderId: data.orderId,
                            productId: item.productId
                        }
                    }
                });

                if (!reservation) {
                    throw new NotFoundException(`Reservation for order ${data.orderId} and product ${item.productId} not found`);
                }
                if (reservation.status === ReservationStatus.RELEASED) {
                    continue;
                }

                await tx.product.update({
                    where: {
                        id: item.productId
                    },
                    data: {
                        stock: {
                            increment: reservation.quantity
                        }
                    }
                });

                await tx.stockReservation.update({
                    where: {
                        orderId_productId: {
                            orderId: data.orderId,
                            productId: item.productId
                        }
                    },
                    data: {
                        status: ReservationStatus.RELEASED
                    }
                })
            }

            await tx.outboxEvent.create({
                data: {
                    eventId: crypto.randomUUID(),
                    eventType: 'StockReleased',
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


}