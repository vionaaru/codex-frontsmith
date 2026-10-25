// Frontsmith Codex Host: доверенная часть между вызывающими модулями
// (reports, dispatcher, analytics) и Frontsmith-controlled Codex App Server.
//
//   исходный текст ─► Privacy Service.prepare ─► turn/start ─► Codex App Server
//   итог turn ◄─ Privacy Service.restore ◄─ ответ модели с <PII .../>
//
// Всё, что видит модель, проходит prepare: ввод пользователя и результаты
// инструментов Host. Восстановленный ответ возвращается вызывающему и никогда
// не отправляется обратно в thread. При любой ошибке Privacy Service turn/start
// не вызывается (fail closed).
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PrivacyProcessingError } from "./privacy-client.mjs";

const PII_TAG = /<PII\b[^>]*\/>/gi;

const HOST_INSTRUCTIONS = [
  "Ты работаешь внутри Frontsmith. Персональные данные в тексте заменены тегами <PII .../>.",
  "Сохраняй теги без изменений и не пытайся узнать исходные значения.",
  "Данные клиентов получай только через инструменты, которые тебе предоставлены."
].join("\n");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Ответы на запросы одобрения по умолчанию: всё отклоняется. Host не даёт агенту
// выполнять команды, править файлы и расширять права.
export function declineAll(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      return null;
  }
}

export class CodexHost {
  #client;
  #privacy;
  #conversations = new Map();
  #byThread = new Map();
  #turns = new Map();
  #tools;
  #options;

  constructor({ client, privacy, workspace, tools = [], model, turnTimeoutMs = 180_000, diagnostics = {}, approvalHandler = declineAll }) {
    if (!workspace || !path.isAbsolute(workspace)) throw new Error("workspace must be an absolute path");
    this.#client = client;
    this.#privacy = privacy;
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#options = { workspace, model, turnTimeoutMs, diagnostics, approvalHandler };
    this.approvals = [];
    client.on("notification", (message) => this.#onNotification(message));
    client.on("request", (message) => this.#onRequest(message));
  }

  // initialize + initialized. Перед этим — готовность Privacy Service: без неё
  // Host не начинает работу с клиентскими диалогами.
  async start({ clientInfo = { name: "frontsmith_codex_host", title: "Frontsmith Codex Host", version: "0.1.0" } } = {}) {
    await this.#privacy.assertReady();
    const result = await this.#client.request("initialize", {
      clientInfo,
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.#client.notify("initialized");
    this.serverInfo = { userAgent: result?.userAgent, platformOs: result?.platformOs };
    return this.serverInfo;
  }

  #threadParams(instructions, tools) {
    return {
      cwd: this.#options.workspace,
      runtimeWorkspaceRoots: [this.#options.workspace],
      sandbox: "read-only",
      approvalPolicy: "on-request",
      ...(this.#options.model ? { model: this.#options.model } : {}),
      developerInstructions: [...instructions, HOST_INSTRUCTIONS].filter(Boolean).join("\n\n"),
      dynamicTools: tools.map((name) => this.#tools.get(name)).map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false }
      }))
    };
  }

  // Инструменты диалога: по умолчанию все инструменты Host, [] — без инструментов
  // (публичный канал). Неизвестное имя — ошибка, а не молчаливое расширение прав.
  #scope(tools) {
    if (tools === undefined) return [...this.#tools.keys()];
    for (const name of tools) if (!this.#tools.has(name)) throw new Error(`unknown host tool: ${name}`);
    return [...new Set(tools)];
  }

  // Контекст вызывающего (например, публичные сведения о бизнесе) уходит модели
  // в developerInstructions и поэтому тоже проходит prepare этой privacy-session.
  async #context(tenantId, privacySessionId, context) {
    if (!context) return "";
    const prepared = await this.#privacy.prepare({ tenantId, privacySessionId, text: context, source: "context" });
    return prepared.text;
  }

  // Новый диалог: privacy-session + thread App Server.
  // modelInstructions в ответе нужен для resumeConversation: это общий текст Privacy Service без ПД.
  async openConversation({ tenantId, ephemeral = true, tools, context = "" }) {
    const scope = this.#scope(tools);
    await this.#privacy.assertReady();
    const session = await this.#privacy.createSession(tenantId);
    const prepared = await this.#context(tenantId, session.privacySessionId, context);
    const result = await this.#client.request("thread/start", { ...this.#threadParams([session.modelInstructions, prepared], scope), ephemeral });
    return { ...this.#remember({ tenantId, privacySessionId: session.privacySessionId, threadId: result.thread.id, tools: scope }), modelInstructions: session.modelInstructions };
  }

  // Возобновление сохранённого thread с той же privacy-session. Набор инструментов
  // thread сохраняет App Server; Host дополнительно проверяет его при каждом вызове.
  async resumeConversation({ tenantId, privacySessionId, threadId, modelInstructions = "", tools, context = "" }) {
    const scope = this.#scope(tools);
    await this.#privacy.assertReady();
    const prepared = await this.#context(tenantId, privacySessionId, context);
    const params = this.#threadParams([modelInstructions, prepared], scope);
    delete params.dynamicTools;
    const result = await this.#client.request("thread/resume", { threadId, ...params });
    return this.#remember({ tenantId, privacySessionId, threadId: result.thread.id, tools: scope });
  }

  #remember({ tenantId, privacySessionId, threadId, tools }) {
    const conversation = { id: randomUUID(), tenantId, privacySessionId, threadId, tools: new Set(tools), turns: 0, busy: false };
    this.#conversations.set(conversation.id, conversation);
    this.#byThread.set(threadId, conversation);
    return { conversationId: conversation.id, threadId, privacySessionId };
  }

  #turn(turnId) {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = { items: [], toolCalls: [], privacyFailure: null, done: deferred() };
      this.#turns.set(turnId, turn);
    }
    return turn;
  }

  // Пишет только метаданные; текст отдаётся лишь в память тестового наблюдателя.
  #modelVisible(kind, conversation, text) {
    const { logFile, captureModelVisible } = this.#options.diagnostics;
    const entry = {
      ts: new Date().toISOString(),
      kind,
      thread_id: conversation.threadId,
      sha256: sha256(text),
      chars: text.length,
      pii_tags: (text.match(PII_TAG) ?? []).length
    };
    if (logFile) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    }
    captureModelVisible?.({ ...entry, text });
  }

  // Один ход диалога. Возвращает ответ, восстановленный для адресата.
  // Второй ход того же диалога до завершения первого отклоняется: conversation_busy.
  async send(conversationId, text, { recipient = "operator" } = {}) {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) throw new Error("unknown conversation");
    if (conversation.busy) throw Object.assign(new Error("conversation_busy"), { code: "conversation_busy" });
    conversation.busy = true;
    try {
      return await this.#send(conversation, text, recipient);
    } finally {
      conversation.busy = false;
    }
  }

  async #send(conversation, text, recipient) {
    // Ошибка prepare пробрасывается как privacy_processing_failed до turn/start.
    const prepared = await this.#privacy.prepare({
      tenantId: conversation.tenantId,
      privacySessionId: conversation.privacySessionId,
      text,
      source: "user"
    });
    this.#modelVisible("turn_input", conversation, prepared.text);
    const started = await this.#client.request("turn/start", {
      threadId: conversation.threadId,
      input: [{ type: "text", text: prepared.text, text_elements: [] }]
    });
    conversation.turns += 1;
    const turn = this.#turn(started.turn.id);
    const timer = setTimeout(() => turn.done.reject(new Error("turn timed out")), this.#options.turnTimeoutMs);
    let completed;
    try {
      completed = await turn.done.promise;
    } finally {
      clearTimeout(timer);
      this.#turns.delete(started.turn.id);
    }
    if (turn.privacyFailure) throw new PrivacyProcessingError(turn.privacyFailure);
    if (completed.status !== "completed") {
      throw new Error(`turn ${completed.status}: ${completed.error?.message ?? "no details"}`);
    }
    const message = turn.items.filter((item) => item.type === "agentMessage").at(-1);
    const modelText = message?.text ?? "";
    const restored = modelText
      ? await this.#privacy.restoreFinalForRecipient({
          tenantId: conversation.tenantId,
          privacySessionId: conversation.privacySessionId,
          text: modelText,
          recipient
        })
      : "";
    return { text: restored, modelText, turnId: started.turn.id, toolCalls: turn.toolCalls };
  }

  #onNotification({ method, params }) {
    if (method === "item/completed" && params?.turnId) this.#turn(params.turnId).items.push(params.item);
    if (method === "turn/completed" && params?.turn?.id) this.#turn(params.turn.id).done.resolve(params.turn);
  }

  async #onRequest({ id, method, params }) {
    try {
      if (method === "item/tool/call") {
        this.#client.respond(id, await this.#callTool(params));
        return;
      }
      const decision = this.#options.approvalHandler(method, params);
      if (decision) {
        this.approvals.push({ method, decision });
        this.#client.respond(id, decision);
        return;
      }
      this.#client.respondError(id, -32601, `method not supported by Frontsmith host: ${method}`);
    } catch {
      this.#client.respondError(id, -32603, "host failed to handle request");
    }
  }

  // Аргументы от модели могут содержать теги <PII .../> (например, дату из результата
  // инструмента). Инструмент выполняется в доверенной части, поэтому строки аргументов
  // восстанавливаются для адресата operator; восстановленные значения модели не возвращаются
  async #restoreArgs(conversation, value) {
    if (typeof value === "string") {
      if (!/<PII\b[^>]*\/>/i.test(value)) return value;
      return this.#privacy.restoreFinalForRecipient({ tenantId: conversation.tenantId, privacySessionId: conversation.privacySessionId, text: value, recipient: "operator" });
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.#restoreArgs(conversation, item)));
    if (value && typeof value === "object") {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await this.#restoreArgs(conversation, item)]));
      return Object.fromEntries(entries);
    }
    return value;
  }

  // Инструмент Host: оригинал остаётся в доверенной части, модели уходит только
  // результат prepare. При отказе Privacy Service модель получает код ошибки.
  async #callTool({ threadId, turnId, tool: name, arguments: args }) {
    const conversation = this.#byThread.get(threadId);
    const tool = this.#tools.get(name);
    const turn = this.#turn(turnId);
    turn.toolCalls.push(name);
    if (!conversation || !tool || !conversation.tools.has(name)) return { contentItems: [{ type: "inputText", text: "unknown_tool" }], success: false };
    try {
      const raw = await tool.handler(await this.#restoreArgs(conversation, args ?? {}), { tenantId: conversation.tenantId, threadId });
      const prepared = await this.#privacy.prepare({
        tenantId: conversation.tenantId,
        privacySessionId: conversation.privacySessionId,
        text: String(raw),
        source: "tool"
      });
      this.#modelVisible("tool_output", conversation, prepared.text);
      return { contentItems: [{ type: "inputText", text: prepared.text }], success: true };
    } catch (error) {
      turn.privacyFailure = error instanceof PrivacyProcessingError ? error.reason : "tool_failed";
      return { contentItems: [{ type: "inputText", text: "privacy_processing_failed" }], success: false };
    }
  }

  close() {
    this.#client.close();
  }
}
