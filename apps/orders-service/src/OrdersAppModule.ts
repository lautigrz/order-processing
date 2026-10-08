import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { OrdersModule } from '../../../src/orders/OrdersModule.js';
import { PrismaModule } from '../../../src/prisma/PrismaModule.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    OrdersModule,
    ScheduleModule.forRoot(),
  ],
})
export class OrdersAppModule {}
