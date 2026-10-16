import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../prisma/PrismaService.js";

type PrismaOrTx = PrismaService | Prisma.TransactionClient;

export async function isEventProcessed(
    client: PrismaOrTx,
    idempotencyKey: string,
): Promise<boolean> {
    const processExist = await client.processedEvent.findUnique({
        where: { eventId: idempotencyKey },
    });
    return !!processExist;
}

export async function markEventProcessed(
    client: PrismaOrTx,
    idempotencyKey: string,
    topic = 'orders',
): Promise<void> {
    try {
        await client.processedEvent.create({
            data: {
                eventId: idempotencyKey,
                topic,
            },
        });
    } catch (err: any) {
        if (err?.code !== 'P2002') {
            throw err;
        }
    }
}

export async function emitOutboxEvent(
    tx: Prisma.TransactionClient,
    eventType: string,
    payload: Record<string, any>,
    topic = 'orders',
): Promise<void> {
    await tx.outboxEvent.create({
        data: {
            eventId: crypto.randomUUID(),
            eventType,
            topic,
            payload,
        },
    });
}
