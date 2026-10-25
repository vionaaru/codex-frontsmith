// Веб-канал Conversation Module для виджета ChatCops (протокол v1, SSE).
//
//   POST /api/chat/session   { conversationId, previousToken } → { conversationId, token }
//   POST /api/chat           Authorization: Bearer <token>, { conversationId, message }
//                            → text/event-stream: start, text-delta, finish | error
//
// Посетитель — недоверенный внешний пользователь. Канал принимает только запросы своего
// сайта (Host и Origin), выдаёт диалог только по его токену, ограничивает размер и частоту
// запросов и не передаёт модели ничего, кроме текста сообщения: pageContext, locale и
// userData виджета отбрасываются. В журнал пишутся только события и коды, без текста.
import { randomUUID } from "node:crypto";
import { ConversationError } from "./core.mjs";

export const LIMITS = {
  bodyBytes: 16 * 1024,
  messageChars: 2000,
  // окно, мс → число запросов
  sessionsPerIp: [10 * 60_000, 10],
  messagesPerConversation: [60_000, 6],
  messagesPerIp: [60 * 60_000, 60],
  concurrentTurns: 3,
  keepaliveMs: 10_000
};

// Коды протокола ChatCops v1: виджет показывает по ним свой текст ошибки
const ERRORS = {
  ai_unavailable: [503, "provider_unavailable", "AI-помощник сейчас недоступен"],
  privacy_unavailable: [503, "provider_unavailable", "Проверка конфиденциальности недоступна: сообщение не отправлено модели"],
  ai_failed: [502, "provider_error", "Не удалось получить ответ AI"],
  conversation_busy: [409, "conversation_busy", "Предыдущий ответ ещё готовится"],
  conversation_needs_human: [409, "conversation_busy", "Диалог передан сотруднику"],
  conversation_closed: [409, "conversation_busy", "Диалог завершён"],
  conversation_not_found: [401, "session_required", "Диалог не найден"]
};

class ChannelError extends Error {
  constructor(status, code, message, retryAfterMs) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// Скользящее окно в памяти процесса: локальному каналу этого достаточно
class RateLimiter {
  #hits = new Map();
  constructor(now) {
    this.now = now;
  }

  take(key, [windowMs, max]) {
    const at = this.now();
    const hits = (this.#hits.get(key) ?? []).filter((time) => at - time < windowMs);
    if (hits.length >= max) {
      this.#hits.set(key, hits);
      return windowMs - (at - hits[0]);
    }
    hits.push(at);
    this.#hits.set(key, hits);
    if (this.#hits.size > 10_000) this.#sweep(at);
    return 0;
  }

  #sweep(at) {
    for (const [key, hits] of this.#hits) if (!hits.length || at - hits.at(-1) > 60 * 60_000) this.#hits.delete(key);
  }
}

// allowedHosts — значения Host, под которыми сайт открыт локально (защита от DNS rebinding);
// Origin, если браузер его прислал, должен совпадать с http://<Host>
export function createWebChannel({ core, allowedHosts, limits = LIMITS, now = () => Date.now(), log = () => {} }) {
  const limiter = new RateLimiter(now);
  let turnsInFlight = 0;

  function checkRequest(req) {
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) throw new ChannelError(403, "origin_not_allowed", "Недопустимый адрес сайта");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new ChannelError(403, "origin_not_allowed", "Запрос не с сайта компании");
    if (req.method !== "POST") throw new ChannelError(405, "invalid_request", "Метод не разрешён");
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new ChannelError(415, "invalid_request", "Нужен JSON");
  }

  async function readJson(req) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limits.bodyBytes) throw new ChannelError(413, "payload_too_large", "Слишком большой запрос");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limits.bodyBytes) throw new ChannelError(413, "payload_too_large", "Слишком большой запрос");
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw new ChannelError(400, "invalid_request", "Некорректный JSON");
    }
  }

  function limit(key, window) {
    const wait = limiter.take(key, window);
    if (wait) throw new ChannelError(429, "rate_limited", "Слишком много сообщений", wait);
  }

  function bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ""));
    return match?.[1] ?? null;
  }

  // Токен прежнего диалога продолжает его; иначе — новый диалог с новым id.
  // id, предложенный браузером, сервер не принимает
  async function session(req, res, ip) {
    const body = await readJson(req);
    const previous = typeof body.previousToken === "string" ? body.previousToken : null;
    if (previous && core.authorize(body.conversationId, previous)) {
      return json(res, 200, { conversationId: body.conversationId, token: previous });
    }
    limit(`session:${ip}`, limits.sessionsPerIp);
    const created = core.start({ channel: "web" });
    json(res, 200, { conversationId: created.id, token: created.token });
  }

  async function chat(req, res, ip) {
    const body = await readJson(req);
    const conversation = core.authorize(body.conversationId, bearer(req));
    if (!conversation) throw new ChannelError(401, "session_required", "Нужен токен диалога");
    if (body.regenerate) throw new ChannelError(400, "invalid_request", "Повторная генерация не поддерживается");
    const text = typeof body.message === "string" ? body.message.trim() : "";
    if (!text) throw new ChannelError(400, "invalid_request", "Пустое сообщение");
    if (text.length > limits.messageChars) throw new ChannelError(413, "payload_too_large", `Сообщение длиннее ${limits.messageChars} символов`);
    limit(`chat:${conversation.id}`, limits.messagesPerConversation);
    limit(`chat-ip:${ip}`, limits.messagesPerIp);
    if (turnsInFlight >= limits.concurrentTurns) throw new ChannelError(429, "rate_limited", "AI-помощник занят", 5000);

    // Поток открывается сразу: комментарии keepalive держат соединение, пока Codex думает
    res.writeHead(200, { ...baseHeaders, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": frontsmith\n\n");
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), limits.keepaliveMs);
    const part = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const messageId = randomUUID();
    turnsInFlight++;
    try {
      const answer = await core.reply(conversation.id, text);
      part({ type: "start", protocol: 1, conversationId: conversation.id, messageId });
      part({ type: "text-delta", id: messageId, delta: answer.text || "Ответ пустой. Попробуйте переформулировать вопрос." });
      part({ type: "finish", reason: "stop" });
    } catch (error) {
      const [, code, message] = ERRORS[error instanceof ConversationError ? error.code : "ai_failed"] ?? ERRORS.ai_failed;
      part({ type: "start", protocol: 1, conversationId: conversation.id, messageId });
      part({ type: "error", code, message, retryable: code !== "session_required" });
      part({ type: "finish", reason: "error" });
    } finally {
      turnsInFlight--;
      clearInterval(keepalive);
      res.end("data: [DONE]\n\n");
    }
  }

  // true — запрос относится к каналу и обработан
  async function handle(req, res, pathname) {
    if (pathname !== "/api/chat" && pathname !== "/api/chat/session") return false;
    const ip = req.socket.remoteAddress ?? "unknown";
    try {
      checkRequest(req);
      if (pathname === "/api/chat/session") await session(req, res, ip);
      else await chat(req, res, ip);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      const channel = error instanceof ChannelError ? error : new ChannelError(500, "internal_error", "Ошибка канала");
      if (!(error instanceof ChannelError)) log({ event: "channel_error", code: error.code ?? "internal_error" });
      else if (channel.status === 429) log({ event: "rate_limited", path: pathname });
      json(res, channel.status, { error: { code: channel.code, message: channel.message, ...(channel.retryAfterMs ? { retryAfterMs: channel.retryAfterMs } : {}) } },
        channel.retryAfterMs ? { "retry-after": String(Math.ceil(channel.retryAfterMs / 1000)) } : {});
    }
    return true;
  }

  return { handle };
}

// Канал выключен: сайт открыт без AI runtime (предпросмотр, нет входа ChatGPT)
export function unavailableWebChannel() {
  return {
    async handle(req, res, pathname) {
      if (pathname !== "/api/chat" && pathname !== "/api/chat/session") return false;
      json(res, 503, { error: { code: "provider_unavailable", message: "AI-помощник не запущен: используйте npm run frontsmith" } });
      return true;
    }
  };
}

const baseHeaders = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { ...baseHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}
