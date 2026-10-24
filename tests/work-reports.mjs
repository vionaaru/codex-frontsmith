// Проверка структурированных результатов разбора сообщений, прикладного слоя и настоящего CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openOfficeDb, migrate, assertHealthy } from '../office/lib/db.mjs';
import * as ops from '../office/lib/operations.mjs';
import { registerWorkReport } from '../office/lib/work-reports.mjs';
import { matchVehicle } from '../office/lib/matching.mjs';
import { getWorkOrder } from '../office/lib/repositories.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'frontsmith-work-reports-'));
const db = openOfficeDb({ file: path.join(root, 'office.sqlite') });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
try {
  migrate(db);
  const ctx = ops.createContext(db, { actor: 'тестовый мастер', now: () => new Date('2026-10-16T15:00:00.000Z') });
  // Клиент — только client_id: контакты живут в CustomerProvider и здесь не нужны
  const customer = { id: '6f1c2a4e-1111-4c3b-9e7a-2a1b3c4d5e6f' };
  db.prepare("INSERT INTO customers (id, is_demo, created_at, updated_at) VALUES (?, 0, ?, ?)").run(customer.id, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  const bmw = ops.addVehicle(ctx, { customerId: customer.id, make: 'BMW', plate: 'А123ВС77' });
  const mazda = ops.addVehicle(ctx, { customerId: customer.id, make: 'Mazda', model: '3', plate: 'М456ОР77' });
  const base = { vehicleId: bmw.id, identityConfirmed: true, performedOn: '2026-10-11', works: ['Замена масла'], finalTotalKopecks: 250000, actualDurationMinutes: 60, basis: 'Отчёт мастера', costApprovalBasis: 'Иван подтвердил стоимость по телефону' };
  const counts = () => ['work_orders', 'activity_events', 'order_items'].map(t => db.prepare(`SELECT count(*) n FROM ${t}`).get().n);
  let first;
  check('одна работа: preview полностью откатывает заказ и журнал', () => {
    const before = counts();
    assert.equal(registerWorkReport(ctx, base, { dryRun: true }).status, 'preview');
    assert.deepEqual(counts(), before);
  });
  check('один автомобиль: дата, стоимость, часы, FK, журнал и панель', () => {
    first = registerWorkReport(ctx, base);
    const order = getWorkOrder(db, first.order.id);
    assert.equal(order.vehicle_id, bmw.id);
    assert.equal(order.customer_id, customer.id);
    assert.equal(order.status, 'ready');
    assert.equal(order.completed_at, null);
    assert.equal(order.performed_on, '2026-10-11');
    assert.equal(order.final_total_kopecks, 250000);
    assert.equal(order.actual_duration_minutes, 60);
    assert.equal(order.items.length, 0);
    assert.ok(order.events.some(e => e.action === 'work_report_registered'));
    assertHealthy(db);
  });
  check('повтор сообщения, пробелы и регистр: нет новых записей', () => {
    const before = counts();
    const repeat = registerWorkReport(ctx, { ...base, works: [' замена   МАСЛА '] });
    assert.equal(repeat.status, 'existing');
    assert.equal(repeat.order.id, first.order.id);
    assert.deepEqual(counts(), before);
  });
  check('несколько работ и машин: общие суммы, 8 и 1,5 часа, разные даты', () => {
    const b = registerWorkReport(ctx, { ...base, performedOn: '2026-10-12', works: ['Замена рейки', 'Замена колодок'], finalTotalKopecks: 1700000, actualDurationMinutes: 480, newOrderConfirmed: true });
    const m = registerWorkReport(ctx, { ...base, vehicleId: mazda.id, works: ['ШРУС', 'Шаровая'], finalTotalKopecks: 650000, actualDurationMinutes: 90 });
    assert.equal(b.order.actual_duration_minutes, 480);
    assert.equal(m.order.actual_duration_minutes, 90);
    assert.equal(m.order.vehicle_id, mazda.id);
    assert.equal(b.order.performed_on, '2026-10-12');
    assert.ok(b.order.note.includes('Замена рейки; Замена колодок'));
    assert.equal(b.order.final_total_kopecks, 1700000);
    assert.equal(b.order.items.length, 0);
    assert.equal(m.order.items.length, 0);
  });
  check('дни без известных часов: NULL минут и сохранённое пояснение', () => {
    const r = registerWorkReport(ctx, { ...base, performedOn: '2026-10-13', actualDurationMinutes: null, durationNote: '2 дня; фактические часы неизвестны', newOrderConfirmed: true });
    assert.equal(r.order.actual_duration_minutes, null);
    assert.ok(r.order.note.includes('2 дня'));
  });
  check('неоднозначная идентификация: вопросы до записи', () => {
    const before = counts();
    assert.throws(() => matchVehicle(db, {}), /VIN, госномер или телефон/);
    assert.equal(matchVehicle(db, { phoneClientIds: [customer.id] }).verdict, 'ambiguous');
    assert.throws(() => registerWorkReport(ctx, { ...base, identityConfirmed: false }), /сопоставление/);
    assert.throws(() => registerWorkReport(ctx, { ...base, vehicleId: 'нет' }), /не найден/);
    assert.deepEqual(counts(), before);
  });
  check('неизвестные сумма, даты, отрицательное время и опечатки отклоняются', () => {
    const before = counts();
    for (const patch of [{ finalTotalKopecks: null }, { performedOn: '2026-02-30' }, { performedOn: '2026-10-17' }, { actualDurationMinutes: -1 }, { actualDurationMinutes: '2 дня' }, { work: 'ошибка' }]) {
      assert.throws(() => registerWorkReport(ctx, { ...base, ...patch }));
    }
    assert.deepEqual(counts(), before);
    assert.throws(() => db.prepare('UPDATE work_orders SET performed_on = ? WHERE id = ?').run('2026-02-30', first.order.id), /CHECK/);
  });
  check('ошибка согласования откатывает созданный заказ и все события', () => {
    const before = counts();
    assert.throws(() => registerWorkReport(ctx, { ...base, performedOn: '2026-10-14', newOrderConfirmed: true, costApprovalBasis: '' }), /согласования/);
    assert.deepEqual(counts(), before);
  });
  check('существующие факты и активный заказ защищены от перезаписи', () => {
    const before = counts();
    assert.throws(() => registerWorkReport(ctx, { ...base, finalTotalKopecks: 260000 }), /активные заказы/);
    assert.throws(() => registerWorkReport(ctx, { ...base, orderId: first.order.id, revision: first.order.revision, finalTotalKopecks: 260000 }), /уже есть отчёт/);
    assert.deepEqual(counts(), before);
  });
  check('связь с обращением и существующий согласованный заказ', () => {
    const inquiry = ops.createInquiry(ctx, { customerId: customer.id, vehicleId: bmw.id, source: 'walk_in', description: 'Стук в подвеске' });
    const before = counts();
    assert.throws(() => registerWorkReport(ctx, { ...base, vehicleId: mazda.id, inquiryId: inquiry.id, newOrderConfirmed: true, performedOn: '2026-10-15' }), /другому клиенту\/автомобилю/);
    assert.deepEqual(counts(), before);
    const order = ops.createWorkOrder(ctx, { inquiryId: inquiry.id });
    ops.setWorkOrderStatus(ctx, { id: order.id, status: 'awaiting_approval' });
    ops.decideOrderCost(ctx, { id: order.id, decision: 'approved', totalKopecks: 300000, basis: 'Иван подтвердил' });
    const current = getWorkOrder(db, order.id);
    const input = { ...base, performedOn: '2026-10-14', works: ['Диагностика подвески'], orderId: order.id, revision: current.revision, costApprovalBasis: undefined };
    assert.throws(() => registerWorkReport(ctx, { ...input, revision: 1 }), /revision/);
    const result = registerWorkReport(ctx, input);
    assert.equal(result.order.inquiry_id, inquiry.id);
    assert.equal(result.order.approved_total_kopecks, 300000);
    assert.equal(result.order.final_total_kopecks, 250000);
    assert.equal(db.prepare('SELECT status FROM inquiries WHERE id = ?').get(inquiry.id).status, 'converted');
  });
  check('UTF-8 stdin CLI: dry-run, регистрация, show и повтор после перезапуска', () => {
    const input = { ...base, performedOn: '2026-10-10', newOrderConfirmed: true, works: ['Замена свечей — проверка UTF-8'] };
    const cli = (args, report) => {
      const r = spawnSync(process.execPath, ['scripts/office.mjs', ...args], { env: { ...process.env, FRONTSMITH_BUSINESS_ROOT: root }, input: report ? JSON.stringify(report) : undefined, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    };
    const before = counts();
    assert.equal(cli(['report:register', '--dry-run'], input).status, 'preview');
    assert.deepEqual(counts(), before);
    const saved = cli(['report:register'], input);
    assert.equal(saved.status, 'registered');
    const read = cli(['show', 'order', '--id', saved.order.id]);
    assert.ok(read.note.includes('Замена свечей — проверка UTF-8'));
    assert.equal(cli(['report:register'], input).status, 'existing');
    const bad = spawnSync(process.execPath, ['scripts/office.mjs', 'report:register'], { env: { ...process.env, FRONTSMITH_BUSINESS_ROOT: root }, input: '{', encoding: 'utf8' });
    assert.equal(bad.status, 1);
  });
  assertHealthy(db);
  console.log(`Work reports: ${passed} проверок пройдено`);
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
