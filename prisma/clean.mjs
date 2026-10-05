import 'dotenv/config';
import pg from 'pg';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';

const { Pool } = pg;

async function clean() {
  console.log('════════════════════════════════════════════════════');
  console.log('  🧹 Limpieza Total de Ambiente (Postgres + Redis + Kafka)');
  console.log('════════════════════════════════════════════════════\n');

  // 1. PostgreSQL
  console.log('1️⃣  Limpiando PostgreSQL...');
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('TRUNCATE TABLE "orderItems", "orders", "processedEvents", "outboxEvents" RESTART IDENTITY CASCADE;');
    await pool.end();
    console.log('    ✅ Tablas orders, orderItems, processedEvents y outboxEvents truncadas (IDs en 1).');
  } catch (err) {
    console.error('    ❌ Error limpiando PostgreSQL:', err.message);
  }

  // 2. Redis
  console.log('\n2️⃣  Limpiando Redis (FLUSHALL)...');
  try {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
    await redis.flushall();
    await redis.quit();
    console.log('    ✅ Redis vaciado completamente (colas BullMQ, reintentos y DLQ eliminados).');
  } catch (err) {
    console.error('    ❌ Error limpiando Redis:', err.message);
  }

  // 3. Kafka
  console.log('\n3️⃣  Limpiando Kafka...');
  try {
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
    const kafka = new Kafka({
      clientId: 'environment-cleaner',
      brokers,
    });
    const admin = kafka.admin();
    await admin.connect();

    const existingTopics = await admin.listTopics();
    if (existingTopics.includes('orders')) {
      await admin.deleteTopics({ topics: ['orders'] });
      console.log('    ✅ Topic "orders" eliminado de Kafka.');
      // Pequeña pausa para que el broker procese la eliminación
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    await admin.createTopics({
      topics: [{ topic: 'orders', numPartitions: 1, replicationFactor: 1 }],
    });
    console.log('    ✅ Topic "orders" recreado en blanco en Kafka.');

    await admin.disconnect();
  } catch (err) {
    console.warn('    ⚠️  Aviso en Kafka (podría estar recreando el topic en background):', err.message);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('  🚀 Ambiente 100% limpio y listo para nuevas pruebas');
  console.log('════════════════════════════════════════════════════\n');
}

clean().catch((err) => {
  console.error('Error fatal durante la limpieza:', err);
  process.exit(1);
});
