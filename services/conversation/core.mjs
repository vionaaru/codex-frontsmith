// Conversation Core: канало-независимое ядро AI-диспетчера.
//
//   канал (веб-виджет, позже Telegram и др.) → ConversationCore → CodexHost
//     → Privacy Service → Codex App Server
//
// Каждый диалог — своя privacy-session и свой thread Codex (не ephemeral: после
// перезапуска Frontsmith thread возобновляется через thread/resume). Ход диалога один за
// другим: второй ход до завершения первого отклоняется (conversation_busy).
//
// Публичные диалоги открываются только с явным списком инструментов Host (tools): CRM и
// другие привилегированные инструменты оператора посетителю недоступны. Набор фиксируется
// при открытии thread и сохраняется в хранилище: thread/resume инструменты thread не меняет,
// поэтому диалог продолжается с тем набором, с которым начат.
//
// Передача человеку: инструмент request_human (если он есть у thread), кнопка посетителя или
// ответ сотрудника переводят диалог в needs_human. В этом статусе AI не отвечает: сообщения
// посетителя только сохраняются для сотрудника. Сотрудник отвечает, закрывает диалог или
// возвращает его AI; при возврате модель получает пропущенную переписку в следующем ходе —
// через Privacy Service, как любое сообщение.
import { createHash } from "node:crypto";
import { PrivacyProcessingError } from "../codex-host/privacy-client.mjs";
import { WIDGET_UI_TOOL } from "./widget-ui.mjs";

export const HANDOFF_TOOL = "request_human";

export const HANDOFF_NOTICE = "Разговор сохранён для сотрудника. Это не означает, что он сейчас онлайн. Можно продолжать писать сюда — сообщения останутся в очереди";
const CLOSED_NOTICE = "Сотрудник завершил разговор. Если появятся вопросы, напишите сюда — ответит AI-помощник";
const RETURNED_NOTICE = "Разговор снова ведёт AI-помощник";
const MAX_REASON = 300;

export class ConversationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const ROLE_LABELS = { visitor: "Посетитель", assistant: "AI-помощник", operator: "Сотрудник", system: "Система" };

export class ConversationCore {
  #store;
  #host;
  #context;
  #tenantId;
  #tools;
  #log;
  #live = new Map();
  #busy = new Set();
  #widget;
  #ui = new Map();
  #pendingUi = new Map();

  // host() — текущий CodexHost или null, если AI runtime не запущен;
  // context({ booking, handoff }) — публичные сведения о компании и правила для developerInstructions;
  // tools — инструменты Host для новых диалогов (BOOKING_TOOLS, HANDOFF_TOOL)
  constructor({ store, host, context, widget = async () => null, tenantId = "public-web", tools = [], log = () => {} }) {
    this.#store = store;
    this.#host = host;
    this.#context = context;
    this.#tenantId = tenantId;
    this.#tools = tools;
    this.#log = log;
    this.#widget = widget;
  }

  // Only a prepared public component ID can cross this tool boundary. No model HTML,
  // arbitrary labels, contact fields, navigation or business mutations.
  widgetTool() {
    return {
      name: WIDGET_UI_TOOL,
      description: "Показать подходящий компонент интерфейса из каталога компании. componentId — id из доступных компонентов в инструкциях. Не вызывай после каждого ответа: используй, когда выбор поможет уточнить задачу. Это не запись и не подтверждение действия.",
      inputSchema: { type: "object", properties: { componentId: { type: "string" } }, required: ["componentId"], additionalProperties: false },
      handler: async ({ componentId } = {}, { threadId }) => {
        const row = this.#store.byThread(threadId);
        if (!row || row.status !== "active" || !this.#busy.has(row.id) || !this.#store.tools(row).includes(WIDGET_UI_TOOL)) return "widget_unavailable";
        const config = await this.#widget();
        if (!config?.components.some(component => component.id === componentId)) return "widget_unknown_component";
        if (this.#store.get(row.id)?.status !== "active") return "widget_unavailable";
        this.#pendingUi.set(row.id, componentId);
        return "widget_selected: компонент будет показан после успешного ответа. Не утверждай, что действие уже выполнено";
      }
    };
  }

  async visitorUi(id) {
    if (this.#store.get(id)?.status !== "active") return { component: null };
    const selected = this.#ui.get(id);
    const config = await this.#widget();
    if (this.#store.get(id)?.status !== "active" || this.#busy.has(id) || selected !== this.#ui.get(id)) return { component: null };
    return { component: config?.components.find(component => component.id === selected) ?? null };
  }

  // Набор для новых диалогов: становится известен после запуска AI runtime. Уже открытые
  // thread сохраняют свой набор
  setTools(tools) {
    this.#tools = [...tools];
  }

  start({ channel }) {
    const created = this.#store.create({ channel, tenantId: this.#tenantId });
    this.#log({ event: "conversation_started", conversation: created.id, channel });
    return created;
  }

  authorize(id, token) {
    return this.#store.authorize(id, token);
  }

  // Передача человеку. by — ai, visitor или operator. Уведомление посетителю сохраняется
  // только после того, как статус записан: повтор для уже переданного диалога ничего не меняет
  handoff(id, reason, { by = "visitor" } = {}) {
    const row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    if (row.status === "needs_human") return { status: row.status, changed: false };
    this.#store.setStatus(id, "needs_human", String(reason ?? "").trim().slice(0, MAX_REASON) || "Посетитель попросил сотрудника", { by });
    this.#ui.delete(id);
    this.#pendingUi.delete(id);
    this.#store.addMessage(id, "system", HANDOFF_NOTICE);
    this.#log({ event: "conversation_handoff", conversation: id, by });
    return { status: "needs_human", changed: true };
  }

  // Инструмент Host для модели: диалог определяется по thread Codex
  handoffTool() {
    return {
      name: HANDOFF_TOOL,
      description: "Передать разговор сотруднику компании. Вызывай, если посетитель просит человека, если ты не можешь достоверно ответить, при проблеме с записью, жалобе или запросе, который ты не вправе решать. reason — коротко, без персональных данных.",
      inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
      handler: async ({ reason }, { threadId }) => {
        const row = this.#store.byThread(threadId);
        if (!row || !this.#store.tools(row).includes(HANDOFF_TOOL)) return "handoff_unavailable: в этом диалоге передача недоступна";
        try {
          this.handoff(row.id, reason, { by: "ai" });
          return "handoff_saved: разговор передан сотруднику и стоит в очереди. Коротко сообщи посетителю, что сотрудник ответит в этом чате, когда освободится. Не обещай мгновенный ответ и не отвечай вместо сотрудника";
        } catch (error) {
          this.#log({ event: "handoff_failed", conversation: row.id, code: error.code ?? "error" });
          return "handoff_failed: передать разговор не удалось. Не говори, что разговор передан; предложи связаться с компанией по контактам";
        }
      }
    };
  }

  // Ответ сотрудника. Если диалог вёл AI, сотрудник его перехватывает: AI больше не отвечает
  operatorReply(id, text) {
    const row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    const message = String(text ?? "").trim();
    if (!message) throw new ConversationError("empty_message", "Пустой ответ");
    if (row.status !== "needs_human") this.#store.setStatus(id, "needs_human", "Сотрудник подключился к разговору", { by: "operator" });
    const saved = this.#store.addMessage(id, "operator", message);
    this.#log({ event: "operator_reply", conversation: id, seq: saved.seq });
    return saved;
  }

  closeConversation(id) {
    const row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    if (row.status === "closed") return row;
    this.#store.setStatus(id, "closed", "Закрыт сотрудником");
    this.#store.addMessage(id, "system", CLOSED_NOTICE);
    this.#log({ event: "conversation_closed", conversation: id });
    return this.#store.get(id);
  }

  returnToAi(id) {
    const row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    if (row.status === "active") return row;
    this.#store.setStatus(id, "active", "Возвращён AI сотрудником");
    this.#store.addMessage(id, "system", RETURNED_NOTICE);
    this.#log({ event: "conversation_returned", conversation: id });
    return this.#store.get(id);
  }

  // Сообщения сотрудника и системы для канала посетителя после seq: свои сообщения и ответы
  // AI канал уже показал сам
  visitorFeed(id, after = 0) {
    const row = this.#store.get(id);
    return { status: row?.status ?? "closed", messages: row ? this.#store.messages(id, { after, roles: ["operator", "system"] }) : [] };
  }

  // Переписка для офиса: только видимые сторонам сообщения
  transcript(id) {
    const row = this.#store.get(id);
    if (!row) return null;
    const { token_hash: _token, model_instructions: _instructions, privacy_session_id: _privacy, codex_thread_id: _thread, tools: _tools, ...conversation } = row;
    return { conversation, messages: this.#store.messages(id) };
  }

  list(options) {
    return this.#store.list(options);
  }

  // Ход посетителя. В статусе needs_human сообщение только сохраняется для сотрудника,
  // AI не вызывается: { text: "", handoff: true }. Закрытый диалог возвращается AI
  async reply(id, text) {
    let row = this.#store.get(id);
    if (!row) throw new ConversationError("conversation_not_found");
    if (this.#busy.has(id)) throw new ConversationError("conversation_busy");
    if (row.status === "closed") {
      this.#store.setStatus(id, "active", "Посетитель написал после закрытия");
      row = this.#store.get(id);
    }
    const visitorMessage = this.#store.addMessage(id, "visitor", text);
    if (row.status === "needs_human") {
      this.#log({ event: "visitor_message_queued", conversation: id });
      return { text: "", handoff: true };
    }
    this.#busy.add(id);
    this.#ui.delete(id);
    this.#pendingUi.delete(id);
    const startedAt = Date.now();
    try {
      const host = this.#host();
      if (!host) throw new ConversationError("ai_unavailable", "Codex App Server не запущен");
      const { handle, replay } = await this.#attach(host, row);
      const result = await host.send(handle, this.#turnInput(row, visitorMessage, text, replay), { recipient: "visitor" });
      this.#store.recordTurn(id);
      this.#store.markAiSynced(id, visitorMessage.seq);
      const after = this.#store.get(id);
      // Пока AI готовил ответ, разговор забрал сотрудник или посетитель: ответ AI не показывается
      if (after.status !== "active" && after.handoff_by !== "ai") {
        this.#log({ event: "turn_discarded", conversation: id, ms: Date.now() - startedAt });
        return { text: "", handoff: true };
      }
      if (result.text) this.#store.addMessage(id, "assistant", result.text);
      if (after.status === "active" && this.#pendingUi.has(id)) this.#ui.set(id, this.#pendingUi.get(id));
      this.#log({ event: "turn_completed", conversation: id, ms: Date.now() - startedAt, tool_calls: result.toolCalls.length });
      return { text: result.text, handoff: after.status === "needs_human" };
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
      this.#pendingUi.delete(id);
      this.#busy.delete(id);
    }
  }

  // Сообщения, которых модель не видела (переписка с сотрудником после передачи), идут в
  // начале хода вместе с новым сообщением — тоже через Privacy Service
  #turnInput(row, visitorMessage, text, replay = false) {
    const missed = this.#store.messages(row.id, { after: replay ? 0 : row.ai_synced_seq ?? 0 }).filter((message) => message.seq < visitorMessage.seq && message.role !== "assistant");
    if (!missed.length) return text;
    const lines = missed.map((message) => `${ROLE_LABELS[message.role]}: ${message.text}`);
    return [replay ? "Предыдущие вопросы посетителя и сообщения сотрудника (не источник актуальных сведений компании):" : "Пока разговор вёл сотрудник, в чате было:", ...lines, "", `Новое сообщение посетителя: ${text}`].join("\n");
  }

  // Диалог в текущем CodexHost: открыть новый thread или возобновить сохранённый.
  // После перезапуска App Server прежняя привязка недействительна — возобновляется заново
  async #attach(host, row) {
    const live = this.#live.get(row.id);

    const tools = row.codex_thread_id ? this.#store.tools(row) : this.#tools;
    const config = tools.includes(WIDGET_UI_TOOL) ? await this.#widget() : null;
    const uiContext = config ? [
      "Интерфейс посетителя: можно показать подготовленный компонент инструментом show_widget_component. Выбирай подходящий по разговору; сохраняй возможность ответить своими словами. Не выдумывай компоненты и не считай выбор оформленной записью.",
      ...config.components.map(component => `${component.id}: ${component.title}; варианты: ${component.options.map(option => option.label).join(", ")}`)
    ].join("\n") : "";
    const context = [await this.#context({ booking: tools.includes("find_booking_slots"), handoff: tools.includes(HANDOFF_TOOL) }), uiContext].filter(Boolean).join("\n\n");
    const contextHash = createHash('sha256').update(context).digest('hex');
    if (live?.host === host && live.context === context) return { handle: live.handle, replay: false };
    const replay = Boolean(row.codex_thread_id && row.context_hash !== contextHash);
    let opened;
    if (row.codex_thread_id && !replay) {
      opened = await host.resumeConversation({
        tenantId: row.tenant_id,
        privacySessionId: row.privacy_session_id,
        threadId: row.codex_thread_id,
        modelInstructions: row.model_instructions ?? "",
        tools,
        context
      });
      this.#log({ event: "conversation_resumed", conversation: row.id });
    } else {
      opened = await host.openConversation({ tenantId: row.tenant_id, ephemeral: false, tools, context });
      this.#store.bind(row.id, { ...opened, tools, contextHash });
    }
    this.#live.set(row.id, { host, handle: opened.conversationId, context });
    return { handle: opened.conversationId, replay };
  }
}
