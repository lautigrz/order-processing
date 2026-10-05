/**
 * STRESS TEST — Llevar el sistema al límite
 *
 * Objetivo: encontrar el punto de quiebre de la API.
 * Escenario: incremento progresivo de carga hasta 100 VUs,
 * luego baja gradual para observar recuperación.
 *
 * Fases:
 *   0 → 20 VUs  (1 min)  — carga normal
 *   20 → 50 VUs (2 min)  — carga alta
 *   50 → 100 VUs (2 min) — carga de estrés
 *   100 VUs     (3 min)  — carga sostenida al límite
 *   100 → 0 VUs (1 min)  — recuperación
 *
 * Ejecución: k6 run load-tests/k6/stress.js
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { randomOrderBody, API, JSON_HEADERS } from './helpers.js';
import { Trend, Rate, Counter } from 'k6/metrics';

// Métricas custom
const createOrderDuration = new Trend('create_order_duration', true);
const createOrderErrors    = new Rate('create_order_errors');
const ordersCreated        = new Counter('orders_created_total');

export const options = {
  stages: [
    { duration: '1m',  target: 20  },   // carga normal
    { duration: '2m',  target: 50  },   // carga alta
    { duration: '2m',  target: 100 },   // estrés
    { duration: '3m',  target: 100 },   // sostenido al límite
    { duration: '1m',  target: 0   },   // recuperación
  ],
  thresholds: {
    // Thresholds más relajados para test de estrés — no queremos que el test falle,
    // queremos observar la degradación
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    http_req_failed: ['rate<0.10'],            // admitimos hasta 10% de errores
    create_order_errors: ['rate<0.10'],
  },
};

const createdOrderIds = [];

export default function () {
  group('create_order', () => {
    const start = Date.now();

    const res = http.post(
      `${API}/api/orders`,
      randomOrderBody(),
      { headers: JSON_HEADERS },
    );

    createOrderDuration.add(Date.now() - start);

    const ok = check(res, {
      'status 201': (r) => r.status === 201,
      'tiene id':   (r) => Boolean(r.json('id')),
    });

    createOrderErrors.add(!ok);

    if (ok) {
      ordersCreated.add(1);
      const id = res.json('id');
      if (id) createdOrderIds.push(id);
    } else {
      // Loguear errores para análisis post-test
      console.warn(`[stress] create failed ${res.status}: ${res.body?.substring(0, 200)}`);
    }
  });

  // Intercalar lecturas para simular tráfico mixto
  if (createdOrderIds.length > 0 && Math.random() < 0.4) {
    group('read_order', () => {
      const id = createdOrderIds[Math.floor(Math.random() * createdOrderIds.length)];
      const res = http.get(`${API}/api/orders/${id}`);
      check(res, { 'GET 200': (r) => r.status === 200 });
    });
  }

  sleep(Math.random() * 0.5); // think time mínimo para maximizar la presión
}

/**
 * Hook que se ejecuta al final — imprime un resumen ejecutivo
 */
export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] ?? 0;
  const p99 = data.metrics.http_req_duration?.values?.['p(99)'] ?? 0;
  const errRate = (data.metrics.http_req_failed?.values?.rate ?? 0) * 100;
  const rps = data.metrics.http_reqs?.values?.rate ?? 0;
  const total = data.metrics.orders_created_total?.values?.count ?? 0;

  const summary = `
╔══════════════════════════════════════════╗
║         STRESS TEST — RESUMEN           ║
╠══════════════════════════════════════════╣
║  Órdenes creadas:  ${String(total).padEnd(22)}║
║  RPS promedio:     ${String(rps.toFixed(1)).padEnd(22)}║
║  p(95) latencia:   ${String(p95.toFixed(0) + 'ms').padEnd(22)}║
║  p(99) latencia:   ${String(p99.toFixed(0) + 'ms').padEnd(22)}║
║  Tasa de error:    ${String(errRate.toFixed(2) + '%').padEnd(22)}║
╚══════════════════════════════════════════╝
`;

  return {
    stdout: summary,
    'load-tests/results/stress-summary.json': JSON.stringify(data, null, 2),
  };
}
