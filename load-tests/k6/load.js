/**
 * LOAD TEST — Carga sostenida normal
 *
 * Simula el uso normal esperado del sistema.
 * Escenario:
 *   - Ramp-up: 0 → 20 VUs en 1 minuto
 *   - Carga estable: 20 VUs durante 3 minutos
 *   - Ramp-down: 20 → 0 VUs en 30 segundos
 *
 * Mix de requests que simula tráfico real:
 *   60% → POST /orders   (crear órdenes)
 *   30% → GET /orders/:id (consultar estado)
 *   10% → GET /orders     (listar todas)
 *
 * Ejecución: k6 run load-tests/k6/load.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomOrderBody, API, JSON_HEADERS } from './helpers.js';
import { SharedArray } from 'k6/data';

export const options = {
  stages: [
    { duration: '1m',  target: 20 },   // ramp-up
    { duration: '3m',  target: 20 },   // carga sostenida
    { duration: '30s', target: 0 },    // ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:create}': ['p(95)<600'],
    'http_req_duration{endpoint:getById}': ['p(95)<200'],
  },
};

// Pool de IDs de órdenes generadas durante el test para reutilizar en GETs
const createdOrderIds = [];

export default function () {
  const rand = Math.random();

  if (rand < 0.60) {
    // ─── Crear orden ───────────────────────────────────────────────────────
    const res = http.post(
      `${API}/api/orders`,
      randomOrderBody(),
      {
        headers: JSON_HEADERS,
        tags: { endpoint: 'create' },
      },
    );

    const ok = check(res, {
      'POST /orders → 201': (r) => r.status === 201,
    });

    if (ok) {
      const id = res.json('id');
      if (id) createdOrderIds.push(id);
    }

  } else if (rand < 0.90) {
    // ─── Consultar orden por ID ────────────────────────────────────────────
    if (createdOrderIds.length === 0) {
      // Si aún no hay ids, leer la orden 1 del seed
      http.get(`${API}/api/orders/1`, { tags: { endpoint: 'getById' } });
    } else {
      const id = createdOrderIds[Math.floor(Math.random() * createdOrderIds.length)];
      const res = http.get(`${API}/api/orders/${id}`, { tags: { endpoint: 'getById' } });
      check(res, { 'GET /orders/:id → 200': (r) => r.status === 200 });
    }

  } else {
    // ─── Listar todas las órdenes ──────────────────────────────────────────
    const res = http.get(`${API}/api/orders`, { tags: { endpoint: 'getAll' } });
    check(res, { 'GET /orders → 200': (r) => r.status === 200 });
  }

  sleep(Math.random() * 1 + 0.5); // think time: 500ms - 1.5s
}
