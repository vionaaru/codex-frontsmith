// Прикладная транзакция регистрации одного автомобиля из свободного отчёта.
// Разбор языка и разрешение неоднозначностей выполняет Codex до вызова операции.
import { createHash } from 'node:crypto';
import { OfficeValidationError, newId } from './domain.mjs';
import * as ops from './operations.mjs';
import { getWorkOrder, insertEvent } from './repositories.mjs';

const fail = (message) => { throw new OfficeValidationError(message); };
const text = (value, field) => typeof value === 'string' && value.trim() ? value.trim() : fail(`Не заполнено: ${field}`);
const fold = (value) => value.normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();

export function registerWorkReport(ctx, input, { dryRun = false } = {}) {
  let preview;
  const rollback = new Error('work-report-preview');
  try {
    return ctx.db.transaction(() => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Ожидается один объект отчёта');
      const fields = ['basis', 'performedOn', 'works', 'finalTotalKopecks', 'actualDurationMinutes', 'durationNote', 'note', 'vehicleId', 'identityConfirmed', 'orderId', 'revision', 'inquiryId', 'newOrderConfirmed', 'costApprovalBasis', 'approvedTotalKopecks'];
      for (const key of Object.keys(input)) if (!fields.includes(key)) fail(`Неизвестное поле отчёта: ${key}`);
      if (input.note !== undefined && typeof input.note !== 'string') fail('Заметка должна быть строкой');
      const basis = text(input.basis, 'основание отчёта');
      const day = text(input.performedOn, 'дата выполнения YYYY-MM-DD');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) fail('Некорректный день выполнения');
      const timeZone = ctx.db.prepare('SELECT time_zone FROM business WHERE singleton = 1').get()?.time_zone ?? 'Europe/Moscow';
      const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now());
      if (day > today) fail('Дата выполнения не может быть в будущем');
      if (!Array.isArray(input.works) || !input.works.length) fail('Нужен перечень выполненных работ');
      const works = input.works.map((work) => text(work, 'название работы'));
      const total = input.finalTotalKopecks;
      if (!Number.isSafeInteger(total) || total < 0) fail('Итог: неотрицательное целое число копеек');
      const minutes = input.actualDurationMinutes ?? null;
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600)) fail('Фактическое время: 1–525600 минут или null');
      if (input.durationNote !== undefined && typeof input.durationNote !== 'string') fail('Пояснение длительности должно быть строкой');
      const vehicle = ctx.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(text(input.vehicleId, 'ID подтверждённого автомобиля'));
      if (!vehicle) fail('Автомобиль не найден: сначала сопоставьте или создайте его');
      if (input.identityConfirmed !== true) fail('Нужно подтверждённое сопоставление автомобиля');
      const fingerprint = createHash('sha256').update(JSON.stringify([
        vehicle.id, day, works.map(fold).sort(), total, minutes, fold(input.durationNote ?? '')
      ])).digest('hex');
      const previous = ctx.db.prepare("SELECT entity_id FROM activity_events WHERE action = 'work_report_registered' AND json_extract(details_json, '$.fingerprint') = ?").get(fingerprint);
      if (previous) return { status: 'existing', order: getWorkOrder(ctx.db, previous.entity_id) };

      let order;
      if (input.orderId) {
        order = ctx.db.prepare('SELECT * FROM work_orders WHERE id = ?').get(input.orderId);
        if (!order || order.vehicle_id !== vehicle.id) fail('Заказ не найден или относится к другому автомобилю');
        if (input.revision !== order.revision) fail('Укажите текущую revision заказа после чтения');
        if (ctx.db.prepare("SELECT 1 FROM activity_events WHERE entity_id = ? AND action = 'work_report_registered'").get(order.id)) fail('У заказа уже есть отчёт: уточните исправление, не перезаписывайте');
        if (order.performed_on !== null || order.actual_duration_minutes !== null || order.final_total_kopecks !== null) fail('У заказа уже есть факты: требуется отдельное уточнение исправления');
        if (!['draft', 'approved', 'in_progress', 'ready', 'completed'].includes(order.status)) fail('Статус заказа требует отдельного решения');
      } else {
        if (input.inquiryId) {
          const inquiry = ctx.db.prepare('SELECT * FROM inquiries WHERE id = ?').get(input.inquiryId);
          if (!inquiry || inquiry.customer_id !== vehicle.customer_id || (inquiry.vehicle_id && inquiry.vehicle_id !== vehicle.id)) fail('Обращение не найдено или относится к другому клиенту/автомобилю');
        }
        const active = ctx.db.prepare("SELECT id FROM work_orders WHERE vehicle_id = ? AND status NOT IN ('completed', 'cancelled')").all(vehicle.id);
        if (active.length && input.newOrderConfirmed !== true) fail('Есть активные заказы: выберите заказ или подтвердите отдельный ремонт');
        order = ops.createWorkOrder(ctx, { customerId: vehicle.customer_id, vehicleId: vehicle.id, inquiryId: input.inquiryId });
      }
      if (order.status === 'draft') {
        // Сообщение о факте ремонта само по себе не является согласием клиента на стоимость
        const approval = text(input.costApprovalBasis, 'подтверждение согласования стоимости клиентом');
        ops.setWorkOrderStatus(ctx, { id: order.id, status: 'awaiting_approval' });
        ops.decideOrderCost(ctx, { id: order.id, decision: 'approved', basis: approval, totalKopecks: input.approvedTotalKopecks ?? total });
        order = { ...order, status: 'approved' };
      }
      if (order.status === 'approved') {
        ops.setWorkOrderStatus(ctx, { id: order.id, status: 'in_progress' });
        order = { ...order, status: 'in_progress' };
      }
      if (order.status === 'in_progress') ops.setWorkOrderStatus(ctx, { id: order.id, status: 'ready' });
      ops.recordWorkResult(ctx, { id: order.id, basis, finalTotalKopecks: total, actualDurationMinutes: minutes });
      const current = ctx.db.prepare('SELECT * FROM work_orders WHERE id = ?').get(order.id);
      const note = [current.note, `Выполнено ${day}: ${works.join('; ')}`, input.durationNote, input.note].filter(Boolean).join('\n');
      const at = ctx.now().toISOString();
      ctx.db.prepare('UPDATE work_orders SET performed_on = ?, note = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(day, note, at, order.id);
      insertEvent(ctx.db, {
        id: newId(), occurred_at: at, entity_type: 'work_order', entity_id: order.id,
        action: 'work_report_registered', actor: ctx.actor, source: ctx.source,
        summary: `${order.number}: ${works.join('; ')}`,
        details_json: JSON.stringify({ fingerprint, basis, works, performedOn: day, finalTotalKopecks: total, actualDurationMinutes: minutes, durationNote: input.durationNote ?? null }),
        is_demo: order.is_demo
      });
      const result = { status: dryRun ? 'preview' : 'registered', order: getWorkOrder(ctx.db, order.id) };
      if (dryRun) { preview = result; throw rollback; }
      return result;
    }).immediate();
  } catch (error) {
    if (error === rollback) return preview;
    throw error;
  }
}
