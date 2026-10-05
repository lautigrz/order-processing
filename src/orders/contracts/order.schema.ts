import z from "zod";
import { Status as OrderStatus } from "../../generated/prisma/enums.js";

export const CreateOrderSchema = z.object({
    customerId: z.number().int().positive(),
    items: z.array(
        z.object({
            productId: z.number().int().positive(),
            quantity: z.number().int().positive()
        })
    )
        .min(1, "Order must contain at least one item").refine(items => {
            return new Set(items.map(item => item.productId)).size === items.length;
        }, {
            message: "Duplicate product id",
            path: ["items"]
        })
});

export const UpdateOrderStatusSchema = z.object({
    status: z.nativeEnum(OrderStatus)
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
export type UpdateOrderStatusDto = z.infer<typeof UpdateOrderStatusSchema>;