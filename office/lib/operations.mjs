// Прикладные операции офиса. Каждая операция — одна транзакция: изменение + запись в журнал.
// CLI и будущие команды панели обязаны вызывать эти функции, а не писать SQL напрямую
import {
  OfficeValidationError,
  appointmentSources,
  appointmentStatuses,
  assertCompletedAt,
  assertTransition,
  inquirySources,
  inquiryStatuses,
  lineAmount,
  newId,
  taskStatuses,
  vinKey,
  vocabulary,
  workOrderStatuses
} from "./domain.mjs";
import { insertEvent } from "./repositories.mjs";

// vocabulary — словарь бизнес-профиля (vocabularyFor): подписи статусов в журнале событий.
// Без него — нейтральные подписи ядра
export function createContext(db, { actor = "оператор", source = "cli", now = () => new Date(), vocabulary: labels = vocabulary } = {}) {
  if (!String(actor).trim()) throw new OfficeValidationError("Не указан автор изменения");
  return { db, actor: String(actor).trim(), source, now, vocabulary: labels };
}

function label(ctx, kind, status) {
  return ctx.vocabulary?.[kind]?.[status]?.label ?? vocabulary[kind][status].label;
}

function run(ctx, fn) {
  return ctx.db.transaction(() => fn(ctx.now().toISOString()))();
}

function event(ctx, at, { entityType, entityId, action, summary, details = null, isDemo = false }) {
  insertEvent(ctx.db, {
    id: newId(),
    occurred_at: at,
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor: ctx.actor,
    source: ctx.source,
    summary,
    details_json: details === null ? null : JSON.stringify(details),
    is_demo: isDemo ? 1 : 0
  });
}

function required(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new OfficeValidationError(`Не заполнено обязательное поле: ${field}`);
  return text;
}

function optional(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function optionalInteger(value, field, { min, max }) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new OfficeValidationError(`${field}: ожидается целое число от ${min} до ${max}`);
  return number;
}

function find(ctx, table, id, label) {
  const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(required(id, `ID ${label}`));
  if (!row) throw new OfficeValidationError(`${label} не найден(а): ${id}`);
  return row;
}

function update(ctx, table, row, fields, at, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== row.revision) {
    throw new OfficeValidationError(`Запись изменилась: ожидалась ревизия ${expectedRevision}, текущая ${row.revision}. Обновите данные и повторите`);
  }
  const keys = Object.keys(fields);
  const sets = [...keys.map((key) => `${key} = @${key}`), "updated_at = @__at", "revision = revision + 1"].join(", ");
  const result = ctx.db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @__id AND revision = @__revision`)
    .run({ ...fields, __at: at, __id: row.id, __revision: row.revision });
  if (result.changes !== 1) throw new OfficeValidationError("Запись изменена параллельно. Повторите операцию");
}

function businessCurrency(ctx) {
  return ctx.db.prepare("SELECT currency FROM business WHERE singleton = 1").get()?.currency ?? "RUB";
}

// --- Клиенты и автомобили ---

// Клиенты создаются только через CustomerProvider (office/customers): контактов в этой базе нет

export function addVehicle(ctx, { customerId, make, model, year, mileageKm, vin, plate, note, isDemo = false, id = newId() }) {
  return run(ctx, (at) => {
    const customer = find(ctx, "customers", customerId, "Клиент");
    const row = {
      id,
      customer_id: customer.id,
      make: required(make, "марка"),
      model: optional(model),
      year: optionalInteger(year, "Год выпуска", { min: 1950, max: 2100 }),
      mileage_km: optionalInteger(mileageKm, "Пробег", { min: 0, max: 5_000_000 }),
      vin: vinKey(vin),
      plate: optional(plate),
      note: optional(note),
      is_demo: isDemo ? 1 : 0,
      created_at: at,
      updated_at: at
    };
    if (row.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(row.vin)) throw new OfficeValidationError("VIN должен содержать 17 символов без I, O, Q");
    ctx.db.prepare(`INSERT INTO vehicles (id, customer_id, make, model, year, mileage_km, vin, plate, note, is_demo, created_at, updated_at)
      VALUES (@id, @customer_id, @make, @model, @year, @mileage_km, @vin, @plate, @note, @is_demo, @created_at, @updated_at)`).run(row);
    event(ctx, at, { entityType: "vehicle", entityId: id, action: "created", summary: `Добавлен автомобиль ${row.make}${row.model ? ` ${row.model}` : ""}`, isDemo });
    return row;
  });
}

// --- Обращения ---

export function createInquiry(ctx, { customerId, vehicleId, serviceCode, source, externalId, description, assignee, receivedAt, isDemo = false, id = newId() }) {
  return run(ctx, (at) => {
    const customer = find(ctx, "customers", customerId, "Клиент");
    const vehicle = vehicleId ? find(ctx, "vehicles", vehicleId, "Автомобиль") : null;
    if (vehicle && vehicle.customer_id !== customer.id) throw new OfficeValidationError("Автомобиль принадлежит другому клиенту");
    const service = serviceCode ? serviceByCode(ctx, serviceCode) : null;
    const sourceKey = required(source, "источник");
    if (!(sourceKey in inquirySources)) throw new OfficeValidationError(`Неизвестный источник обращения: ${sourceKey}. Допустимо: ${Object.keys(inquirySources).join(", ")}`);
    const row = {
      id,
      customer_id: customer.id,
      vehicle_id: vehicle?.id ?? null,
      requested_service_id: service?.id ?? null,
      source: sourceKey,
      external_id: optional(externalId),
      description: required(description, "описание обращения"),
      status: "new",
      assignee: optional(assignee),
      received_at: receivedAt ?? at,
      is_demo: isDemo ? 1 : 0,
      created_at: at,
      updated_at: at
    };
    ctx.db.prepare(`INSERT INTO inquiries (id, customer_id, vehicle_id, requested_service_id, source, external_id, description, status, assignee, received_at, is_demo, created_at, updated_at)
      VALUES (@id, @customer_id, @vehicle_id, @requested_service_id, @source, @external_id, @description, @status, @assignee, @received_at, @is_demo, @created_at, @updated_at)`).run(row);
    event(ctx, at, { entityType: "inquiry", entityId: id, action: "created", summary: `Новое обращение${service ? `: ${service.name}` : ""}`, details: { source: sourceKey }, isDemo });
    return row;
  });
}

export function setInquiryStatus(ctx, { id, status, note, revision }) {
  return run(ctx, (at) => {
    const inquiry = find(ctx, "inquiries", id, "Обращение");
    if (status === "converted") throw new OfficeValidationError(`Статус «${label(ctx, "inquiry", "converted")}» ставится операцией order:create`);
    assertTransition(ctx.vocabulary?.inquiry ?? inquiryStatuses, inquiry.status, status, "Обращение");
    update(ctx, "inquiries", inquiry, { status, closed_at: status === "closed" ? at : null }, at, revision);
    event(ctx, at, { entityType: "inquiry", entityId: id, action: "status_changed", summary: `Обращение: ${label(ctx, "inquiry", inquiry.status)} → ${label(ctx, "inquiry", status)}`, details: { from: inquiry.status, to: status, note: optional(note) }, isDemo: inquiry.is_demo === 1 });
    return { ...inquiry, status };
  });
}

// --- Заказы работ ---

export function createWorkOrder(ctx, { inquiryId, customerId, vehicleId, number, plannedStartAt, plannedEndAt, assignee, note, isDemo, id = newId() }) {
  return run(ctx, (at) => {
    const inquiry = inquiryId ? find(ctx, "inquiries", inquiryId, "Обращение") : null;
    if (inquiry && !["new", "in_progress", "waiting_customer"].includes(inquiry.status)) {
      throw new OfficeValidationError(`Обращение уже в статусе «${label(ctx, "inquiry", inquiry.status)}»; заказ из него не создаётся`);
    }
    const customer = find(ctx, "customers", inquiry?.customer_id ?? customerId, "Клиент");
    const vehicle = find(ctx, "vehicles", vehicleId ?? inquiry?.vehicle_id, "Автомобиль");
    if (vehicle.customer_id !== customer.id) throw new OfficeValidationError("Автомобиль принадлежит другому клиенту");
    const demo = isDemo ?? ((inquiry ?? customer).is_demo === 1);
    const row = {
      id,
      number: optional(number) ?? nextOrderNumber(ctx, at),
      customer_id: customer.id,
      vehicle_id: vehicle.id,
      inquiry_id: inquiry?.id ?? null,
      status: "draft",
      currency: businessCurrency(ctx),
      planned_start_at: plannedStartAt ?? null,
      planned_end_at: plannedEndAt ?? null,
      assignee: optional(assignee),
      note: optional(note),
      is_demo: demo ? 1 : 0,
      created_at: at,
      updated_at: at
    };
    ctx.db.prepare(`INSERT INTO work_orders (id, number, customer_id, vehicle_id, inquiry_id, status, currency, planned_start_at, planned_end_at, assignee, note, is_demo, created_at, updated_at)
      VALUES (@id, @number, @customer_id, @vehicle_id, @inquiry_id, @status, @currency, @planned_start_at, @planned_end_at, @assignee, @note, @is_demo, @created_at, @updated_at)`).run(row);
    event(ctx, at, { entityType: "work_order", entityId: id, action: "created", summary: `Создан заказ ${row.number}`, details: { inquiryId: inquiry?.id ?? null }, isDemo: demo });
    if (inquiry) {
      update(ctx, "inquiries", inquiry, { status: "converted", closed_at: at }, at);
      event(ctx, at, { entityType: "inquiry", entityId: inquiry.id, action: "converted", summary: `Обращение оформлено в заказ ${row.number}`, details: { workOrderId: id }, isDemo: inquiry.is_demo === 1 });
    }
    return row;
  });
}

function nextOrderNumber(ctx, at) {
  const prefix = `ЗН-${at.slice(0, 4)}-`;
  const last = ctx.db.prepare("SELECT number FROM work_orders WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(`${prefix}%`)?.number;
  const next = last ? Number(last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export function addOrderItem(ctx, { workOrderId, kind, serviceCode, title, unitPriceKopecks, quantityMilli = 1000, id = newId() }) {
  return run(ctx, (at) => {
    const order = find(ctx, "work_orders", workOrderId, "Заказ");
    if (order.status !== "draft") throw new OfficeValidationError("Позиции меняются только в черновике заказа. Верните заказ в черновик: прежнее согласование стоимости будет сброшено");
    if (!["service", "part"].includes(kind)) throw new OfficeValidationError("Тип позиции: service или part");
    const service = kind === "service" && serviceCode ? serviceByCode(ctx, serviceCode) : null;
    if (kind === "part" && serviceCode) throw new OfficeValidationError("Запчасть не ссылается на услугу каталога");
    const price = unitPriceKopecks ?? service?.base_price_kopecks;
    if (price === null || price === undefined) throw new OfficeValidationError("Цена не указана и не задана в каталоге: передайте --price");
    if (service && service.currency !== order.currency) throw new OfficeValidationError("Валюта услуги не совпадает с валютой заказа");
    const row = {
      id,
      work_order_id: order.id,
      kind,
      service_id: service?.id ?? null,
      title: optional(title) ?? service?.name ?? required(title, "название позиции"),
      unit_price_kopecks: price,
      quantity_milli: quantityMilli,
      amount_kopecks: lineAmount(price, quantityMilli),
      currency: order.currency,
      sort_order: ctx.db.prepare("SELECT coalesce(max(sort_order), 0) + 1 AS n FROM order_items WHERE work_order_id = ?").get(order.id).n,
      is_demo: order.is_demo,
      created_at: at
    };
    ctx.db.prepare(`INSERT INTO order_items (id, work_order_id, kind, service_id, title, unit_price_kopecks, quantity_milli, amount_kopecks, currency, sort_order, is_demo, created_at)
      VALUES (@id, @work_order_id, @kind, @service_id, @title, @unit_price_kopecks, @quantity_milli, @amount_kopecks, @currency, @sort_order, @is_demo, @created_at)`).run(row);
    update(ctx, "work_orders", order, {}, at);
    event(ctx, at, { entityType: "work_order", entityId: order.id, action: "item_added", summary: `${order.number}: добавлена позиция «${row.title}»`, details: { itemId: id, kind, amountKopecks: row.amount_kopecks }, isDemo: order.is_demo === 1 });
    return row;
  });
}

export function orderEstimateKopecks(db, workOrderId) {
  return db.prepare("SELECT coalesce(sum(amount_kopecks), 0) AS total FROM order_items WHERE work_order_id = ?").get(workOrderId).total;
}

// completedAt — фактическое время выдачи из отчёта; без него берётся текущее
export function setWorkOrderStatus(ctx, { id, status, note, completedAt, revision }) {
  return run(ctx, (at) => {
    const order = find(ctx, "work_orders", id, "Заказ");
    assertTransition(workOrderStatuses, order.status, status, `Заказ ${order.number}`);
    if (status === "approved") throw new OfficeValidationError("Заказ становится согласованным через order:cost --decision approved с основанием");
    if (completedAt && status !== "completed") throw new OfficeValidationError("Дата завершения указывается только при переводе в «Выдан»");
    const fields = { status };
    // Без позиций можно: общая сумма тогда указывается при согласовании
    if (status === "awaiting_approval") Object.assign(fields, { cost_approval: "requested", approved_total_kopecks: null, cost_approved_at: null });
    if (status === "draft") Object.assign(fields, { cost_approval: "not_requested", approved_total_kopecks: null, cost_approved_at: null });
    fields.completed_at = status === "completed" ? (completedAt ? assertCompletedAt(completedAt, ctx.now()) : at) : null;
    // Возврат на доработку: прежние факты устаревают, их значения остаются в журнале
    const cleared = status === "in_progress" && (order.actual_duration_minutes !== null || order.final_total_kopecks !== null)
      ? { actualDurationMinutes: order.actual_duration_minutes, finalTotalKopecks: order.final_total_kopecks } : null;
    if (status === "in_progress") Object.assign(fields, { actual_duration_minutes: null, final_total_kopecks: null });
    update(ctx, "work_orders", order, fields, at, revision);
    event(ctx, at, { entityType: "work_order", entityId: id, action: "status_changed", summary: `${order.number}: ${workOrderStatuses[order.status].label} → ${workOrderStatuses[status].label}`, details: { from: order.status, to: status, note: optional(note), completedAt: fields.completed_at, clearedResult: cleared }, isDemo: order.is_demo === 1 });
    return { ...order, ...fields };
  });
}

// Факты выполненного ремонта: фактическое время, итоговая сумма, уточнённая дата выдачи.
// undefined — не менять, null — стереть. Итог не раскладывается на позиции
export function recordWorkResult(ctx, { id, actualDurationMinutes, finalTotalKopecks, completedAt, basis, revision }) {
  return run(ctx, (at) => {
    const order = find(ctx, "work_orders", id, "Заказ");
    if (!["ready", "completed"].includes(order.status)) {
      throw new OfficeValidationError(`${order.number}: факты работ фиксируются для заказа в статусе «Готов к выдаче» или «Выдан», сейчас «${workOrderStatuses[order.status].label}»`);
    }
    const reason = required(basis, "основание (например: отчёт владельца от 14.10)");
    const fields = {};
    if (actualDurationMinutes !== undefined) {
      fields.actual_duration_minutes = actualDurationMinutes === null ? null : optionalInteger(actualDurationMinutes, "Фактическое время, мин", { min: 1, max: 525_600 });
    }
    if (finalTotalKopecks !== undefined) {
      if (finalTotalKopecks !== null && (!Number.isSafeInteger(finalTotalKopecks) || finalTotalKopecks < 0)) throw new OfficeValidationError("Итоговая стоимость: неотрицательное целое число копеек");
      fields.final_total_kopecks = finalTotalKopecks;
    }
    if (completedAt !== undefined) {
      if (order.status !== "completed") throw new OfficeValidationError("Дата завершения уточняется только у выданного заказа; для выдачи используйте order:status --to completed");
      fields.completed_at = assertCompletedAt(completedAt, ctx.now());
    }
    const changed = Object.keys(fields).filter((key) => fields[key] !== order[key]);
    if (!changed.length) throw new OfficeValidationError("Нет изменений: передайте фактическое время, итоговую стоимость или дату завершения");
    update(ctx, "work_orders", order, fields, at, revision);
    event(ctx, at, {
      entityType: "work_order",
      entityId: id,
      action: "work_result_recorded",
      summary: `${order.number}: записаны факты выполненных работ`,
      details: { basis: reason, changes: Object.fromEntries(changed.map((key) => [key, { from: order[key], to: fields[key] }])) },
      isDemo: order.is_demo === 1
    });
    return { ...order, ...fields };
  });
}

function itemCount(ctx, workOrderId) {
  return ctx.db.prepare("SELECT count(*) AS n FROM order_items WHERE work_order_id = ?").get(workOrderId).n;
}

function approvedTotal(ctx, order, totalKopecks) {
  const given = totalKopecks === undefined || totalKopecks === null ? null : totalKopecks;
  if (given !== null && (!Number.isSafeInteger(given) || given < 0)) throw new OfficeValidationError("Согласованная сумма: неотрицательное целое число копеек");
  if (!itemCount(ctx, order.id)) {
    if (given === null) throw new OfficeValidationError(`${order.number}: позиций нет — укажите общую согласованную сумму`);
    return given;
  }
  const estimate = orderEstimateKopecks(ctx.db, order.id);
  if (given !== null && given !== estimate) throw new OfficeValidationError(`${order.number}: сумма позиций ${estimate / 100} ₽; общая сумма указывается только для заказа без позиций`);
  return estimate;
}

// totalKopecks — общая согласованная сумма для заказа без позиций. С позициями сумма считается по ним
export function decideOrderCost(ctx, { id, decision, basis, totalKopecks, revision }) {
  return run(ctx, (at) => {
    const order = find(ctx, "work_orders", id, "Заказ");
    if (order.status !== "awaiting_approval") throw new OfficeValidationError("Решение по стоимости фиксируется только для заказа в статусе «Ждёт согласования»");
    const reason = required(basis, "основание решения клиента (кто, когда, каким способом)");
    let fields;
    if (decision === "approved") {
      fields = { status: "approved", cost_approval: "approved", approved_total_kopecks: approvedTotal(ctx, order, totalKopecks), cost_approved_at: at };
    } else if (decision === "declined") {
      if (totalKopecks !== undefined && totalKopecks !== null) throw new OfficeValidationError("Сумма указывается только при согласовании");
      fields = { status: "draft", cost_approval: "declined", approved_total_kopecks: null, cost_approved_at: null };
    } else {
      throw new OfficeValidationError("Решение: approved или declined");
    }
    update(ctx, "work_orders", order, fields, at, revision);
    event(ctx, at, {
      entityType: "work_order",
      entityId: id,
      action: decision === "approved" ? "cost_approved" : "cost_declined",
      summary: decision === "approved" ? `${order.number}: клиент согласовал стоимость` : `${order.number}: клиент не согласовал стоимость, заказ возвращён в черновик`,
      details: { basis: reason, approvedTotalKopecks: fields.approved_total_kopecks },
      isDemo: order.is_demo === 1
    });
    return { ...order, ...fields };
  });
}

// --- Записи на время ---

export function createAppointment(ctx, { inquiryId, workOrderId, startsAt, endsAt, source, externalId, note, isDemo, id = newId() }) {
  return run(ctx, (at) => {
    const inquiry = inquiryId ? find(ctx, "inquiries", inquiryId, "Обращение") : null;
    const order = workOrderId ? find(ctx, "work_orders", workOrderId, "Заказ") : null;
    if (!inquiry && !order) throw new OfficeValidationError("Запись должна ссылаться на обращение или заказ");
    if (inquiry && order && order.inquiry_id && order.inquiry_id !== inquiry.id) throw new OfficeValidationError("Заказ создан из другого обращения");
    const sourceKey = required(source, "источник записи");
    if (!(sourceKey in appointmentSources)) throw new OfficeValidationError(`Неизвестный источник записи: ${sourceKey}`);
    if (!(endsAt > startsAt)) throw new OfficeValidationError("Окончание записи должно быть позже начала");
    const demo = isDemo ?? ((inquiry ?? order).is_demo === 1);
    const row = { id, inquiry_id: inquiry?.id ?? null, work_order_id: order?.id ?? null, starts_at: startsAt, ends_at: endsAt, status: "tentative", source: sourceKey, external_id: optional(externalId), note: optional(note), is_demo: demo ? 1 : 0, created_at: at, updated_at: at };
    ctx.db.prepare(`INSERT INTO appointments (id, inquiry_id, work_order_id, starts_at, ends_at, status, source, external_id, note, is_demo, created_at, updated_at)
      VALUES (@id, @inquiry_id, @work_order_id, @starts_at, @ends_at, @status, @source, @external_id, @note, @is_demo, @created_at, @updated_at)`).run(row);
    event(ctx, at, { entityType: "appointment", entityId: id, action: "created", summary: "Добавлена предварительная запись", details: { startsAt, inquiryId: row.inquiry_id, workOrderId: row.work_order_id }, isDemo: demo });
    return row;
  });
}

export function setAppointmentStatus(ctx, { id, status, basis, revision }) {
  return run(ctx, (at) => {
    const appointment = find(ctx, "appointments", id, "Запись");
    assertTransition(ctx.vocabulary?.appointment ?? appointmentStatuses, appointment.status, status, "Запись");
    const fields = { status };
    if (status === "confirmed") fields.confirmation_basis = required(basis, "основание подтверждения (например: клиент подтвердил по телефону)");
    update(ctx, "appointments", appointment, fields, at, revision);
    event(ctx, at, { entityType: "appointment", entityId: id, action: "status_changed", summary: `Запись: ${label(ctx, "appointment", appointment.status)} → ${label(ctx, "appointment", status)}`, details: { from: appointment.status, to: status, basis: optional(basis) }, isDemo: appointment.is_demo === 1 });
    return { ...appointment, ...fields };
  });
}

// --- Задачи ---

export function createTask(ctx, { inquiryId, workOrderId, title, dueAt, assignee, isDemo, id = newId() }) {
  return run(ctx, (at) => {
    const inquiry = inquiryId ? find(ctx, "inquiries", inquiryId, "Обращение") : null;
    const order = workOrderId ? find(ctx, "work_orders", workOrderId, "Заказ") : null;
    const demo = isDemo ?? ((inquiry ?? order)?.is_demo === 1);
    const row = { id, inquiry_id: inquiry?.id ?? null, work_order_id: order?.id ?? null, title: required(title, "название задачи"), status: "open", due_at: dueAt ?? null, assignee: optional(assignee), is_demo: demo ? 1 : 0, created_at: at, updated_at: at };
    ctx.db.prepare(`INSERT INTO tasks (id, inquiry_id, work_order_id, title, status, due_at, assignee, is_demo, created_at, updated_at)
      VALUES (@id, @inquiry_id, @work_order_id, @title, @status, @due_at, @assignee, @is_demo, @created_at, @updated_at)`).run(row);
    event(ctx, at, { entityType: "task", entityId: id, action: "created", summary: `Задача: ${row.title}`, details: { dueAt: row.due_at }, isDemo: demo });
    return row;
  });
}

export function setTaskStatus(ctx, { id, status, revision }) {
  return run(ctx, (at) => {
    const task = find(ctx, "tasks", id, "Задача");
    assertTransition(taskStatuses, task.status, status, "Задача");
    const fields = { status, completed_at: status === "done" ? at : null };
    update(ctx, "tasks", task, fields, at, revision);
    event(ctx, at, { entityType: "task", entityId: id, action: "status_changed", summary: `Задача «${task.title}»: ${taskStatuses[task.status].label} → ${taskStatuses[status].label}`, details: { from: task.status, to: status }, isDemo: task.is_demo === 1 });
    return { ...task, ...fields };
  });
}

// --- Каталог услуг ---

function serviceByCode(ctx, code) {
  const service = ctx.db.prepare("SELECT * FROM services WHERE code = ?").get(required(code, "код услуги"));
  if (!service) throw new OfficeValidationError(`Услуга с кодом «${code}» не найдена в каталоге`);
  return service;
}

export function setServicePrice(ctx, { code, priceKopecks, demoPrice, revision }) {
  return run(ctx, (at) => {
    const service = serviceByCode(ctx, code);
    const fields = { base_price_kopecks: priceKopecks };
    if (demoPrice !== undefined) fields.is_demo_price = demoPrice ? 1 : 0;
    update(ctx, "services", service, fields, at, revision);
    event(ctx, at, { entityType: "service", entityId: service.id, action: "price_changed", summary: `Цена «${service.name}» изменена`, details: { fromKopecks: service.base_price_kopecks, toKopecks: priceKopecks, demoPrice: fields.is_demo_price ?? service.is_demo_price } });
    return { ...service, ...fields };
  });
}

export function setServiceActive(ctx, { code, active, revision }) {
  return run(ctx, (at) => {
    const service = serviceByCode(ctx, code);
    if ((service.is_active === 1) === active) throw new OfficeValidationError(`Услуга уже ${active ? "активна" : "скрыта"}`);
    update(ctx, "services", service, { is_active: active ? 1 : 0 }, at, revision);
    event(ctx, at, { entityType: "service", entityId: service.id, action: active ? "activated" : "deactivated", summary: `Услуга «${service.name}» ${active ? "возвращена в каталог" : "скрыта из каталога"}` });
    return service;
  });
}
