/**
 * SMOKE TEST — Verificación mínima
 *
 * Objetivo: confirmar que la API funciona con carga mínima antes de tests reales.
 * Carga: 1 VU durante 30 segundos.
 * Pasa si: 0% errores y p(95) < 300ms
 *
 * Ejecución: k6 run load-tests/k6/smoke.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomOrderBody, API, JSON_HEADERS } from './helpers.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.001'],   // prácticamente 0 errores
    http_req_duration: ['p(95)<300'],  // muy rápido
  },
};

export default function () {
  // 1. Crear una orden
  const createRes = http.post(
    `${API}/api/orders`,
    randomOrderBody(),
    { headers: JSON_HEADERS },
  );

  const created = check(createRes, {
    'POST /orders → 201': (r) => r.status === 201,
    'respuesta tiene id': (r) => r.json('id') !== undefined,
  });

  if (!created) {
    console.error(`[smoke] POST failed: ${createRes.status} — ${createRes.body}`);
    return;
  }

  const orderId = createRes.json('id');
  sleep(0.5);

  // 2. Leer la orden recién creada
  const getRes = http.get(`${API}/api/orders/${orderId}`);
  check(getRes, {
    'GET /orders/:id → 200': (r) => r.status === 200,
    'id correcto': (r) => r.json('id') === orderId,
  });

  sleep(1);
}
