# Guía de Pruebas de Carga y Estrés

Este directorio contiene las herramientas para evaluar el rendimiento, la estabilidad y la resiliencia del sistema tanto a nivel HTTP/Base de Datos como en el pipeline asíncrono (**Outbox -> Kafka -> BullMQ -> Worker**).

---

## 🏗️ Dos Enfoques Disponibles

| Herramienta | Requisitos | Ideal para |
|---|---|---|
| **Autocannon** (`pnpm load:*`) | Solo Node.js (`pnpm add -D autocannon`) | Pruebas rápidas sin dependencias externas |
| **k6** (`pnpm k6:*`) | [Instalar k6](https://k6.io/docs/get-started/installation/) (`winget install k6`) | Pruebas avanzadas con métricas detalladas y gráficos |

---

## ⚡ ¿Las pruebas HTTP evalúan Kafka y BullMQ?

- **Pruebas HTTP estándar (`load:load`, `k6:load`, `load:stress`, etc.)**:
  Miden la capacidad de **ingesta de la API y escritura en Postgres**.
  Gracias al patrón **Transactional Outbox**, `POST /v1/api/orders` guarda la orden y el evento en la DB y responde `201 Created` de inmediato (latencia < 50ms). **No esperan** a que el evento se publique en Kafka ni a que BullMQ procese el pago.

- **Pruebas de Pipeline Asíncrono (`k6:e2e` y `load:monitor`)**:
  Diseñadas específicamente para evaluar **Kafka, BullMQ y el Outbox**:
  1. **`k6:e2e` (`load-tests/k6/pipeline-e2e.js`)**: Realiza `POST /orders`, obtiene el ID y hace *polling* contra `GET /orders/:id` hasta comprobar que el estado pasa a `PAYMENT_PROCESSING`. Mide el tiempo total extremo a extremo (`pipeline_e2e_duration_ms`).
  2. **`load:monitor` (`load-tests/autocannon/monitor.mjs`)**: Script en Node.js que corre en vivo en una terminal paralela mientras se ejecuta cualquier test de carga. Consulta en tiempo real Redis y PostgreSQL, mostrando el estado de BullMQ (`waiting`, `active`, `completed`, `failed`), la DLQ, los eventos pendientes del Outbox y el throughput de jobs/segundo.

---

## 🚀 Cómo ejecutar las pruebas

### Preparación
1. Asegurarse de tener PostgreSQL, Redis y Kafka corriendo (`docker compose up -d`).
2. Levantar la aplicación:
   ```bash
   pnpm start:dev
   ```

### 1. Pruebas con Autocannon (npm)
```bash
# Smoke test (5 segundos, 1 conexión, verificar salud)
pnpm load:smoke

# Load test (30 segundos, 10 conexiones simultáneas)
pnpm load:load

# Stress test (60 segundos, 50 conexiones simultáneas con ráfagas)
pnpm load:stress

# Solo lectura (30 segundos GET /orders, 20 conexiones)
pnpm load:readonly
```

### 2. Pruebas con k6
```bash
# Smoke test (1 usuario, 30s)
pnpm k6:smoke

# Load test con ramp-up gradual (20 usuarios durante 3 min)
pnpm k6:load

# Stress test al límite (hasta 100 usuarios simultáneos)
pnpm k6:stress

# Spike test (pico súbito de 5 a 200 usuarios)
pnpm k6:spike

# Pipeline End-to-End (mide Kafka + BullMQ asíncrono)
pnpm k6:e2e
```

### 3. Monitoreo en tiempo real (BullMQ + Outbox)
Abre dos terminales:
- **Terminal 1**:
  ```bash
  pnpm load:monitor
  ```
- **Terminal 2**:
  ```bash
  pnpm load:stress
  # o
  pnpm k6:load
  ```

---

## 📊 Qué buscar en los resultados

1. **Cuello de botella en Outbox:**
   Si `Pendientes de publicar a Kafka` crece sin cesar en el monitor, significa que el cron de 5s del `OutboxPublisher` no está dando abasto para el volumen de órdenes entrantes (posible mejora: reducir el intervalo o procesar lotes más grandes).
2. **Backpressure en BullMQ:**
   Si `Waiting` en BullMQ aumenta mucho mientras `Active` se mantiene en 1, significa que el `PaymentWorker` está limitado por su concurrencia (posible mejora: configurar `concurrency: 5` o escalar workers).
3. **Dead Letter Queue (DLQ):**
   Si aparecen items en `DLQ`, se puede inspeccionar y reprocesar con:
   ```http
   POST /v1/api/payment/dlq/:jobId/reprocess
   ```
