/**
 * Este archivo ya no es el entrypoint del sistema.
 *
 * El proyecto fue refactorizado en dos servicios independientes:
 *
 *   pnpm start:orders   →  apps/orders-service/src/main.ts  (groupId: orders-service,  port: 3000)
 *   pnpm start:payment  →  apps/payment-service/src/main.ts (groupId: payment-service, port: 3001)
 *
 * No corras este archivo directamente.
 */
throw new Error(
  '[src/main.ts] Entrypoint obsoleto. Usá "pnpm start:orders" o "pnpm start:payment".',
);
