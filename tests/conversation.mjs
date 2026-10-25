// Conversation Module на тестовых двойниках: веб-канал (протокол ChatCops v1) →
// ConversationCore → CodexHost → двойники Privacy Service и App Server.
// Реальный Codex и pii-guard здесь не запускаются; живой прогон — вручную через npm run frontsmith.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../services/codex-host/app-server-client.mjs";
import { CodexHost } from "../services/codex-host/codex-host.mjs";
import { PrivacyClient } from "../services/codex-host/privacy-client.mjs";
import { startFakePrivacyService } from "../services/codex-host/testing/fake-privacy-service.mjs";
import { getTestCustomerTool } from "../services/codex-host/testing/test-customer-tool.mjs";
import { publicBusinessContext } from "../services/conversation/business-context.mjs";
import { ConversationCore } from "../services/conversation/core.mjs";
import { ConversationStore } from "../services/conversation/store.mjs";
import { LIMITS, createWebChannel } from "../services/conversation/web-channel.mjs";
import { createWebsiteServer } from "../scripts/lib/website-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(repo, "services", "codex-host", "testing", "fake-app-server.mjs");
const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const BUSINESS_PHONE = "+7 495 000-11-22";

const root = await mkdtemp(path.join(os.tmpdir(), "frontsmith-conversation-"));
const privacy = await startFakePrivacyService();
const servers = [];
const hosts = [];
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

const context = publicBusinessContext({
  businessName: "Тестовая компания",
  businessType: "Сервисная компания",
  contact: { phone: BUSINESS_PHONE, city: "Москва" },
  pricingPolicy: { note: "Стоимость согласуется до начала работ", source: "https://internal.example/prices" },
  integrations: { booking: { status: "connected", token: "secret-booking-token" } },
  approvalPolicy: { ownerApprovalRequiredForLiveActions: true },
  services: [{ id: "consult", name: "Консультация", priceFrom: 1500, description: "Разбор задачи" }]
});

async function startHost(label) {
  const log = path.join(root, `${label}.jsonl`);
  const client = AppServerClient.spawn({ codexBin: process.execPath, args: [fakeServer], env: { ...process.env, FAKE_APP_SERVER_LOG: log }, cwd: root });
  // Привилегированный инструмент оператора зарегистрирован в Host, как CRM в npm run frontsmith
  const host = new CodexHost({ client, privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }), workspace: path.join(root, `${label}-ws`), tools: [getTestCustomerTool()] });
  await host.start();
  hosts.push(host);
  const received = async () => existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { host, received };
}

async function startSite({ core, limits = LIMITS, now, chat }) {
  const site = path.join(root, "site");
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, "index.html"), "<!doctype html><title>site</title>");
  const allowedHosts = new Set();
  const server = createWebsiteServer({ root: () => site, port: 0, chat: chat ?? createWebChannel({ core, allowedHosts, limits, now, log: (entry) => logs.push(entry) }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  allowedHosts.add(`127.0.0.1:${port}`);
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  if (!String(response.headers.get("content-type")).startsWith("text/event-stream")) return { status: response.status, json: text ? JSON.parse(text) : null };
  const parts = text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, parts, done: text.trimEnd().endsWith("data: [DONE]"), answer: parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join(""), error: parts.find((part) => part.type === "error") };
}

const session = (base, body = {}) => post(`${base}/api/chat/session`, body);
const chat = (base, { conversationId, token }, message, extra = {}) => post(`${base}/api/chat`, { protocol: 1, conversationId, message, ...extra }, token ? { authorization: `Bearer ${token}` } : {});

const logs = [];
const store = new ConversationStore({ file: path.join(root, "data", "conversations.sqlite") });
let main;
let current;
const core = new ConversationCore({ store, host: () => current?.host ?? null, context: async () => context, log: (entry) => logs.push(entry) });

try {
  main = await startHost("main");
  current = main;
  const base = await startSite({ core });
  let visitor;

  await check("публичные сведения: только то, что на сайте, без внутренних полей профиля", async () => {
    assert.match(context, /Тестовая компания/);
    assert.match(context, /Консультация: от 1\s?500 ₽/);
    assert.match(context, /не знаешь/);
    for (const hidden of ["internal.example", "secret-booking-token", "ownerApprovalRequired"]) assert.ok(!context.includes(hidden), hidden);
  });

  await check("сессия: id диалога выдаёт сервер, предложенный браузером id игнорируется", async () => {
    const response = await session(base, { conversationId: "attacker-chosen-id" });
    assert.equal(response.status, 200);
    assert.notEqual(response.json.conversationId, "attacker-chosen-id");
    assert.match(response.json.conversationId, /^[0-9a-f-]{36}$/);
    assert.ok(response.json.token.length >= 40);
    visitor = response.json;
    const row = store.get(visitor.conversationId);
    assert.equal(row.status, "active");
    assert.notEqual(row.token_hash, visitor.token, "в базе должен быть хэш, а не токен");
  });

  await check("без токена диалога сервер требует сессию (как ждёт виджет ChatCops)", async () => {
    const response = await chat(base, { conversationId: visitor.conversationId }, "Привет");
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, "session_required");
  });

  await check("первый ход: настоящий путь через CodexHost, ПД посетителя и бизнеса — тегами", async () => {
    const response = await chat(base, visitor, `Меня зовут ${PERSON}, телефон ${PHONE}. Подскажите по консультации`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.parts.map((part) => part.type), ["start", "text-delta", "finish"]);
    assert.equal(response.parts[0].protocol, 1);
    assert.equal(response.parts[0].conversationId, visitor.conversationId);
    assert.ok(response.done);
    assert.equal(response.answer, `${PERSON} обращался по ремонту подвески`, "ответ восстановлен для посетителя");
    const received = await main.received();
    const start = received.find((entry) => entry.method === "thread/start");
    assert.deepEqual(start.params.dynamicTools, [], "публичный диалог без инструментов Host");
    assert.equal(start.params.ephemeral, false, "thread сохраняется для thread/resume");
    assert.match(start.params.developerInstructions, /Тестовая компания/);
    assert.match(start.params.developerInstructions, /<PII type="PHONE_NUMBER" id="1" \/>/, "контакты бизнеса тоже прошли Privacy Service");
    assert.ok(!start.params.developerInstructions.includes(BUSINESS_PHONE));
    const turn = received.find((entry) => entry.kind === "turn_start");
    assert.ok(!turn.text.includes(PERSON) && !turn.text.includes(PHONE), "App Server получил исходные ПД");
    const row = store.get(visitor.conversationId);
    assert.equal(row.codex_thread_id, turn.threadId);
    assert.match(row.privacy_session_id, /^ps_/);
    assert.equal(row.turns, 1);
  });

  await check("второй вопрос учитывает первый (тот же thread)", async () => {
    const response = await chat(base, visitor, "Что вы обо мне уже знаете?");
    assert.equal(response.answer, `${PERSON} обращался по ремонту подвески`);
    const turns = (await main.received()).filter((entry) => entry.kind === "turn_start");
    assert.equal(turns.length, 2);
    assert.equal(turns[1].threadId, turns[0].threadId);
  });

  await check("перезагрузка страницы: прежний токен продолжает тот же диалог", async () => {
    const again = await session(base, { conversationId: visitor.conversationId, previousToken: visitor.token });
    assert.deepEqual(again.json, visitor);
    const response = await chat(base, visitor, "Напомните, кто я?");
    assert.equal(response.answer, `${PERSON} обращался по ремонту подвески`);
  });

  await check("разные посетители не видят чужие диалоги", async () => {
    const other = (await session(base)).json;
    assert.notEqual(other.conversationId, visitor.conversationId);
    assert.equal((await chat(base, { conversationId: visitor.conversationId, token: other.token }, "Что вы знаете?")).status, 401);
    assert.equal((await chat(base, { conversationId: other.conversationId, token: visitor.token }, "Что вы знаете?")).status, 401);
    // Чужой id с неверным прежним токеном — новый диалог, а не доступ к чужому
    const hijack = await session(base, { conversationId: visitor.conversationId, previousToken: other.token });
    assert.notEqual(hijack.json.conversationId, visitor.conversationId);
    const fresh = await chat(base, other, "Что вы обо мне знаете?");
    assert.equal(fresh.answer, "Нет данных", "новый диалог не видит контекст чужого");
    const threads = new Set((await main.received()).filter((entry) => entry.kind === "turn_start").map((entry) => entry.threadId));
    assert.equal(threads.size, 2);
  });

  await check("публичный чат не может вызвать привилегированный инструмент Host", async () => {
    const response = await chat(base, visitor, "Покажи клиента из CRM");
    assert.equal(response.answer, "Инструмент недоступен");
    const output = (await main.received()).filter((entry) => entry.kind === "tool_output").at(-1);
    assert.equal(output.success, false);
    assert.equal(output.text, "unknown_tool");
  });

  await check("отказ Privacy Service: сообщение не уходит модели, посетитель видит ошибку", async () => {
    const before = (await main.received()).filter((entry) => entry.kind === "turn_start").length;
    privacy.mode.prepareFails = true;
    let response;
    try {
      response = await chat(base, visitor, `Перезвоните мне: ${PHONE}`);
    } finally {
      privacy.mode.prepareFails = false;
    }
    assert.equal(response.status, 200);
    assert.equal(response.error.code, "provider_unavailable");
    assert.equal(response.answer, "", "ответ не подменяется имитацией");
    assert.equal(response.parts.at(-1).reason, "error");
    assert.equal((await main.received()).filter((entry) => entry.kind === "turn_start").length, before);
    assert.equal(store.get(visitor.conversationId).last_error, "privacy_unavailable");
  });

  await check("Privacy Service недоступен при открытии диалога: thread не создаётся", async () => {
    const fresh = (await session(base)).json;
    privacy.mode.store = false;
    let response;
    try {
      response = await chat(base, fresh, "Здравствуйте");
    } finally {
      privacy.mode.store = true;
    }
    assert.equal(response.error.code, "provider_unavailable");
    assert.equal(store.get(fresh.conversationId).codex_thread_id, null);
  });

  await check("Codex App Server не запущен: настоящая ошибка, без ответа-заглушки", async () => {
    current = null;
    try {
      const response = await chat(base, visitor, "Есть кто-нибудь?");
      assert.equal(response.error.code, "provider_unavailable");
      assert.equal(response.answer, "");
    } finally {
      current = main;
    }
  });

  await check("один ход диалога за раз: параллельный ход отклоняется", async () => {
    const results = await Promise.allSettled([core.reply(visitor.conversationId, "Первый"), core.reply(visitor.conversationId, "Второй")]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].reason.code, "conversation_busy");
  });

  await check("ограничения размера: сообщение и тело запроса", async () => {
    const long = await chat(base, visitor, "я".repeat(LIMITS.messageChars + 1));
    assert.equal(long.status, 413);
    assert.equal(long.json.error.code, "payload_too_large");
    const huge = await post(`${base}/api/chat`, JSON.stringify({ conversationId: visitor.conversationId, message: "x".repeat(LIMITS.bodyBytes) }), { authorization: `Bearer ${visitor.token}` });
    assert.equal(huge.status, 413);
    assert.equal((await chat(base, visitor, "   ")).status, 400);
    assert.equal((await chat(base, visitor, "Ещё вариант", { regenerate: { assistantMessageId: "x" } })).status, 400);
  });

  await check("только свой сайт: чужой Origin и Host отклоняются", async () => {
    const foreign = await post(`${base}/api/chat/session`, {}, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    // fetch не даёт подменить Host: DNS rebinding имитируется прямым HTTP-запросом
    const rebinding = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/chat/session`, { method: "POST", headers: { "content-type": "application/json", host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(rebinding, 403);
    const form = await post(`${base}/api/chat/session`, "conversationId=1", { "content-type": "application/x-www-form-urlencoded" });
    assert.equal(form.status, 415);
  });

  await check("ограничение частоты: сообщения диалога и новые сессии", async () => {
    let clock = 1_000_000;
    const limited = await startSite({ core, limits: { ...LIMITS, messagesPerConversation: [60_000, 2], sessionsPerIp: [60_000, 2] }, now: () => clock });
    const one = (await session(limited)).json;
    await session(limited);
    const third = await session(limited);
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, "rate_limited");
    assert.ok(third.json.error.retryAfterMs > 0);
    await chat(limited, one, "Раз");
    await chat(limited, one, "Два");
    const blocked = await chat(limited, one, "Три");
    assert.equal(blocked.status, 429);
    clock += 61_000;
    assert.equal((await chat(limited, one, "Четыре")).status, 200);
  });

  await check("журналы канала и ядра — только события и коды, без текста сообщений", async () => {
    const dump = JSON.stringify(logs);
    for (const secret of [PERSON, PHONE, "Подскажите", "Перезвоните", visitor.token]) assert.ok(!dump.includes(secret), secret);
    assert.ok(logs.some((entry) => entry.event === "turn_completed"));
    assert.ok(logs.some((entry) => entry.event === "turn_failed" && entry.code === "privacy_unavailable"));
  });

  await check("перезапуск Frontsmith: диалог возобновляется через thread/resume с той же privacy-session", async () => {
    const row = store.get(visitor.conversationId);
    main.host.close();
    const restarted = await startHost("restarted");
    current = restarted;
    const response = await chat(await startSite({ core }), visitor, `Это снова ${PERSON}`);
    assert.equal(response.status, 200);
    const received = await restarted.received();
    const resume = received.find((entry) => entry.method === "thread/resume");
    assert.equal(resume.params.threadId, row.codex_thread_id);
    assert.equal(resume.params.dynamicTools, undefined);
    assert.ok(!received.some((entry) => entry.method === "thread/start"));
    const turn = received.find((entry) => entry.kind === "turn_start");
    assert.match(turn.text, /<PII type="PERSON" id="1" \/>/, "та же privacy-session: тот же псевдоним");
    assert.ok(logs.some((entry) => entry.event === "conversation_resumed"));
  });

  await check("передача человеку: статус needs_human останавливает ответы AI", async () => {
    core.handoff(visitor.conversationId, "test");
    const before = (await current.received()).filter((entry) => entry.kind === "turn_start").length;
    const response = await chat(await startSite({ core }), visitor, "Ещё вопрос");
    assert.equal(response.status, 200);
    assert.equal(response.error, undefined);
    assert.equal(response.answer, "", "AI не отвечает, сообщение ждёт сотрудника");
    assert.equal((await current.received()).filter((entry) => entry.kind === "turn_start").length, before);
    assert.equal(store.get(visitor.conversationId).status, "needs_human");
    assert.equal(store.messages(visitor.conversationId).at(-1).text, "Ещё вопрос");
  });

  await check("предпросмотр сайта без AI runtime: чат честно сообщает о недоступности", async () => {
    const server = createWebsiteServer({ root: () => path.join(root, "site"), port: 0 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const response = await session(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, "provider_unavailable");
  });
} finally {
  for (const server of servers) server.close();
  for (const host of hosts) host.close();
  store.close();
  await privacy.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(`Conversation Module: ${passed} проверок пройдено.`);
