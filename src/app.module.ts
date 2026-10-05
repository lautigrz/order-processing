import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrdersModule } from './orders/OrdersModule.js';
import { PrismaModule } from './prisma/PrismaModule.js';
import { PaymentModule } from './payment/PaymentModule.js';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    OrdersModule,
    PaymentModule,
    ScheduleModule.forRoot(),
  ],
})
export class AppModule { }
