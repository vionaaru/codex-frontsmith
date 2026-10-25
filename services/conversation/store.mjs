// Состояние диалогов Conversation Module: <каталог данных>/conversations/conversations.sqlite.
// Вне репозитория и рабочей области Codex, как CRM и состояние Privacy Service.
//
// Хранится только привязка диалога: канал, хэш токена посетителя, статус, thread Codex,
// privacy-session и счётчики. Текст сообщений здесь не хранится: видимую историю держит
// канал (виджет — в браузере посетителя), контекст модели — thread Codex, где ПД заменены
// тегами <PII .../>.
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
`;

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

  bind(id, { threadId, privacySessionId, modelInstructions }) {
    this.#db.prepare("UPDATE conversations SET codex_thread_id = ?, privacy_session_id = ?, model_instructions = ?, updated_at = ? WHERE id = ?")
      .run(threadId, privacySessionId, modelInstructions ?? "", this.#now().toISOString(), id);
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
