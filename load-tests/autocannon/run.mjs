/**
 * Autocannon Load Test — system-order-processing
 *
 * Alternativa a k6, no requiere instalación externa.
 * Usa autocannon (ya en devDependencies).
 *
 * Ejecución:
 *   node load-tests/autocannon/run.mjs smoke
 *   node load-tests/autocannon/run.mjs load
 *   node load-tests/autocannon/run.mjs stress
 *
 * O con pnpm:
 *   pnpm load:smoke
 *   pnpm load:stress
 */

import autocannon from 'autocannon';

const BASE_URL = 'http://localhost:3000';
const API = `${BASE_URL}/v1`;

// ── Datos del seed ──────────────────────────────────────────────────────────
const CUSTOMER_IDS = [1, 2, 3, 4, 5];
const PRODUCT_IDS = [1, 2, 3, 4, 5, 6, 7];

function randomOrderBody() {
  const customerId = CUSTOMER_IDS[Math.floor(Math.random() * CUSTOMER_IDS.length)];
  const shuffled = [...PRODUCT_IDS].sort(() => 0.5 - Math.random());
  const count = Math.floor(Math.random() * 3) + 1;
  const items = shuffled.slice(0, count).map((productId) => ({
    productId,
    quantity: Math.floor(Math.random() * 3) + 1,
  }));
  return JSON.stringify({ customerId, items });
}

// ── Configuraciones de escenarios ───────────────────────────────────────────
const scenarios = {
  /**
   * SMOKE: verificación rápida
   * 1 conexión, 10 segundos
   */
  smoke: {
    url: `${API}/api/orders`,
    connections: 1,
    duration: 10,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: randomOrderBody(),
    title: '🔍 Smoke Test',
  },

  /**
   * LOAD: carga normal sostenida
   * 20 conexiones, 60 segundos, body dinámico por request
   */
  load: {
    url: `${API}/api/orders`,
    connections: 20,
    duration: 60,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Body dinámico — se recalcula en cada request
    setupClient: (client) => {
      client.setBody(randomOrderBody());
    },
    title: '🚀 Load Test (20 conexiones, 60s)',
  },

  /**
   * STRESS: máxima presión
   * 100 conexiones, 90 segundos — un pipeline de 10 requests en vuelo por conexión
   */
  stress: {
    url: `${API}/api/orders`,
    connections: 100,
    pipelining: 1,         // una request a la vez por conexión (HTTP/1.1)
    duration: 90,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: randomOrderBody(),
    title: '💥 Stress Test (100 conexiones, 90s)',
  },

  /**
   * READONLY: solo lecturas — para aislar el costo de las queries
   */
  readonly: {
    url: `${API}/api/orders`,
    connections: 50,
    duration: 30,
    method: 'GET',
    title: '📖 Read-Only Test (50 conexiones, 30s — GET /orders)',
  },
};

// ── Runner ──────────────────────────────────────────────────────────────────
const scenarioName = process.argv[2] ?? 'smoke';
const scenario = scenarios[scenarioName];

if (!scenario) {
  console.error(`Escenario desconocido: "${scenarioName}"`);
  console.error(`Disponibles: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

console.log(`\n${scenario.title}`);
console.log('─'.repeat(50));
console.log(`URL:         ${scenario.url}`);
console.log(`Conexiones:  ${scenario.connections}`);
console.log(`Duración:    ${scenario.duration}s`);
console.log('─'.repeat(50) + '\n');

const instance = autocannon({
  ...scenario,
  // Callback dinámico de body si está configurado
  ...(scenario.setupClient ? {} : {}),
}, (err, result) => {
  if (err) {
    console.error('Error en el test:', err);
    process.exit(1);
  }

  printSummary(result, scenario);
});

autocannon.track(instance, {
  renderProgressBar: true,
  renderResultsTable: false, // usamos nuestro propio summary
});

function printSummary(result, scenario) {
  const { requests, latency, throughput, errors, non2xx } = result;

  const totalReqs = requests.total || 0;
  const errRate = totalReqs > 0
    ? ((errors + non2xx) / totalReqs * 100).toFixed(2)
    : '100.00';

  if (totalReqs === 0) {
    console.error('\n  ❌ No se completó ningún request.');
    console.error('  → Verificá que la app esté corriendo: pnpm start:dev\n');
    return;
  }

  const p95Pass = latency.p97_5 < 500;
  const errPass = parseFloat(errRate) < 1;

  console.log('\n' + '═'.repeat(52));
  console.log('  RESULTADOS');
  console.log('═'.repeat(52));
  console.log(`  Requests totales:   ${requests.total}`);
  console.log(`  RPS (promedio):     ${requests.average.toFixed(1)}`);
  console.log(`  RPS (máximo):       ${requests.max}`);
  console.log(`  Throughput:         ${(throughput.average / 1024).toFixed(1)} KB/s`);
  console.log('─'.repeat(52));
  console.log(`  Latencia p50:       ${latency.p50}ms`);
  console.log(`  Latencia p90:       ${latency.p90}ms`);
  console.log(`  Latencia p97.5:     ${latency.p97_5}ms  ${p95Pass ? '✅' : '❌ >500ms'}`);
  console.log(`  Latencia p99:       ${latency.p99}ms`);
  console.log(`  Latencia máx:       ${latency.max}ms`);
  console.log('─'.repeat(52));
  console.log(`  Errores (non-2xx):  ${non2xx}`);
  console.log(`  Errores red:        ${errors}`);
  console.log(`  Tasa de error:      ${errRate}%  ${errPass ? '✅' : '❌ >1%'}`);
  console.log('═'.repeat(52));
  console.log(p95Pass && errPass ? '\n  ✅ TEST PASADO\n' : '\n  ❌ TEST FALLÓ — ver métricas arriba\n');
}
