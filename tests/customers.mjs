// Customer Module: CustomerProvider/CrmkitProvider, client_id и связи, раздел «Клиенты»
// панели, перенос старой модели клиента и доверенный инструмент через Privacy Service.
// crmkit — тестовый двойник HTTP API (проверенное поведение v0.9.1); настоящий crmkitd
// проверяет `npm run test:crm`. Codex и pii-guard — двойники, как в test:codex-host.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-customers-"));
const businessRoot = path.join(testRoot, "business");
process.env.FRONTSMITH_BUSINESS_ROOT = businessRoot;
process.env.FRONTSMITH_ACTOR = "тест";
const port = 4188;

const { useFakeCrm } = await import("../services/crm/testing/fake-crmkit.mjs");
const fake = await useFakeCrm(path.join(testRoot, "data"));
const { migrate, officeDbPath, openOfficeDb } = await import("../office/lib/db.mjs");
const { CustomerError, normalizePhone } = await import("../office/customers/contract.mjs");
const { connectCustomers } = await import("../office/customers/index.mjs");
const { migrateLegacyCustomers, planLegacyMigration } = await import("../office/customers/migrate-legacy.mjs");
const { createOfficeServer } = await import("../office/server.mjs");
const ops = await import("../office/lib/operations.mjs");
const { AppServerClient } = await import("../services/codex-host/app-server-client.mjs");
const { CodexHost } = await import("../services/codex-host/codex-host.mjs");
const { codexEnv } = await import("../services/codex-host/codex-home.mjs");
const { PrivacyClient } = await import("../services/codex-host/privacy-client.mjs");
const { startFakePrivacyService } = await import("../services/codex-host/testing/fake-privacy-service.mjs");
const { getCustomerContextTool } = await import("../services/codex-host/tools/customer-context.mjs");
const { IVAN, IVAN_PII, MARIA, buildLegacyFixture, scanForPii } = await import("./fixtures/legacy-customers.mjs");

const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const EMAIL = "ivan@example.test";
const ORIGINALS = [PERSON, PHONE, "+79161234567", "9161234567", EMAIL];
const clean = (text) => ORIGINALS.every((value) => !text.includes(value));

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const privacy = await startFakePrivacyService();
let db;
let customers;
let connection;
try {
  await mkdir(businessRoot, { recursive: true });
  await copyFile("blueprints/auto-service/business.example.json", path.join(businessRoot, "business.json"));
  await cli("init");
  db = openOfficeDb();
  connection = await connectCustomers({ db });
  customers = connection.provider;
  let ivan;

  await check("телефон: распространённые российские записи дают один номер", () => {
    for (const value of ["+7 916 123-45-67", "8 916 123 45 67", "+7(916)1234567", "89161234567", "9161234567"]) assert.equal(normalizePhone(value), "+79161234567", value);
    assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
    assert.throws(() => normalizePhone("912 345 67 89 доб. 2"), (error) => error instanceof CustomerError && error.code === "invalid_input");
    assert.throws(() => normalizePhone("123-45"), /Телефон/);
  });

  await check("CustomerProvider создаёт клиента: контакт в CRM, в офисе только client_id и связь", async () => {
    const result = await customers.createCustomer({ displayName: PERSON, phone: "8 916 123 45 67", email: "Ivan@Example.test", notes: "Предпочитает звонки" });
    ivan = result.customer;
    assert.equal(result.status, "created");
    assert.match(ivan.id, /^[0-9a-f-]{36}$/);
    const contact = fake.contacts.find((item) => item.custom.frontsmith_client_id === ivan.id);
    assert.equal(contact.name, PERSON);
    assert.equal(contact.phone, "+79161234567", "в CRM нормализованный номер");
    assert.equal(contact.email, EMAIL);
    assert.notEqual(contact.id, ivan.id, "client_id Frontsmith не равен ID контакта CRM");
    assert.deepEqual(Object.keys(db.prepare("SELECT * FROM customers WHERE id = ?").get(ivan.id)).sort(), ["created_at", "id", "is_demo", "revision", "updated_at"]);
    const link = db.prepare("SELECT * FROM customer_provider_links WHERE client_id = ?").get(ivan.id);
    assert.deepEqual({ provider: link.provider, instance: link.provider_instance, external: link.external_id }, { provider: "crmkit", instance: fake.workspaceId, external: contact.id });
  });

  await check("CustomerProvider читает клиента по client_id", async () => {
    const read = await customers.getCustomer(ivan.id);
    assert.equal(read.displayName, PERSON);
    assert.equal(read.phoneDisplay, PHONE);
    assert.equal(read.email, EMAIL);
    assert.equal(read.notes, "Предпочитает звонки");
    assert.equal(await customers.getCustomer("00000000-0000-4000-8000-000000000000"), null);
  });

  await check("поиск: кириллица без учёта регистра, телефон в любой записи, часть номера, email", async () => {
    assert.equal((await customers.searchCustomers("петров")).matches[0].id, ivan.id);
    assert.equal((await customers.searchCustomers("+7(916)1234567")).kind, "phone");
    assert.equal((await customers.searchCustomers("8 916 123 45 67")).matches[0].id, ivan.id);
    assert.equal((await customers.searchCustomers("4567")).verdict, "single");
    assert.equal((await customers.searchCustomers("ivan@example")).matches[0].id, ivan.id);
    assert.equal((await customers.searchCustomers("Сидорова")).verdict, "none");
  });

  await check("один номер у двух людей: клиенты не сливаются, решение за оператором", async () => {
    await assert.rejects(customers.createCustomer({ displayName: "Пётр Иванов", phone: "+7 916 123-45-67" }),
      (error) => error.code === "phone_in_use" && error.candidates.includes(ivan.id) && !error.message.includes("916"));
    const second = await customers.createCustomer({ displayName: "Пётр Иванов", phone: "89161234567" }, { allowSharedPhone: true });
    assert.notEqual(second.customer.id, ivan.id);
    const found = await customers.searchCustomers("+7 916 123-45-67");
    assert.equal(found.verdict, "multiple");
    assert.equal(found.matches.length, 2);
  });

  await check("email уже у клиента: конфликт до upsert crmkit, чужой контакт не меняется", async () => {
    const before = JSON.stringify(fake.contacts);
    await assert.rejects(customers.createCustomer({ displayName: "Другой Иван", email: "IVAN@example.test" }), (error) => error.code === "email_in_use" && error.candidates[0] === ivan.id);
    assert.equal(JSON.stringify(fake.contacts), before);
  });

  await check("редактирование через CustomerProvider; client_id стабилен; устаревшая версия отклоняется", async () => {
    const current = await customers.getCustomer(ivan.id);
    const updated = await customers.updateCustomer(ivan.id, { displayName: "Иван Петрович Петров", phone: "+7 916 765-43-21", email: null }, { version: current.version });
    assert.equal(updated.id, ivan.id);
    assert.equal(updated.phone, "+79167654321");
    assert.equal(updated.email, null);
    await assert.rejects(customers.updateCustomer(ivan.id, { notes: "x" }, { version: current.version }), (error) => error.code === "version_conflict");
    assert.equal(db.prepare("SELECT count(*) AS n FROM customer_provider_links WHERE client_id = ?").get(ivan.id).n, 1);
    const event = db.prepare("SELECT summary, details_json FROM activity_events WHERE entity_id = ? AND action = 'contact_updated'").get(ivan.id);
    assert.equal(event.summary, "Изменены контакты клиента");
    assert.ok(!/Петров|916/.test(event.details_json), "в журнале только названия полей");
    await customers.updateCustomer(ivan.id, { displayName: PERSON, phone: PHONE, email: EMAIL }, { allowSharedPhone: true });
  });

  await check("повтор создания с тем же ключом и сбой после создания контакта не дают дубль", async () => {
    const requestId = "7d7e8f90-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    const count = fake.contacts.length;
    fake.faults.dropResponseAfterCreate = true;
    await assert.rejects(customers.createCustomer({ displayName: "Сбойный Клиент" }, { clientId: requestId }), (error) => error.code === "crm_unavailable");
    assert.equal(fake.contacts.length, count + 1, "контакт создан, ответ потерян");
    assert.equal(db.prepare("SELECT count(*) AS n FROM customers WHERE id = ?").get(requestId).n, 0, "связи ещё нет");
    const retry = await customers.createCustomer({ displayName: "Сбойный Клиент" }, { clientId: requestId });
    assert.equal(retry.status, "recovered");
    assert.equal((await customers.createCustomer({ displayName: "Сбойный Клиент" }, { clientId: requestId })).status, "existing");
    assert.equal(fake.contacts.length, count + 1, "второй контакт не создан");
  });

  await check("новый клиент: в офисной базе нет его ПД (ячейки и байты файла)", async () => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const scan = scanForPii(officeDbPath(), ORIGINALS);
    assert.deepEqual(Object.values(scan.cells).filter(Boolean), [], JSON.stringify(scan.cells));
    assert.deepEqual(scan.bytes, {});
  });

  // --- Панель ---
  const server = createOfficeServer({ port });
  await new Promise((resolve) => server.server.listen(port, "127.0.0.1", resolve));
  const responses = [];
  const call = async (route, options) => {
    const response = await http(route, options);
    responses.push(response.raw);
    return response;
  };
  const write = (method, route, body, headers = {}) => call(route, { method, body, headers: { "content-type": "application/json", "x-frontsmith-office": "1", ...headers } });
  try {
    let createdId;
    await check("UI: список клиентов из CRM через сервер Frontsmith", async () => {
      const list = (await call("/api/customers")).body.data;
      const row = list.find((item) => item.id === ivan.id);
      assert.equal(row.displayName, PERSON);
      assert.equal(row.phoneDisplay, PHONE);
      assert.equal(row.contactStatus, "ok");
      assert.equal((await call(`/api/customers?q=${encodeURIComponent("ПЕТРОВ")}`)).body.data.length, 1);
      const meta = (await call("/api/meta")).body.data.customers;
      assert.deepEqual({ provider: meta.provider, available: meta.available }, { provider: "crmkit", available: true });
    });

    await check("UI: создание клиента; повтор той же формы не создаёт дубль; запрос не из панели отклоняется", async () => {
      const requestId = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
      const body = { displayName: "Ольга Кузнецова", phone: "+7 (905) 111-22-33", email: "olga@example.test", notes: "Из панели", tags: ["vip"], requestId };
      const created = await write("POST", "/api/customers", body);
      assert.equal(created.status, 201, created.raw);
      createdId = created.body.data.customer.id;
      assert.equal(createdId, requestId);
      const again = await write("POST", "/api/customers", body);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.status, "existing");
      assert.equal(fake.contacts.filter((contact) => contact.name === "Ольга Кузнецова").length, 1);
      assert.equal((await call("/api/customers", { method: "POST", body, headers: { "content-type": "application/json" } })).status, 403, "без заголовка панели");
      assert.equal((await write("POST", "/api/customers", body, { origin: "http://attacker.example" })).status, 403, "чужой Origin");
      assert.equal((await write("POST", "/api/customers", { displayName: "" })).body.error.code, "invalid_input");
      assert.equal((await write("POST", "/api/orders", {})).status, 405, "остальные разделы только читают");
    });

    await check("UI: карточка — контакты из CRM и бизнес-данные по client_id", async () => {
      const vehicle = ops.addVehicle(ops.createContext(db, { actor: "тест" }), { customerId: createdId, make: "Skoda", model: "Rapid" });
      const inquiry = ops.createInquiry(ops.createContext(db, { actor: "тест" }), { customerId: createdId, vehicleId: vehicle.id, source: "phone", description: "Плановое ТО" });
      const card = (await call(`/api/customers/${createdId}`)).body.data;
      assert.equal(card.contact.displayName, "Ольга Кузнецова");
      assert.equal(card.contactStatus, "ok");
      assert.equal(card.vehicles[0].id, vehicle.id);
      assert.equal(card.inquiries[0].id, inquiry.id);
      const inquiries = (await call("/api/inquiries")).body.data;
      assert.equal(inquiries.find((item) => item.id === inquiry.id).customer_name, "Ольга Кузнецова", "подпись бизнес-записи — через CustomerProvider");
      assert.equal((await call(`/api/inquiries?q=${encodeURIComponent("кузнецова")}`)).body.data.length, 1, "поиск обращения по имени клиента из CRM");
      assert.ok(!db.prepare("SELECT summary FROM activity_events WHERE entity_id = ?").get(inquiry.id).summary.includes("Кузнецова"), "журнал без имени");
    });

    await check("UI: редактирование контактов; устаревшая версия — 409", async () => {
      const card = (await call(`/api/customers/${createdId}`)).body.data;
      const updated = await write("PATCH", `/api/customers/${createdId}`, { displayName: "Ольга Кузнецова-Смирнова", phone: "8 905 111 22 44", version: card.contact.version });
      assert.equal(updated.status, 200, updated.raw);
      assert.equal(updated.body.data.customer.phoneDisplay, "+7 905 111-22-44");
      assert.equal((await write("PATCH", `/api/customers/${createdId}`, { notes: "x", version: card.contact.version })).status, 409);
      assert.equal((await call(`/api/customers/${createdId}`)).body.data.contact.displayName, "Ольга Кузнецова-Смирнова");
    });

    await check("UI: CRM недоступен — бизнес-разделы работают, имя не угадывается", async () => {
      fake.faults.failNext = 1000;
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const inquiries = await call("/api/inquiries");
      assert.equal(inquiries.status, 200);
      const row = inquiries.body.data.find((item) => item.customer_id === createdId);
      assert.equal(row.customer_contact, "unavailable");
      assert.match(row.customer_name, /^Клиент [0-9a-f]{8}$/);
      fake.faults.failNext = 0;
    });

    await check("учётные данные crmkit не попадают в браузер", async () => {
      for (const route of ["/", "/app.js", "/api/meta", "/api/overview", "/api/events"]) await call(route);
      for (const raw of responses) {
        assert.ok(!raw.includes(fake.token), "токен crmkit");
        assert.ok(!raw.includes(fake.url), "адрес crmkit");
        assert.ok(!raw.includes("c_fake"), "ID контакта CRM");
      }
    });
  } finally {
    await server.close();
  }

  await check("CLI: customer:add через CRM, вывод без контактов", async () => {
    const output = await cli("customer:add", "--name", "Анна Белова", "--phone", "+7 911 000-11-22");
    assert.ok(!/Анна|911/.test(output));
    const id = JSON.parse(output.slice(output.indexOf("{"))).id;
    assert.equal((await customers.getCustomer(id)).displayName, "Анна Белова");
    assert.ok(!/Анна|911/.test(await cli("list", "customers")), "list без --contacts не показывает контакты");
    assert.match(await cli("list", "customers", "--contacts"), /Анна Белова/);
  });

  // --- Перенос старой модели ---
  const fixture = path.join(testRoot, "legacy.sqlite");
  await check("fixture старой модели: миграция схемы 004 сохраняет client_id и связи, ПД — в карантине", async () => {
    assert.equal(buildLegacyFixture(fixture), 3);
    const legacy = openOfficeDb({ file: fixture });
    try {
      assert.deepEqual(migrate(legacy).applied, ["004_customer_identity.sql"]);
      assert.deepEqual(legacy.pragma("foreign_key_check"), []);
      assert.equal(legacy.prepare("SELECT count(*) AS n FROM customers").get().n, 2);
      assert.equal(legacy.prepare("SELECT customer_id FROM work_orders WHERE id = 'o-ivan'").get().customer_id, IVAN.id);
      assert.equal(legacy.prepare("SELECT full_name FROM legacy_customer_contacts WHERE client_id = ?").get(IVAN.id).full_name, IVAN.name);
      assert.ok(!legacy.prepare("SELECT name FROM pragma_table_info('customers')").all().some((column) => ["full_name", "phone", "email", "note", "phone_key"].includes(column.name)));
    } finally {
      legacy.close();
    }
  });

  await check("перенос --dry-run: конфликт email с клиентом CRM виден до переноса", async () => {
    const output = await execFileAsync(process.execPath, ["scripts/crm-migrate-customers.mjs", "--dry-run", "--db", fixture], { env: process.env }).then((result) => result.stdout);
    assert.match(output, new RegExp(`Конфликт: email уже есть у контакта CRM — ${IVAN.id}`));
    assert.ok(!output.includes(IVAN.email));
    // Тот же синтетический email у клиента из проверок выше: убрать, чтобы перенос не конфликтовал
    await customers.updateCustomer(ivan.id, { email: null });
  });

  await check("перенос --dry-run: количества и типы ПД без значений, база не меняется", async () => {
    const output = await execFileAsync(process.execPath, ["scripts/crm-migrate-customers.mjs", "--dry-run", "--db", fixture], { env: process.env }).then((result) => result.stdout);
    assert.match(output, /Клиентов с контактами в офисной базе: 2/);
    assert.match(output, /будет создано контактов в CRM:\s+2/);
    assert.match(output, /имя 2, телефон 2, email 1, заметка 1/);
    assert.ok(IVAN_PII.concat([MARIA.name, "765-43-21"]).every((value) => !output.includes(value)), output);
    const legacy = openOfficeDb({ file: fixture, readonly: true });
    try {
      assert.equal(legacy.prepare("SELECT count(*) AS n FROM legacy_customer_contacts").get().n, 2);
    } finally {
      legacy.close();
    }
  });

  await check("перенос fixture: контакты в CRM, тот же client_id, связи и FK на месте, ПД из базы удалены", async () => {
    const legacy = openOfficeDb({ file: fixture });
    const legacyConnection = await connectCustomers({ db: legacy });
    try {
      const plan = await planLegacyMigration(legacy, legacyConnection.provider);
      assert.equal(plan.toCreate, 2);
      const result = await migrateLegacyCustomers(legacy, legacyConnection.provider);
      assert.deepEqual({ migrated: result.migrated, remaining: result.remaining, conflicts: result.conflicts.length }, { migrated: 2, remaining: 0, conflicts: 0 });
      const contact = fake.contacts.find((item) => item.custom.frontsmith_client_id === IVAN.id);
      assert.deepEqual({ name: contact.name, phone: contact.phone, email: contact.email, notes: contact.notes }, { name: IVAN.name, phone: "+79161234567", email: IVAN.email, notes: IVAN.note });
      assert.equal((await legacyConnection.provider.getCustomer(IVAN.id)).displayName, IVAN.name);
      assert.equal(legacy.prepare("SELECT count(*) AS n FROM customers").get().n, 2, "client_id сохранены");
      assert.equal(legacy.prepare("SELECT external_id FROM customer_provider_links WHERE client_id = ?").get(IVAN.id).external_id, contact.id);
      for (const [table, id] of [["vehicles", "v-ivan"], ["inquiries", "i-ivan"], ["work_orders", "o-ivan"]]) {
        assert.equal(legacy.prepare(`SELECT customer_id FROM ${table} WHERE id = ?`).get(id).customer_id, IVAN.id, table);
      }
      assert.deepEqual(legacy.pragma("foreign_key_check"), []);
      assert.equal(legacy.pragma("integrity_check", { simple: true }), "ok");
      const summaries = legacy.prepare("SELECT summary FROM activity_events ORDER BY rowid").all().map((row) => row.summary);
      assert.ok(summaries.includes("Добавлен клиент") && summaries.includes("Добавлен автомобиль Kia Rio") && summaries.includes("Новое обращение: Диагностика") && summaries.includes("Создан заказ ЗН-2026-0001"), summaries.join(" | "));
      assert.equal(legacy.prepare("SELECT description FROM inquiries WHERE id = 'i-ivan'").get().description, "Стук в подвеске", "бизнес-текст не тронут");
      // Повтор: ни нового контакта, ни изменений
      const count = fake.contacts.length;
      const again = await migrateLegacyCustomers(legacy, legacyConnection.provider);
      assert.deepEqual({ migrated: again.migrated, remaining: again.remaining }, { migrated: 0, remaining: 0 });
      assert.equal(fake.contacts.length, count);
    } finally {
      await legacyConnection.stop();
      legacy.close();
    }
    const scan = scanForPii(fixture, [...IVAN_PII, MARIA.name, "8 (903) 765-43-21", "+79037654321"]);
    assert.deepEqual(Object.entries(scan.cells).filter(([, n]) => n), [], "ячейки базы");
    assert.deepEqual(scan.bytes, {}, "байты файла и WAL");
  });

  await check("перенос: ПД не удаляются, пока связь не сохранена (сбой CRM на середине)", async () => {
    const second = path.join(testRoot, "legacy-fault.sqlite");
    buildLegacyFixture(second);
    const legacy = openOfficeDb({ file: second });
    migrate(legacy);
    // Контакты этого fixture уже есть в CRM от прошлого переноса: удалить отметки, чтобы перенос создавал новые
    for (const contact of fake.contacts) if ([IVAN.id, MARIA.id].includes(contact.custom.frontsmith_client_id)) contact.custom = { moved: true };
    for (const contact of fake.contacts) if (contact.email === IVAN.email) delete contact.email;
    const legacyConnection = await connectCustomers({ db: legacy });
    try {
      fake.faults.dropResponseAfterCreate = true;
      const interrupted = await migrateLegacyCustomers(legacy, legacyConnection.provider);
      assert.deepEqual(interrupted.failed.map((entry) => [entry.clientId, entry.code]), [[IVAN.id, "crm_unavailable"]]);
      assert.equal(interrupted.remaining, 1);
      assert.ok(legacy.prepare("SELECT 1 FROM legacy_customer_contacts WHERE client_id = ?").get(IVAN.id), "ПД на месте: контакт создан, но связь не сохранена");
      assert.equal(legacy.prepare("SELECT count(*) AS n FROM customer_provider_links WHERE client_id = ?").get(IVAN.id).n, 0);
      const result = await migrateLegacyCustomers(legacy, legacyConnection.provider);
      assert.equal(result.recovered, 1, "перенос продолжился без второго контакта");
      assert.equal(result.remaining, 0);
      assert.equal(fake.contacts.filter((contact) => contact.custom.frontsmith_client_id === IVAN.id).length, 1);
    } finally {
      await legacyConnection.stop();
      legacy.close();
    }
  });

  // --- Доверенный инструмент → Privacy Service → Codex ---
  await check("get_customer_context: CRM → CustomerProvider → Privacy Service → Codex без исходных ПД", async () => {
    const workspace = path.join(testRoot, "agent-workspace");
    const log = path.join(testRoot, "fake-app-server.jsonl");
    const client = AppServerClient.spawn({ codexBin: process.execPath, args: [path.join(repo, "services", "codex-host", "testing", "fake-app-server.mjs")], env: { ...process.env, FAKE_APP_SERVER_LOG: log }, cwd: testRoot });
    const seen = [];
    const tool = getCustomerContextTool(customers);
    const raw = await tool.handler({ client_id: ivan.id });
    assert.ok(raw.includes(PERSON) && raw.includes(PHONE), "инструмент читает настоящие контакты в доверенной части");
    const host = new CodexHost({ client, privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }), workspace, tools: [tool], diagnostics: { captureModelVisible: (entry) => seen.push(entry) } });
    try {
      await host.start();
      const conversation = await host.openConversation({ tenantId: "test-tenant" });
      const reply = await host.send(conversation.conversationId, `get_customer_context client_id=${ivan.id}`);
      assert.deepEqual(reply.toolCalls, ["get_customer_context"]);
      const received = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const output = received.find((entry) => entry.kind === "tool_output");
      assert.ok(output.success);
      assert.ok(clean(output.text), output.text);
      assert.match(output.text, /<PII type="PERSON"/);
      assert.match(output.text, /<PII type="PHONE_NUMBER"/);
      assert.ok(output.text.includes(ivan.id), "client_id модель видит: это не ПД");
      assert.ok(clean(reply.modelText));
      assert.ok(reply.text.includes(PERSON), "ответ оператору восстановлен локально");
      assert.ok(seen.every((entry) => clean(entry.text)));
      const start = received.find((entry) => entry.method === "thread/start");
      assert.deepEqual(start.params.dynamicTools.map((item) => item.name), ["get_customer_context"], "crmkit MCP и прямой доступ к CRM не подключаются");

      privacy.mode.failSource = "tool";
      await assert.rejects(host.send(conversation.conversationId, `get_customer_context client_id=${ivan.id}`), /privacy/);
      privacy.mode.failSource = null;
      const failed = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.kind === "tool_output").at(-1);
      assert.equal(failed.text, "privacy_processing_failed", "отказ Privacy Service — модель получает только код");
    } finally {
      host.close();
    }
    const env = codexEnv(path.join(testRoot, "codex-home"), process.env);
    assert.ok(!JSON.stringify(env).includes(fake.token) && !Object.keys(env).some((key) => key.startsWith("FRONTSMITH_CRM")), "окружение App Server без учётных данных CRM");
    assert.ok(!existsSync(path.join(workspace, "credential.json")));
  });

  console.log(`Customer Module: ${passed} проверок пройдено`);
} finally {
  await connection?.stop();
  db?.close();
  await privacy.close();
  await fake.close();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function cli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/office.mjs", ...args], { env: process.env });
    return stdout;
  } catch (error) {
    throw new Error(`${error.stderr || error.stdout || error.message}`);
  }
}

function http(route, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path: route, method, headers: { host: `127.0.0.1:${port}`, ...headers, ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) }, agent: false }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* не JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
