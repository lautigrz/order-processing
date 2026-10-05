
export type EventPayload = {
    eventId: string;
    event: string;
    orderId: number;
    customerId: number;
    total: string;
    isFromDLQ?: boolean;
}

export type ObjectFailed = {
    jobId: string;
    payload: EventPayload;
    failedReason?: string;
    stacktrace?: string[];
    attemptsMade: number;
    attempts: number;
    timestamp: number;
    reprocessCount: number;
};