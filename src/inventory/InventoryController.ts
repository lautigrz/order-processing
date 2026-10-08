import { Controller, Inject, Logger } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import * as paymentTypes from "../payment/types/payment.types.js";
import { InventoryService } from "./InventoryService.js";

@Controller({ path: "/api/inventory", version: "1" })
export class InventoryController {
    private readonly logger = new Logger(InventoryController.name);
    constructor(
        @Inject(InventoryService)
        private readonly inventoryService: InventoryService) { }

    @EventPattern("orders")
    async handleEvent(@Payload() data: paymentTypes.EventPayload) {
        if (data.event === 'OrderCreated') {
            this.logger.log(
                `Received OrderCreated for order ${data.orderId}`,
            );
            await this.inventoryService.deductStock(data);
        } else if (data.event === 'PaymentFailed') {
            this.logger.log(
                `Received PaymentFailed for order ${data.orderId}`,
            );
            await this.inventoryService.refundStock(data);
        }

    }
}