// Передача AI-диалога человеку и операторский inbox на тестовых двойниках: request_human и
// кнопка посетителя, раздел «Диалоги» офиса, ответ сотрудника в чате посетителя, возврат AI,
// закрытие, изоляция посетителей, перезапуск, очистка по сроку и решения по предварительным записям.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-handoff-"));
const businessRoot = path.join(testRoot, "business");
process.env.FRONTSMITH_BUSINESS_ROOT = businessRoot;
process.env.FRONTSMITH_ACTOR = "тест";
const { useFakeCrm } = await import("../services/crm/testing/fake-crmkit.mjs");
const crm = await useFakeCrm(path.join(testRoot, "data"));
const { openOfficeDb } = await import("../office/lib/db.mjs");
const { registerFunctions } = await import("../office/lib/repositories.mjs");
const { connectCustomers } = await import("../office/customers/index.mjs");
const { createOfficeServer } = await import("../office/server.mjs");
const ops = await import("../office/lib/operations.mjs");
const { freePort } = await import("../services/crm/runtime.mjs");
const { AppServerClient } = await import("../services/codex-host/app-server-client.mjs");
const { CodexHost } = await import("../services/codex-host/codex-host.mjs");
const { PrivacyClient } = await import("../services/codex-host/privacy-client.mjs");
const { startFakePrivacyService } = await import("../services/codex-host/testing/fake-privacy-service.mjs");
const { BOOKING_TOOLS, BookingDesk } = await import("../services/conversation/booking.mjs");
const { publicBusinessContext } = await import("../services/conversation/business-context.mjs");
const { ConversationCore, HANDOFF_NOTICE, HANDOFF_TOOL } = await import("../services/conversation/core.mjs");
const { ConversationStore } = await import("../services/conversation/store.mjs");
const { LIMITS, createWebChannel } = await import("../services/conversation/web-channel.mjs");
const { createWebsiteServer } = await import("../scripts/lib/website-server.mjs");

const fakeServer = path.join(repo, "services", "codex-host", "testing", "fake-app-server.mjs");
const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const clock = { now: new Date("2026-10-26T06:00:00Z") };
const now = () => new Date(clock.now);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const profileFile = path.join(businessRoot, "business.json");
const profile = () => JSON.parse(readFileSync(profileFile, "utf8"));
await mkdir(businessRoot, { recursive: true });
const demo = JSON.parse(await readFile(path.join(repo, "blueprints", "generic-service", "booking-demo.json"), "utf8"));
demo.booking.autoConfirm = false;
await writeFile(profileFile, JSON.stringify(demo, null, 2));
for (const command of ["init", "import"]) await execFileAsync(process.execPath, ["scripts/office.mjs", command], { cwd: repo, env: process.env });

const privacy = await startFakePrivacyService();
const db = registerFunctions(openOfficeDb());
const customers = await connectCustomers({ db });
const storeFile = path.join(testRoot, "data", "conversations", "conversations.sqlite");
const store = new ConversationStore({ file: storeFile, now });
const logs = [];
const log = (entry) => logs.push(entry);
const desk = new BookingDesk({ db, provider: customers.provider, store, profile, now, log });
const servers = [];
const hosts = [];
let current;
let aiOnline = true;

const context = async ({ booking, handoff }) => publicBusinessContext(profile(), profile().services, { booking, handoff });
function makeCore(tools, conversationStore = store) {
  return new ConversationCore({ store: conversationStore, host: () => (aiOnline ? current?.host ?? null : null), context, tools, log });
}
const core = makeCore([...BOOKING_TOOLS, HANDOFF_TOOL]);

async function startHost(label) {
  const file = path.join(testRoot, `${label}.jsonl`);
  const client = AppServerClient.spawn({ codexBin: process.execPath, args: [fakeServer], env: { ...process.env, FAKE_APP_SERVER_LOG: file }, cwd: testRoot });
  const host = new CodexHost({ client, privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }), workspace: path.join(testRoot, `${label}-ws`), tools: [...desk.tools(), core.handoffTool()] });
  await host.start();
  hosts.push(host);
  const received = async () => existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { host, received };
}

const testLimits = { ...LIMITS, messagesPerConversation: [60_000, 100], messagesPerIp: [60 * 60_000, 1000], sessionsPerIp: [60_000, 100] };
async function startSite(conversationCore) {
  const allowedHosts = new Set();
  const server = createWebsiteServer({ root: () => testRoot, port: 0, chat: createWebChannel({ core: conversationCore, booking: desk, allowedHosts, limits: testLimits, log }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  allowedHosts.add(`127.0.0.1:${server.address().port}`);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, body, headers = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!String(response.headers.get("content-type")).startsWith("text/event-stream")) return { status: response.status, json: text ? JSON.parse(text) : null };
  const parts = text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, parts, answer: parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join(""), error: parts.find((part) => part.type === "error") };
}

async function visitor(base) {
  const session = (await post(`${base}/api/chat/session`, {})).json;
  const auth = { authorization: `Bearer ${session.token}` };
  return {
    ...session,
    say: (message) => post(`${base}/api/chat`, { protocol: 1, conversationId: session.conversationId, message }, auth),
    tool: (name, args = {}) => post(`${base}/api/chat`, { protocol: 1, conversationId: session.conversationId, message: `call ${name} ${JSON.stringify(args)}` }, auth),
    feed: async (after = 0) => (await post(`${base}/api/chat/messages`, { conversationId: session.conversationId, after }, auth)).json,
    handoff: () => post(`${base}/api/chat/handoff`, { conversationId: session.conversationId }, auth),
    offer: async () => (await post(`${base}/api/chat/booking`, { conversationId: session.conversationId }, auth)).json.offer,
    confirm: (body) => post(`${base}/api/chat/booking/confirm`, { conversationId: session.conversationId, consent: true, ...body }, auth)
  };
}

const officePort = await freePort();
const office = createOfficeServer({ port: officePort, now, inbox: core });
await new Promise((resolve) => office.server.listen(officePort, "127.0.0.1", resolve));
const officeUrl = `http://127.0.0.1:${officePort}`;
const officeGet = async (pathname) => {
  const response = await fetch(`${officeUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
};
const officePost = (pathname, body = {}, headers = { "x-frontsmith-office": "1" }) => post(`${officeUrl}${pathname}`, body, headers);
const turnStarts = async () => (await current.received()).filter((entry) => entry.kind === "turn_start");

try {
  current = await startHost("main");
  const base = await startSite(core);
  let ivan;

  await check("request_human: AI передаёт разговор, причина и уведомление сохранены до ответа", async () => {
    ivan = await visitor(base);
    await ivan.say(`Здравствуйте, я ${PERSON}, телефон ${PHONE}`);
    const start = (await current.received()).find((entry) => entry.method === "thread/start");
    assert.ok(start.params.dynamicTools.some((tool) => tool.name === HANDOFF_TOOL), "у нового диалога есть request_human");
    assert.match(start.params.developerInstructions, /request_human/);
    const response = await ivan.tool(HANDOFF_TOOL, { reason: "Посетитель просит сотрудника" });
    assert.match(response.answer, /^handoff_saved/);
    const row = store.get(ivan.conversationId);
    assert.equal(row.status, "needs_human");
    assert.equal(row.handoff_by, "ai");
    assert.equal(row.status_reason, "Посетитель просит сотрудника");
    const feed = await ivan.feed();
    assert.equal(feed.status, "needs_human");
    assert.deepEqual(feed.messages.map((message) => [message.role, message.text]), [["system", HANDOFF_NOTICE]]);
  });

  await check("после передачи AI не отвечает: сообщение посетителя ждёт сотрудника", async () => {
    const before = (await turnStarts()).length;
    const response = await ivan.say("Когда мне ответят?");
    assert.equal(response.status, 200);
    assert.equal(response.answer, "");
    assert.equal(response.error, undefined);
    assert.equal((await turnStarts()).length, before);
  });

  let transcript;
  await check("раздел «Диалоги»: обращение в очереди с причиной и временем последнего сообщения", async () => {
    const list = await officeGet("/api/conversations?status=needs_human");
    assert.equal(list.status, 200);
    const item = list.body.data.find((row) => row.id === ivan.conversationId);
    assert.equal(item.status, "needs_human");
    assert.equal(item.status_reason, "Посетитель просит сотрудника");
    assert.equal(item.last_role, "visitor");
    assert.ok(item.last_message_at);
    transcript = (await officeGet(`/api/conversations/${ivan.conversationId}`)).body.data;
    assert.deepEqual(transcript.messages.map((message) => message.role), ["visitor", "assistant", "visitor", "system", "assistant", "visitor"]);
    assert.equal(transcript.messages[0].text, `Здравствуйте, я ${PERSON}, телефон ${PHONE}`, "сотрудник видит сообщение посетителя как есть");
    assert.ok(transcript.messages.every((message) => !/<PII|developer|unknown_tool/.test(message.text)), "без тегов, инструкций и данных инструментов модели");
    for (const hidden of ["token_hash", "codex_thread_id", "privacy_session_id", "model_instructions", "tools"]) assert.ok(!(hidden in transcript.conversation), hidden);
  });

  await check("операторские методы: только из панели офиса, не с сайта", async () => {
    assert.equal((await officePost(`/api/conversations/${ivan.conversationId}/messages`, { text: "Здравствуйте" }, {})).status, 403, "без заголовка панели");
    assert.equal((await officePost(`/api/conversations/${ivan.conversationId}/messages`, { text: "Здравствуйте" }, { "x-frontsmith-office": "1", origin: base })).status, 403, "с Origin сайта");
    for (const pathname of ["/api/conversations", `/api/conversations/${ivan.conversationId}`, `/api/conversations/${ivan.conversationId}/messages`]) {
      const response = await fetch(`${base}${pathname}`, { method: pathname.endsWith("messages") ? "POST" : "GET", headers: { "content-type": "application/json" }, body: pathname.endsWith("messages") ? "{}" : undefined });
      assert.equal(response.status, 404, `сайт не обслуживает ${pathname}`);
    }
  });

  let operatorSeq;
  await check("ответ сотрудника приходит посетителю в тот же чат, без дублей при повторных запросах", async () => {
    const reply = await officePost(`/api/conversations/${ivan.conversationId}/messages`, { text: "Здравствуйте! Я Анна, помогу с вопросом" });
    assert.equal(reply.status, 201);
    operatorSeq = reply.json.data.message.seq;
    const feed = await ivan.feed();
    assert.deepEqual(feed.messages.at(-1), { seq: operatorSeq, role: "operator", text: "Здравствуйте! Я Анна, помогу с вопросом", createdAt: feed.messages.at(-1).createdAt });
    assert.deepEqual((await ivan.feed(operatorSeq)).messages, [], "после последнего полученного — пусто");
    assert.equal((await ivan.feed(0)).messages.filter((message) => message.role === "operator").length, 1);
  });

  await check("другой посетитель не видит чужую переписку и не пишет в чужой диалог", async () => {
    const other = await visitor(base);
    assert.deepEqual((await other.feed()).messages, []);
    const foreign = await post(`${base}/api/chat/messages`, { conversationId: ivan.conversationId, after: 0 }, { authorization: `Bearer ${other.token}` });
    assert.equal(foreign.status, 401);
    const foreignHandoff = await post(`${base}/api/chat/handoff`, { conversationId: ivan.conversationId }, { authorization: `Bearer ${other.token}` });
    assert.equal(foreignHandoff.status, 401);
  });

  await check("после перезапуска Frontsmith переписка и ответы сотрудника сохранены", async () => {
    // Новый процесс видит те же данные: отдельный экземпляр хранилища на том же файле
    const reopened = new ConversationStore({ file: storeFile, now });
    try {
      const restarted = makeCore([...BOOKING_TOOLS, HANDOFF_TOOL], reopened);
      assert.equal(restarted.visitorFeed(ivan.conversationId, 0).messages.find((message) => message.role === "operator").text, "Здравствуйте! Я Анна, помогу с вопросом");
      assert.equal(restarted.transcript(ivan.conversationId).messages.length, transcript.messages.length + 1);
      assert.equal(restarted.visitorFeed(ivan.conversationId, 0).status, "needs_human");
    } finally {
      reopened.close();
    }
  });

  // ядро и канал после «перезапуска» работают с новым экземпляром хранилища
  const core2 = makeCore([...BOOKING_TOOLS, HANDOFF_TOOL]);
  const desk2 = new BookingDesk({ db, provider: customers.provider, store, profile, now, log });
  const base2 = await (async () => {
    const allowedHosts = new Set();
    const server = createWebsiteServer({ root: () => testRoot, port: 0, chat: createWebChannel({ core: core2, booking: desk2, allowedHosts, limits: testLimits, log }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    allowedHosts.add(`127.0.0.1:${server.address().port}`);
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  })();
  const office2Port = await freePort();
  const office2 = createOfficeServer({ port: office2Port, now, inbox: core2 });
  await new Promise((resolve) => office2.server.listen(office2Port, "127.0.0.1", resolve));
  const office2Post = (pathname, body = {}) => post(`http://127.0.0.1:${office2Port}${pathname}`, body, { "x-frontsmith-office": "1" });
  const resumedIvan = { ...ivan, say: (message) => post(`${base2}/api/chat`, { protocol: 1, conversationId: ivan.conversationId, message }, { authorization: `Bearer ${ivan.token}` }) };

  await check("возврат AI: модель получает пропущенную переписку через Privacy Service", async () => {
    const returned = await office2Post(`/api/conversations/${ivan.conversationId}/return-ai`);
    assert.equal(returned.status, 200);
    assert.equal(returned.json.data.conversation.status, "active");
    const response = await resumedIvan.say("Спасибо, а ещё вопрос про цены");
    assert.equal(response.status, 200);
    assert.notEqual(response.answer, "");
    const turn = (await turnStarts()).at(-1);
    assert.match(turn.text, /Пока разговор вёл сотрудник/);
    assert.match(turn.text, /Сотрудник: Здравствуйте! Я Анна, помогу с вопросом/);
    assert.match(turn.text, /Посетитель: Когда мне ответят\?/);
    assert.ok(!turn.text.includes(PERSON), "ПД в пропущенной переписке тоже псевдонимизированы");
    const second = await resumedIvan.say("И последний вопрос");
    assert.doesNotMatch((await turnStarts()).at(-1).text, /Пока разговор вёл сотрудник/, "пропущенное передаётся один раз");
    assert.equal(second.status, 200);
  });

  await check("сотрудник перехватывает разговор: ответ AI, готовившийся в этот момент, не показывается", async () => {
    const pending = core2.reply(ivan.conversationId, "Вопрос, на который ответит сотрудник");
    core2.operatorReply(ivan.conversationId, "Отвечу я, сотрудник");
    const result = await pending;
    assert.deepEqual(result, { text: "", handoff: true });
    const messages = store.messages(ivan.conversationId);
    assert.equal(messages.at(-1).role, "operator");
    assert.equal(store.get(ivan.conversationId).handoff_by, "operator");
  });

  await check("закрытие обращения: посетитель получает уведомление, новый вопрос снова у AI", async () => {
    const closed = await office2Post(`/api/conversations/${ivan.conversationId}/close`);
    assert.equal(closed.json.data.conversation.status, "closed");
    const feed = core2.visitorFeed(ivan.conversationId, 0);
    assert.equal(feed.status, "closed");
    assert.match(feed.messages.at(-1).text, /завершил разговор/);
    const response = await resumedIvan.say("Ещё один вопрос");
    assert.notEqual(response.answer, "");
    assert.equal(store.get(ivan.conversationId).status, "active");
  });

  await check("кнопка «Позвать сотрудника» работает без AI", async () => {
    aiOnline = false;
    try {
      const guest = await visitor(base2);
      const failed = await guest.say("Есть кто-нибудь?");
      assert.equal(failed.error.code, "provider_unavailable");
      const response = await guest.handoff();
      assert.equal(response.status, 200);
      assert.equal(response.json.status, "needs_human");
      assert.equal(store.get(guest.conversationId).handoff_by, "visitor");
      assert.equal((await guest.feed()).messages.at(-1).text, HANDOFF_NOTICE);
      assert.equal((await guest.handoff()).json.status, "needs_human", "повтор не дублирует передачу");
      assert.equal((await guest.feed()).messages.filter((message) => message.role === "system").length, 1);
      const queued = await guest.say("Перезвоните, пожалуйста");
      assert.equal(queued.status, 200);
      assert.equal(queued.error, undefined, "в очереди к сотруднику AI не нужен");
    } finally {
      aiOnline = true;
    }
  });

  await check("старый диалог без request_human: инструмента нет, кнопка работает", async () => {
    const legacySite = await startSite(makeCore([...BOOKING_TOOLS]));
    const legacy = await visitor(legacySite);
    await legacy.say("Здравствуйте");
    assert.equal(store.get(legacy.conversationId).tools, JSON.stringify(BOOKING_TOOLS));
    const viaNewCore = await post(`${base2}/api/chat`, { protocol: 1, conversationId: legacy.conversationId, message: 'call request_human {"reason":"x"}' }, { authorization: `Bearer ${legacy.token}` });
    assert.equal(viaNewCore.answer, "Инструмент недоступен");
    assert.equal(store.get(legacy.conversationId).status, "active");
    const button = await post(`${base2}/api/chat/handoff`, { conversationId: legacy.conversationId }, { authorization: `Bearer ${legacy.token}` });
    assert.equal(button.json.status, "needs_human");
  });

  await check("предварительная запись: сотрудник подтверждает, посетитель и AI видят итог", async () => {
    const guest = await visitor(base2);
    await guest.tool("offer_booking", { service: "consultation", start: "2026-10-27T10:00" });
    const offer = await guest.offer();
    const confirmed = await guest.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: PHONE });
    assert.equal(confirmed.json.offer.status, "requested");
    const appointmentId = db.prepare("SELECT id FROM appointments WHERE external_id = ?").get(`chat:${offer.id}`).id;
    const decision = await office2Post(`/api/appointments/${appointmentId}/decision`, { decision: "confirm" });
    assert.equal(decision.status, 200);
    assert.equal(decision.json.data.appointment.status, "confirmed");
    assert.equal(db.prepare("SELECT confirmation_basis FROM appointments WHERE id = ?").get(appointmentId).confirmation_basis, "Подтверждено сотрудником в панели офиса");
    assert.equal((await guest.offer()).status, "confirmed");
    assert.match((await guest.tool("get_booking_status")).answer, /^confirmed: компания подтвердила запись/);
    assert.equal((await office2Post(`/api/appointments/${appointmentId}/decision`, { decision: "confirm" })).status, 409, "решение только по предварительной записи");
  });

  await check("предварительная запись: отклонение освобождает время и закрывает обращение", async () => {
    const guest = await visitor(base2);
    await guest.tool("offer_booking", { service: "consultation", start: "2026-10-27T12:00" });
    const offer = await guest.offer();
    await guest.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: PHONE });
    const row = db.prepare("SELECT id, inquiry_id FROM appointments WHERE external_id = ?").get(`chat:${offer.id}`);
    const decision = await office2Post(`/api/appointments/${row.id}/decision`, { decision: "reject" });
    assert.equal(decision.json.data.appointment.status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM inquiries WHERE id = ?").get(row.inquiry_id).status, "closed");
    assert.equal((await guest.offer()).status, "declined");
    assert.match((await guest.tool("get_booking_status")).answer, /^declined/);
    const slots = await guest.tool("find_booking_slots", { service: "consultation", date: "2026-10-27" });
    assert.match(slots.answer, /2026-10-27T12:00/, "время снова свободно");
  });

  await check("подтверждение проверяет пересечения заново", async () => {
    const ctx = ops.createContext(db, { actor: "тест", source: "cli", now });
    const confirmedSlot = db.prepare("SELECT * FROM appointments WHERE status = 'confirmed' LIMIT 1").get();
    const clash = ops.createAppointment(ctx, { inquiryId: confirmedSlot.inquiry_id, startsAt: confirmedSlot.starts_at, endsAt: confirmedSlot.ends_at, source: "phone" });
    const decision = await office2Post(`/api/appointments/${clash.id}/decision`, { decision: "confirm" });
    assert.equal(decision.status, 409);
    assert.equal(decision.json.error.code, "slot_unavailable");
    assert.equal(db.prepare("SELECT status FROM appointments WHERE id = ?").get(clash.id).status, "tentative");
  });

  await check("журналы без текста сообщений и контактов", async () => {
    const dump = JSON.stringify(logs);
    for (const secret of [PERSON, PHONE, "Анна", "Когда мне ответят", "Перезвоните"]) assert.ok(!dump.includes(secret), secret);
  });

  await check("срок хранения: старые диалоги и их переписка удаляются", async () => {
    const later = new ConversationStore({ file: storeFile, now: () => new Date(clock.now.getTime() + 91 * 86_400_000) });
    try {
      const { conversations } = later.purge({ days: 90 });
      assert.ok(conversations >= 3);
      assert.equal(later.get(ivan.conversationId), null);
      assert.deepEqual(later.messages(ivan.conversationId), []);
    } finally {
      later.close();
    }
  });

  const closed = office2.close();
  office2.server.closeAllConnections?.();
  await closed;
} finally {
  for (const server of servers) server.close();
  for (const host of hosts) host.close();
  const closed = office.close();
  office.server.closeAllConnections?.();
  await closed;
  store.close();
  db.close();
  await customers.stop?.();
  await privacy.close();
  await crm.close?.();
  await rm(testRoot, { recursive: true, force: true }).catch(() => {});
}
console.log(`Handoff: ${passed} проверок пройдено`);
