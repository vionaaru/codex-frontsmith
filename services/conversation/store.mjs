// Состояние диалогов Conversation Module: <каталог данных>/conversations/conversations.sqlite.
// Вне репозитория и рабочей области Codex, как CRM и состояние Privacy Service.
//
// conversations — привязка диалога: канал, хэш токена посетителя, статус и причина передачи
// человеку, thread Codex, privacy-session, набор инструментов thread, client_id и счётчики.
//
// conversation_messages — видимая переписка для оператора и посетителя: сообщения посетителя,
// ответы AI в том виде, в каком их видел посетитель, ответы сотрудника и уведомления системы.
// Внутренних инструкций, сообщений инструментов и данных моделей здесь нет: контекст модели —
// отдельно, в thread Codex, где ПД заменены тегами <PII .../>. Контакты из формы записи сюда
// не пишутся: они только в CustomerProvider. Срок хранения ограничен: purge().
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

CREATE TABLE IF NOT EXISTS conversation_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL CHECK (role IN ('visitor', 'assistant', 'operator', 'system')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_messages_idx ON conversation_messages (conversation_id, seq);
`;

export const MESSAGE_ROLES = ["visitor", "assistant", "operator", "system"];

// Столбцы, добавленные после первой версии хранилища
const COLUMNS = [
  ["tools", "TEXT"],
  ["client_id", "TEXT"],
  // кто передал диалог человеку: ai, visitor или operator
  ["handoff_by", "TEXT"],
  ["handoff_at", "TEXT"],
  ["last_message_at", "TEXT"],
  // последнее сообщение, которое уже видела модель: остальные она получит в следующем ходе
  ["ai_synced_seq", "INTEGER NOT NULL DEFAULT 0"]
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

  // by — для needs_human: кто передал диалог человеку
  setStatus(id, status, reason = null, { by = null } = {}) {
    if (!CONVERSATION_STATUSES.includes(status)) throw new Error(`unknown conversation status: ${status}`);
    const at = this.#now().toISOString();
    this.#db.prepare("UPDATE conversations SET status = ?, status_reason = ?, handoff_by = ?, handoff_at = ?, updated_at = ? WHERE id = ?")
      .run(status, reason, status === "needs_human" ? by : null, status === "needs_human" ? at : null, at, id);
  }

  addMessage(conversationId, role, text) {
    if (!MESSAGE_ROLES.includes(role)) throw new Error(`unknown message role: ${role}`);
    const at = this.#now().toISOString();
    return this.#db.transaction(() => {
      const { lastInsertRowid } = this.#db.prepare("INSERT INTO conversation_messages (conversation_id, role, text, created_at) VALUES (?, ?, ?, ?)").run(conversationId, role, text, at);
      this.#db.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?").run(at, at, conversationId);
      return { seq: Number(lastInsertRowid), role, text, createdAt: at };
    })();
  }

  messages(conversationId, { after = 0, roles = MESSAGE_ROLES, limit = 500 } = {}) {
    return this.#db.prepare(`SELECT seq, role, text, created_at AS createdAt FROM conversation_messages
      WHERE conversation_id = ? AND seq > ? AND role IN (${roles.map(() => "?").join(", ")}) ORDER BY seq LIMIT ?`)
      .all(conversationId, Number(after) || 0, ...roles, limit);
  }

  lastSeq(conversationId) {
    return this.#db.prepare("SELECT max(seq) AS seq FROM conversation_messages WHERE conversation_id = ?").get(conversationId)?.seq ?? 0;
  }

  markAiSynced(id, seq) {
    this.#db.prepare("UPDATE conversations SET ai_synced_seq = max(ai_synced_seq, ?) WHERE id = ?").run(seq, id);
  }

  // Список для офиса: без токенов и служебных полей Codex
  list({ status = null, limit = 200 } = {}) {
    return this.#db.prepare(`SELECT c.id, c.channel, c.status, c.status_reason, c.handoff_by, c.handoff_at, c.client_id, c.created_at, c.last_message_at,
        (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT m.role FROM conversation_messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_role
      FROM conversations c WHERE EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)${status ? " AND c.status = ?" : ""}
      ORDER BY CASE c.status WHEN 'needs_human' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, coalesce(c.last_message_at, c.created_at) DESC LIMIT ?`)
      .all(...(status ? [status] : []), limit);
  }

  // Очистка по сроку хранения: диалоги без активности дольше days дней (или все, если all).
  // Thread Codex на диске App Server этим не удаляется
  purge({ days = 90, all = false } = {}) {
    const cutoff = new Date(this.#now().getTime() - days * 86_400_000).toISOString();
    return this.#db.transaction(() => {
      const ids = this.#db.prepare(`SELECT id FROM conversations ${all ? "" : "WHERE coalesce(last_message_at, updated_at) < ?"}`).all(...(all ? [] : [cutoff])).map((row) => row.id);
      for (const id of ids) {
        this.#db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(id);
        this.#db.prepare("DELETE FROM booking_offers WHERE conversation_id = ?").run(id);
        this.#db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      }
      return { conversations: ids.length };
    })();
  }

  close() {
    this.#db.close();
  }
}
