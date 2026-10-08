import { Status as OrderStatus } from "../../generated/prisma/enums.js";



const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {

    [OrderStatus.PENDING]: [OrderStatus.PAYMENT_PROCESSING, OrderStatus.CANCELLED],
    [OrderStatus.PAYMENT_PROCESSING]: [OrderStatus.PAID, OrderStatus.FAILED, OrderStatus.CANCELLED],
    [OrderStatus.PAID]: [OrderStatus.PROCESSING],
    [OrderStatus.PROCESSING]: [OrderStatus.COMPLETED],
    [OrderStatus.FAILED]: [],
    [OrderStatus.COMPLETED]: [],
    [OrderStatus.CANCELLED]: []
};


export const canTransition = (from: OrderStatus, to: OrderStatus) => {
    return allowedTransitions[from].includes(to);
};

