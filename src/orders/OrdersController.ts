import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Logger, Param, Patch, Post } from "@nestjs/common";
import { OrdersService } from "./OrdersService.js";
import * as orderSchema from "./contracts/order.schema.js";
import { EventPattern, Payload } from "@nestjs/microservices";
import * as paymentTypes from "../payment/types/payment.types.js";
import { Status } from "../generated/prisma/enums.js";

@Controller({ path: "/api/orders", version: "1" })
export class OrdersController {
    private readonly logger = new Logger(OrdersController.name);

    private readonly eventHandlers: Record<string, (data: paymentTypes.EventPayload) => Promise<void>> = {
        PaymentFailed: async (data) => {
            this.logger.log(`Received PaymentFailed for order #${data.orderId}`);
            await this.ordersService.paymentFailed(data.orderId);
        },
        StockReservationFailed: async (data) => {
            this.logger.log(`Received StockReservationFailed for order #${data.orderId}`);
            await this.ordersService.cancelOrder(data.orderId);
        },
        PaymentSucceeded: async (data) => {
            this.logger.log(`Received PaymentSucceeded for order #${data.orderId}`);
            await this.ordersService.paymentSucceeded(data.orderId);
        },
        StockReserved: async (data) => {
            this.logger.log(`Received StockReserved for order #${data.orderId}`);
            await this.ordersService.reservationSucceeded(data.orderId);
        },
        StockReleased: async (data) => {
            this.logger.log(`Received StockReleased for order #${data.orderId}`);
            await this.ordersService.stockReleased(data.orderId);
        },
        PaymentRefunded: async (data) => {
            this.logger.log(`Received PaymentRefunded for order #${data.orderId}`);
            await this.ordersService.paymentRefunded(data.orderId);
        },
    };

    constructor(
        @Inject(OrdersService)
        private readonly ordersService: OrdersService,
    ) { }

    @EventPattern("orders")
    async handleOrderEvent(@Payload() data: paymentTypes.EventPayload) {
        this.logger.log(`[OrdersController] Received event "${data?.event}" for order #${data?.orderId}`);

        const handler = this.eventHandlers[data?.event];
        if (handler) {
            try {
                await handler(data);
            } catch (err: any) {
                this.logger.error(`Error processing Kafka event "${data?.event}" for order #${data?.orderId}: ${err?.message}`, err?.stack);
            }
        } else {
            this.logger.debug(`[OrdersController] Unhandled event "${data?.event}" — skipping`);
        }
    }

    @Get()
    getAll() {
        return this.ordersService.getAll();
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    create(@Body() dto: orderSchema.CreateOrderDto) {
        return this.ordersService.create(dto);
    }

    @Patch("/:id/status")
    @HttpCode(HttpStatus.OK)
    updateStatus(@Body() dto: orderSchema.UpdateOrderStatusDto, @Param("id") id: string) {
        return this.ordersService.updateStatus(dto, Number(id));
    }

    @Get("/:id")
    @HttpCode(HttpStatus.OK)
    getById(@Param("id") id: string) {
        return this.ordersService.getById(Number(id));
    }
}