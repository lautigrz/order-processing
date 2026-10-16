import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/PrismaService.js";
import { ReservationStatus } from "../generated/prisma/enums.js";
import { EventPayload } from "../payment/types/payment.types.js";
import { Prisma } from "../generated/prisma/client.js";
import { emitOutboxEvent, isEventProcessed, markEventProcessed } from "../common/utils/event.util.js";

interface OrderItemRequirement {
    productId: number;
    quantity: number;
}

@Injectable()
export class InventoryService {
    private readonly logger = new Logger(InventoryService.name);

    constructor(
        @Inject(PrismaService)
        private readonly prisma: PrismaService,
    ) { }

    // =========================================================================
    // Stock Deduction (Reservation)
    // =========================================================================

    async deductStock(data: EventPayload): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:inventory`;
            if (await isEventProcessed(tx, idempotencyKey)) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const orderItems = await this.getOrderItems(tx, data.orderId);
            const itemWithoutStock = await this.findInsufficientStockItem(tx, orderItems);

            if (itemWithoutStock) {
                await this.handleInsufficientStock(tx, data.orderId, itemWithoutStock, idempotencyKey);
                return;
            }

            await this.reserveProductsAndCreateReservations(tx, data.orderId, orderItems);
            await markEventProcessed(tx, idempotencyKey);

            await emitOutboxEvent(tx, 'StockReserved', {
                orderId: data.orderId,
                customerId: data.customerId,
                total: data.total,
            });

            this.logger.log(`Stock successfully reserved for order #${data.orderId}`);
        });
    }

    private async getOrderItems(tx: Prisma.TransactionClient, orderId: number): Promise<OrderItemRequirement[]> {
        return tx.orderItem.findMany({
            where: { orderId },
            select: { productId: true, quantity: true },
        });
    }

    private async findInsufficientStockItem(
        tx: Prisma.TransactionClient,
        orderItems: OrderItemRequirement[],
    ): Promise<OrderItemRequirement | undefined> {
        const productIds = orderItems.map((item) => item.productId);
        const products = await tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, stock: true },
        });

        const productStockMap = new Map(products.map((p) => [p.id, p.stock]));

        return orderItems.find((item) => {
            const availableStock = productStockMap.get(item.productId);
            return availableStock === undefined || availableStock < item.quantity;
        });
    }

    private async handleInsufficientStock(
        tx: Prisma.TransactionClient,
        orderId: number,
        insufficientItem: OrderItemRequirement,
        idempotencyKey: string,
    ): Promise<void> {
        this.logger.warn(`Insufficient stock for product #${insufficientItem.productId} in order #${orderId}`);

        await emitOutboxEvent(tx, 'StockReservationFailed', {
            orderId,
            productId: insufficientItem.productId,
            reason: 'Insufficient stock',
        });

        await markEventProcessed(tx, idempotencyKey);
    }

    private async reserveProductsAndCreateReservations(
        tx: Prisma.TransactionClient,
        orderId: number,
        orderItems: OrderItemRequirement[],
    ): Promise<void> {
        for (const item of orderItems) {
            await tx.product.update({
                where: { id: item.productId },
                data: {
                    stock: { decrement: item.quantity },
                },
            });

            await tx.stockReservation.create({
                data: {
                    orderId,
                    productId: item.productId,
                    quantity: item.quantity,
                    status: ReservationStatus.RESERVED,
                },
            });
        }
    }

    // =========================================================================
    // Stock Refund / Release
    // =========================================================================

    async refundStock(data: EventPayload): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            const idempotencyKey = `${data.eventId}:inventory-refund`;
            if (await isEventProcessed(tx, idempotencyKey)) {
                this.logger.warn(`Event ${data.eventId} already processed — skipping`);
                return;
            }

            const orderItems = await this.getOrderItems(tx, data.orderId);

            for (const item of orderItems) {
                await this.releaseProductReservation(tx, data.orderId, item.productId);
            }

            await emitOutboxEvent(tx, 'StockReleased', { orderId: data.orderId });
            await markEventProcessed(tx, idempotencyKey);

            this.logger.log(`Stock reservations released for order #${data.orderId}`);
        });
    }

    private async releaseProductReservation(
        tx: Prisma.TransactionClient,
        orderId: number,
        productId: number,
    ): Promise<void> {
        const reservation = await tx.stockReservation.findUnique({
            where: {
                orderId_productId: { orderId, productId },
            },
        });

        if (!reservation) {
            throw new NotFoundException(`Reservation for order ${orderId} and product ${productId} not found`);
        }

        if (reservation.status === ReservationStatus.RELEASED) {
            return;
        }

        await tx.product.update({
            where: { id: productId },
            data: {
                stock: { increment: reservation.quantity },
            },
        });

        await tx.stockReservation.update({
            where: {
                orderId_productId: { orderId, productId },
            },
            data: {
                status: ReservationStatus.RELEASED,
            },
        });
    }
}