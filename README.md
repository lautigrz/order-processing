# System Order Processing

Sistema de procesamiento de órdenes distribuido y orientado a eventos, diseñado con NestJS, PostgreSQL, Apache Kafka y Redis/BullMQ. Implementa patrones de resiliencia empresarial como Transactional Outbox, procesamiento idempotente y Dead Letter Queue (DLQ).

---

## Arquitectura y Flujo de Datos

El sistema utiliza el patrón Transactional Outbox para evitar la pérdida de eventos entre la persistencia de la orden y su publicación en Kafka. Los eventos pendientes se reintentan hasta ser publicados, dando lugar a una semántica de entrega at-least-once que se complementa con procesamiento idempotente en los consumidores.

### Diagrama de Flujo

```
Cliente HTTP
    │
    ▼ [POST /v1/api/orders]
1. OrdersService (Transacción PostgreSQL)
    ├── Inserta Order + OrderItems
    └── Inserta OutboxEvent (estado no publicado)
    │
    ▼ [HTTP 201 Created inmediato]
2. OutboxPublisher (Cron cada 2s, background)
    ├── Lectura por lotes con SELECT ... FOR UPDATE SKIP LOCKED
    ├── Publicación paralela al topic 'orders' en Apache Kafka
    └── Actualización masiva de publishedAt para los eventos publicados correctamente.
    │
    ▼
3. PaymentController (Kafka Consumer Group)
    └── Recibe evento y encola en BullMQ (Redis)
    │
    ▼
4. PaymentWorker (BullMQ Worker concurrente)
    └── Ejecuta PaymentService:
        ├── Verificación de idempotencia contra processedEvents
        ├── Transición de estado de la orden a PAYMENT_PROCESSING
        └── Registro en processedEvents dentro de la misma transacción
```

---

## Patrones de Diseño Implementados

### 1. Transactional Outbox Pattern
En lugar de publicar directamente a Kafka desde el endpoint HTTP (lo cual genera inconsistencias si la transacción de base de datos falla luego de emitir o viceversa), el evento se almacena en la tabla `outboxEvents` dentro de la misma transacción ACID que crea la orden.

Un proceso en segundo plano (`OutboxPublisher`):
- Lee los eventos pendientes utilizando `FOR UPDATE SKIP LOCKED`, lo que permite concurrencia entre instancias sin colisiones ni bloqueos de tabla.
- Emite los eventos a Kafka en paralelo mediante `Promise.all()`.
- Actualiza la marca temporal `publishedAt` en bloque (`updateMany`).

### 2. Consumo Idempotente
Debido a que Kafka garantiza entrega al menos una vez (*at-least-once*), los consumidores pueden recibir mensajes duplicados durante rebalanceos de red. `PaymentService` valida cada `eventId` contra la tabla `processedEvents`. Si el evento ya fue procesado, se descarta inmediatamente antes de realizar cualquier mutación.

### 3. Manejo de Fallos y Dead Letter Queue (DLQ)
Si el procesamiento de pago falla:
- BullMQ reintenta con backoff exponencial (3 intentos con incremento de retardo).
- Al agotar los reintentos, el worker captura el fallo y crea un nuevo job en la cola payment-retry-dlq, conservando metadata del error, stacktrace y conteo de intentos.
- Se expone un endpoint administrativo para reprocesar manualmente los jobs de la DLQ:
  `POST /v1/api/payment/dlq/:jobId/reprocess`

---

## Optimizaciones de Rendimiento Aplicadas

Durante las pruebas de carga se identificaron y resolvieron los siguientes cuellos de botella:

1. **Ajuste del Connection Pool de PostgreSQL**:
   Se configuró el adaptador `@prisma/adapter-pg` con un pool explícito de 30 conexiones (`max: 30`, configurable vía `DB_POOL_MAX`), evitando que las solicitudes HTTP entrantes y los workers asíncronos compitan por el pool por defecto de 10 conexiones.

2. **Drenado por Lotes del Outbox**:
   Se incrementó el tamaño de lote de 10 a 100 eventos y se añadió un bucle de drenado continuo por ciclo de ejecución para absorber ráfagas masivas sin acumular latencia en disco.

3. **Concurrencia en Workers**:
   Se configuró el worker de BullMQ con `concurrency: 10` y `lockDuration: 60000`, permitiendo procesar hasta ~70-100 jobs por segundo sin pérdida de candados (*missing lock*) por contención de CPU.

4. **Niveles de Logging**:
   Los registros detallados por orden se movieron a nivel `debug`, permitiendo silenciar la salida por consola durante pruebas de estrés mediante `LOG_LEVELS="log,warn,error"` para evitar que operaciones I/O en terminal bloqueen el Event Loop de Node.js.

---

## Métricas de Rendimiento Obtenidas

Resultados registrados con Autocannon en pruebas de carga sostenida sobre un solo nodo:

### Load Test (20 conexiones concurrentes, 60 segundos)
- Requests totales: 8.636
- Throughput: 143.9 req/s (pico de 201 req/s)
- Latencia p50: 124 ms
- Latencia p90: 187 ms
- Latencia p97.5: 306 ms
- Tasa de error: 0.00%

### Stress Test (100 conexiones concurrentes, 90 segundos)
- Requests totales: 17.161
- Throughput: 190.7 req/s (pico de 252 req/s)
- Latencia p50: 496 ms
- Latencia p90: 722 ms
- Tasa de error: 0.00% (cero fallas de conexión o errores 5xx)

---

## Stack Tecnológico

- **Runtime**: Node.js v22+
- **Framework**: NestJS v12
- **Lenguaje**: TypeScript
- **Base de Datos**: PostgreSQL 16 (con Prisma ORM v7 y `@prisma/adapter-pg`)
- **Broker de Mensajería**: Apache Kafka (KafkaJS)
- **Colas y Cache**: Redis 7 con BullMQ v6
- **Pruebas de Carga**: Autocannon y k6

---

## Requisitos Previos

- Docker y Docker Compose
- Node.js v22 o superior
- pnpm v9 o superior

---

## Instalación y Puesta en Marcha

### 1. Clonar el repositorio e instalar dependencias
```bash
git clone <URL_DEL_REPOSITORIO>
cd system-order-processing
pnpm install
```

### 2. Configurar variables de entorno
Crear un archivo `.env` en la raíz del proyecto tomando como referencia el siguiente esquema:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/order_processing?schema=public"
PORT=3000

KAFKA_BROKERS="localhost:9092"
KAFKA_CLIENT_ID_ORDERS="order-processing"
KAFKA_CLIENT_ID_PAYMENT="payment-service"
KAFKA_GROUP_ID_PAYMENT="payment-service"

REDIS_HOST="localhost"
REDIS_PORT=6379

DB_POOL_MAX=30
LOG_LEVELS="log,warn,error"
```

### 3. Levantar la infraestructura
```bash
docker compose up -d
```

### 4. Inicializar la base de datos
```bash
# Sincronizar esquema y generar cliente Prisma
pnpm db:push

# Cargar datos iniciales (usuarios y productos)
pnpm db:seed
```

### 5. Iniciar la aplicación
```bash
# Modo desarrollo con recarga en caliente
pnpm start:dev

# Compilación y modo producción
pnpm build
pnpm start:prod
```

---

## Endpoints de la API

### Órdenes

#### Crear una orden
- **Método**: `POST`
- **Ruta**: `/v1/api/orders`
- **Cuerpo**:
```json
{
  "customerId": 1,
  "items": [
    { "productId": 1, "quantity": 2 },
    { "productId": 2, "quantity": 1 }
  ]
}
```
- **Respuesta**: `201 Created` con el detalle de la orden generada.

#### Consultar todas las órdenes
- **Método**: `GET`
- **Ruta**: `/v1/api/orders`

#### Consultar orden por ID
- **Método**: `GET`
- **Ruta**: `/v1/api/orders/:id`

### Pagos (Administración)

#### Reprocesar job desde la DLQ
- **Método**: `POST`
- **Ruta**: `/v1/api/payment/dlq/:jobId/reprocess`

---

## Pruebas de Carga y Monitoreo

El repositorio incluye herramientas integradas para evaluar el comportamiento bajo tráfico concurrente.

### Monitor en Tiempo Real
Permite observar en consola el estado de las colas BullMQ, el acumulado de eventos en el Outbox y la distribución de órdenes en base de datos:
```bash
pnpm load:monitor
```

### Ejecutar Pruebas con Autocannon
```bash
# Verificación básica (1 conexión, 10s)
pnpm load:smoke

# Carga sostenida (20 conexiones, 60s)
pnpm load:load

# Prueba de estrés (100 conexiones, 90s)
pnpm load:stress

# Solo lectura (20 conexiones, 30s)
pnpm load:readonly
```

### Ejecutar Pruebas con k6 (Opcional)
```bash
pnpm k6:smoke
pnpm k6:load
pnpm k6:stress
pnpm k6:spike
pnpm k6:e2e
```

### Limpiar el Entorno de Pruebas
Reinicia a cero las órdenes en PostgreSQL, limpia las colas en Redis (`FLUSHALL`) y recrea el topic de Kafka:
```bash
pnpm db:clean
```

---
