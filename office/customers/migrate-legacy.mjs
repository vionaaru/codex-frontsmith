// Перенос контактов прежней модели клиента в CustomerProvider.
//
//   прежний клиент (legacy_customer_contacts, миграция 004)
//     → найти или создать контакт CRM (custom.frontsmith_client_id = прежний client_id)
//     → сохранить связь customer_provider_links
//     → в одной транзакции с проверкой связи: убрать копии контактов из журнала
//       и удалить строку legacy_customer_contacts
//
// Состояния «ПД удалены, а контакт или связь не сохранены» не бывает: строка карантина
// удаляется только в транзакции, которая видит сохранённую связь. Повторный запуск
// продолжает с места сбоя и не создаёт второй контакт (поиск по client_id в CRM).
// Свободные бизнес-тексты не чистятся: их обрабатывает Privacy Service при передаче AI.
import { CustomerError, normalizeEmail, normalizePhone } from "./contract.mjs";
import { getLink } from "./identity.mjs";

const REDACTED = "[контакт перенесён в CRM]";

export function legacyRows(db) {
  const version = db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v;
  if (version >= 4) return db.prepare("SELECT client_id, full_name, phone, email, note FROM legacy_customer_contacts ORDER BY captured_at, client_id").all();
  // База до миграции 004 (только для --dry-run): контакты ещё в customers
  return db.prepare("SELECT id AS client_id, full_name, phone, email, note FROM customers ORDER BY created_at, id").all();
}

// Поля для CRM. Номер или email, которые не проходят проверку, не теряются: они
// переносятся в заметку контакта CRM, а не остаются в офисной базе
export function contactInput(row) {
  const notes = [];
  let phone = null;
  let email = null;
  if (row.phone) {
    try { phone = normalizePhone(row.phone); } catch { notes.push(`Прежняя запись телефона: ${row.phone}`); }
  }
  if (row.email) {
    try { email = normalizeEmail(row.email); } catch { notes.push(`Прежняя запись email: ${row.email}`); }
  }
  if (row.note) notes.unshift(row.note);
  return { input: { displayName: row.full_name?.trim() || "Клиент без имени", phone, email, notes: notes.join("\n") || null }, unparsed: { phone: Boolean(row.phone && !phone), email: Boolean(row.email && !email) } };
}

// Сводка без значений: только количества и client_id
export async function planLegacyMigration(db, provider = null) {
  const rows = legacyRows(db);
  const scope = provider ? { provider: provider.name, instance: provider.instance } : null;
  const plan = {
    customers: rows.length,
    linked: 0,
    toCreate: 0,
    alreadyInCrm: 0,
    pii: { name: 0, phone: 0, email: 0, note: 0 },
    unparsed: { phone: 0, email: 0 },
    conflicts: [],
    sharedPhones: 0,
    crm: provider ? "available" : "not_checked"
  };
  const emails = new Map();
  const phones = new Map();
  for (const row of rows) {
    for (const [key, column] of [["name", "full_name"], ["phone", "phone"], ["email", "email"], ["note", "note"]]) if (row[column]) plan.pii[key] += 1;
    const { input, unparsed } = contactInput(row);
    if (unparsed.phone) plan.unparsed.phone += 1;
    if (unparsed.email) plan.unparsed.email += 1;
    if (input.email) emails.set(input.email, [...(emails.get(input.email) ?? []), row.client_id]);
    if (input.phone) phones.set(input.phone, (phones.get(input.phone) ?? 0) + 1);
    if (scope && getLink(db, row.client_id, scope)) {
      plan.linked += 1;
      continue;
    }
    if (provider && (await provider.findMarkedContact(row.client_id))) {
      plan.alreadyInCrm += 1;
      continue;
    }
    plan.toCreate += 1;
    const inCrm = provider && input.email ? await provider.emailConflict(input.email) : null;
    if (inCrm) plan.conflicts.push({ kind: "email_in_crm", clientIds: [row.client_id], crmCandidates: inCrm });
  }
  for (const ids of emails.values()) if (ids.length > 1) plan.conflicts.push({ kind: "duplicate_email", clientIds: ids });
  plan.sharedPhones = [...phones.values()].filter((count) => count > 1).length;
  return plan;
}

// Связанные с клиентом записи журнала: сам клиент, его автомобили, обращения, заказы, записи и задачи
function relatedEntityIds(db, clientId) {
  return db.prepare(`SELECT @id AS id
    UNION SELECT id FROM vehicles WHERE customer_id = @id
    UNION SELECT id FROM inquiries WHERE customer_id = @id
    UNION SELECT id FROM work_orders WHERE customer_id = @id
    UNION SELECT a.id FROM appointments a LEFT JOIN inquiries i ON i.id = a.inquiry_id LEFT JOIN work_orders w ON w.id = a.work_order_id WHERE coalesce(i.customer_id, w.customer_id) = @id
    UNION SELECT t.id FROM tasks t LEFT JOIN inquiries i ON i.id = t.inquiry_id LEFT JOIN work_orders w ON w.id = t.work_order_id WHERE coalesce(i.customer_id, w.customer_id) = @id`)
    .all({ id: clientId }).map((row) => row.id);
}

// Прежние шаблоны журнала копировали имя клиента в summary. Шаблон заменяется новым
// без имени, остальные точные совпадения контактов — меткой
export function scrubSummary(summary, values) {
  let text = summary;
  for (const name of values.names) {
    text = text
      .replace(`Добавлен клиент ${name}`, "Добавлен клиент")
      .replace(new RegExp(`^Автомобиль (.+) добавлен клиенту ${escape(name)}$`), "Добавлен автомобиль $1")
      .replace(new RegExp(`^Новое обращение: ${escape(name)}( · (.+))?$`), (_, __, service) => `Новое обращение${service ? `: ${service}` : ""}`)
      .replace(new RegExp(`^(Создан заказ .+) для ${escape(name)}$`), "$1");
  }
  return replaceValues(text, values.all);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceValues(text, values) {
  let result = text;
  for (const value of values) if (value) result = result.split(value).join(REDACTED);
  return result;
}

function scrubEvents(db, clientId, row) {
  const values = { names: [row.full_name].filter(Boolean), all: [row.full_name, row.phone, row.email, row.note].filter((value) => value && value.trim().length >= 3) };
  const ids = relatedEntityIds(db, clientId);
  const events = db.prepare(`SELECT id, summary, details_json FROM activity_events WHERE entity_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  let changed = 0;
  for (const event of events) {
    const summary = scrubSummary(event.summary, values);
    const details = event.details_json === null ? null : JSON.stringify(scrubJson(JSON.parse(event.details_json), values.all));
    if (summary !== event.summary || details !== event.details_json) {
      db.prepare("UPDATE activity_events SET summary = ?, details_json = ? WHERE id = ?").run(summary, details, event.id);
      changed += 1;
    }
  }
  return changed;
}

function scrubJson(value, values) {
  if (typeof value === "string") return replaceValues(value, values);
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubJson(item, values)]));
  return value;
}

// Перенос. onProgress получает только client_id и статус
export async function migrateLegacyCustomers(db, provider, { onProgress = () => {} } = {}) {
  const scope = { provider: provider.name, instance: provider.instance };
  const result = { migrated: 0, recovered: 0, alreadyLinked: 0, eventsScrubbed: 0, conflicts: [], failed: [] };
  db.pragma("secure_delete = ON");
  for (const row of legacyRows(db)) {
    let status;
    if (getLink(db, row.client_id, scope)) {
      status = "linked";
      result.alreadyLinked += 1;
    } else {
      try {
        const created = await provider.createCustomer(contactInput(row).input, {
          clientId: row.client_id, adoptIdentity: true, allowSharedPhone: true, actor: "перенос в CRM", source: "migration"
        });
        status = created.status;
        if (status === "recovered") result.recovered += 1;
      } catch (error) {
        if (!(error instanceof CustomerError)) throw error;
        const entry = { clientId: row.client_id, code: error.code, candidates: error.candidates };
        if (["email_in_use", "phone_in_use", "link_conflict", "invalid_input"].includes(error.code)) result.conflicts.push(entry);
        else result.failed.push(entry);
        onProgress({ clientId: row.client_id, status: error.code });
        continue;
      }
    }
    // Связь проверяется в той же транзакции, что и удаление контактов из офисной базы
    db.transaction(() => {
      if (!getLink(db, row.client_id, scope)) throw new Error(`связь для ${row.client_id} не найдена: контакты не удаляются`);
      result.eventsScrubbed += scrubEvents(db, row.client_id, row);
      db.prepare("DELETE FROM legacy_customer_contacts WHERE client_id = ?").run(row.client_id);
    })();
    if (status !== "linked") result.migrated += 1;
    onProgress({ clientId: row.client_id, status });
  }
  // Удалённые строки не должны остаться в свободных страницах файла и в WAL
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  result.remaining = db.prepare("SELECT count(*) AS n FROM legacy_customer_contacts").get().n;
  return result;
}
