import { Module } from "@nestjs/common";
import { InventoryModule } from "../../../src/inventory/InventoryModule.js";
import { ConfigModule } from "@nestjs/config";

@Module({
    imports: [ConfigModule.forRoot({ isGlobal: true }), InventoryModule],
})

export class InventoryAppModule { }