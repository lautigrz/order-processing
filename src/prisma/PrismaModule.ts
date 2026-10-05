import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./PrismaService.js";

@Global()
@Module({
    providers: [PrismaService],
    exports: [PrismaService]
})
export class PrismaModule { }