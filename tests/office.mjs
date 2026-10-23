// Проверки контура офиса: схема, миграции, импорт, учебный набор, операции, API, копии
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-office-"));
const root = path.join(testRoot, "business");
process.env.FRONTSMITH_BUSINESS_ROOT = root;
process.env.FRONTSMITH_ACTOR = "тест";
const port = 4187;
// Клиенты — через CustomerProvider: двойник crmkit в памяти
const { useFakeCrm } = await import("../services/crm/testing/fake-crmkit.mjs");
const fakeCrm = await useFakeCrm(path.join(testRoot, "data"));

const { backupOfficeDb, listMigrations, migrate, officeDbPath, openOfficeDb, verifyBackup } = await import("../office/lib/db.mjs");
const domain = await import("../office/lib/domain.mjs");
const ops = await import("../office/lib/operations.mjs");
const { matchVehicle, matchVehicleWithCustomers } = await import("../office/lib/matching.mjs");
const { connectCustomers } = await import("../office/customers/index.mjs");
const { registerWorkReport } = await import("../office/lib/work-reports.mjs");
const { monthlyWork } = await import("../office/lib/repositories.mjs");
const { loadServiceCatalog } = await import("../office/lib/catalog.mjs");
const { createOfficeServer } = await import("../office/server.mjs");

let passed = 0;
async function check(name, fn) {
  if (process.env.OFFICE_TEST_VERBOSE) console.log(`→ ${name}`);
  try {
    await fn();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

try {
  await mkdir(path.join(root, "customer-inquiries"), { recursive: true });
  await copyFile("blueprints/auto-service/business.example.json", path.join(root, "business.json"));
  await copyFile("blueprints/auto-service/business.example.json", path.join(testRoot, "profile.json"));
  const profile = JSON.parse(await readFile(path.join(root, "business.json"), "utf8"));
  await writeDemoInquiry();

  await check("Node 20 остаётся минимальной версией, драйвер закреплён", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(pkg.engines.node, ">=20");
    assert.match(pkg.dependencies["better-sqlite3"], /^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    assert.equal(lock.packages["node_modules/better-sqlite3"].version, pkg.dependencies["better-sqlite3"]);
  });

  await check("база и копии не попадают в Git", async () => {
    for (const file of [".frontsmith/business/office.sqlite", ".frontsmith/business/backups/office-x.sqlite"]) {
      const { stdout } = await execFileAsync("git", ["check-ignore", file]);
      assert.equal(stdout.trim(), file);
    }
  });

  await check("без базы: файловый прайс, честный статус и 503 в API", async () => {
    const catalog = await loadServiceCatalog(profile);
    assert.equal(catalog.source, "file");
    assert.equal(catalog.services.length, 8);
    assert.match(await cli("status"), /не создана/);
    await withServer(async () => {
      const response = await get("/api/overview");
      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, "database_missing");
      assert.equal((await get("/api/health")).body.data.database, "missing");
    });
    await assert.rejects(cli("seed"), /office:init/);
  });

  await check("init повторяем, миграции версионированы", async () => {
    assert.match(await cli("init"), /применены 001_initial\.sql, 002_work_results\.sql/);
    assert.match(await cli("init"), /новых нет/);
    const db = openOfficeDb();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations").get().n, listMigrations().length);
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(db.prepare("SELECT name FROM business").get().name, "АвтоРитм");
    } finally {
      db.close();
    }
  });

  await check("изменённая миграция обнаруживается", async () => {
    const copy = path.join(testRoot, "tampered.sqlite");
    await backupOfficeDb({ destination: copy });
    const db = openOfficeDb({ file: copy });
    try {
      const { createHash } = await import("node:crypto");
      const crlf = createHash("sha256").update(listMigrations()[0].sql.replace(/\n/g, "\r\n")).digest("hex");
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(crlf);
      assert.doesNotThrow(() => migrate(db), "переводы строк CRLF после checkout на Windows не считаются правкой");
      db.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE version = 1").run();
      assert.throws(() => migrate(db), /изменена после применения/);
    } finally {
      db.close();
    }
  });

  await check("импорт каталога и синтетического обращения идемпотентен", async () => {
    assert.match(await cli("import"), /добавлено 8, уже в базе 0[\s\S]*импортировано/);
    assert.match(await cli("import"), /добавлено 0, уже в базе 8[\s\S]*уже в базе/);
    const counts = tableCounts();
    assert.equal(counts.services, 8);
    assert.equal(counts.inquiries, 1);
    assert.equal(counts.customers, 1);
  });

  await check("учебный набор связный, помечен и не дублируется", async () => {
    await cli("seed");
    const first = tableCounts();
    assert.match(await cli("seed"), /создано ничего/);
    assert.deepEqual(tableCounts(), first);
    assert.equal(first.work_orders, 3);
    assert.ok(first.appointments >= 3 && first.tasks >= 6);
    const db = openOfficeDb({ readonly: true });
    try {
      for (const table of ["customers", "vehicles", "inquiries", "work_orders", "order_items", "appointments", "tasks"]) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE is_demo = 0`).get().n, 0, `${table}: все записи учебные`);
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM inquiries WHERE source = 'booking_flow'").get().n, 0, "учебный набор не выдаёт себя за Booking Flow");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const statuses = new Set(db.prepare("SELECT status FROM inquiries").all().map((row) => row.status));
      for (const status of ["new", "in_progress", "waiting_customer", "converted", "closed"]) assert.ok(statuses.has(status), `есть обращение ${status}`);
      const oil = db.prepare("SELECT * FROM work_orders WHERE number = 'ДЕМО-0002'").get();
      assert.equal(db.prepare("SELECT sum(amount_kopecks) AS total FROM order_items WHERE work_order_id = ?").get(oil.id).total, 655500, "1500 + 950×4,5 + 780 = 6555 ₽");
      assert.equal(oil.approved_total_kopecks, 655500);
    } finally {
      db.close();
    }
  });

  await check("FK и CHECK-ограничения работают", () => {
    const db = openOfficeDb();
    const at = new Date().toISOString();
    try {
      const customer = db.prepare("SELECT id FROM customers LIMIT 1").get().id;
      const otherVehicle = db.prepare("SELECT id FROM vehicles WHERE customer_id <> ? LIMIT 1").get(customer).id;
      const order = db.prepare("SELECT * FROM work_orders WHERE status = 'awaiting_approval' LIMIT 1").get();
      const constraint = (fn, pattern) => assert.throws(fn, (error) => String(error.code).startsWith("SQLITE_CONSTRAINT") && (!pattern || pattern.test(error.code)));
      constraint(() => db.prepare("INSERT INTO vehicles (id, customer_id, make, created_at, updated_at) VALUES (?, ?, 'X', ?, ?)").run(domain.newId(), domain.newId(), at, at), /FOREIGNKEY/);
      constraint(() => db.prepare("INSERT INTO inquiries (id, customer_id, vehicle_id, source, description, status, received_at, created_at, updated_at) VALUES (?, ?, ?, 'phone', 'x', 'new', ?, ?, ?)").run(domain.newId(), customer, otherVehicle, at, at, at), /FOREIGNKEY/);
      constraint(() => db.prepare("INSERT INTO inquiries (id, customer_id, source, description, status, received_at, created_at, updated_at) VALUES (?, ?, 'phone', 'x', 'lost', ?, ?, ?)").run(domain.newId(), customer, at, at, at), /CHECK/);
      constraint(() => db.prepare("UPDATE work_orders SET status = 'approved' WHERE id = ?").run(order.id), /CHECK/);
      constraint(() => db.prepare("INSERT INTO order_items (id, work_order_id, kind, title, unit_price_kopecks, quantity_milli, amount_kopecks, currency, created_at) VALUES (?, ?, 'part', 'x', 1000, 1000, 999, 'RUB', ?)").run(domain.newId(), order.id, at), /CHECK/);
      constraint(() => db.prepare("UPDATE appointments SET status = 'confirmed', confirmation_basis = NULL WHERE status = 'tentative'").run(), /CHECK/);
      assert.throws(() => db.prepare("DELETE FROM customers WHERE id = ?").run(customer), /FOREIGN KEY constraint failed/, "RESTRICT запрещает удалять клиента со связями");
      assert.throws(() => db.prepare("UPDATE services SET base_price_kopecks = 1500.5 WHERE code = 'oil-service'").run(), /cannot store REAL value in INTEGER column/);
    } finally {
      db.close();
    }
  });

  await check("деньги — целые копейки, ввод валидируется", () => {
    assert.equal(domain.parseRubles("1499,90"), 149990);
    assert.equal(domain.parseRubles("0"), 0);
    for (const bad of ["-5", "1.234", "abc", "1e3", ""]) assert.throws(() => domain.parseRubles(bad), domain.OfficeValidationError);
    assert.equal(domain.parseQuantity("4,5"), 4500);
    assert.throws(() => domain.parseQuantity("0"));
    assert.equal(domain.lineAmount(95000, 4500), 427500);
    assert.equal(domain.lineAmount(333, 1500), 500);
  });

  await check("переходы статусов и основания проверяются", async () => {
    const db = openOfficeDb();
    try {
      const ctx = ops.createContext(db, { actor: "тест" });
      const closed = db.prepare("SELECT id FROM inquiries WHERE status = 'closed'").get().id;
      assert.throws(() => ops.setInquiryStatus(ctx, { id: closed, status: "waiting_customer" }), /не разрешён/);
      const converted = db.prepare("SELECT id FROM inquiries WHERE status = 'converted'").get().id;
      assert.throws(() => ops.createWorkOrder(ctx, { inquiryId: converted }), /заказ из него не создаётся/);
      const tentative = db.prepare("SELECT id FROM appointments WHERE status = 'tentative'").get().id;
      assert.throws(() => ops.setAppointmentStatus(ctx, { id: tentative, status: "confirmed" }), /основание/);
      const awaiting = db.prepare("SELECT id FROM work_orders WHERE status = 'awaiting_approval'").get().id;
      assert.throws(() => ops.setWorkOrderStatus(ctx, { id: awaiting, status: "approved" }), /order:cost/);
      assert.throws(() => ops.addOrderItem(ctx, { workOrderId: awaiting, kind: "part", title: "x", unitPriceKopecks: 100 }), /черновике/);
      const task = db.prepare("SELECT id, revision FROM tasks LIMIT 1").get();
      assert.throws(() => ops.setTaskStatus(ctx, { id: task.id, status: "in_progress", revision: task.revision + 1 }), /ревизия/);
    } finally {
      db.close();
    }
    await assert.rejects(cli("inquiry:status", "--id", domain.newId(), "--to", "closed"), /не найден/);
  });

  await check("журнал пишется в той же транзакции", () => {
    const db = openOfficeDb();
    try {
      const before = tableCounts(db);
      assert.throws(() => db.transaction(() => {
        ops.createTask(ops.createContext(db, { actor: "тест" }), { title: "Откатываемая задача" });
        throw new Error("сбой после изменения");
      })(), /сбой/);
      assert.deepEqual(tableCounts(db), before, "ни задачи, ни события");
    } finally {
      db.close();
    }
  });

  let customerId;
  let inquiryId;
  await check("CLI-изменение переживает перезапуск и видно в API", async () => {
    customerId = JSON.parse(jsonPart(await cli("customer:add", "--name", "Тестовый клиент Ян", "--phone", "+7 000 111-22-33"))).id;
    const vehicleId = JSON.parse(jsonPart(await cli("vehicle:add", "--customer", customerId, "--make", "Lada", "--model", "Largus", "--year", "2020"))).id;
    inquiryId = JSON.parse(jsonPart(await cli("inquiry:add", "--customer", customerId, "--vehicle", vehicleId, "--service", "computer-diagnostics", "--source", "phone", "--description", "Плавают обороты"))).id;
    await cli("task:add", "--inquiry", inquiryId, "--title", "Перезвонить Яну", "--due", "2020-01-01 10:00");
    await assert.rejects(cli("vehicle:add", "--customer", customerId, "--make", "Lada", "--vin", "SHORT"), /VIN/);

    await withServer(async () => {
      const overview = (await get("/api/overview")).body.data;
      assert.equal(overview.counts.realRecords, 3, "клиент, обращение, задача");
      assert.ok(overview.activeInquiries.some((item) => item.id === inquiryId));
      assert.ok(overview.overdueTasks.some((task) => task.title === "Перезвонить Яну"));
      const db = openOfficeDb({ readonly: true });
      try {
        assert.equal(overview.counts.activeInquiries, db.prepare("SELECT count(*) AS n FROM inquiries WHERE status IN ('new','in_progress','waiting_customer')").get().n, "обзор совпадает с базой");
        assert.equal(overview.counts.overdueTasks, db.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('open','in_progress') AND due_at < ?").get(new Date().toISOString()).n);
      } finally {
        db.close();
      }
      const card = (await get(`/api/customers/${customerId}`)).body.data;
      assert.equal(card.vehicles.length, 1);
      assert.equal(card.inquiries[0].service_code, "computer-diagnostics");
      const events = (await get(`/api/inquiries/${inquiryId}`)).body.data.events;
      assert.equal(events[0].actor, "тест");
      assert.equal(events[0].source, "cli");
    });
  });

  await check("цена меняется в каталоге, старые заказы не пересчитываются, сайт читает базу", async () => {
    const before = await loadServiceCatalog(profile);
    assert.equal(before.source, "db");
    assert.equal(before.services.find((service) => service.id === "brake-pads").priceFrom, 1800);
    assert.equal(before.services.find((service) => service.id === "brake-pads").image, "/assets/auto-workshop.png", "оформление услуги берётся из профиля");
    await cli("service:price", "--code", "brake-pads", "--price", "2100");
    const after = await loadServiceCatalog(profile);
    assert.equal(after.services.find((service) => service.id === "brake-pads").priceFrom, 2100);
    await cli("service:active", "--code", "air-conditioning", "--active", "no");
    assert.equal((await loadServiceCatalog(profile)).services.length, 7, "скрытая услуга не попадает на сайт");
    await withServer(async () => {
      const orders = (await get("/api/orders?status=all&q=%D0%94%D0%95%D0%9C%D0%9E-0001")).body.data;
      const order = (await get(`/api/orders/${orders[0].id}`)).body.data;
      const item = order.items.find((row) => row.service_code === "brake-pads");
      assert.equal(item.unit_price_kopecks, 180000);
      assert.equal(item.current_base_price_kopecks, 210000);
      assert.equal(order.approved_total_kopecks, 500000);
    });
  });

  await check("API только читает, фильтрует и не раскрывает приватное", async () => {
    await withServer(async () => {
      for (const route of ["/api/meta", "/api/customers", "/api/inquiries", "/api/orders", "/api/tasks", "/api/services", "/api/schedule", "/api/events", "/", "/app.js", "/styles.css"]) {
        assert.equal((await get(route)).status, 200, route);
      }
      assert.equal((await get("/api/inquiries?status=active")).body.data.length, 4);
      assert.equal((await get("/api/inquiries?status=closed")).body.data.length, 1);
      assert.equal((await get("/api/orders?status=awaiting_approval")).body.data.length, 1);
      assert.equal((await get("/api/services?active=no")).body.data.length, 1);
      assert.equal((await get("/api/customers?q=%D1%8F%D0%BD")).body.data.length, 1, "поиск по кириллице без учёта регистра");
      assert.equal((await get("/api/customers?q=largus")).body.data[0].id, customerId, "поиск по автомобилю");
      assert.equal((await get("/api/tasks?due=overdue")).body.data.every((task) => Date.parse(task.due_at) < Date.now()), true);
      assert.equal((await get("/api/inquiries?status=lost")).status, 400);
      assert.equal((await get("/api/tasks?due=yesterday")).status, 400);
      assert.equal((await get("/api/customers/not-a-uuid")).status, 400);
      assert.equal((await get(`/api/customers/${domain.newId()}`)).status, 404);
      const schedule = (await get("/api/schedule?days=7")).body.data;
      assert.ok(schedule.appointments.length >= 2);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await get("/api/orders", { method });
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.allow, "GET, HEAD");
      }
      assert.equal((await get("/api/customers", { method: "POST" })).status, 403, "изменение клиента без заголовка панели отклоняется");
      assert.equal((await get("/api/overview", { host: "attacker.example" })).status, 421);
      for (const route of ["/db/migrations/001_initial.sql", "/lib/db.mjs", "/../business.json", "/%2e%2e/business.json", "/office.sqlite"]) {
        assert.equal((await get(route)).status, 404, route);
      }
      const meta = await get("/api/meta");
      assert.ok(!meta.raw.includes("office.sqlite") && !meta.raw.includes(root.replaceAll("\\", "\\\\")), "путь к базе не раскрывается");
      assert.match(meta.headers["content-security-policy"], /default-src 'self'/);
    });
    const html = await readFile("office/public/index.html", "utf8");
    assert.ok(!/<form|method=["']post/i.test(html), "в разметке панели нет форм записи");
    const app = await readFile("office/public/app.js", "utf8");
    const writes = [...app.matchAll(/fetch\(([^,]+),/g)].map((match) => match[1].trim());
    assert.ok(writes.every((target) => target === "url" || /api\/customers/.test(target)), "интерфейс меняет только карточки клиентов");
  });

  await check("панель: отчёты без позиций, календарные дни, поиск и стоимость", async () => {
    const db = openOfficeDb();
    let first, second, vehicle;
    let expectedTotal, eventCount;
    try {
      const ctx = ops.createContext(db, { actor: "тест", now: () => new Date("2026-10-16T15:00:00Z") });
      const customer = addClient(db);
      vehicle = ops.addVehicle(ctx, { customerId: customer.id, make: "Mazda", plate: "М456ОР77" });
      const report = { vehicleId: vehicle.id, identityConfirmed: true, performedOn: "2026-10-02", works: ["Замена рейки", "Проверка сход-развала"],
        basis: "Отчёт мастера", costApprovalBasis: "Клиент согласовал", finalTotalKopecks: 1700000, actualDurationMinutes: null,
        durationNote: "2 дня; фактические часы неизвестны" };
      first = registerWorkReport(ctx, report).order;
      second = registerWorkReport(ctx, { ...report, performedOn: "2026-10-03", actualDurationMinutes: 90, newOrderConfirmed: true }).order;
      ops.setWorkOrderStatus(ctx, { id: second.id, status: "completed" });
      expectedTotal = db.prepare(`SELECT sum(coalesce(wo.final_total_kopecks, wo.approved_total_kopecks,
        (SELECT coalesce(sum(amount_kopecks), 0) FROM order_items oi WHERE oi.work_order_id = wo.id))) total
        FROM work_orders wo WHERE status IN ('draft', 'awaiting_approval', 'approved', 'in_progress', 'ready')`).get().total;
      eventCount = db.prepare("SELECT count(*) n FROM activity_events").get().n;
    } finally { db.close(); }
    await withServer(async () => {
      const results = (await get("/api/orders?performed=yes")).body.data;
      assert.deepEqual(results.map(o => o.id), [second.id, first.id]);
      const sameDay = (await get("/api/orders?performed=yes&from=2026-10-02&to=2026-10-02")).body.data;
      assert.deepEqual(sameDay.map(o => o.id), [first.id], "границы периода включены");
      assert.equal(sameDay[0].actual_duration_minutes, null, "дни не превращаются в часы");
      assert.equal(sameDay[0].completed_at, null, "день работ не означает выдачу");
      assert.deepEqual(sameDay[0].workReport.works, ["Замена рейки", "Проверка сход-развала"]);
      assert.equal(sameDay[0].workReport.durationNote, "2 дня; фактические часы неизвестны");
      assert.equal((await get("/api/orders?performed=yes&status=completed")).body.data[0].id, second.id);
      for (const q of ["рейки", vehicle.plate]) {
        assert.equal((await get(`/api/orders?performed=yes&q=${encodeURIComponent(q)}`)).body.data.length, 2);
      }
      const detail = (await get(`/api/orders/${first.id}`)).body.data;
      assert.equal(detail.items.length, 0);
      assert.equal(detail.final_total_kopecks, 1700000);
      assert.equal(detail.workReport.basis, "Отчёт мастера");
      const overview = (await get("/api/overview")).body.data;
      assert.equal(overview.activeOrdersEstimate.total, expectedTotal, "итог и согласованная сумма учтены без позиций");
      assert.deepEqual(overview.recentPerformedWork.map(o => o.id), [second.id, first.id]);
      const monthly = (await get("/api/overview?month=2026-10")).body.data.monthlyWork;
      assert.equal(monthly.days.length, 31);
      assert.equal(monthly.orders, 2);
      assert.equal(monthly.totalKopecks, 3400000);
      assert.equal(monthly.days[1].totalKopecks, 1700000);
      assert.equal(monthly.days[1].orders, 1);
      assert.equal(monthly.days[2].orders, 1, "готовые и выданные учитываются по дню выполнения");
      assert.deepEqual(monthly.days[0], { date: "2026-10-01", orders: 0, missingTotals: 0, totalKopecks: 0 });
      const meta = (await get("/api/meta")).body.data;
      assert.equal(overview.monthlyWork.month, meta.today.date.slice(0, 7), "текущий месяц по часовому поясу бизнеса");
      for (const [month, length] of [["2024-02", 29], ["2025-02", 28], ["2100-02", 28], ["2026-04", 30]]) {
        const empty = (await get(`/api/overview?month=${month}`)).body.data.monthlyWork;
        assert.equal(empty.days.length, length);
        assert.equal(empty.orders, 0);
        assert.equal(empty.totalKopecks, 0);
        assert.ok(empty.days.every(day => day.orders === 0 && day.totalKopecks === 0));
      }
      for (const month of ["2026-13", "2026-00", "2026-1", "oops", "2026-10-01", "0000-01", ""]) {
        assert.equal((await get(`/api/overview?month=${month}`)).status, 400, month);
      }
      for (const query of ["from=2026-02-30", "to=garbage", "from=2026-10-04&to=2026-10-02", "performed=no"]) {
        assert.equal((await get(`/api/orders?${query}`)).status, 400, query);
      }
      assert.equal((await get("/api/orders?performed=yes&from=2027-01-01")).body.data.length, 0);
    });
    const afterDb = openOfficeDb({ readonly: true });
    try {
      assert.equal(afterDb.prepare("SELECT count(*) n FROM activity_events").get().n, eventCount, "просмотр не меняет журнал");
    } finally { afterDb.close(); }
  });

  await check("месячный график: все ремонты без лимита списка, неизвестные суммы и валюты", () => {
    const db = openOfficeDb({ file: ":memory:" });
    try {
      migrate(db);
      const ctx = ops.createContext(db, { actor: "тест", now: () => new Date("2026-10-17T15:00:00Z") });
      const customer = addClient(db);
      const vehicle = ops.addVehicle(ctx, { customerId: customer.id, make: "Mazda" });
      db.transaction(() => {
        for (let index = 0; index < 205; index++) registerWorkReport(ctx, {
          vehicleId: vehicle.id, identityConfirmed: true, newOrderConfirmed: true,
          performedOn: "2026-10-01", works: [`Работа ${index}`], finalTotalKopecks: 10000,
          basis: "Отчёт мастера", costApprovalBasis: "Клиент согласовал" });
      })();
      let month = monthlyWork(db, "2026-10");
      assert.equal(month.orders, 205, "агрегат не ограничен 200 строками списка");
      assert.equal(month.totalKopecks, 2050000);
      assert.equal(month.days[0].orders, 205);
      db.prepare("UPDATE work_orders SET final_total_kopecks = NULL").run();
      month = monthlyWork(db, "2026-10");
      assert.equal(month.totalKopecks, null, "неизвестная стоимость не превращается в ноль");
      assert.equal(month.missingTotals, 205);
      assert.equal(month.days[0].totalKopecks, null);
      db.prepare("UPDATE work_orders SET final_total_kopecks = 0").run();
      month = monthlyWork(db, "2026-10");
      assert.equal(month.totalKopecks, 0, "известная нулевая стоимость допустима");
      assert.equal(month.missingTotals, 0);
      db.prepare("UPDATE work_orders SET currency = 'USD' WHERE id = (SELECT id FROM work_orders LIMIT 1)").run();
      month = monthlyWork(db, "2026-10");
      assert.equal(month.mixedCurrencies, true);
      assert.equal(month.totalKopecks, null, "разные валюты не складываются");
      assert.equal(month.orders, 205);
    } finally { db.close(); }
  });

  await check("копия согласована с WAL и восстанавливается", async () => {
    const db = openOfficeDb();
    let walCustomer;
    try {
      db.pragma("wal_autocheckpoint = 0");
      walCustomer = addClient(db).id;
      const backupFile = await backupOfficeDb();
      const copy = openOfficeDb({ file: backupFile, readonly: true });
      try {
        assert.ok(copy.prepare("SELECT 1 FROM customers WHERE id = ?").get(walCustomer), "копия содержит изменения из WAL");
      } finally {
        copy.close();
      }
      process.env.FRONTSMITH_TEST_BACKUP = backupFile;
    } finally {
      db.close();
    }
    const backupFile = process.env.FRONTSMITH_TEST_BACKUP;
    assert.deepEqual(verifyBackup(backupFile), { version: Math.max(...listMigrations().map((migration) => migration.version)) });

    const lateCustomer = JSON.parse(jsonPart(await cli("customer:add", "--name", "Появился после копии"))).id;
    await assert.rejects(cli("restore", "--from", backupFile), /--confirm/);
    const output = await cli("restore", "--from", backupFile, "--confirm");
    const safetyCopy = /Прежнее состояние сохранено: (.+)/.exec(output)[1].trim();

    const restored = openOfficeDb({ readonly: true });
    try {
      assert.ok(restored.prepare("SELECT 1 FROM customers WHERE id = ?").get(walCustomer));
      assert.equal(restored.prepare("SELECT 1 FROM customers WHERE id = ?").get(lateCustomer), undefined);
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      restored.close();
    }
    const safety = openOfficeDb({ file: safetyCopy, readonly: true });
    try {
      assert.ok(safety.prepare("SELECT 1 FROM customers WHERE id = ?").get(lateCustomer), "страховочная копия хранит состояние до восстановления");
    } finally {
      safety.close();
    }
    await assert.rejects(cli("restore", "--from", path.join(testRoot, "profile.json"), "--confirm"), /file is not a database|не найден|SQLITE_NOTADB/);
  });

  await check("миграция 002 поверх базы версии 001 сохраняет данные", () => {
    const [first] = listMigrations();
    const build = (file, completedAt) => {
      const db = openOfficeDb({ file });
      db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
      db.exec(first.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (1, ?, ?, '2026-10-01T00:00:00.000Z')").run(first.name, first.checksum);
      const at = "2026-10-01T09:00:00.000Z";
      db.prepare("INSERT INTO customers (id, full_name, phone, created_at, updated_at) VALUES ('c1', 'Старый клиент', '8 (912) 345-67-89', ?, ?)").run(at, at);
      db.prepare("INSERT INTO vehicles (id, customer_id, make, vin, plate, created_at, updated_at) VALUES ('v1', 'c1', 'Kia', 'XWEPH81ABK0012345', 'а 123 вс 77', ?, ?)").run(at, at);
      db.prepare(`INSERT INTO work_orders (id, number, customer_id, vehicle_id, status, cost_approval, approved_total_kopecks, cost_approved_at, currency, completed_at, created_at, updated_at)
        VALUES ('o1', 'ЗН-1', 'c1', 'v1', 'completed', 'approved', 500000, ?, 'RUB', ?, ?, ?)`).run(at, completedAt, at, at);
      return db;
    };

    const db = build(path.join(testRoot, "v1.sqlite"), "2026-10-02T15:00:00.000Z");
    try {
      assert.deepEqual(migrate(db, { upTo: 3 }).applied, ["002_work_results.sql", "003_work_reports.sql"]);
      assert.equal(db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v, 3);
      const order = db.prepare("SELECT * FROM work_orders WHERE id = 'o1'").get();
      assert.equal(order.completed_at, "2026-10-02T15:00:00.000Z");
      assert.equal(order.approved_total_kopecks, 500000);
      assert.equal(order.actual_duration_minutes, null);
      assert.equal(order.final_total_kopecks, null);
      assert.equal(db.prepare("SELECT plate_key FROM vehicles WHERE id = 'v1'").get().plate_key, "A123BC77");
      assert.equal(db.prepare("SELECT phone_key FROM customers WHERE id = 'c1'").get().phone_key, "79123456789");
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }

    const broken = build(path.join(testRoot, "v1-broken.sqlite"), "02.10.2026 15:00");
    try {
      assert.throws(() => migrate(broken, { upTo: 3 }), /completed_at: ожидается ISO/);
      assert.equal(broken.prepare("SELECT max(version) AS v FROM schema_migrations").get().v, 1, "миграция откатилась целиком");
      assert.ok(!broken.prepare("SELECT name FROM pragma_table_info('work_orders')").all().some((column) => column.name === "final_total_kopecks"));
    } finally {
      broken.close();
    }
  });

  await check("ключ госномера одинаков в SQL и JS", () => {
    const db = openOfficeDb();
    try {
      const ctx = ops.createContext(db, { actor: "тест" });
      const plates = ["а 123 вс 77", "A123BC77", "А123ВС-777", "a123bc 777", "ж 001 жж", " ", null];
      for (const plate of plates) {
        const customer = addClient(db);
        const vehicle = ops.addVehicle(ctx, { customerId: customer.id, make: "Test", plate });
        assert.equal(db.prepare("SELECT plate_key FROM vehicles WHERE id = ?").get(vehicle.id).plate_key, domain.plateKey(plate), `номер «${plate}»`);
      }
      assert.equal(domain.plateKey("а 123 вс 77"), "A123BC77");
      assert.ok(!db.prepare("SELECT name FROM pragma_table_info('customers')").all().some((column) => column.name === "phone_key"), "ключа телефона в офисной базе нет");
    } finally {
      db.close();
    }
  });

  await check("факты работ: время, итог без позиций, дата завершения", async () => {
    const db = openOfficeDb();
    const constraint = (fn, pattern) => assert.throws(fn, (error) => String(error.code).startsWith("SQLITE_CONSTRAINT") && (!pattern || pattern.test(error.message)));
    try {
      const ctx = ops.createContext(db, { actor: "тест" });
      const customer = addClient(db);
      const vehicle = ops.addVehicle(ctx, { customerId: customer.id, make: "Lada", vin: " xta 21700 0c 0123456 " });
      assert.equal(vehicle.vin, "XTA217000C0123456", "VIN приводится к канонической записи");
      const order = ops.createWorkOrder(ctx, { customerId: customer.id, vehicleId: vehicle.id });
      const id = order.id;

      ops.setWorkOrderStatus(ctx, { id, status: "awaiting_approval" });
      assert.throws(() => ops.decideOrderCost(ctx, { id, decision: "approved", basis: "отчёт" }), /общую согласованную сумму/);
      ops.decideOrderCost(ctx, { id, decision: "approved", basis: "Отчёт владельца", totalKopecks: 1_250_000 });
      ops.setWorkOrderStatus(ctx, { id, status: "in_progress" });
      assert.throws(() => ops.recordWorkResult(ctx, { id, finalTotalKopecks: 1, basis: "отчёт" }), /Готов к выдаче/);
      constraint(() => db.prepare("UPDATE work_orders SET final_total_kopecks = 100 WHERE id = ?").run(id), /final_total_kopecks/);
      constraint(() => db.prepare("UPDATE work_orders SET actual_duration_minutes = 30 WHERE id = ?").run(id), /actual_duration_minutes/);

      ops.setWorkOrderStatus(ctx, { id, status: "ready" });
      assert.throws(() => ops.recordWorkResult(ctx, { id, finalTotalKopecks: 1 }), /основание/);
      assert.throws(() => ops.recordWorkResult(ctx, { id, actualDurationMinutes: 0, basis: "отчёт" }), /Фактическое время/);
      assert.throws(() => ops.recordWorkResult(ctx, { id, completedAt: "2026-10-01T10:00:00.000Z", basis: "отчёт" }), /выданного/);
      ops.recordWorkResult(ctx, { id, actualDurationMinutes: 150, finalTotalKopecks: 1_340_000, basis: "Отчёт владельца: доплата за доп. работы" });
      constraint(() => db.prepare("UPDATE work_orders SET final_total_kopecks = -1 WHERE id = ?").run(id), /CHECK/);
      constraint(() => db.prepare("UPDATE work_orders SET actual_duration_minutes = 0 WHERE id = ?").run(id), /CHECK/);
      constraint(() => db.prepare("UPDATE work_orders SET status = 'completed', completed_at = '2026-10-02 15:00' WHERE id = ?").run(id), /completed_at/);
      constraint(() => db.prepare("UPDATE vehicles SET vin = 'xta217000c0123456' WHERE id = ?").run(vehicle.id), /vin/);
      assert.equal(db.prepare("SELECT count(*) AS n FROM order_items WHERE work_order_id = ?").get(id).n, 0, "итог без искусственных позиций");

      const future = new Date(Date.now() + 86_400_000).toISOString();
      assert.throws(() => ops.setWorkOrderStatus(ctx, { id, status: "completed", completedAt: future }), /будущем/);
      ops.setWorkOrderStatus(ctx, { id, status: "completed", completedAt: "2026-10-01T15:30:00.000Z" });
      ops.recordWorkResult(ctx, { id, completedAt: "2026-10-01T16:00:00.000Z", basis: "Владелец уточнил время выдачи" });
      const done = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id);
      assert.equal(done.completed_at, "2026-10-01T16:00:00.000Z", "дата завершения не зависит от даты создания");
      assert.ok(done.completed_at < done.created_at);
      assert.equal(done.actual_duration_minutes, 150);
      assert.equal(done.final_total_kopecks, 1_340_000);
      assert.equal(done.approved_total_kopecks, 1_250_000);
      const recorded = db.prepare("SELECT details_json FROM activity_events WHERE entity_id = ? AND action = 'work_result_recorded' ORDER BY occurred_at, rowid").all(id);
      assert.deepEqual(JSON.parse(recorded[0].details_json).changes.final_total_kopecks, { from: null, to: 1_340_000 });
      assert.throws(() => ops.recordWorkResult(ctx, { id, actualDurationMinutes: 150, basis: "повтор" }), /Нет изменений/);

      const withItems = ops.createWorkOrder(ctx, { customerId: customer.id, vehicleId: vehicle.id });
      ops.addOrderItem(ctx, { workOrderId: withItems.id, kind: "part", title: "Фильтр", unitPriceKopecks: 50_000 });
      ops.setWorkOrderStatus(ctx, { id: withItems.id, status: "awaiting_approval" });
      assert.throws(() => ops.decideOrderCost(ctx, { id: withItems.id, decision: "approved", basis: "x", totalKopecks: 1 }), /только для заказа без позиций/);
      ops.decideOrderCost(ctx, { id: withItems.id, decision: "approved", basis: "x" });
      ops.setWorkOrderStatus(ctx, { id: withItems.id, status: "in_progress" });
      ops.setWorkOrderStatus(ctx, { id: withItems.id, status: "ready" });
      ops.recordWorkResult(ctx, { id: withItems.id, actualDurationMinutes: 40, finalTotalKopecks: 55_000, basis: "отчёт" });
      const back = ops.setWorkOrderStatus(ctx, { id: withItems.id, status: "in_progress", note: "переделка" });
      assert.equal(back.final_total_kopecks, null, "возврат на доработку сбрасывает факты");
      assert.equal(db.prepare("SELECT final_total_kopecks FROM work_orders WHERE id = ?").get(withItems.id).final_total_kopecks, null);
      process.env.FRONTSMITH_TEST_READY_ORDER = withItems.id;
    } finally {
      db.close();
    }
    const readyId = process.env.FRONTSMITH_TEST_READY_ORDER;
    await cli("order:status", "--id", readyId, "--to", "ready");
    const viaCli = JSON.parse(jsonPart(await cli("order:result", "--id", readyId, "--minutes", "95", "--total", "612,50", "--basis", "Отчёт владельца")));
    assert.equal(viaCli.actual_duration_minutes, 95);
    assert.equal(viaCli.final_total_kopecks, 61_250);
    assert.equal(JSON.parse(jsonPart(await cli("order:result", "--id", readyId, "--total", "none", "--basis", "Сумма не подтверждена"))).final_total_kopecks, null);
    await withServer(async () => {
      const order = (await get(`/api/orders/${readyId}`)).body.data;
      assert.equal(order.actual_duration_minutes, 95, "панель получает новые поля");
    });
  });

  await check("сопоставление автомобиля по VIN, госномеру и телефону", async () => {
    const db = openOfficeDb();
    const connection = await connectCustomers({ db });
    const customers = connection.provider;
    const matchVehicle = (input) => matchVehicleWithCustomers(db, customers, input);
    const create = async (displayName, phone) => (await customers.createCustomer({ displayName, phone }, { allowSharedPhone: true })).customer;
    try {
      const ctx = ops.createContext(db, { actor: "тест" });
      const anna = await create("Анна Сопоставление", "+7 (901) 111-22-33");
      const annaFocus = ops.addVehicle(ctx, { customerId: anna.id, make: "Ford", model: "Focus", vin: "WF0AXXGCDA1234567", plate: "К 111 КК 77" });
      const annaRio = ops.addVehicle(ctx, { customerId: anna.id, make: "Kia", model: "Rio", plate: "М 222 ММ 77" });
      const boris = await create("Борис Сопоставление", "8 901 111 22 33");
      ops.addVehicle(ctx, { customerId: boris.id, make: "Lada", plate: "Е 333 ЕЕ 77" });
      const repeat = ops.createWorkOrder(ctx, { customerId: anna.id, vehicleId: annaFocus.id });

      let result = await matchVehicle({ vin: "wf0axxgcda1234567" });
      assert.equal(result.verdict, "match");
      assert.equal(result.confidence, "strong");
      assert.equal(result.candidates[0].vehicle_id, annaFocus.id);
      assert.equal(result.candidates[0].order_count, 1, "видно повторное обращение");
      assert.deepEqual(result.candidates[0].active_orders.map((order) => order.id), [repeat.id]);

      result = await matchVehicle({ plate: "k111kk77", phone: "89011112233" });
      assert.equal(result.verdict, "match");
      assert.equal(result.confidence, "strong", "номер и телефон совпали у одной машины");

      result = await matchVehicle({ plate: "к 111 кк 77" });
      assert.equal(result.verdict, "match");
      assert.equal(result.confidence, "weak", "только номер — уточнить");

      result = await matchVehicle({ vin: "1234567" });
      assert.equal(result.verdict, "match");
      assert.equal(result.confidence, "weak", "хвост VIN — уточнить");

      result = await matchVehicle({ phone: "+7 901 111-22-33" });
      assert.equal(result.verdict, "ambiguous", "телефон общий у двух клиентов и трёх машин");
      assert.equal(result.customers.length, 2);

      result = await matchVehicle({ vin: "WF0AXXGCDA1234567", plate: "М 222 ММ 77" });
      assert.equal(result.verdict, "ambiguous", "VIN и номер указывают на разные машины");
      assert.ok(result.candidates.some((candidate) => candidate.vehicle_id === annaRio.id));

      result = await matchVehicle({ plate: "Е 333 ЕЕ 77", phone: "+7 999 000-00-00" });
      assert.equal(result.verdict, "ambiguous", "номер есть, но телефон владельца другой");
      assert.deepEqual(result.candidates[0].conflicts, ["phone"]);

      const solo = await create("Без машины", "+7 902 000-00-01");
      result = await matchVehicle({ phone: "89020000001", plate: "Т 999 ТТ 99" });
      assert.equal(result.verdict, "customer_only");
      assert.equal(result.customers[0].id, solo.id);

      assert.equal((await matchVehicle({ plate: "О 000 ОО 00" })).verdict, "none");
      await assert.rejects(matchVehicle({}), /хотя бы/);
      await assert.rejects(matchVehicle({ vin: "ABIO1" }), /без I, O, Q/);
      assert.ok(!JSON.stringify(result).includes("902"), "результат сопоставления без телефона");
    } finally {
      await connection.stop();
      db.close();
    }
    const cliOutput = await cli("match", "--plate", "К111КК77", "--phone", "+79011112233");
    assert.equal(JSON.parse(cliOutput).verdict, "match");
    assert.ok(!/Анна|901/.test(cliOutput), "CLI match не выводит контакты клиента");
  });

  await check("часовой пояс бизнеса и ввод времени", () => {
    const range = domain.zonedDayRange(new Date("2026-10-13T22:30:00Z"), "Europe/Moscow");
    assert.deepEqual(range, { start: "2026-10-13T21:00:00.000Z", end: "2026-10-14T21:00:00.000Z", date: "2026-10-14" });
    assert.equal(domain.parseInstant("2026-10-14 10:00", "t", "Europe/Moscow"), "2026-10-14T07:00:00.000Z");
    assert.equal(domain.parseInstant("2026-10-14T10:00+05:00", "t", "Europe/Moscow"), "2026-10-14T05:00:00.000Z");
    assert.throws(() => domain.parseInstant("завтра", "t", "Europe/Moscow"));
  });

  console.log(`Проверки офиса пройдены: ${passed}. База: ${officeDbPath()}`);
} finally {
  await fakeCrm.close();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// --- помощники ---

// Клиент без контактов: бизнес-проверкам нужен только client_id
function addClient(db) {
  const id = domain.newId();
  const at = new Date().toISOString();
  db.prepare("INSERT INTO customers (id, is_demo, created_at, updated_at) VALUES (?, 0, ?, ?)").run(id, at, at);
  return { id };
}

async function writeDemoInquiry() {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "customer-inquiries", "demo-inquiry.json"), JSON.stringify({
    id: "demo-001",
    demo: true,
    customer: { name: "Демо-клиент Алексей", email: "alexey@example.com" },
    vehicle: { make: "Kia", model: "Rio", year: 2018, mileageKm: 95000 },
    serviceId: "computer-diagnostics",
    symptoms: "Горит Check Engine. Причина пока не установлена.",
    note: "Синтетический пример для теста"
  }));
}

async function cli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/office.mjs", ...args], { env: process.env });
    return stdout;
  } catch (error) {
    throw new Error(`${error.stderr || error.stdout || error.message}`);
  }
}

function jsonPart(output) {
  return output.slice(output.indexOf("{"));
}

function tableCounts(existing) {
  const db = existing ?? openOfficeDb({ readonly: true });
  try {
    return Object.fromEntries(["services", "customers", "vehicles", "inquiries", "work_orders", "order_items", "appointments", "tasks", "activity_events"]
      .map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  } finally {
    if (!existing) db.close();
  }
}

async function withServer(fn) {
  const instance = createOfficeServer({ port });
  await new Promise((resolve) => instance.server.listen(port, "127.0.0.1", resolve));
  try {
    await fn();
  } finally {
    await instance.close();
  }
}

function get(route, { method = "GET", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: route, method, headers: { host }, agent: false }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* не JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
