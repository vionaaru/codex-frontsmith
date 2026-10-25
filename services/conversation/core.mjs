// Conversation Core: канало-независимое ядро AI-диспетчера.
//
//   канал (веб-виджет, позже Telegram и др.) → ConversationCore → CodexHost
//     → Privacy Service → Codex App Server
//
// Каждый диалог — своя privacy-session и свой thread Codex (не ephemeral: после
// перезапуска Frontsmith thread возобновляется через thread/resume). Ход диалога один за
// другим: второй ход до завершения первого отклоняется (conversation_busy).
//
// Публичные диалоги открываются без инструментов Host (tools: []): CRM и другие
// привилегированные инструменты оператора посетителю недоступны. Бизнес-инструменты
// (запись на услугу) добавляются сюда явным списком.
import { PrivacyProcessingError } from "../codex-host/privacy-client.mjs";

export class ConversationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class ConversationCore {
  #store;
  #host;
  #context;
  #tenantId;
  #tools;
  #log;
  #live = new Map();
  #busy = new Set();

  // host() — текущий CodexHost или null, если AI runtime не запущен;
  // context() — публичные сведения о компании для developerInstructions
  constructor({ store, host, context, tenantId = "public-web", tools = [], log = () => {} }) {
    this.#store = store;
    this.#host = host;
    this.#context = context;
    this.#tenantId = tenantId;
    this.#tools = tools;
    this.#log = log;
  }

  start({ channel }) {
    const created = this.#store.create({ channel, tenantId: this.#tenantId });
    this.#log({ event: "conversation_started", conversation: created.id, channel });
    return created;
  }

  authorize(id, token) {
    return this.#store.authorize(id, token);
  }

  // Передача человеку: статус needs_human, AI в этом диалоге больше не отвечает.
  // Оператор сможет прочитать thread Codex и восстановить его для адресата operator
  handoff(id, reason) {
    this.#store.setStatus(id, "needs_human", reason);
    this.#log({ event: "conversation_handoff", conversation: id });
  }

  // Ход посетителя → ответ AI, восстановленный для посетителя (адресат visitor)
  async reply(id, text) {
    const row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    if (row.status !== "active") throw new ConversationError(`conversation_${row.status}`);
    if (this.#busy.has(id)) throw new ConversationError("conversation_busy");
    this.#busy.add(id);
    const startedAt = Date.now();
    try {
      const host = this.#host();
      if (!host) throw new ConversationError("ai_unavailable", "Codex App Server не запущен");
      const handle = await this.#attach(host, row);
      const result = await host.send(handle, text, { recipient: "visitor" });
      this.#store.recordTurn(id);
      this.#log({ event: "turn_completed", conversation: id, ms: Date.now() - startedAt, tool_calls: result.toolCalls.length });
      return { text: result.text };
    } catch (error) {
      const failure = error instanceof ConversationError ? error
        : error instanceof PrivacyProcessingError ? new ConversationError("privacy_unavailable", "Privacy Service отклонил обработку")
        : error.code === "conversation_busy" ? new ConversationError("conversation_busy")
        : new ConversationError("ai_failed", "Codex не вернул ответ");
      this.#store.recordTurn(id, { error: failure.code });
      // В журнал — только код и длительность, без текста и деталей ошибки
      this.#log({ event: "turn_failed", conversation: id, code: failure.code, ms: Date.now() - startedAt });
      throw failure;
    } finally {
      this.#busy.delete(id);
    }
  }

  // Диалог в текущем CodexHost: открыть новый thread или возобновить сохранённый.
  // После перезапуска App Server прежняя привязка недействительна — возобновляется заново
  async #attach(host, row) {
    const live = this.#live.get(row.id);
    if (live?.host === host) return live.handle;
    const context = await this.#context();
    let opened;
    if (row.codex_thread_id) {
      opened = await host.resumeConversation({
        tenantId: row.tenant_id,
        privacySessionId: row.privacy_session_id,
        threadId: row.codex_thread_id,
        modelInstructions: row.model_instructions ?? "",
        tools: this.#tools,
        context
      });
      this.#log({ event: "conversation_resumed", conversation: row.id });
    } else {
      opened = await host.openConversation({ tenantId: row.tenant_id, ephemeral: false, tools: this.#tools, context });
      this.#store.bind(row.id, opened);
    }
    this.#live.set(row.id, { host, handle: opened.conversationId });
    return opened.conversationId;
  }
}
