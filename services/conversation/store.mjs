// Состояние диалогов Conversation Module: <каталог данных>/conversations/conversations.sqlite.
// Вне репозитория и рабочей области Codex, как CRM и состояние Privacy Service.
//
// Хранится только привязка диалога: канал, хэш токена посетителя, статус, thread Codex,
// privacy-session, набор инструментов thread, client_id и счётчики. Текст сообщений здесь не
// хранится: видимую историю держит канал (виджет — в браузере посетителя), контекст модели —
// thread Codex, где ПД заменены тегами <PII .../>. Контакты клиента — только в CustomerProvider.
//
// booking_offers — предложения записи, которые посетитель подтверждает в форме канала:
// услуга, время и результат (обращение и запись офиса). Без имён и телефонов.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { dataRoot } from "../privacy/runtime.mjs";
import { assertOutside } from "../codex-host/codex-home.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// active — отвечает AI; needs_human — диалог передан оператору, AI больше не отвечает;
// closed — диалог завершён
export const CONVERSATION_STATUSES = ["active", "needs_human", "closed"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_human', 'closed')),
  status_reason TEXT,
  tenant_id TEXT NOT NULL,
  codex_thread_id TEXT,
  privacy_session_id TEXT,
  model_instructions TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_offers (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('offered', 'requested', 'confirmed', 'withdrawn')),
  client_id TEXT NOT NULL,
  inquiry_id TEXT,
  appointment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_offers_conversation_idx ON booking_offers (conversation_id, created_at);
`;

// Столбцы, добавленные после первой версии хранилища
const COLUMNS = [
  ["tools", "TEXT"],
  ["client_id", "TEXT"]
];

const hashToken = (token) => createHash("sha256").update(String(token), "utf8").digest();

export function defaultConversationDbPath() {
  return path.join(dataRoot(), "conversations", "conversations.sqlite");
}

export class ConversationStore {
  #db;
  #now;

  constructor({ file = defaultConversationDbPath(), now = () => new Date() } = {}) {
    assertOutside(file, [repo]);
    mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.#now = now;
    this.#db = new Database(file);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(SCHEMA);
    const existing = new Set(this.#db.prepare("PRAGMA table_info(conversations)").all().map((column) => column.name));
    for (const [name, type] of COLUMNS) if (!existing.has(name)) this.#db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`);
  }

  // Новый диалог и его токен. Токен возвращается один раз; в базе — только SHA-256
  create({ channel, tenantId }) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const at = this.#now().toISOString();
    this.#db.prepare("INSERT INTO conversations (id, channel, token_hash, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, channel, hashToken(token).toString("hex"), tenantId, at, at);
    return { id, token };
  }

  get(id) {
    return this.#db.prepare("SELECT * FROM conversations WHERE id = ?").get(String(id ?? "")) ?? null;
  }

  // Диалог по id и токену канала; чужой токен и несуществующий id неразличимы
  authorize(id, token) {
    const row = this.get(id);
    if (!row || typeof token !== "string" || !token) return null;
    const expected = Buffer.from(row.token_hash, "hex");
    return timingSafeEqual(expected, hashToken(token)) ? row : null;
  }

  byThread(threadId) {
    return this.#db.prepare("SELECT * FROM conversations WHERE codex_thread_id = ?").get(String(threadId ?? "")) ?? null;
  }

  // tools — инструменты Host, с которыми открыт thread: при thread/resume набор не меняется
  bind(id, { threadId, privacySessionId, modelInstructions, tools = [] }) {
    this.#db.prepare("UPDATE conversations SET codex_thread_id = ?, privacy_session_id = ?, model_instructions = ?, tools = ?, updated_at = ? WHERE id = ?")
      .run(threadId, privacySessionId, modelInstructions ?? "", JSON.stringify(tools), this.#now().toISOString(), id);
  }

  // Диалоги до появления инструментов записи сохранены без набора: у их thread инструментов нет
  tools(row) {
    try {
      const tools = JSON.parse(row?.tools ?? "[]");
      return Array.isArray(tools) ? tools : [];
    } catch {
      return [];
    }
  }

  setClient(id, clientId) {
    this.#db.prepare("UPDATE conversations SET client_id = ?, updated_at = ? WHERE id = ? AND client_id IS NULL").run(clientId, this.#now().toISOString(), id);
  }

  // Новое предложение записи заменяет прежнее неподтверждённое предложение того же диалога
  offer(conversationId, { serviceCode, serviceName, startsAt, clientId }) {
    const at = this.#now().toISOString();
    const id = randomUUID();
    this.#db.transaction(() => {
      this.#db.prepare("UPDATE booking_offers SET status = 'withdrawn', updated_at = ? WHERE conversation_id = ? AND status = 'offered'").run(at, conversationId);
      this.#db.prepare(`INSERT INTO booking_offers (id, conversation_id, service_code, service_name, starts_at, status, client_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'offered', ?, ?, ?)`).run(id, conversationId, serviceCode, serviceName, startsAt, clientId, at, at);
    })();
    return this.getOffer(id);
  }

  getOffer(id) {
    return this.#db.prepare("SELECT * FROM booking_offers WHERE id = ?").get(String(id ?? "")) ?? null;
  }

  latestOffer(conversationId) {
    return this.#db.prepare("SELECT * FROM booking_offers WHERE conversation_id = ? AND status != 'withdrawn' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(conversationId) ?? null;
  }

  completeOffer(id, { status, startsAt, inquiryId, appointmentId }) {
    this.#db.prepare("UPDATE booking_offers SET status = ?, starts_at = ?, inquiry_id = ?, appointment_id = ?, updated_at = ? WHERE id = ?")
      .run(status, startsAt, inquiryId, appointmentId, this.#now().toISOString(), id);
    return this.getOffer(id);
  }

  recordTurn(id, { error = null } = {}) {
    this.#db.prepare(`UPDATE conversations SET turns = turns + ${error ? 0 : 1}, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, this.#now().toISOString(), id);
  }

  setStatus(id, status, reason = null) {
    if (!CONVERSATION_STATUSES.includes(status)) throw new Error(`unknown conversation status: ${status}`);
    this.#db.prepare("UPDATE conversations SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, reason, this.#now().toISOString(), id);
  }

  close() {
    this.#db.close();
  }
}
