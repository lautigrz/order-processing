import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { CreateOrderDto, UpdateOrderStatusDto } from "./contracts/order.schema.js";
import { Decimal } from "@prisma/client/runtime/client";
import { canTransition } from "./utils/status.js";
import { PaymentStatus, ReservationStatus, Status } from "../generated/prisma/enums.js";
import { Prisma } from "../generated/prisma/client.js";

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService) { }

    async getAll() {
        return this.prisma.order.findMany({
            include: {
                orderItems: {
                    include: {
                        product: true
                    }
                }
            }
        })
    }

    async create(dto: CreateOrderDto) {
        const productsId = [...new Set(dto.items.map(item => item.productId))];

        const createOrder = await this.prisma.$transaction(async (tx) => {
            const products = await tx.product.findMany({
                where: {
                    id: {
                        in: productsId
                    }
                },
                select: {
                    id: true,
                    price: true
                }
            })

            const userExists = await tx.user.findUnique({ where: { id: dto.customerId }, select: { id: true } });
            if (!userExists) throw new NotFoundException(`User with id ${dto.customerId} not found`);


            const productMap = new Map(products.map(p => [p.id, p]));

            const orderItems = dto.items.map(item => {
                const product = productMap.get(item.productId);
                if (!product) {
                    throw new NotFoundException(`Product with id ${item.productId} not found`);
                }
                return {
                    productId: product.id,
                    quantity: item.quantity,
                    unitPrice: product.price
                };
            });

            const total = orderItems.reduce((acc, item) => acc.add(
                item.unitPrice.times(item.quantity)),
                new Decimal(0)
            );


            const order = await tx.order.create({
                data: {
                    customerId: userExists.id,
                    total,
                    orderItems: {
                        create: orderItems
                    }
                }
            });
            const eventId = crypto.randomUUID();
            await tx.outboxEvent.create({
                data: {
                    eventId,
                    eventType: 'OrderCreated',
                    topic: 'orders',
                    payload: {
                        orderId: order.id,
                        customerId: order.customerId,
                        total: order.total
                    }
                }
            });

            return order;
        });

        this.logger.debug(`Order ${createOrder!.id} created for customer ${createOrder!.customerId}`);
        return createOrder;
    }

    async updateStatus(dto: UpdateOrderStatusDto, orderId: number) {
        const order = await this.prisma.order.findUnique({
            where: {
                id: orderId
            }
        })

        if (!order) {
            throw new NotFoundException(`Order with id ${orderId} not found`);
        }

        if (!canTransition(order.status, dto.status)) {
            throw new BadRequestException(`Invalid status transition from ${order.status} to ${dto.status}`);
        }

        this.logger.log(`Order ${orderId} status: ${order.status} → ${dto.status}`);

        return this.prisma.order.update({
            where: {
                id: orderId
            },
            data: {
                status: dto.status
            }
        })
    }

    async getById(id: number) {
        const order = await this.prisma.order.findUnique({
            where: {
                id
            },
            include: {
                orderItems: {
                    include: {
                        product: true
                    }
                }
            }
        })
        if (!order) {
            throw new NotFoundException(`Order with id ${id} not found`);
        }
        return order;
    }


    async paymentSucceeded(orderId: number) {
        await this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({
                where: { id: orderId }
            });
            if (!order) throw new Error(`Order ${orderId} not found`);

            if (order.status === Status.CANCELLED || order.paymentStatus === PaymentStatus.REFUNDED) {
                return;
            }

            if (order.paymentStatus === PaymentStatus.PAID) {
                return;
            }

            await tx.order.update({
                where: { id: orderId },
                data: { paymentStatus: PaymentStatus.PAID }
            });


            await this.tryAdvanceOrder(tx, order.id);
        });
    }

    async reservationSucceeded(orderId: number) {
        await this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({
                where: { id: orderId }
            });
            if (!order) throw new Error(`Order ${orderId} not found`);

            if (order.stockReservationStatus === ReservationStatus.RESERVED) {
                return;
            }

            await tx.order.update({
                where: { id: orderId },
                data: { stockReservationStatus: ReservationStatus.RESERVED }
            });


            await this.tryAdvanceOrder(tx, order.id);

        });
    }

    async tryAdvanceOrder(tx: Prisma.TransactionClient, orderId: number) {

        const order = await tx.order.findUnique({
            where: { id: orderId }
        });
        if (!order) throw new Error(`Order ${orderId} not found`);

        if (order.paymentStatus === PaymentStatus.PAID &&
            order.stockReservationStatus === ReservationStatus.RESERVED) {

            await tx.order.update({
                where: { id: orderId },
                data: { status: Status.PROCESSING }
            });
        }
    }

    async paymentFailed(orderId: number) {
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: Status.FAILED,
                paymentStatus: PaymentStatus.FAILED,
            },
        });
    }

    async stockReleased(orderId: number) {
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                stockReservationStatus: ReservationStatus.RELEASED,
            },
        });
    }


}