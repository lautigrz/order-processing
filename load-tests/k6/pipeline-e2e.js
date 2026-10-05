/**
 * PIPELINE END-TO-END STRESS TEST
 *
 * Evalúa el pipeline asíncrono completo:
 *
 *   HTTP POST /orders
 *     └─▶ DB (order + outboxEvent)
 *           └─▶ OutboxPublisher (cron cada 5s)
 *                 └─▶ Kafka topic "orders"
 *                       └─▶ PaymentController (consumer)
 *                             └─▶ BullMQ queue "payment-retry"
 *                                   └─▶ PaymentWorker
 *                                         └─▶ DB: order.status = PAYMENT_PROCESSING
 *
 * Métricas clave:
 *   - pipeline_completed:      cuántos órdenes completaron el pipeline completo
 *   - pipeline_duration:       tiempo total desde POST hasta status = PAYMENT_PROCESSING
 *   - pipeline_failed:         órdenes que no completaron en el timeout
 *   - kafka_bullmq_lag:        tiempo desde que se creó la orden hasta que el worker la procesó
 *
 * IMPORTANTE: El timeout de polling es largo (30s) porque:
 *   - El Outbox publisher corre cada 5s
 *   - Kafka tiene latencia de entrega
 *   - BullMQ procesa de forma asíncrona
 *
 * Ejecución:
 *   k6 run load-tests/k6/pipeline-e2e.js
 *   k6 run --env CONCURRENCY=10 load-tests/k6/pipeline-e2e.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { randomOrderBody, API, JSON_HEADERS } from './helpers.js';

// ── Métricas custom del pipeline ─────────────────────────────────────────────
const pipelineDuration  = new Trend('pipeline_e2e_duration_ms', true);
const pipelineCompleted = new Counter('pipeline_completed');
const pipelineFailed    = new Counter('pipeline_failed');
const kafkaBullmqLag    = new Trend('kafka_bullmq_lag_ms', true);

// ── Configuración ─────────────────────────────────────────────────────────────
const CONCURRENCY      = parseInt(__ENV.CONCURRENCY ?? '5');
const POLL_INTERVAL_MS = 1000;   // chequear status cada 1 segundo
const PIPELINE_TIMEOUT = 35000;  // 35s máximo (OutboxPublisher corre cada 5s)

export const options = {
  vus: CONCURRENCY,
  iterations: CONCURRENCY * 5,   // cada VU crea 5 órdenes en total
  maxDuration: '5m',
  thresholds: {
    // Al menos 80% de órdenes deben completar el pipeline
    pipeline_completed: [`count>=${Math.floor(CONCURRENCY * 5 * 0.8)}`],

    // El pipeline completo debe terminar en < 30s para el 95% de los casos
    'pipeline_e2e_duration_ms': ['p(95)<30000'],

    // La latencia HTTP pura debe seguir siendo rápida
    'http_req_duration{stage:create}': ['p(95)<600'],
  },
};

export default function () {
  // ── 1. Crear orden (HTTP síncrono) ─────────────────────────────────────────
  const t0 = Date.now();

  const createRes = http.post(
    `${API}/api/orders`,
    randomOrderBody(),
    {
      headers: JSON_HEADERS,
      tags: { stage: 'create' },
    },
  );

  const created = check(createRes, {
    'POST /orders → 201': (r) => r.status === 201,
    'tiene id':           (r) => Boolean(r.json('id')),
  });

  if (!created) {
    console.warn(`[pipeline] create falló: ${createRes.status} — ${createRes.body?.substring(0, 100)}`);
    pipelineFailed.add(1);
    return;
  }

  const orderId = createRes.json('id');
  const tCreated = Date.now();

  // ── 2. Polling: esperar que el pipeline procese la orden ───────────────────
  let pipelineCompleted_ = false;
  let tProcessed = 0;
  const deadline = Date.now() + PIPELINE_TIMEOUT;

  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_MS / 1000);

    const pollRes = http.get(
      `${API}/api/orders/${orderId}`,
      { tags: { stage: 'poll' } },
    );

    if (pollRes.status !== 200) continue;

    const status = pollRes.json('status');

    // El pipeline corrió si el status cambió de PENDING a cualquier otro
    // (PAYMENT_PROCESSING significa que Kafka + BullMQ + Worker lo procesaron)
    if (status && status !== 'PENDING') {
      tProcessed = Date.now();
      pipelineCompleted_ = true;

      check(pollRes, {
        'status transitó a PAYMENT_PROCESSING': (r) => r.json('status') === 'PAYMENT_PROCESSING',
      });

      break;
    }
  }

  // ── 3. Registrar métricas ──────────────────────────────────────────────────
  if (pipelineCompleted_) {
    const totalDuration = tProcessed - t0;
    const lag = tProcessed - tCreated; // tiempo solo del pipeline async

    pipelineDuration.add(totalDuration);
    kafkaBullmqLag.add(lag);
    pipelineCompleted.add(1);

    console.log(`[pipeline] order ${orderId} ✅ completado en ${totalDuration}ms (lag async: ${lag}ms)`);
  } else {
    pipelineFailed.add(1);
    console.warn(`[pipeline] order ${orderId} ❌ timeout — no procesado en ${PIPELINE_TIMEOUT}ms`);
  }
}

export function handleSummary(data) {
  const completed  = data.metrics.pipeline_completed?.values?.count ?? 0;
  const failed     = data.metrics.pipeline_failed?.values?.count ?? 0;
  const total      = completed + failed;
  const successPct = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';

  const p50  = data.metrics.pipeline_e2e_duration_ms?.values?.['p(50)']  ?? 0;
  const p95  = data.metrics.pipeline_e2e_duration_ms?.values?.['p(95)']  ?? 0;
  const lagP50 = data.metrics.kafka_bullmq_lag_ms?.values?.['p(50)'] ?? 0;
  const lagP95 = data.metrics.kafka_bullmq_lag_ms?.values?.['p(95)'] ?? 0;

  const summary = `
╔════════════════════════════════════════════════════╗
║      PIPELINE E2E TEST — RESUMEN                  ║
╠════════════════════════════════════════════════════╣
║  Órdenes totales:       ${String(total).padEnd(27)}║
║  Pipeline completado:   ${String(completed + ' (' + successPct + '%)').padEnd(27)}║
║  Pipeline fallido:      ${String(failed).padEnd(27)}║
╠════════════════════════════════════════════════════╣
║  LATENCIA TOTAL (create + pipeline async)          ║
║  p(50):                 ${String(p50.toFixed(0) + 'ms').padEnd(27)}║
║  p(95):                 ${String(p95.toFixed(0) + 'ms').padEnd(27)}║
╠════════════════════════════════════════════════════╣
║  LAG KAFKA+BULLMQ (solo pipeline async)            ║
║  p(50):                 ${String(lagP50.toFixed(0) + 'ms').padEnd(27)}║
║  p(95):                 ${String(lagP95.toFixed(0) + 'ms').padEnd(27)}║
╚════════════════════════════════════════════════════╝
`;

  return {
    stdout: summary,
    'load-tests/results/pipeline-e2e-summary.json': JSON.stringify(data, null, 2),
  };
}
