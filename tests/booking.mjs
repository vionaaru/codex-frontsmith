// Запись на услугу через AI-диспетчера на тестовых двойниках: веб-канал → ConversationCore →
// CodexHost (двойник App Server вызывает инструменты записи) → BookingDesk → офисная база
// и CustomerProvider (двойник crmkit). Оба режима подтверждения, повтор, занятое время,
// одновременные подтверждения, расписание панели, thread/resume и отсутствие контактов у модели.
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
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-booking-"));
const businessRoot = path.join(testRoot, "business");
process.env.FRONTSMITH_BUSINESS_ROOT = businessRoot;
process.env.FRONTSMITH_ACTOR = "тест";
const { useFakeCrm } = await import("../services/crm/testing/fake-crmkit.mjs");
const crm = await useFakeCrm(path.join(testRoot, "data"));
const { openOfficeDb } = await import("../office/lib/db.mjs");
const { registerFunctions } = await import("../office/lib/repositories.mjs");
const { connectCustomers } = await import("../office/customers/index.mjs");
const { createOfficeServer } = await import("../office/server.mjs");
const { availableSlots, bookingSettings, slotLabel } = await import("../office/lib/booking.mjs");
const { AppServerClient } = await import("../services/codex-host/app-server-client.mjs");
const { CodexHost } = await import("../services/codex-host/codex-host.mjs");
const { PrivacyClient } = await import("../services/codex-host/privacy-client.mjs");
const { startFakePrivacyService } = await import("../services/codex-host/testing/fake-privacy-service.mjs");
const { getTestCustomerTool } = await import("../services/codex-host/testing/test-customer-tool.mjs");
const { BOOKING_TOOLS, BookingDesk } = await import("../services/conversation/booking.mjs");
const { publicBusinessContext } = await import("../services/conversation/business-context.mjs");
const { ConversationCore } = await import("../services/conversation/core.mjs");
const { ConversationStore } = await import("../services/conversation/store.mjs");
const { LIMITS, createWebChannel } = await import("../services/conversation/web-channel.mjs");
const { createWebsiteServer } = await import("../scripts/lib/website-server.mjs");

const fakeServer = path.join(repo, "services", "codex-host", "testing", "fake-app-server.mjs");
const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const OTHER = "Мария Сидорова";
const OTHER_PHONE = "+7 926 555-44-33";
const CONTACTS = [PERSON, "Петров", PHONE, "+79161234567", "9161234567", OTHER, "Сидорова", OTHER_PHONE, "+79265554433"];
const clean = (text) => CONTACTS.every((value) => !text.includes(value));
// Понедельник, 26 октября 2026, 09:00 в Москве
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
async function setProfile(change) {
  const next = profile();
  change(next);
  await writeFile(profileFile, JSON.stringify(next, null, 2));
}

await mkdir(businessRoot, { recursive: true });
const demo = JSON.parse(await readFile(path.join(repo, "blueprints", "generic-service", "booking-demo.json"), "utf8"));
demo.booking.autoConfirm = false;
await writeFile(profileFile, JSON.stringify(demo, null, 2));
for (const command of ["init", "import"]) await execFileAsync(process.execPath, ["scripts/office.mjs", command], { cwd: repo, env: process.env });

const privacy = await startFakePrivacyService();
const db = registerFunctions(openOfficeDb());
const customers = await connectCustomers({ db });
const store = new ConversationStore({ file: path.join(testRoot, "data", "conversations", "conversations.sqlite") });
const logs = [];
const desk = new BookingDesk({ db, provider: customers.provider, store, profile, now, log: (entry) => logs.push(entry) });
const servers = [];
const hosts = [];
const seen = [];
let current;

async function startHost(label) {
  const log = path.join(testRoot, `${label}.jsonl`);
  const client = AppServerClient.spawn({ codexBin: process.execPath, args: [fakeServer], env: { ...process.env, FAKE_APP_SERVER_LOG: log }, cwd: testRoot });
  const host = new CodexHost({
    client,
    privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }),
    workspace: path.join(testRoot, `${label}-ws`),
    tools: [getTestCustomerTool(), ...desk.tools()],
    diagnostics: { captureModelVisible: (entry) => seen.push(entry) }
  });
  await host.start();
  hosts.push(host);
  const received = async () => existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { host, received };
}

const context = async ({ booking }) => publicBusinessContext(profile(), profile().services, { booking });
function makeCore(tools) {
  return new ConversationCore({ store, host: () => current?.host ?? null, context, tools, log: (entry) => logs.push(entry) });
}

// Сценарий шлёт больше сообщений, чем допускает лимит канала; лимиты проверяет test:conversation
const testLimits = { ...LIMITS, messagesPerConversation: [60_000, 100], messagesPerIp: [60 * 60_000, 1000], sessionsPerIp: [60_000, 100] };

async function startSite(core) {
  const allowedHosts = new Set();
  const server = createWebsiteServer({ root: () => testRoot, port: 0, chat: createWebChannel({ core, booking: desk, allowedHosts, limits: testLimits, log: (entry) => logs.push(entry) }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  allowedHosts.add(`127.0.0.1:${server.address().port}`);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, body, token) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!String(response.headers.get("content-type")).startsWith("text/event-stream")) return { status: response.status, json: text ? JSON.parse(text) : null };
  const parts = text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
  return { status: response.status, answer: parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join(""), error: parts.find((part) => part.type === "error") };
}

async function visitor(base) {
  const session = (await post(`${base}/api/chat/session`, {})).json;
  return {
    ...session,
    say: (message) => post(`${base}/api/chat`, { protocol: 1, conversationId: session.conversationId, message }, session.token),
    tool: (name, args = {}) => post(`${base}/api/chat`, { protocol: 1, conversationId: session.conversationId, message: `call ${name} ${JSON.stringify(args)}` }, session.token),
    offer: async () => (await post(`${base}/api/chat/booking`, { conversationId: session.conversationId }, session.token)).json.offer,
    confirm: (body) => post(`${base}/api/chat/booking/confirm`, { conversationId: session.conversationId, consent: true, ...body }, session.token)
  };
}

const appointments = () => db.prepare("SELECT a.*, i.customer_id, i.status AS inquiry_status, i.source AS inquiry_source FROM appointments a JOIN inquiries i ON i.id = a.inquiry_id ORDER BY a.starts_at").all();

try {
  current = await startHost("main");
  const core = makeCore(BOOKING_TOOLS);
  const base = await startSite(core);
  let ivan;
  let offer;

  await check("расписание: без рабочих часов интервалы не выдумываются", async () => {
    const generic = JSON.parse(await readFile(path.join(repo, "blueprints", "generic-service", "business.example.json"), "utf8"));
    const settings = bookingSettings(generic);
    assert.equal(settings.configured, false);
    assert.match(settings.missing.join(" "), /рабочие дни и часы/);
    const service = db.prepare("SELECT * FROM services WHERE code = 'consultation'").get();
    assert.deepEqual(availableSlots(db, settings, service, { now: now() }), []);
  });

  await check("расписание: рабочие часы, часовой пояс, длительность и минимальный срок", async () => {
    const settings = bookingSettings(profile());
    const service = db.prepare("SELECT * FROM services WHERE code = 'full-service'").get();
    const slots = availableSlots(db, settings, service, { now: now(), limit: 40, perDay: 40 });
    assert.equal(slots[0].key, "2026-10-26T10:00");
    assert.equal(slots[0].startsAt, "2026-10-26T07:00:00.000Z", "10:00 по Москве = 07:00 UTC");
    assert.ok(slots.every((slot) => slot.key.slice(11) <= "17:00"), "120-минутная услуга заканчивается до 19:00");
    assert.ok(!slots.some((slot) => slot.key.startsWith("2026-11-01")), "воскресенье — выходной");
    assert.equal(slotLabel(new Date(slots[0].startsAt), settings.timeZone), "пн, 26 октября в 10:00");
  });

  await check("публичный диалог получает только инструменты записи, без CRM-инструмента оператора", async () => {
    ivan = await visitor(base);
    const response = await ivan.tool("find_booking_slots", { service: "Консультация" });
    assert.equal(response.status, 200);
    assert.match(response.answer, /consultation — Консультация, длительность 60 мин/);
    assert.match(response.answer, /2026-10-26T10:00 — пн, 26 октября в 10:00/);
    const start = (await current.received()).find((entry) => entry.method === "thread/start");
    assert.deepEqual(start.params.dynamicTools.map((tool) => tool.name).sort(), [...BOOKING_TOOLS].sort());
    assert.match(start.params.developerInstructions, /find_booking_slots/);
    assert.equal(store.get(ivan.conversationId).tools, JSON.stringify(BOOKING_TOOLS));
    const crmTool = await ivan.tool("get_test_customer", {});
    assert.equal(crmTool.answer, "Инструмент недоступен");
  });

  await check("занятое и нерабочее время не предлагается", async () => {
    assert.match((await ivan.tool("offer_booking", { service: "consultation", start: "2026-10-26T09:00" })).answer, /slot_unavailable: это время вне рабочего расписания/);
    assert.match((await ivan.tool("offer_booking", { service: "consultation", start: "2026-11-01T12:00" })).answer, /slot_unavailable/);
    assert.match((await ivan.tool("offer_booking", { service: "consultation", start: "завтра" })).answer, /invalid_start/);
  });

  await check("offer_booking: форма с выбором времени, запись ещё не создана", async () => {
    const response = await ivan.tool("offer_booking", { service: "consultation", start: "2026-10-26T10:00" });
    assert.match(response.answer, /offer_created/);
    assert.match(response.answer, /компания получит запрос/);
    // Дата дошла до модели тегом DATE_TIME и вернулась в аргументе тегом: Host восстановил её до вызова
    const turn = (await current.received()).filter((entry) => entry.kind === "turn_start").at(-1);
    assert.match(turn.text, /"start":"<PII type="DATE_TIME" id="\d+" \/>T10:00"/);
    offer = await ivan.offer();
    assert.equal(offer.status, "offered");
    assert.equal(offer.mode, "request");
    assert.equal(offer.start, "2026-10-26T10:00");
    assert.ok(offer.options.some((option) => option.start === "2026-10-26T10:00"));
    assert.equal(appointments().length, 0);
    assert.match((await ivan.tool("get_booking_status")).answer, /waiting_for_form/);
  });

  await check("форма проверяет согласие и контакты", async () => {
    const noConsent = await ivan.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: PHONE, consent: false });
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.json.error.code, "consent_required");
    const badPhone = await ivan.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: "позвоните мне" });
    assert.equal(badPhone.status, 400);
    assert.equal(badPhone.json.error.code, "invalid_contact");
    assert.ok(clean(JSON.stringify(badPhone.json)), "ошибка без контактных значений");
    const foreign = await post(`${base}/api/chat/booking/confirm`, { conversationId: ivan.conversationId, offerId: offer.id, consent: true, name: PERSON, phone: PHONE }, (await visitor(base)).token);
    assert.equal(foreign.status, 401, "чужой токен не подтверждает чужую запись");
  });

  let ivanAppointment;
  await check("режим по умолчанию: обращение и предварительная запись, время не подтверждено", async () => {
    const response = await ivan.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: PHONE });
    assert.equal(response.status, 200);
    assert.equal(response.json.offer.status, "requested");
    const rows = appointments();
    assert.equal(rows.length, 1);
    ivanAppointment = rows[0];
    assert.equal(ivanAppointment.status, "tentative");
    assert.equal(ivanAppointment.starts_at, "2026-10-26T07:00:00.000Z");
    assert.equal(ivanAppointment.ends_at, "2026-10-26T08:00:00.000Z");
    assert.equal(ivanAppointment.source, "website");
    assert.equal(ivanAppointment.inquiry_status, "new");
    assert.equal(ivanAppointment.is_demo, 1, "демо-профиль: записи помечены учебными");
    const contact = crm.contacts.find((item) => item.custom.frontsmith_client_id === ivanAppointment.customer_id);
    assert.equal(contact.name, PERSON);
    assert.equal(contact.phone, "+79161234567");
    assert.equal(store.get(ivan.conversationId).client_id, ivanAppointment.customer_id);
    const events = db.prepare("SELECT * FROM activity_events WHERE source = 'ai_dispatcher'").all();
    assert.ok(events.some((event) => event.entity_type === "inquiry") && events.some((event) => event.entity_type === "appointment"), "журнал действий");
    assert.ok(events.every((event) => event.actor === "AI-диспетчер сайта" && clean(JSON.stringify(event))));
    const status = await ivan.tool("get_booking_status");
    assert.match(status.answer, /requested: .*НЕ подтверждено/);
  });

  await check("повтор подтверждения не создаёт дубль", async () => {
    const again = await ivan.confirm({ offerId: offer.id, start: offer.start, name: PERSON, phone: PHONE });
    assert.equal(again.status, 200);
    assert.equal(again.json.offer.status, "requested");
    assert.equal(appointments().length, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM inquiries").get().n, 1);
    assert.equal(crm.contacts.length, 1);
  });

  await check("занятое время: запись не подтверждается, предлагаются другие варианты", async () => {
    const maria = await visitor(base);
    const response = await maria.tool("offer_booking", { service: "consultation", start: "2026-10-26T10:30" });
    assert.match(response.answer, /slot_unavailable: это время уже занято/);
    assert.match(response.answer, /2026-10-26T11:00/);
    const slots = await maria.tool("find_booking_slots", { service: "consultation" });
    assert.doesNotMatch(slots.answer, /2026-10-26T10:00|2026-10-26T10:30/, "занятый понедельник 10:00–11:00 не предлагается");
  });

  await check("одновременные подтверждения одного времени: создаётся ровно одна запись", async () => {
    const a = await visitor(base);
    const b = await visitor(base);
    await a.tool("offer_booking", { service: "consultation", start: "2026-10-26T12:00" });
    await b.tool("offer_booking", { service: "consultation", start: "2026-10-26T12:00" });
    const [offerA, offerB] = [await a.offer(), await b.offer()];
    const results = await Promise.all([
      a.confirm({ offerId: offerA.id, start: offerA.start, name: OTHER, phone: OTHER_PHONE }),
      b.confirm({ offerId: offerB.id, start: offerB.start, name: PERSON, phone: PHONE })
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const loser = results.find((result) => result.status === 409);
    assert.equal(loser.json.error.code, "slot_unavailable");
    assert.ok(loser.json.offer.options.length > 0 && loser.json.offer.options.every((option) => option.start !== "2026-10-26T12:00"), "форма получает свободные варианты");
    assert.equal(appointments().filter((row) => row.starts_at === "2026-10-26T09:00:00.000Z").length, 1);
  });

  await check("автоподтверждение только по разрешению владельца в профиле", async () => {
    const guest = await visitor(base);
    // Модель не может включить автоподтверждение аргументом
    await guest.tool("offer_booking", { service: "express", start: "2026-10-26T14:00", autoConfirm: true });
    const requested = await guest.offer();
    assert.equal(requested.mode, "request");
    await setProfile((next) => { next.booking.autoConfirm = true; });
    const auto = await visitor(base);
    const offered = await auto.tool("offer_booking", { service: "express", start: "2026-10-26T15:00" });
    assert.match(offered.answer, /подтвердит запись, если оно свободно/);
    const autoOffer = await auto.offer();
    assert.equal(autoOffer.mode, "auto");
    const response = await auto.confirm({ offerId: autoOffer.id, start: "2026-10-26T15:30", name: OTHER, phone: OTHER_PHONE });
    assert.equal(response.status, 200);
    assert.equal(response.json.offer.status, "confirmed");
    assert.equal(response.json.offer.start, "2026-10-26T15:30", "посетитель выбрал другой вариант в форме");
    const row = appointments().find((item) => item.starts_at === "2026-10-26T12:30:00.000Z");
    assert.equal(row.status, "confirmed");
    assert.match(row.confirmation_basis, /разрешено владельцем/);
    assert.match((await auto.tool("get_booking_status")).answer, /confirmed: запись подтверждена/);
  });

  await check("запись видна в расписании офисной панели с подписью клиента из CRM", async () => {
    const { freePort } = await import("../services/crm/runtime.mjs");
    const port = await freePort();
    const office = createOfficeServer({ port, now });
    await new Promise((resolve) => office.server.listen(port, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/schedule?from=2026-10-26&days=1`);
      assert.equal(response.status, 200);
      const { data } = await response.json();
      const ivanRow = data.appointments.find((item) => item.id === ivanAppointment.id);
      assert.equal(ivanRow.customer_name, PERSON);
      assert.equal(ivanRow.status, "tentative");
      assert.ok(data.appointments.some((item) => item.status === "confirmed"));
    } finally {
      const closed = office.close();
      office.server.closeAllConnections?.();
      await closed;
    }
  });

  await check("модель и журналы не видят контакты: только Privacy-текст, статусы и время", async () => {
    assert.ok(seen.length > 0);
    assert.ok(seen.every((entry) => clean(entry.text)), "model-visible текст без имён и телефонов");
    const received = [...(await current.received())];
    assert.ok(clean(JSON.stringify(received)), "App Server не получал контакты");
    assert.ok(clean(JSON.stringify(logs)), "журналы канала без контактов");
    assert.ok(clean(readFileSync(store.file).toString("utf8")), "хранилище диалогов без контактов");
  });

  await check("thread/resume: инструменты записи продолжают работать в том же диалоге", async () => {
    const before = store.get(ivan.conversationId);
    current.host.close();
    current = await startHost("restarted");
    const response = await ivan.tool("get_booking_status");
    assert.match(response.answer, /requested/);
    const received = await current.received();
    const resume = received.find((entry) => entry.method === "thread/resume");
    assert.equal(resume.params.threadId, before.codex_thread_id);
    assert.match(resume.params.developerInstructions, /find_booking_slots/);
  });

  await check("диалог, начатый без инструментов, не получает их при resume", async () => {
    const legacySite = await startSite(makeCore([]));
    const legacy = await visitor(legacySite);
    await legacy.say("Здравствуйте");
    assert.equal(store.get(legacy.conversationId).tools, "[]");
    const viaBookingCore = await post(`${base}/api/chat`, { protocol: 1, conversationId: legacy.conversationId, message: 'call find_booking_slots {"service":"consultation"}' }, legacy.token);
    assert.equal(viaBookingCore.answer, "Инструмент недоступен");
  });

  await check("форма после перезагрузки: состояние берётся с сервера по токену диалога", async () => {
    const view = await ivan.offer();
    assert.equal(view.status, "requested");
    assert.equal(view.reference.length, 8);
    assert.ok(clean(JSON.stringify(view)));
  });
} finally {
  for (const server of servers) server.close();
  for (const host of hosts) host.close();
  store.close();
  db.close();
  await customers.stop?.();
  await privacy.close();
  await crm.close?.();
  await rm(testRoot, { recursive: true, force: true }).catch(() => {});
}
console.log(`Booking: ${passed} проверок пройдено`);
