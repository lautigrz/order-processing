import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
import { OrdersService } from "./OrdersService.js";
import * as orderSchema from "./contracts/order.schema.js";

@Controller({ path: "/api/orders", version: "1" })
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) { }

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