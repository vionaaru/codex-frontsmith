// Идентичность клиента в офисной базе: client_id и связь с записью провайдера.
// Здесь нет и не должно быть имён, телефонов, email и заметок
import { randomUUID } from "node:crypto";
import { CustomerError } from "./contract.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newClientId() {
  return randomUUID();
}

export function assertClientId(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new CustomerError("invalid_input", "client_id: ожидается UUID");
  return value;
}

export function getIdentity(db, clientId) {
  return db.prepare("SELECT id, is_demo, created_at, updated_at FROM customers WHERE id = ?").get(clientId) ?? null;
}

export function getLink(db, clientId, { provider, instance }) {
  return db.prepare(`SELECT client_id, external_id, created_at, updated_at FROM customer_provider_links
    WHERE client_id = ? AND provider = ? AND provider_instance = ?`).get(clientId, provider, instance) ?? null;
}

// external_id → { clientId, isDemo } для всех связей подключения
export function linksByExternalId(db, { provider, instance }) {
  return new Map(db.prepare(`SELECT l.external_id, l.client_id, c.is_demo FROM customer_provider_links l
    JOIN customers c ON c.id = l.client_id WHERE l.provider = ? AND l.provider_instance = ?`).all(provider, instance)
    .map((row) => [row.external_id, { clientId: row.client_id, isDemo: row.is_demo === 1 }]));
}

export function unlinkedClientIds(db, { provider, instance }) {
  return db.prepare(`SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_provider_links l
    WHERE l.client_id = c.id AND l.provider = ? AND l.provider_instance = ?)`).all(provider, instance).map((row) => row.id);
}

function insertEvent(db, { at, clientId, action, summary, actor, source, isDemo, details = null }) {
  db.prepare(`INSERT INTO activity_events (id, occurred_at, entity_type, entity_id, action, actor, source, summary, details_json, is_demo)
    VALUES (?, ?, 'customer', ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), at, clientId, action, actor, source, summary, details === null ? null : JSON.stringify(details), isDemo ? 1 : 0);
}

// Одна транзакция: идентичность (если её ещё нет) + связь + запись в журнал.
// Повтор с той же парой client_id ↔ external_id ничего не меняет
export function saveLink(db, { clientId, provider, instance, externalId, isDemo = false, actor = "оператор", source = "cli", now = new Date() }) {
  assertClientId(clientId);
  return db.transaction(() => {
    const at = now.toISOString();
    const byExternal = db.prepare("SELECT client_id FROM customer_provider_links WHERE provider = ? AND provider_instance = ? AND external_id = ?")
      .get(provider, instance, externalId);
    if (byExternal && byExternal.client_id !== clientId) throw new CustomerError("link_conflict", "Запись CRM уже связана с другим клиентом Frontsmith", { candidates: [byExternal.client_id] });
    const existing = getLink(db, clientId, { provider, instance });
    if (existing) {
      if (existing.external_id !== externalId) throw new CustomerError("link_conflict", "Клиент Frontsmith уже связан с другой записью CRM");
      return { status: "existing" };
    }
    const identity = getIdentity(db, clientId);
    if (!identity) {
      db.prepare("INSERT INTO customers (id, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?)").run(clientId, isDemo ? 1 : 0, at, at);
      insertEvent(db, { at, clientId, action: "created", summary: "Добавлен клиент", actor, source, isDemo, details: { provider } });
    } else {
      insertEvent(db, { at, clientId, action: "provider_linked", summary: "Контакты клиента связаны с CRM", actor, source, isDemo: identity.is_demo === 1, details: { provider } });
    }
    db.prepare(`INSERT INTO customer_provider_links (client_id, provider, provider_instance, external_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(clientId, provider, instance, externalId, at, at);
    return { status: identity ? "linked" : "created" };
  })();
}

// Отметка в журнале об изменении контактов: перечислены только названия полей
export function recordContactUpdate(db, { clientId, fields, actor = "оператор", source = "cli", now = new Date() }) {
  const at = now.toISOString();
  db.transaction(() => {
    const identity = getIdentity(db, clientId);
    db.prepare("UPDATE customers SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(at, clientId);
    insertEvent(db, { at, clientId, action: "contact_updated", summary: "Изменены контакты клиента", actor, source, isDemo: identity?.is_demo === 1, details: { fields } });
  })();
}
