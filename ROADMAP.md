# Roadmap de Evolución Arquitectónica y Rendimiento

Este documento detalla extensiones arquitectónicas, patrones de resiliencia y optimizaciones de rendimiento aplicables sobre la base actual del proyecto. Cada propuesta aborda problemas reales de sistemas distribuidos a gran escala.

---

## 1. Patrones de Arquitectura Distribuida y Resiliencia

### 1.1. Saga Pattern para Compensación de Transacciones
- **Problema actual**: El flujo avanza en un solo sentido (`PENDING` -> `PAYMENT_PROCESSING`). Si el pago falla definitivamente en la pasarela o no hay fondos, no existe un mecanismo formal para cancelar la orden y revertir el estado del negocio de manera consistente.
- **Implementación**:
  - **Saga Coreografiada**: Cuando `PaymentWorker` determina que el pago falló, emite un evento `PaymentFailed` a Kafka. `OrdersService` escucha ese evento y transiciona la orden a `FAILED` o `CANCELLED`.
  - **Acciones compensatorias**: Si se añade un módulo de inventario, un evento `PaymentFailed` dispara la liberación del stock previamente reservado.

### 1.2. Idempotencia en la Capa HTTP (Idempotency-Key Header)
- **Problema actual**: La idempotencia actual protege a Kafka y BullMQ contra mensajes duplicados, pero si un cliente HTTP sufre un timeout de red y reintenta el `POST /v1/api/orders`, se crean dos órdenes distintas con cargos duplicados.
- **Implementación**:
  - Implementar un interceptor en NestJS que verifique el header `Idempotency-Key: <UUID>`.
  - Almacenar en Redis la clave junto con el estado del request (`PROCESSING` o el payload de respuesta `201 Created` en cache con TTL de 24h).
  - Si llega una petición con la misma clave mientras se procesa, responder `409 Conflict`. Si ya finalizó, devolver la respuesta previa cacheada sin volver a escribir en la base de datos.

### 1.3. Circuit Breaker Pattern (Fusible de Protección)
- **Problema actual**: Si se integra una pasarela de pagos externa (simulada) y esta sufre degradación o latencias de 10 segundos, los workers de BullMQ mantendrán conexiones abiertas y agotarán los recursos del sistema.
- **Implementación**:
  - Integrar una librería como `opossum` o construir un decorador personalizado de Circuit Breaker.
  - Estados:
    - **Closed**: Flujo normal.
    - **Open**: Tras N fallas consecutivas, las llamadas a la pasarela fallan inmediatamente sin ejecutar llamadas de red, encolando directamente para reintento posterior.
    - **Half-Open**: Permite un porcentaje de prueba para verificar si el servicio externo se recuperó.

### 1.4. Change Data Capture (CDC) con Debezium (Evolución del Outbox)
- **Problema actual**: El `OutboxPublisher` actual utiliza un mecanismo de polling (`@Cron` cada 2 segundos con `FOR UPDATE SKIP LOCKED`). Aunque está optimizado por lotes, sigue consumiendo ciclos de base de datos incluso cuando no hay eventos nuevos.
- **Implementación**:
  - Utilizar **Debezium** conectado al Write-Ahead Log (WAL) de PostgreSQL.
  - Debezium detecta inserciones en la tabla `outboxEvents` a nivel de disco y transmite los eventos directamente a Kafka en tiempo real (milisegundos) sin necesidad de cron jobs ni lecturas periódicas en la aplicación.

---

## 2. Escalabilidad y Rendimiento Extremo

### 2.1. Particionamiento de Kafka y Escalabilidad Horizontal de Consumidores
- **Problema actual**: El topic `orders` tiene 1 sola partición. En Kafka, una partición solo puede ser consumida por un consumidor dentro del mismo `group.id`.
- **Implementación**:
  - Configurar el topic `orders` con 4 u 8 particiones.
  - Utilizar `order.customerId` o `order.id` como `key` del mensaje. Esto garantiza que todos los eventos de un mismo cliente se procesen en orden estricto dentro de la misma partición, mientras que eventos de distintos clientes se procesan en paralelo.
  - Levantar múltiples instancias de la aplicación (`replicas: 3` en Docker Compose); Kafka balanceará las particiones entre las instancias automáticamente.

### 2.2. Patrón Cache-Aside para Consultas Rápidas
- **Problema actual**: Las consultas `GET /v1/api/orders/:id` impactan directamente en PostgreSQL.
- **Implementación**:
  - En `OrdersService.getById(id)`: consultar primero Redis (`order:{id}`).
  - Si no existe (Cache Miss), consultar PostgreSQL, guardar en Redis con un TTL (ej. 5 minutos) y retornar.
  - **Invalidación**: Cuando `PaymentWorker` actualice el estado a `PAYMENT_PROCESSING` o `COMPLETED`, invalidar o actualizar la clave en Redis.

### 2.3. Cluster Mode en Node.js
- **Problema actual**: Node.js corre en un único hilo de ejecución. Aunque la máquina disponga de 8 núcleos de CPU, la aplicación solo utiliza uno, limitando el throughput a ~200-250 RPS.
- **Implementación**:
  - Utilizar el módulo nativo `node:cluster` o configurar un process manager como **PM2** con `exec_mode: 'cluster'` e `instances: 'max'`.
  - Permite levantar un worker por cada núcleo físico de la máquina, compartiendo el mismo puerto TCP, lo que eleva el techo de 200 RPS a más de 800-1000 RPS locales.

---

## 3. Observabilidad y Telemetría Distribuida

### 3.1. Trazabilidad Distribuida con OpenTelemetry
- **Problema actual**: Cuando una orden falla, es complejo correlacionar qué request HTTP generó qué mensaje en Kafka y qué job en BullMQ.
- **Implementación**:
  - Inyectar OpenTelemetry SDK en NestJS.
  - Propagar un `traceId` en los headers HTTP, incluirlo en el payload de `outboxEvents`, en los headers del mensaje de Kafka y en los datos del job de BullMQ.
  - Exportar trazas a **Jaeger** o **Zipkin** para visualizar cascadas de ejecución completas y medir la latencia individual de cada salto de red.

### 3.2. Métricas con Prometheus y Grafana
- **Problema actual**: Las métricas se observan actualmente mediante el script de consola `monitor.mjs`.
- **Implementación**:
  - Exponer un endpoint `/metrics` en formato Prometheus usando `@willsoto/nestjs-prometheus`.
  - Recolectar:
    - Latencia de peticiones HTTP (Histogramas p50, p90, p99).
    - Kafka Consumer Lag (diferencia entre el último offset producido y el último procesado).
    - Estado de colas BullMQ (waiting, active, failed).
    - Tasa de utilización del pool de PostgreSQL.

---

## 4. Cuadro Comparativo de Priorización

| Iniciativa | Dificultad | Impacto en Arquitectura | Valor de Aprendizaje |
|---|---|---|---|
| **Saga Pattern (Compensación de fallos)** | Media | Alto (Consistencia eventual completa) | Muy Alto |
| **Idempotency-Key en HTTP** | Baja | Medio (Previene doble facturación) | Alto |
| **Particionamiento de Kafka + Réplicas** | Media | Alto (Escalado horizontal real) | Muy Alto |
| **Cache-Aside con Redis (`GET /orders`)** | Baja | Medio (Reduce carga en DB de lectura) | Medio |
| **OpenTelemetry (Distributed Tracing)** | Alta | Alto (Visibilidad de extremo a extremo) | Muy Alto |
| **CDC con Debezium** | Alta | Muy Alto (Elimina el polling del Outbox) | Avanzado |
