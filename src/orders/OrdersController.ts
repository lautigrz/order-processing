import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Logger, Param, Patch, Post } from "@nestjs/common";
import { OrdersService } from "./OrdersService.js";
import * as orderSchema from "./contracts/order.schema.js";
import { EventPattern, Payload } from "@nestjs/microservices";
import * as paymentTypes from "../payment/types/payment.types.js";
import { Status } from "../generated/prisma/enums.js";

@Controller({ path: "/api/orders", version: "1" })
export class OrdersController {
    private readonly logger = new Logger(OrdersController.name);

    constructor(
        @Inject(OrdersService)
        private readonly ordersService: OrdersService) { }


    @EventPattern("orders")
    async handleOrderEvent(@Payload() data: paymentTypes.EventPayload) {
        this.logger.log(`[OrdersController] Received Kafka event from topic "orders": ${JSON.stringify(data)}`);

        if (data.event === "PaymentFailed") {
            this.logger.log(`Received PaymentFailed for order ${data.orderId}`);
            await this.ordersService.paymentFailed(data.orderId);
        }
        else if (data.event === "StockReservationFailed") {
            this.logger.log(`Received StockReservationFailed for order ${data.orderId}`);
            await this.ordersService.updateStatus({ status: Status.CANCELLED }, data.orderId)
        }
        else if (data.event === "PaymentSucceeded") {
            this.logger.log(`Received PaymentSucceeded for order ${data.orderId}`);
            await this.ordersService.paymentSucceeded(data.orderId);
        }
        else if (data.event === "StockReserved") {
            await this.ordersService.reservationSucceeded(data.orderId);
        } else if (data.event === "StockReleased") {
            this.logger.log(`Received StockReleased for order ${data.orderId}`);
            await this.ordersService.stockReleased(data.orderId);
        }
    }


    @Get()
    getAll() {
        return this.ordersService.getAll()
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    create(@Body() dto: orderSchema.CreateOrderDto) {
        return this.ordersService.create(dto)
    }

    @Patch("/:id/status")
    @HttpCode(HttpStatus.OK)
    updateStatus(@Body() dto: orderSchema.UpdateOrderStatusDto, @Param("id") id: string) {
        return this.ordersService.updateStatus(dto, Number(id))
    }

    @Get("/:id")
    @HttpCode(HttpStatus.OK)
    getById(@Param("id") id: string) {
        return this.ordersService.getById(Number(id))
    }

}