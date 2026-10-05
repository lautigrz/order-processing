/**
 * SPIKE TEST — Pico repentino de tráfico
 *
 * Objetivo: evaluar cómo responde el sistema ante una explosión de tráfico
 * (como un flash sale, notificación masiva, etc.)
 *
 * Escenario:
 *   - Base normal: 5 VUs
 *   - Spike: sube a 200 VUs en 10 segundos (impacto inmediato)
 *   - Se mantiene 1 minuto en pico
 *   - Baja rápido a 5 VUs (observar recuperación)
 *   - Se mantiene en base para verificar estabilidad post-spike
 *
 * Ejecución: k6 run load-tests/k6/spike.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomOrderBody, API, JSON_HEADERS } from './helpers.js';
import { Trend } from 'k6/metrics';

const timeToFirstByte = new Trend('ttfb', true);

export const options = {
  stages: [
    { duration: '30s', target: 5   },   // línea base
    { duration: '10s', target: 200  },  // ← spike repentino
    { duration: '1m',  target: 200  },  // pico sostenido
    { duration: '10s', target: 5   },   // caída rápida
    { duration: '2m',  target: 5   },   // recuperación y estabilidad
  ],
  thresholds: {
    // En un spike es normal degradar — solo chequeamos que no colapse total
    http_req_failed: ['rate<0.20'],
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  const res = http.post(
    `${API}/api/orders`,
    randomOrderBody(),
    { headers: JSON_HEADERS },
  );

  timeToFirstByte.add(res.timings.waiting); // TTFB real

  check(res, {
    'no 5xx': (r) => r.status < 500,
    '201 o 400 (validación)': (r) => [201, 400, 422].includes(r.status),
  });

  // Sin think time para maximizar el efecto del spike
  sleep(0.1);
}

export function handleSummary(data) {
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] ?? 0;
  const errRate = (data.metrics.http_req_failed?.values?.rate ?? 0) * 100;
  const rps = data.metrics.http_reqs?.values?.rate ?? 0;
  const ttfb95 = data.metrics.ttfb?.values?.['p(95)'] ?? 0;

  const summary = `
╔══════════════════════════════════════════╗
║          SPIKE TEST — RESUMEN           ║
╠══════════════════════════════════════════╣
║  RPS promedio:     ${String(rps.toFixed(1)).padEnd(22)}║
║  p(95) latencia:   ${String(p95.toFixed(0) + 'ms').padEnd(22)}║
║  p(95) TTFB:       ${String(ttfb95.toFixed(0) + 'ms').padEnd(22)}║
║  Tasa de error:    ${String(errRate.toFixed(2) + '%').padEnd(22)}║
╚══════════════════════════════════════════╝
`;
  return {
    stdout: summary,
    'load-tests/results/spike-summary.json': JSON.stringify(data, null, 2),
  };
}
