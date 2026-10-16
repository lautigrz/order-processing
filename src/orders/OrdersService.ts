import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { CreateOrderDto, UpdateOrderStatusDto } from "./contracts/order.schema.js";
type OrderInputItem = CreateOrderDto['items'][number];
import { Decimal } from "@prisma/client/runtime/client";
import { canTransition } from "./utils/status.js";
import { PaymentStatus, ReservationStatus, Status } from "../generated/prisma/enums.js";
import { Prisma } from "../generated/prisma/client.js";
import { emitOutboxEvent } from "../common/utils/event.util.js";

interface PreparedOrderItem {
    productId: number;
    quantity: number;
    unitPrice: Decimal;
}

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService,
    ) { }

    // =========================================================================
    // Queries
    // =========================================================================

    async getAll() {
        return this.prisma.order.findMany({
            include: {
                orderItems: {
                    include: { product: true },
                },
            },
        });
    }

    async getById(id: number) {
        return this.findOrderOrThrow(this.prisma, id, true);
    }

    // =========================================================================
    // Order Creation
    // =========================================================================

    async create(dto: CreateOrderDto) {
        const createdOrder = await this.prisma.$transaction(async (tx) => {
            await this.ensureCustomerExists(tx, dto.customerId);

            const { orderItems, total } = await this.buildOrderItemsAndTotal(tx, dto.items);
            const order = await this.saveOrderWithItems(tx, dto.customerId, total, orderItems);

            await emitOutboxEvent(tx, 'OrderCreated', {
                orderId: order.id,
                customerId: order.customerId,
                total: order.total,
            });

            return order;
        });

        this.logger.debug(`Order #${createdOrder.id} created for customer #${createdOrder.customerId}`);
        return createdOrder;
    }

    private async ensureCustomerExists(tx: Prisma.TransactionClient, customerId: number): Promise<void> {
        const userExists = await tx.user.findUnique({
            where: { id: customerId },
            select: { id: true },
        });

        if (!userExists) {
            throw new NotFoundException(`User with id ${customerId} not found`);
        }
    }

    private async buildOrderItemsAndTotal(
        tx: Prisma.TransactionClient,
        items: OrderInputItem[],
    ): Promise<{ orderItems: PreparedOrderItem[]; total: Decimal }> {
        const productIds = [...new Set(items.map((item) => item.productId))];

        const products = await tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, price: true },
        });

        const productMap = new Map(products.map((p) => [p.id, p]));

        const orderItems: PreparedOrderItem[] = items.map((item) => {
            const product = productMap.get(item.productId);
            if (!product) {
                throw new NotFoundException(`Product with id ${item.productId} not found`);
            }
            return {
                productId: product.id,
                quantity: item.quantity,
                unitPrice: product.price,
            };
        });

        const total = orderItems.reduce(
            (acc, item) => acc.add(item.unitPrice.times(item.quantity)),
            new Decimal(0),
        );

        return { orderItems, total };
    }

    private async saveOrderWithItems(
        tx: Prisma.TransactionClient,
        customerId: number,
        total: Decimal,
        orderItems: PreparedOrderItem[],
    ) {
        return tx.order.create({
            data: {
                customerId,
                total,
                orderItems: {
                    create: orderItems,
                },
            },
        });
    }

    // =========================================================================
    // Status Transitions
    // =========================================================================

    async updateStatus(dto: UpdateOrderStatusDto, orderId: number) {
        const order = await this.findOrderOrThrow(this.prisma, orderId);

        if (!canTransition(order.status, dto.status)) {
            throw new BadRequestException(`Invalid status transition from ${order.status} to ${dto.status}`);
        }

        this.logger.log(`Order #${orderId} status: ${order.status} → ${dto.status}`);

        return this.prisma.order.update({
            where: { id: orderId },
            data: { status: dto.status },
        });
    }

    // =========================================================================
    // Saga Event Handlers
    // =========================================================================

    async paymentSucceeded(orderId: number): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { id: orderId } });
            if (!order || this.isTerminalState(order.status, order.paymentStatus)) {
                return;
            }

            if (order.paymentStatus === PaymentStatus.PAID) {
                return;
            }

            await tx.order.update({
                where: { id: orderId },
                data: { paymentStatus: PaymentStatus.PAID },
            });

            await this.advanceOrderIfReady(tx, order.id, PaymentStatus.PAID, order.stockReservationStatus);
        });
    }

    async reservationSucceeded(orderId: number): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { id: orderId } });
            if (!order || order.stockReservationStatus === ReservationStatus.RESERVED) {
                return;
            }

            await tx.order.update({
                where: { id: orderId },
                data: { stockReservationStatus: ReservationStatus.RESERVED },
            });

            await this.advanceOrderIfReady(tx, order.id, order.paymentStatus, ReservationStatus.RESERVED);
        });
    }

    private async advanceOrderIfReady(
        tx: Prisma.TransactionClient,
        orderId: number,
        paymentStatus: PaymentStatus,
        stockReservationStatus: ReservationStatus,
    ): Promise<void> {
        if (paymentStatus === PaymentStatus.PAID && stockReservationStatus === ReservationStatus.RESERVED) {
            await tx.order.update({
                where: { id: orderId },
                data: { status: Status.PROCESSING },
            });
            this.logger.log(`Order #${orderId} fully confirmed → status set to PROCESSING`);
        }
    }

    private isTerminalState(status: Status, paymentStatus: PaymentStatus): boolean {
        return status === Status.CANCELLED || paymentStatus === PaymentStatus.REFUNDED;
    }

    async paymentFailed(orderId: number): Promise<void> {
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: Status.FAILED,
                paymentStatus: PaymentStatus.FAILED,
            },
        });
    }

    async stockReleased(orderId: number): Promise<void> {
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                stockReservationStatus: ReservationStatus.RELEASED,
            },
        });
    }

    async paymentRefunded(orderId: number): Promise<void> {
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                paymentStatus: PaymentStatus.REFUNDED,
            },
        });
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private async findOrderOrThrow(
        client: PrismaService | Prisma.TransactionClient,
        id: number,
        includeItems = false,
    ) {
        const order = await client.order.findUnique({
            where: { id },
            ...(includeItems
                ? {
                    include: {
                        orderItems: {
                            include: { product: true },
                        },
                    },
                }
                : {}),
        });

        if (!order) {
            throw new NotFoundException(`Order with id ${id} not found`);
        }

        return order;
    }
}