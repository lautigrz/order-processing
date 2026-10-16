# System Order Processing

Sistema distribuido de procesamiento de órdenes orientado a eventos y de alta concurrencia, diseñado con **NestJS**, **PostgreSQL**, **Apache Kafka**, **Redis/BullMQ** e integración con **Stripe**. Implementa patrones avanzados de arquitectura empresarial como **Transactional Outbox**, **Sagas Coreografiadas**, **Consumo Idempotente**, **Pessimistic Locking (`FOR UPDATE`)** y **Dead Letter Queue (DLQ)**.

---

## 🏛️ Arquitectura y Flujo de Datos

El sistema está dividido en microservicios independientes que se comunican de forma asíncrona mediante Kafka y colas BullMQ, asegurando consistencia eventual y desacoplamiento total.

```
Cliente HTTP
    │
    ▼ [POST /api/orders]
1. OrdersService (Transacción ACID PostgreSQL)
    ├── Valida cliente e ítems
    ├── Inserta Order + OrderItems (estado PENDING)
    └── Inserta OutboxEvent (OrderCreated)
    │
    ▼ [HTTP 201 Created inmediato < 40ms]
2. OutboxPublisher (Cron background continuo)
    ├── Lectura por lotes con SELECT ... FOR UPDATE SKIP LOCKED
    ├── Publicación paralela al topic 'orders' en Apache Kafka
    └── Marca de publishedAt masiva en PostgreSQL
    │
    ▼
3. InventoryService (Consumidor Kafka)
    ├── Verificación de idempotencia
    ├── Si hay stock: descuenta inventario y emite StockReserved
    └── Si no hay stock: emite StockReservationFailed ➔ Orders cancela la orden (Saga Compensatoria)
    │
    ▼
4. PaymentController / PaymentQueueService (BullMQ en Redis)
    ├── Encola job en cola payment-retry con backoff exponencial
    └── PaymentWorker (Concurrencia 10)
         ├── Crea registro Payment (PENDING)
         └── Genera Stripe Checkout Session (fuera de la transacción de DB)
    │
    ▼
5. Pasarela Stripe & Webhooks (PaymentWebhookService)
    ├── checkout.session.completed ➔ Marca PAID y emite PaymentSucceeded
    ├── payment_intent.payment_failed (fondos insuficientes/tarjeta) ➔ Marca FAILED y emite PaymentFailed
    └── checkout.session.expired (abandono de checkout) ➔ Marca FAILED y emite PaymentFailed
    │
    ▼
6. Compensación en Saga (Orders e Inventory)
    ├── OrdersService recibe PaymentSucceeded y pasa la orden a PROCESSING
    └── Si recibe PaymentFailed ➔ Orders cancela la orden y libera reservas de stock en Inventory
```

---

## 🧩 Patrones de Diseño y Resiliencia Implementados

### 1. Patrón Saga Coreografiada (Choreographed Saga Pattern)
Coordinación de procesos de negocio distribuidos entre `orders`, `inventory` y `payment` sin un orquestador centralizado:
- **Transacciones Positivas:** `OrderCreated` ➔ `StockReserved` ➔ `PaymentSucceeded` ➔ Orden en `PROCESSING`.
- **Transacciones de Compensación:** 
  - Si el inventario no tiene stock: emite `StockReservationFailed` y `orders` cancela automáticamente la orden (`CANCELLED`).
  - Si el pago falla en Stripe (tarjeta declinada o fondos insuficientes): emite `PaymentFailed`, `orders` pasa a `FAILED` e `inventory` ejecuta `refundStock()` liberando las reservas.

### 2. Transactional Outbox Pattern
Para evitar inconsistencias de doble escritura entre la base de datos y el broker de mensajería:
- El evento se guarda en la tabla `outboxEvents` dentro de la misma transacción ACID de PostgreSQL.
- Un worker lee mediante `SELECT ... FOR UPDATE SKIP LOCKED`, publica a Kafka y confirma los eventos procesados por lotes.

### 3. Consumo Idempotente
Debido a que Kafka ofrece semántica *at-least-once*, cada evento recibido por cualquier servicio verifica su clave de idempotencia (`${eventId}:${service}`) en la tabla `processedEvents`. Si el evento ya se procesó, se descarta de forma segura sin efectos secundarios.

### 4. Arquitectura de Colas Desacoplada con BullMQ
- `PaymentQueueService`: Servicio inyectable bajo el contenedor IoC de NestJS (`OnModuleDestroy`) que aísla las colas.
- **`payment-retry`**: Cola principal de cobro con reintentos exponenciales (3 intentos).
- **`payment-refund`**: Cola aislada para reembolsos asíncronos.
- **`payment-retry-dlq` (Dead Letter Queue)**: Almacena jobs fallidos conservando metadata, stacktrace y número de reintentos para inspección o reprocesamiento manual:
  `POST /api/payment/dlq/:jobId/reprocess`

### 5. Integración Robusta con Stripe (Ports & Adapters)
- **Timeouts y Reintentos de Red:** Cliente de Stripe configurado con timeout explícito (10s) y `maxNetworkRetries: 2`.
- **Fast-Commit Transactions:** La llamada HTTP externa a Stripe se realiza fuera de la transacción de PostgreSQL para no agotar el Connection Pool, y la confirmación en base de datos se ejecuta en una transacción atómica ultrarrápida (< 2ms).
- **Webhooks Seguros:** Verificación criptográfica de firma en [PaymentWebhookService](file:///e:/workspace-node/system-order-processing/src/payment/webhook/PaymentWebhookService.ts), respondiendo `400 Bad Request` en caso de firmas inválidas sin tocar la base de datos (protección anti-DDoS).

### 6. Control de Concurrencia con Locks Pesimistas (`FOR UPDATE`)
En flujos de reembolso concurrentes, se utiliza `SELECT ... FOR UPDATE` sobre la tabla `payments` para prevenir condiciones de carrera y evitar dobles reembolsos.

---

## ⚡ Optimizaciones de Rendimiento

1. **Connection Pool de PostgreSQL**: Configurado en `@prisma/adapter-pg` con pool de conexiones ampliado (`DB_POOL_MAX=30`), evitando contención de sockets.
2. **Concurrencia en Workers de Pagos**: `PaymentWorker` opera con `concurrency: 10` y `lockDuration: 60000`, procesando lotes masivos de pagos en paralelo.
3. **Limpieza y Clean Code**:
   - Funciones cortas con nombres reveladores de intención.
   - Event Dispatchers basados en diccionarios para controladores (`eventHandlers`), respetando el principio Open/Closed (OCP).
   - Utilidades puras compartidas para idempotencia y Outbox en `src/common/utils/event.util.ts`.

---

## 📊 Métricas de Rendimiento Obtenidas

Resultados registrados con **Autocannon** sobre un solo nodo:

### 1. Load Test (20 conexiones concurrentes, 60 segundos)
- **Requests totales:** 7.381
- **Throughput:** 123.0 req/s (pico de 210 req/s)
- **Latencia p50:** 141 ms
- **Latencia p90:** 258 ms
- **Latencia p97.5:** 343 ms ✅
- **Tasa de error:** **0.00%** (0 errores HTTP, 0 desconexiones)

### 2. Stress Test (100 conexiones concurrentes, 90 segundos)
- **Requests totales:** 15.379
- **Throughput:** 170.9 req/s (pico de 249 req/s)
- **Latencia p50:** 532 ms
- **Tasa de error:** **0.00%** (cero fallas de conexión o errores 5xx bajo 100 clientes simultáneos)

### 3. Stripe Webhook Stress Test (30 conexiones concurrentes, 15 segundos)
- **Requests totales:** 52.299
- **Throughput:** **3.487 req/s**
- **Latencia promedio:** **8.1 ms** (p50: 6 ms, p99: 29 ms)
- **Comportamiento:** Intercepción inmediata de firmas inválidas (`400 Bad Request`) en memoria sin degradación de base de datos.

---

## 🛠️ Stack Tecnológico

- **Runtime**: Node.js v22+
- **Framework**: NestJS v12
- **Lenguaje**: TypeScript
- **Base de Datos**: PostgreSQL 16 (Prisma ORM v7 y `@prisma/adapter-pg`)
- **Broker de Mensajería**: Apache Kafka (KafkaJS)
- **Colas y Cache**: Redis 7 con BullMQ v6
- **Pasarela de Pagos**: Stripe API v23
- **Pruebas de Carga**: Autocannon y k6

---

## 🚀 Instalación y Puesta en Marcha

### 1. Clonar e instalar dependencias
```bash
git clone <URL_DEL_REPOSITORIO>
cd system-order-processing
pnpm install
```

### 2. Variables de Entorno (`.env`)
Crear un archivo `.env` en la raíz tomando como base:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/order_proccesing?schema=public"

ORDERS_PORT=3000
PAYMENT_PORT=3001
INVENTORY_PORT=3002

KAFKA_BROKERS="localhost:9092"
KAFKA_CLIENT_ID_ORDERS="orders-service"
KAFKA_CLIENT_ID_PAYMENT="payment-service"
KAFKA_CLIENT_ID_INVENTORY="inventory-service"
KAFKA_GROUP_ID_ORDERS="orders-service"
KAFKA_GROUP_ID_PAYMENT="payment-service"
KAFKA_GROUP_ID_INVENTORY="inventory-service"

REDIS_HOST="localhost"
REDIS_PORT=6379
DB_POOL_MAX=30
LOG_LEVELS="log,warn,error"

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL="http://localhost:3000/api/v1/orders/success"
STRIPE_CANCEL_URL="http://localhost:3000/api/v1/orders/cancel"
```

### 3. Levantar la infraestructura
```bash
docker compose up -d
```

### 4. Inicializar Base de Datos
```bash
pnpm db:push
pnpm db:seed
```

### 5. Iniciar los Microservicios
Abrir 3 terminales:
```bash
# Terminal 1 - Orders Service (Puerto 3000)
pnpm start:orders

# Terminal 2 - Inventory Service (Puerto 3002)
pnpm start:inventory

# Terminal 3 - Payment Service (Puerto 3001)
pnpm start:payment
```

---

## 📡 Endpoints de la API

### Órdenes (`/api/orders`)
- `POST /api/orders` — Crea una nueva orden y emite `OrderCreated`.
- `GET /api/orders` — Lista todas las órdenes con sus ítems.
- `GET /api/orders/:id` — Obtiene detalle de una orden por ID.
- `PATCH /api/orders/:id/status` — Actualiza estado con validación de máquina de estados.

### Pagos (`/api/payment`)
- `POST /api/payment/webhook` — Webhook oficial para eventos de Stripe (`completed`, `failed`, `expired`).
- `POST /api/payment/dlq/:jobId/reprocess` — Reintenta manualmente un job fallido desde la Dead Letter Queue.

---

## 🧪 Pruebas de Carga y Monitoreo

```bash
# Monitor en tiempo real de BullMQ, DLQ y Outbox
pnpm load:monitor

# Pruebas con Autocannon
pnpm load:smoke    # Smoke test (1 conexión, 10s)
pnpm load:load     # Load test (20 conexiones, 60s)
pnpm load:stress   # Stress test (100 conexiones, 90s)
pnpm load:readonly # Solo lectura (50 conexiones, 30s)

# Limpieza total del ambiente (PostgreSQL, Redis y topics Kafka)
pnpm db:clean
```
