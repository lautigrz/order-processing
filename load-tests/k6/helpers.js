/**
 * k6 Load Test — system-order-processing
 *
 * Prerequisito: instalar k6
 *   Windows: winget install k6 --source winget
 *   o descargar desde https://k6.io/docs/get-started/installation/
 *
 * Ejecución:
 *   k6 run load-tests/k6/smoke.js
 *   k6 run load-tests/k6/load.js
 *   k6 run load-tests/k6/stress.js
 *   k6 run load-tests/k6/spike.js
 *
 * Con reporte HTML:
 *   k6 run --out json=results.json load-tests/k6/stress.js
 */

export const BASE_URL = 'http://localhost:3000';
export const API = `${BASE_URL}/v1`;

// Clientes del seed (id 1-5)
export const CUSTOMER_IDS = [1, 2, 3, 4, 5];

// Productos del seed (id 1-7)
export const PRODUCT_IDS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Genera un body de orden aleatorio con 1-3 items sin duplicados
 */
export function randomOrderBody() {
  const customerId = CUSTOMER_IDS[Math.floor(Math.random() * CUSTOMER_IDS.length)];

  // Elegir entre 1 y 3 productos distintos
  const shuffled = [...PRODUCT_IDS].sort(() => 0.5 - Math.random());
  const count = Math.floor(Math.random() * 3) + 1;
  const items = shuffled.slice(0, count).map((productId) => ({
    productId,
    quantity: Math.floor(Math.random() * 3) + 1,
  }));

  return JSON.stringify({ customerId, items });
}

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

/**
 * Thresholds comunes — se pueden overridear por test
 */
export const DEFAULT_THRESHOLDS = {
  // 95% de requests < 500ms
  http_req_duration: ['p(95)<500'],
  // Menos del 1% de errores
  http_req_failed: ['rate<0.01'],
};
