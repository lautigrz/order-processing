/**
 * BullMQ + Outbox Monitor
 *
 * Script para correr EN PARALELO mientras hacés un test de carga.
 * Muestra en tiempo real el estado de las colas BullMQ y del Outbox.
 *
 * Muestra:
 *   - Waiting / Active / Completed / Failed en BullMQ
 *   - Eventos del Outbox pendientes de publicar
 *   - Throughput del worker (jobs/s)
 *
 * Uso:
 *   Terminal 1: pnpm start:dev
 *   Terminal 2: pnpm load:monitor
 *   Terminal 3: pnpm load:stress    (o cualquier test de carga)
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import pg from 'pg';

const { Pool } = pg;

const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const retryQueue = new Queue('payment-retry', { connection: redisConnection });
const dlqQueue   = new Queue('payment-retry-dlq', { connection: redisConnection });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const INTERVAL_MS = 2000; // refrescar cada 2 segundos

let prevCompleted = 0;
let prevTs = Date.now();

async function snapshot() {
  try {
    const [
      retryStats,
      dlqStats,
      pendingOutboxRes,
      totalOrdersRes,
      byStatusRes,
    ] = await Promise.all([
      retryQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      dlqQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
      pool.query('SELECT COUNT(*)::int AS count FROM "outboxEvents" WHERE "publishedAt" IS NULL'),
      pool.query('SELECT COUNT(*)::int AS count FROM "orders"'),
      pool.query('SELECT status, COUNT(*)::int AS count FROM "orders" GROUP BY status'),
    ]);

    const pendingOutbox = pendingOutboxRes.rows[0]?.count ?? 0;
    const totalOrders = totalOrdersRes.rows[0]?.count ?? 0;

    const now = Date.now();
    const elapsed = (now - prevTs) / 1000;
    const throughput = prevCompleted > 0 && elapsed > 0
      ? ((retryStats.completed - prevCompleted) / elapsed).toFixed(1)
      : '0.0';

    prevCompleted = retryStats.completed;
    prevTs = now;

    const statusMap = Object.fromEntries(
      byStatusRes.rows.map(r => [r.status, r.count])
    );

    // Limpiar pantalla en terminal
    process.stdout.write('\x1Bc');

    console.log('═'.repeat(58));
    console.log('  📊  BullMQ + Outbox Monitor  —  ' + new Date().toLocaleTimeString());
    console.log('═'.repeat(58));

    console.log('\n  🔄  BullMQ: payment-retry queue');
    console.log(`     Waiting:    ${retryStats.waiting}`);
    console.log(`     Active:     ${retryStats.active}`);
    console.log(`     Completed:  ${retryStats.completed}`);
    console.log(`     Failed:     ${retryStats.failed}`);
    console.log(`     Delayed:    ${retryStats.delayed}`);
    console.log(`     Throughput: ${throughput} jobs/s`);

    console.log('\n  ☠️   BullMQ: DLQ (payment-retry-dlq)');
    console.log(`     Waiting:    ${dlqStats.waiting}`);
    console.log(`     Failed:     ${dlqStats.failed}`);

    console.log('\n  📤  Outbox');
    console.log(`     Pendientes de publicar a Kafka: ${pendingOutbox}`);

    console.log('\n  📦  Orders en DB: ' + totalOrders);
    console.log('     Por status:');
    for (const [status, count] of Object.entries(statusMap)) {
      const bar = '█'.repeat(Math.min(count, 40));
      console.log(`       ${status.padEnd(22)} ${String(count).padStart(4)}  ${bar}`);
    }

    if (retryStats.failed > 0) {
      console.log('\n  ⚠️   Hay jobs fallidos en BullMQ. Revisá los logs del worker.');
    }
    if (pendingOutbox > 20) {
      console.log('\n  ⚠️   Outbox backpressure: muchos eventos pendientes. El Outbox Publisher no da abasto.');
    }
    if (dlqStats.waiting > 0) {
      console.log(`\n  🚨  DLQ tiene ${dlqStats.waiting} job(s). Usá POST /v1/api/payment/dlq/:jobId/reprocess`);
    }

    console.log('\n  Ctrl+C para detener\n');
  } catch (err) {
    console.error('Error al obtener métricas:', err.message);
  }
}

console.log('Iniciando monitor... (refresca cada 2s)\n');

// Primera snapshot inmediata
await snapshot();

// Loop periódico
const interval = setInterval(snapshot, INTERVAL_MS);

process.on('SIGINT', async () => {
  clearInterval(interval);
  await retryQueue.close();
  await dlqQueue.close();
  await pool.end();
  console.log('\nMonitor detenido.');
  process.exit(0);
});
