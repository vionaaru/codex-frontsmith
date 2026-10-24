// Fixture старой модели клиента (схема 003: контакты в customers) и поиск ПД после переноса.
// Значения синтетические. Журнал повторяет шаблоны прежних операций, которые копировали имя клиента
import { readFileSync, existsSync } from "node:fs";
import { migrate, openOfficeDb } from "../../office/lib/db.mjs";

export const IVAN = {
  id: "0b8f4f2e-6c1d-4f0a-9a57-3d2c1b0a9e81",
  name: "Иван Петров",
  phone: "+7 916 123-45-67",
  email: "ivan@example.test",
  note: "Синтетический клиент для проверки переноса"
};
export const MARIA = { id: "5d0c9b8a-7e6f-4d3c-8b2a-1f0e9d8c7b6a", name: "Мария Сидорова", phone: "8 (903) 765-43-21", email: null, note: null };

// Значения, которых не должно остаться в офисной базе после переноса
export const IVAN_PII = ["Иван Петров", "+7 916 123-45-67", "89161234567", "+79161234567", "79161234567", "ivan@example.test"];

export function buildLegacyFixture(file) {
  const db = openOfficeDb({ file });
  try {
    migrate(db, { upTo: 3 });
    const at = "2026-10-01T09:00:00.000Z";
    db.prepare(`INSERT INTO business (id, name, time_zone, currency, demo_mode, profile_source, synced_at, created_at, updated_at)
      VALUES ('b1', 'Fixture', 'Europe/Moscow', 'RUB', 0, 'fixture', ?, ?, ?)`).run(at, at, at);
    const event = (entityType, entityId, action, summary, details = null) => db.prepare(`INSERT INTO activity_events
      (id, occurred_at, entity_type, entity_id, action, actor, source, summary, details_json) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 'fixture', 'cli', ?, ?)`)
      .run(at, entityType, entityId, action, summary, details === null ? null : JSON.stringify(details));
    for (const customer of [IVAN, MARIA]) {
      db.prepare("INSERT INTO customers (id, full_name, phone, email, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(customer.id, customer.name, customer.phone, customer.email, customer.note, at, at);
      event("customer", customer.id, "created", `Добавлен клиент ${customer.name}`);
    }
    db.prepare("INSERT INTO services (id, code, name, category, currency, created_at, updated_at) VALUES ('s1', 'diag', 'Диагностика', 'diagnostics', 'RUB', ?, ?)").run(at, at);
    db.prepare("INSERT INTO vehicles (id, customer_id, make, model, plate, created_at, updated_at) VALUES ('v-ivan', ?, 'Kia', 'Rio', 'А123ВС77', ?, ?)").run(IVAN.id, at, at);
    event("vehicle", "v-ivan", "created", `Автомобиль Kia Rio добавлен клиенту ${IVAN.name}`);
    db.prepare("INSERT INTO vehicles (id, customer_id, make, created_at, updated_at) VALUES ('v-maria', ?, 'Lada', ?, ?)").run(MARIA.id, at, at);
    event("vehicle", "v-maria", "created", `Автомобиль Lada добавлен клиенту ${MARIA.name}`);
    db.prepare(`INSERT INTO inquiries (id, customer_id, vehicle_id, requested_service_id, source, description, status, received_at, closed_at, created_at, updated_at)
      VALUES ('i-ivan', ?, 'v-ivan', 's1', 'phone', 'Стук в подвеске', 'converted', ?, ?, ?, ?)`).run(IVAN.id, at, at, at, at);
    event("inquiry", "i-ivan", "created", `Новое обращение: ${IVAN.name} · Диагностика`, { source: "phone" });
    db.prepare(`INSERT INTO work_orders (id, number, customer_id, vehicle_id, inquiry_id, status, currency, created_at, updated_at)
      VALUES ('o-ivan', 'ЗН-2026-0001', ?, 'v-ivan', 'i-ivan', 'draft', 'RUB', ?, ?)`).run(IVAN.id, at, at);
    event("work_order", "o-ivan", "created", `Создан заказ ЗН-2026-0001 для ${IVAN.name}`, { inquiryId: "i-ivan" });
    db.prepare("INSERT INTO tasks (id, work_order_id, title, status, created_at, updated_at) VALUES ('t-ivan', 'o-ivan', 'Перезвонить по стоимости', 'open', ?, ?)").run(at, at);
    // Копия контакта в деталях события: такие поля переносятся вместе с клиентом
    event("task", "t-ivan", "created", "Задача: Перезвонить по стоимости", { callback: IVAN.phone, email: IVAN.email });
    return db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v;
  } finally {
    db.close();
  }
}

// Поиск значений во всех текстовых ячейках всех таблиц и в байтах файлов базы (включая WAL)
export function scanForPii(file, values) {
  const db = openOfficeDb({ file, readonly: true });
  const hits = Object.fromEntries(values.map((value) => [value, 0]));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
        for (const cell of Object.values(row)) {
          if (typeof cell !== "string") continue;
          for (const value of values) if (cell.includes(value)) hits[value] += 1;
        }
      }
    }
  } finally {
    db.close();
  }
  const bytes = {};
  for (const suffix of ["", "-wal"]) {
    if (!existsSync(`${file}${suffix}`)) continue;
    const content = readFileSync(`${file}${suffix}`);
    for (const value of values) if (content.includes(Buffer.from(value, "utf8"))) bytes[value] = (bytes[value] ?? 0) + 1;
  }
  return { cells: hits, bytes };
}
