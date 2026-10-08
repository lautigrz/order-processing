import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentModule } from '../../../src/payment/PaymentModule.js';
import { PrismaModule } from '../../../src/prisma/PrismaModule.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    PaymentModule,
  ],
})
export class PaymentAppModule { }
