import { Controller, Inject, Logger } from "@nestjs/common";
import { EventPattern, Payload } from "@nestjs/microservices";
import * as paymentTypes from "../payment/types/payment.types.js";
import { InventoryService } from "./InventoryService.js";

@Controller({ path: "/api/inventory", version: "1" })
export class InventoryController {
    private readonly logger = new Logger(InventoryController.name);

    private readonly eventHandlers: Record<string, (data: paymentTypes.EventPayload) => Promise<void>> = {
        OrderCreated: async (data) => {
            this.logger.log(`Received OrderCreated for order #${data.orderId}`);
            await this.inventoryService.deductStock(data);
        },
        PaymentFailed: async (data) => {
            this.logger.log(`Received PaymentFailed for order #${data.orderId}`);
            await this.inventoryService.refundStock(data);
        },
    };

    constructor(
        @Inject(InventoryService)
        private readonly inventoryService: InventoryService,
    ) { }

    @EventPattern("orders")
    async handleEvent(@Payload() data: paymentTypes.EventPayload) {
        const handler = this.eventHandlers[data?.event];
        if (handler) {
            await handler(data);
        } else {
            this.logger.debug(`[InventoryController] Unhandled event "${data?.event}" — skipping`);
        }
    }
}