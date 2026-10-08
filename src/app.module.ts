/**
 * AppModule monolítico — RETIRADO.
 *
 * Este módulo existía cuando Orders y Payment corrían en el mismo proceso.
 * Fue reemplazado por:
 *
 *   apps/orders-service/src/OrdersAppModule.ts  → proceso 1
 *   apps/payment-service/src/PaymentAppModule.ts → proceso 2
 *
 * No importar este archivo desde ningún entrypoint activo.
 */
