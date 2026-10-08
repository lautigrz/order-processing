import { Module } from "@nestjs/common";
import { InventoryController } from "./InventoryController.js";
import { InventoryService } from "./InventoryService.js";
import { PrismaModule } from "../prisma/PrismaModule.js";

@Module({
    controllers: [InventoryController],
    imports: [PrismaModule],
    providers: [InventoryService]
})
export class InventoryModule { }