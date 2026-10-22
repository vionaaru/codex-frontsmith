// SQL-слой офиса: только запросы и маппинг строк. Правила и транзакции — в operations.mjs
import {
  activeInquiryStatuses,
  activeWorkOrderStatuses,
  openTaskStatuses,
  upcomingAppointmentStatuses
} from "./domain.mjs";

export function registerFunctions(db) {
  // SQLite lower() не понимает кириллицу; поиск сравнивает свёрнутые строки
  db.function("fs_fold", { deterministic: true }, (value) => (value === null ? null : String(value).toLocaleLowerCase("ru")));
  return db;
}

const fold = (value) => String(value ?? "").trim().toLocaleLowerCase("ru");
const placeholders = (values) => values.map(() => "?").join(", ");

const orderTotalSql = `(SELECT coalesce(sum(amount_kopecks), 0) FROM order_items oi WHERE oi.work_order_id = wo.id)`;
const orderValueSql = `coalesce(wo.final_total_kopecks, wo.approved_total_kopecks, ${orderTotalSql})`;

export function getBusiness(db) {
  return db.prepare("SELECT * FROM business WHERE singleton = 1").get() ?? null;
}

export function overview(db, { now, dayStart, dayEnd, month = dayStart.slice(0, 7) }) {
  const inquiryCounts = countBy(db, "inquiries", "status");
  const orderCounts = countBy(db, "work_orders", "status");
  const estimate = db.prepare(`SELECT count(*) AS orders, coalesce(sum(${orderValueSql}), 0) AS total, min(wo.currency) AS currency, count(DISTINCT wo.currency) AS currencies
    FROM work_orders wo WHERE wo.status IN (${placeholders(activeWorkOrderStatuses)})`).get(...activeWorkOrderStatuses);

  return {
    monthlyWork: monthlyWork(db, month),
    counts: {
      inquiries: inquiryCounts,
      workOrders: orderCounts,
      activeInquiries: sumStatuses(inquiryCounts, activeInquiryStatuses),
      activeWorkOrders: sumStatuses(orderCounts, activeWorkOrderStatuses),
      customers: db.prepare("SELECT count(*) AS n FROM customers").get().n,
      vehicles: db.prepare("SELECT count(*) AS n FROM vehicles").get().n,
      services: db.prepare("SELECT count(*) AS n FROM services WHERE is_active = 1").get().n,
      overdueTasks: db.prepare(`SELECT count(*) AS n FROM tasks WHERE status IN (${placeholders(openTaskStatuses)}) AND due_at < ?`).get(...openTaskStatuses, now).n,
      todayTasks: db.prepare(`SELECT count(*) AS n FROM tasks WHERE status IN (${placeholders(openTaskStatuses)}) AND due_at >= ? AND due_at < ?`).get(...openTaskStatuses, now, dayEnd).n,
      demoRecords: db.prepare(`SELECT
        (SELECT count(*) FROM customers WHERE is_demo = 1) + (SELECT count(*) FROM inquiries WHERE is_demo = 1) +
        (SELECT count(*) FROM work_orders WHERE is_demo = 1) + (SELECT count(*) FROM tasks WHERE is_demo = 1) +
        (SELECT count(*) FROM appointments WHERE is_demo = 1) AS n`).get().n,
      realRecords: db.prepare(`SELECT
        (SELECT count(*) FROM customers WHERE is_demo = 0) + (SELECT count(*) FROM inquiries WHERE is_demo = 0) +
        (SELECT count(*) FROM work_orders WHERE is_demo = 0) + (SELECT count(*) FROM tasks WHERE is_demo = 0) +
        (SELECT count(*) FROM appointments WHERE is_demo = 0) AS n`).get().n
    },
    activeOrdersEstimate: estimate.currencies > 1 ? { ...estimate, total: null, mixedCurrencies: true } : estimate,
    activeInquiries: listInquiries(db, { statuses: activeInquiryStatuses, limit: 8 }),
    activeWorkOrders: listWorkOrders(db, { statuses: activeWorkOrderStatuses, limit: 8 }),
    recentPerformedWork: listWorkOrders(db, { performed: true, limit: 8 }),
    overdueTasks: listTasks(db, { due: "overdue", now, dayStart, dayEnd, limit: 20 }),
    todayTasks: listTasks(db, { due: "today", now, dayStart, dayEnd, limit: 20 }),
    upcomingAppointments: listAppointments(db, { from: dayStart, statuses: upcomingAppointmentStatuses, limit: 8 }),
    recentEvents: listEvents(db, { limit: 12 })
  };
}

export function monthlyWork(db, month) {
  const rows = db.prepare(`SELECT performed_on AS date, count(*) AS orders,
      count(final_total_kopecks) AS priced_orders, sum(final_total_kopecks) AS total_kopecks,
      min(currency) AS currency, count(DISTINCT currency) AS currencies
    FROM work_orders WHERE performed_on >= ? AND performed_on <= ? AND status IN ('ready', 'completed')
    GROUP BY performed_on ORDER BY performed_on`).all(`${month}-01`, `${month}-31`);
  const currencies = db.prepare(`SELECT DISTINCT currency FROM work_orders
    WHERE performed_on >= ? AND performed_on <= ? AND status IN ('ready', 'completed')`).all(`${month}-01`, `${month}-31`);
  const mixedCurrencies = currencies.length > 1;
  const byDate = new Map(rows.map(row => [row.date, row]));
  const [year, number] = month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const row = byDate.get(date);
    return { date, orders: row?.orders ?? 0, missingTotals: row ? row.orders - row.priced_orders : 0,
      totalKopecks: mixedCurrencies ? null : row ? row.total_kopecks : 0 };
  });
  return { month, currency: currencies[0]?.currency ?? getBusiness(db)?.currency ?? 'RUB', mixedCurrencies, days,
    orders: rows.reduce((sum, row) => sum + row.orders, 0),
    missingTotals: rows.reduce((sum, row) => sum + row.orders - row.priced_orders, 0),
    totalKopecks: mixedCurrencies || (rows.length && rows.every(row => row.priced_orders === 0))
      ? null : rows.reduce((sum, row) => sum + (row.total_kopecks ?? 0), 0) };
}

function countBy(db, table, column) {
  return Object.fromEntries(db.prepare(`SELECT ${column} AS key, count(*) AS n FROM ${table} GROUP BY ${column}`).all().map((row) => [row.key, row.n]));
}

function sumStatuses(counts, statuses) {
  return statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
}

export function listCustomers(db, { q, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push(`(instr(fs_fold(c.full_name), ?) OR instr(fs_fold(coalesce(c.phone, '')), ?) OR instr(fs_fold(coalesce(c.email, '')), ?)
      OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND (instr(fs_fold(v.make || ' ' || coalesce(v.model, '')), ?) OR instr(fs_fold(coalesce(v.plate, '')), ?) OR instr(fs_fold(coalesce(v.vin, '')), ?))))`);
    params.push(...Array(6).fill(fold(q)));
  }
  return db.prepare(`SELECT c.*,
      (SELECT count(*) FROM vehicles v WHERE v.customer_id = c.id) AS vehicle_count,
      (SELECT count(*) FROM inquiries i WHERE i.customer_id = c.id AND i.status IN (${placeholders(activeInquiryStatuses)})) AS active_inquiries,
      (SELECT count(*) FROM work_orders wo WHERE wo.customer_id = c.id AND wo.status IN (${placeholders(activeWorkOrderStatuses)})) AS active_orders,
      (SELECT group_concat(v.make || coalesce(' ' || v.model, ''), ', ') FROM vehicles v WHERE v.customer_id = c.id) AS vehicles_label
    FROM customers c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY c.full_name COLLATE NOCASE LIMIT ?`).all(...activeInquiryStatuses, ...activeWorkOrderStatuses, ...params, limit);
}

export function getCustomer(db, id) {
  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
  if (!customer) return null;
  return {
    ...customer,
    vehicles: db.prepare("SELECT * FROM vehicles WHERE customer_id = ? ORDER BY created_at").all(id),
    inquiries: listInquiries(db, { customerId: id }),
    workOrders: listWorkOrders(db, { customerId: id }),
    events: listEvents(db, { entityType: "customer", entityId: id })
  };
}

export function getVehicle(db, id) {
  const vehicle = db.prepare(`SELECT v.*, c.full_name AS customer_name FROM vehicles v JOIN customers c ON c.id = v.customer_id WHERE v.id = ?`).get(id);
  if (!vehicle) return null;
  return {
    ...vehicle,
    inquiries: listInquiries(db, { vehicleId: id }),
    workOrders: listWorkOrders(db, { vehicleId: id }),
    events: listEvents(db, { entityType: "vehicle", entityId: id })
  };
}

const inquirySelect = `SELECT i.*, c.full_name AS customer_name, c.phone AS customer_phone,
    v.make AS vehicle_make, v.model AS vehicle_model, v.year AS vehicle_year,
    s.name AS service_name, s.code AS service_code,
    (SELECT count(*) FROM tasks t WHERE t.inquiry_id = i.id AND t.status IN ('open', 'in_progress')) AS open_tasks
  FROM inquiries i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN vehicles v ON v.id = i.vehicle_id
  LEFT JOIN services s ON s.id = i.requested_service_id`;

export function listInquiries(db, { status, statuses, q, customerId, vehicleId, demo, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const list = statuses ?? (status ? [status] : null);
  if (list) { where.push(`i.status IN (${placeholders(list)})`); params.push(...list); }
  if (customerId) { where.push("i.customer_id = ?"); params.push(customerId); }
  if (vehicleId) { where.push("i.vehicle_id = ?"); params.push(vehicleId); }
  if (demo !== undefined) { where.push("i.is_demo = ?"); params.push(demo ? 1 : 0); }
  if (q) {
    where.push("(instr(fs_fold(i.description), ?) OR instr(fs_fold(c.full_name), ?) OR instr(fs_fold(coalesce(s.name, '')), ?) OR instr(fs_fold(coalesce(v.make || ' ' || v.model, '')), ?))");
    params.push(...Array(4).fill(fold(q)));
  }
  return db.prepare(`${inquirySelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.received_at DESC LIMIT ?`).all(...params, limit);
}

export function getInquiry(db, id) {
  const inquiry = db.prepare(`${inquirySelect} WHERE i.id = ?`).get(id);
  if (!inquiry) return null;
  return {
    ...inquiry,
    workOrders: db.prepare(`SELECT wo.*, ${orderTotalSql} AS estimate_kopecks FROM work_orders wo WHERE wo.inquiry_id = ? ORDER BY wo.created_at`).all(id),
    tasks: listTasks(db, { inquiryId: id }),
    appointments: listAppointments(db, { inquiryId: id }),
    events: listEvents(db, { entityType: "inquiry", entityId: id })
  };
}

const orderSelect = `SELECT wo.*, ${orderTotalSql} AS estimate_kopecks,
    (SELECT json_object('works', json_extract(ae.details_json, '$.works'),
      'basis', json_extract(ae.details_json, '$.basis'), 'durationNote', json_extract(ae.details_json, '$.durationNote'))
      FROM activity_events ae WHERE ae.entity_type = 'work_order' AND ae.entity_id = wo.id AND ae.action = 'work_report_registered'
      ORDER BY ae.occurred_at DESC, ae.rowid DESC LIMIT 1) AS work_report_json,
    c.full_name AS customer_name, v.make AS vehicle_make, v.model AS vehicle_model, v.year AS vehicle_year, v.plate AS vehicle_plate,
    (SELECT count(*) FROM order_items oi WHERE oi.work_order_id = wo.id) AS item_count,
    (SELECT count(*) FROM tasks t WHERE t.work_order_id = wo.id AND t.status IN ('open', 'in_progress')) AS open_tasks
  FROM work_orders wo
  JOIN customers c ON c.id = wo.customer_id
  JOIN vehicles v ON v.id = wo.vehicle_id`;

function withWorkReport({ work_report_json, ...order }) {
  return { ...order, workReport: work_report_json ? JSON.parse(work_report_json) : null };
}

export function listWorkOrders(db, { status, statuses, q, customerId, vehicleId, performed, from, to, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const list = statuses ?? (status ? [status] : null);
  if (list) { where.push(`wo.status IN (${placeholders(list)})`); params.push(...list); }
  if (customerId) { where.push("wo.customer_id = ?"); params.push(customerId); }
  if (vehicleId) { where.push("wo.vehicle_id = ?"); params.push(vehicleId); }
  if (performed) { where.push("wo.performed_on IS NOT NULL AND wo.status IN ('ready', 'completed')"); }
  if (from) { where.push("wo.performed_on >= ?"); params.push(from); }
  if (to) { where.push("wo.performed_on <= ?"); params.push(to); }
  if (q) {
    where.push("(instr(fs_fold(wo.number), ?) OR instr(fs_fold(c.full_name), ?) OR instr(fs_fold(v.make || ' ' || coalesce(v.model, '')), ?) OR instr(fs_fold(coalesce(wo.note, '')), ?) OR instr(fs_fold(coalesce(v.plate, '')), ?))");
    params.push(...Array(5).fill(fold(q)));
  }
  return db.prepare(`${orderSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${performed ? "wo.performed_on DESC," : "CASE WHEN wo.planned_start_at IS NULL THEN 1 ELSE 0 END, wo.planned_start_at,"} wo.created_at DESC, wo.rowid DESC LIMIT ?`).all(...params, limit).map(withWorkReport);
}

export function getWorkOrder(db, id) {
  const order = db.prepare(`${orderSelect} WHERE wo.id = ?`).get(id);
  if (!order) return null;
  return {
    ...withWorkReport(order),
    inquiry: order.inquiry_id ? db.prepare("SELECT id, description, status, received_at FROM inquiries WHERE id = ?").get(order.inquiry_id) : null,
    items: db.prepare(`SELECT oi.*, s.code AS service_code, s.name AS current_service_name, s.base_price_kopecks AS current_base_price_kopecks
      FROM order_items oi LEFT JOIN services s ON s.id = oi.service_id WHERE oi.work_order_id = ? ORDER BY oi.sort_order, oi.created_at`).all(id),
    tasks: listTasks(db, { workOrderId: id }),
    appointments: listAppointments(db, { workOrderId: id }),
    events: listEvents(db, { entityType: "work_order", entityId: id })
  };
}

const taskSelect = `SELECT t.*, i.description AS inquiry_description, wo.number AS work_order_number,
    coalesce(ci.full_name, cw.full_name) AS customer_name, coalesce(ci.id, cw.id) AS customer_id
  FROM tasks t
  LEFT JOIN inquiries i ON i.id = t.inquiry_id
  LEFT JOIN customers ci ON ci.id = i.customer_id
  LEFT JOIN work_orders wo ON wo.id = t.work_order_id
  LEFT JOIN customers cw ON cw.id = wo.customer_id`;

export function listTasks(db, { status, statuses, due, now, dayEnd, q, inquiryId, workOrderId, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const list = statuses ?? (status ? [status] : due ? openTaskStatuses : null);
  if (list) { where.push(`t.status IN (${placeholders(list)})`); params.push(...list); }
  if (due === "overdue") { where.push("t.due_at < ?"); params.push(now); }
  if (due === "today") { where.push("t.due_at >= ? AND t.due_at < ?"); params.push(now, dayEnd); }
  if (due === "later") { where.push("t.due_at >= ?"); params.push(dayEnd); }
  if (due === "none") where.push("t.due_at IS NULL");
  if (inquiryId) { where.push("t.inquiry_id = ?"); params.push(inquiryId); }
  if (workOrderId) { where.push("t.work_order_id = ?"); params.push(workOrderId); }
  if (q) {
    where.push("(instr(fs_fold(t.title), ?) OR instr(fs_fold(coalesce(t.assignee, '')), ?) OR instr(fs_fold(coalesce(ci.full_name, cw.full_name, '')), ?))");
    params.push(...Array(3).fill(fold(q)));
  }
  return db.prepare(`${taskSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.created_at LIMIT ?`).all(...params, limit);
}

export function listServices(db, { active, category, q } = {}) {
  const where = [];
  const params = [];
  if (active !== undefined) { where.push("s.is_active = ?"); params.push(active ? 1 : 0); }
  if (category) { where.push("s.category = ?"); params.push(category); }
  if (q) { where.push("(instr(fs_fold(s.name), ?) OR instr(fs_fold(coalesce(s.description, '')), ?) OR instr(s.code, ?))"); params.push(...Array(3).fill(fold(q))); }
  return db.prepare(`SELECT s.*,
      (SELECT count(*) FROM order_items oi WHERE oi.service_id = s.id) AS order_item_count,
      (SELECT count(*) FROM inquiries i WHERE i.requested_service_id = s.id) AS inquiry_count
    FROM services s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.sort_order, s.name`).all(...params);
}

const appointmentSelect = `SELECT a.*, coalesce(ci.full_name, cw.full_name) AS customer_name, coalesce(ci.id, cw.id) AS customer_id,
    i.description AS inquiry_description, wo.number AS work_order_number,
    coalesce(vi.make || coalesce(' ' || vi.model, ''), vw.make || coalesce(' ' || vw.model, '')) AS vehicle_label
  FROM appointments a
  LEFT JOIN inquiries i ON i.id = a.inquiry_id
  LEFT JOIN customers ci ON ci.id = i.customer_id
  LEFT JOIN vehicles vi ON vi.id = i.vehicle_id
  LEFT JOIN work_orders wo ON wo.id = a.work_order_id
  LEFT JOIN customers cw ON cw.id = wo.customer_id
  LEFT JOIN vehicles vw ON vw.id = wo.vehicle_id`;

export function listAppointments(db, { from, to, status, statuses, inquiryId, workOrderId, limit = 300 } = {}) {
  const where = [];
  const params = [];
  const list = statuses ?? (status ? [status] : null);
  if (list) { where.push(`a.status IN (${placeholders(list)})`); params.push(...list); }
  if (from) { where.push("a.ends_at > ?"); params.push(from); }
  if (to) { where.push("a.starts_at < ?"); params.push(to); }
  if (inquiryId) { where.push("a.inquiry_id = ?"); params.push(inquiryId); }
  if (workOrderId) { where.push("a.work_order_id = ?"); params.push(workOrderId); }
  return db.prepare(`${appointmentSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.starts_at LIMIT ?`).all(...params, limit);
}

export function listEvents(db, { entityType, entityId, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (entityType) { where.push("entity_type = ?"); params.push(entityType); }
  if (entityId) { where.push("entity_id = ?"); params.push(entityId); }
  return db.prepare(`SELECT * FROM activity_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at DESC, rowid DESC LIMIT ?`).all(...params, limit);
}

// Кандидаты для сопоставления автомобиля. Ключи уже нормализованы (domain.mjs); оценку даёт matching.mjs
export function vehicleMatchCandidates(db, { vin, vinSuffix, plate, phone }) {
  return db.prepare(`SELECT v.id AS vehicle_id, v.make, v.model, v.year, v.vin, v.plate, v.plate_key, v.is_demo,
      c.id AS customer_id, c.full_name AS customer_name, c.phone AS customer_phone, c.phone_key,
      (SELECT count(*) FROM work_orders wo WHERE wo.vehicle_id = v.id) AS order_count,
      (SELECT max(coalesce(wo.completed_at, wo.created_at)) FROM work_orders wo WHERE wo.vehicle_id = v.id) AS last_order_at,
      (SELECT json_group_array(json_object('id', wo.id, 'number', wo.number, 'status', wo.status)) FROM work_orders wo
        WHERE wo.vehicle_id = v.id AND wo.status IN (${placeholders(activeWorkOrderStatuses)})) AS active_orders_json
    FROM vehicles v JOIN customers c ON c.id = v.customer_id
    WHERE (@vin IS NOT NULL AND v.vin = @vin)
      OR (@vinSuffix IS NOT NULL AND substr(v.vin, -length(@vinSuffix)) = @vinSuffix)
      OR (@plate IS NOT NULL AND v.plate_key = @plate)
      OR (@phone IS NOT NULL AND c.phone_key = @phone)`)
    .all(...activeWorkOrderStatuses, { vin: vin ?? null, vinSuffix: vinSuffix ?? null, plate: plate ?? null, phone: phone ?? null })
    .map(({ active_orders_json: json, ...row }) => ({ ...row, active_orders: JSON.parse(json) }));
}

export function customersByPhoneKey(db, phoneKey) {
  return db.prepare(`SELECT c.id, c.full_name, c.phone, c.is_demo, (SELECT count(*) FROM vehicles v WHERE v.customer_id = c.id) AS vehicle_count
    FROM customers c WHERE c.phone_key = ? ORDER BY c.created_at`).all(phoneKey);
}

export function insertEvent(db, event) {
  db.prepare(`INSERT INTO activity_events (id, occurred_at, entity_type, entity_id, action, actor, source, summary, details_json, is_demo)
    VALUES (@id, @occurred_at, @entity_type, @entity_id, @action, @actor, @source, @summary, @details_json, @is_demo)`).run(event);
}

export function serviceCatalogRows(db) {
  return db.prepare("SELECT * FROM services ORDER BY sort_order, name").all();
}
