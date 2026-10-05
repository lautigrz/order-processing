import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting seed...');

  // ── Users ──────────────────────────────────────────────────────────────────
  const [alice, bob, carol, dave, eve] = await Promise.all([
    prisma.user.upsert({
      where: { id: 1 },
      update: {},
      create: { name: 'Alice Johnson' },
    }),
    prisma.user.upsert({
      where: { id: 2 },
      update: {},
      create: { name: 'Bob Smith' },
    }),
    prisma.user.upsert({
      where: { id: 3 },
      update: {},
      create: { name: 'Carol Williams' },
    }),
    prisma.user.upsert({
      where: { id: 4 },
      update: {},
      create: { name: 'Dave Brown' },
    }),
    prisma.user.upsert({
      where: { id: 5 },
      update: {},
      create: { name: 'Eve Davis' },
    }),
  ]);

  console.log(`✅ Users: ${[alice, bob, carol, dave, eve].map((u) => u.name).join(', ')}`);

  // ── Products ───────────────────────────────────────────────────────────────
  const [laptop, phone, headphones, keyboard, mouse, monitor, webcam] =
    await Promise.all([
      prisma.product.upsert({
        where: { id: 1 },
        update: { name: 'Laptop Pro 15"', price: '1299.99' },
        create: { name: 'Laptop Pro 15"', price: '1299.99' },
      }),
      prisma.product.upsert({
        where: { id: 2 },
        update: { name: 'Smartphone X12', price: '849.50' },
        create: { name: 'Smartphone X12', price: '849.50' },
      }),
      prisma.product.upsert({
        where: { id: 3 },
        update: { name: 'Noise-Cancelling Headphones', price: '249.00' },
        create: { name: 'Noise-Cancelling Headphones', price: '249.00' },
      }),
      prisma.product.upsert({
        where: { id: 4 },
        update: { name: 'Mechanical Keyboard', price: '129.95' },
        create: { name: 'Mechanical Keyboard', price: '129.95' },
      }),
      prisma.product.upsert({
        where: { id: 5 },
        update: { name: 'Ergonomic Mouse', price: '79.99' },
        create: { name: 'Ergonomic Mouse', price: '79.99' },
      }),
      prisma.product.upsert({
        where: { id: 6 },
        update: { name: '4K Monitor 27"', price: '599.00' },
        create: { name: '4K Monitor 27"', price: '599.00' },
      }),
      prisma.product.upsert({
        where: { id: 7 },
        update: { name: 'HD Webcam', price: '89.95' },
        create: { name: 'HD Webcam', price: '89.95' },
      }),
    ]);


  const products = [laptop, phone, headphones, keyboard, mouse, monitor, webcam];
  console.log(`✅ Products: ${products.map((p) => p.name).join(', ')}`);

  // ── Orders with items ──────────────────────────────────────────────────────
  // Helper to compute the total from items
  const total = (items: { unitPrice: string; quantity: number }[]) =>
    items.reduce((sum, i) => sum + Number(i.unitPrice) * i.quantity, 0);

  // Order 1 — Alice, COMPLETED
  const order1Items = [
    { productId: laptop.id, quantity: 1, unitPrice: laptop.price.toString() },
    { productId: headphones.id, quantity: 2, unitPrice: headphones.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 1 },
    update: {},
    create: {
      customerId: alice.id,
      status: 'COMPLETED',
      total: total(order1Items),
      orderItems: { create: order1Items },
    },
  });

  // Order 2 — Bob, PAID
  const order2Items = [
    { productId: phone.id, quantity: 1, unitPrice: phone.price.toString() },
    { productId: keyboard.id, quantity: 1, unitPrice: keyboard.price.toString() },
    { productId: mouse.id, quantity: 1, unitPrice: mouse.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 2 },
    update: {},
    create: {
      customerId: bob.id,
      status: 'PAID',
      total: total(order2Items),
      orderItems: { create: order2Items },
    },
  });

  // Order 3 — Carol, PROCESSING
  const order3Items = [
    { productId: monitor.id, quantity: 2, unitPrice: monitor.price.toString() },
    { productId: webcam.id, quantity: 1, unitPrice: webcam.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 3 },
    update: {},
    create: {
      customerId: carol.id,
      status: 'PROCESSING',
      total: total(order3Items),
      orderItems: { create: order3Items },
    },
  });

  // Order 4 — Dave, PAYMENT_PROCESSING
  const order4Items = [
    { productId: laptop.id, quantity: 1, unitPrice: laptop.price.toString() },
    { productId: mouse.id, quantity: 2, unitPrice: mouse.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 4 },
    update: {},
    create: {
      customerId: dave.id,
      status: 'PAYMENT_PROCESSING',
      total: total(order4Items),
      orderItems: { create: order4Items },
    },
  });

  // Order 5 — Eve, PENDING
  const order5Items = [
    { productId: keyboard.id, quantity: 3, unitPrice: keyboard.price.toString() },
    { productId: headphones.id, quantity: 1, unitPrice: headphones.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 5 },
    update: {},
    create: {
      customerId: eve.id,
      status: 'PENDING',
      total: total(order5Items),
      orderItems: { create: order5Items },
    },
  });

  // Order 6 — Alice, FAILED
  const order6Items = [
    { productId: phone.id, quantity: 1, unitPrice: phone.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 6 },
    update: {},
    create: {
      customerId: alice.id,
      status: 'FAILED',
      total: total(order6Items),
      orderItems: { create: order6Items },
    },
  });

  // Order 7 — Bob, CANCELLED
  const order7Items = [
    { productId: monitor.id, quantity: 1, unitPrice: monitor.price.toString() },
    { productId: webcam.id, quantity: 2, unitPrice: webcam.price.toString() },
  ];
  await prisma.order.upsert({
    where: { id: 7 },
    update: {},
    create: {
      customerId: bob.id,
      status: 'CANCELLED',
      total: total(order7Items),
      orderItems: { create: order7Items },
    },
  });

  console.log('✅ Orders (7) with OrderItems created');
  console.log('🎉 Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
