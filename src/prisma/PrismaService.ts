import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {

    constructor() {
        const adapter = new PrismaPg({
            connectionString: process.env.DATABASE_URL,
            max: Number(process.env.DB_POOL_MAX ?? 30),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });
        super({ adapter });
    }

    onModuleInit() {
        this.$connect();
    }
    onModuleDestroy() {
        this.$disconnect();
    }
}