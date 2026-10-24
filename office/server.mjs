// Локальный сервер панели офиса, только 127.0.0.1. Бизнес-данные — только чтение;
// единственные изменения из браузера — карточки клиентов через CustomerProvider.
// Браузер получает JSON-представления; SQL, путь к базе, токен CRM и приватные файлы наружу не отдаются.
// Контакты клиентов в офисной базе не хранятся: сервер добавляет подписи по client_id
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OfficeDbMissingError, listMigrations, officeDbExists, officeDbPath, openOfficeDb, schemaVersion } from "./lib/db.mjs";
import {
  appointmentStatuses,
  inquiryStatuses,
  taskStatuses,
  vocabulary,
  workOrderStatuses,
  zonedDayRange
} from "./lib/domain.mjs";
import * as repo from "./lib/repositories.mjs";
import { CustomerError } from "./customers/contract.mjs";
import { connectCustomers, enrichCustomerRefs } from "./customers/index.mjs";
import { officeModules } from "../scripts/lib/blueprints.mjs";
import { businessPath } from "../scripts/lib/paths.mjs";

export const defaultOfficePort = 4180;
const host = "127.0.0.1";
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const staticFiles = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml; charset=utf-8"]
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxBodyBytes = 16 * 1024;

const securityHeaders = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin"
};

class HttpError extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// connectProvider(db) → { provider, stop } — CustomerProvider на отдельном соединении с записью
// (идентичность и связи клиентов). По умолчанию — встроенный crmkit
export function createOfficeServer({ port = defaultOfficePort, dbFile = officeDbPath(), now = () => new Date(), connectProvider = (conn) => connectCustomers({ db: conn }) } = {}) {
  let db = null;
  let customersDb = null;
  let customers = null;
  let connecting = null;
  let failedAt = 0;
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);

  // Провайдер подключается при первом обращении; недоступный CRM не ломает остальные разделы
  async function customerProvider({ required = false } = {}) {
    if (customers) return customers.provider;
    if (!required && failedAt && Date.now() - failedAt < 10_000) return null;
    try {
      connection();
      connecting ??= (async () => {
        customersDb = repo.registerFunctions(openOfficeDb({ file: dbFile }));
        const connected = await connectProvider(customersDb);
        customers = connected;
        // Дочерний crmkit завершился — следующий запрос подключится заново
        connected.crm?.exited?.then(() => { if (customers === connected) { customers = null; connecting = null; } });
        return connected.provider;
      })();
      return await connecting;
    } catch (error) {
      connecting = null;
      failedAt = Date.now();
      try { customersDb?.close(); } catch { /* уже закрыто */ }
      customersDb = null;
      if (!required) return null;
      if (error instanceof HttpError || error instanceof OfficeDbMissingError) throw error;
      throw new HttpError(503, `CRM недоступен: ${error.code === "crm_runtime_missing" || error.code === "crm_credential_missing" ? "выполните npm run crm:bootstrap" : "проверьте npm run crm:start"}`, "crm_unavailable");
    }
  }

  function connection() {
    if (db) return db;
    if (!officeDbExists(dbFile)) throw new OfficeDbMissingError(dbFile);
    db = repo.registerFunctions(openOfficeDb({ file: dbFile, readonly: true }));
    const latest = Math.max(...listMigrations().map((migration) => migration.version));
    if (schemaVersion(db) !== latest) {
      closeDb();
      throw new HttpError(503, "Схема базы устарела. Выполните npm run office:init", "schema_outdated");
    }
    return db;
  }

  function closeDb() {
    try { db?.close(); } catch { /* соединение уже закрыто */ }
    db = null;
  }

  async function closeAll() {
    closeDb();
    const current = customers;
    customers = null;
    connecting = null;
    await current?.stop();
    try { customersDb?.close(); } catch { /* уже закрыто */ }
    customersDb = null;
  }

  const routes = [
    ["/api/health", () => ({ ok: true, database: officeDbExists(dbFile) ? "present" : "missing" })],
    ["/api/meta", async (conn, ctx) => {
      const provider = await customerProvider();
      return { business: publicBusiness(ctx.business), modules: profileModules(), vocabulary, schemaVersion: schemaVersion(conn), today: ctx.day,
        customers: { provider: provider?.name ?? null, available: Boolean(provider), capabilities: provider?.capabilities ?? null } };
    }],
    ["/api/overview", (conn, ctx) => {
      const month = ctx.params.get("month") ?? ctx.day.date.slice(0, 7);
      if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Месяц: YYYY-MM", "bad_request");
      return repo.overview(conn, { now: ctx.now, dayStart: ctx.day.start, dayEnd: ctx.day.end, month });
    }],
    ["/api/customers", (conn, ctx) => listCustomers(conn, ctx)],
    [/^\/api\/customers\/([^/]+)$/, (conn, ctx, id) => customerCard(conn, uuid(id))],
    [/^\/api\/vehicles\/([^/]+)$/, (conn, ctx, id) => found(repo.getVehicle(conn, uuid(id)), "Автомобиль")],
    ["/api/inquiries", (conn, ctx) => repo.listInquiries(conn, { q: ctx.q, qClientIds: ctx.qClientIds, ...statusFilter(ctx.params, inquiryStatuses, { active: ["new", "in_progress", "waiting_customer"] }) })],
    [/^\/api\/inquiries\/([^/]+)$/, (conn, ctx, id) => found(repo.getInquiry(conn, uuid(id)), "Обращение")],
    ["/api/orders", (conn, ctx) => {
      const from = dateFilter(ctx.params.get("from"));
      const to = dateFilter(ctx.params.get("to"));
      if (from && to && from > to) throw new HttpError(400, "Начало периода позже окончания", "bad_request");
      return repo.listWorkOrders(conn, { q: ctx.q, qClientIds: ctx.qClientIds, from, to,
        performed: oneOf(ctx.params.get("performed"), ["yes"], "performed") === "yes",
        ...statusFilter(ctx.params, workOrderStatuses, { active: ["draft", "awaiting_approval", "approved", "in_progress", "ready"] }) });
    }],
    [/^\/api\/orders\/([^/]+)$/, (conn, ctx, id) => found(repo.getWorkOrder(conn, uuid(id)), "Заказ")],
    ["/api/tasks", (conn, ctx) => repo.listTasks(conn, { q: ctx.q, qClientIds: ctx.qClientIds, due: oneOf(ctx.params.get("due"), ["overdue", "today", "later", "none"], "due"), now: ctx.now, dayEnd: ctx.day.end, ...statusFilter(ctx.params, taskStatuses, { open: ["open", "in_progress"] }) })],
    ["/api/services", (conn, ctx) => repo.listServices(conn, { q: ctx.q, active: activeFilter(ctx.params.get("active")), category: ctx.params.get("category") || undefined })],
    ["/api/schedule", (conn, ctx) => schedule(conn, ctx)],
    ["/api/events", (conn) => repo.listEvents(conn, { limit: 100 })]
  ];

  // Список: все client_id офиса + контакты из провайдера. Клиент без связи с CRM
  // (ещё не перенесённый) показывается с contactStatus = "pending_migration"
  async function listCustomers(conn, ctx) {
    const provider = await customerProvider({ required: true });
    const summaries = repo.customerSummaries(conn);
    const { items } = await provider.listCustomers();
    const contacts = new Map(items.map((customer) => [customer.id, customer]));
    let rows = [...summaries.values()].map((summary) => customerRow(summary, contacts.get(summary.id)));
    if (ctx.q) {
      const matched = new Set([...(await provider.listCustomers({ q: ctx.q })).items.map((customer) => customer.id), ...repo.customerIdsByVehicle(conn, ctx.q)]);
      rows = rows.filter((row) => matched.has(row.id));
    }
    return rows.sort((a, b) => (a.displayName ?? "\uffff").localeCompare(b.displayName ?? "\uffff", "ru", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  }

  // Карточка: контакты из провайдера и бизнес-данные офиса по одному client_id
  async function customerCard(conn, id) {
    const business = found(repo.getCustomer(conn, id), "Клиент");
    const provider = await customerProvider();
    let contact = null;
    let contactStatus = provider ? "ok" : "unavailable";
    if (provider) {
      try {
        contact = await provider.getCustomer(id);
      } catch (error) {
        if (!(error instanceof CustomerError)) throw error;
        contactStatus = error.code === "contact_missing" ? (conn.prepare("SELECT 1 FROM legacy_customer_contacts WHERE client_id = ?").get(id) ? "pending_migration" : "missing") : "unavailable";
      }
    }
    return { ...business, contact, contactStatus };
  }

  async function writeCustomer(req, url) {
    if (url.pathname === "/api/customers" && req.method === "POST") {
      const body = await readJson(req);
      const { requestId, allowSharedPhone, ...input } = body;
      if (requestId !== undefined && (typeof requestId !== "string" || !uuidPattern.test(requestId))) throw new HttpError(400, "requestId: UUID", "bad_request");
      const provider = await customerProvider({ required: true });
      // requestId — ключ идемпотентности: повтор той же отправки формы вернёт того же клиента
      const result = await provider.createCustomer(input, { clientId: requestId, allowSharedPhone: allowSharedPhone === true, actor: "оператор панели", source: "panel" });
      return { status: result.status === "created" ? 201 : 200, data: { status: result.status, customer: result.customer } };
    }
    const match = /^\/api\/customers\/([^/]+)$/.exec(url.pathname);
    if (match && req.method === "PATCH") {
      const id = uuid(decodeURIComponent(match[1]));
      const { version, allowSharedPhone, ...input } = await readJson(req);
      const provider = await customerProvider({ required: true });
      const customer = await provider.updateCustomer(id, input, { version, allowSharedPhone: allowSharedPhone === true, actor: "оператор панели", source: "panel" });
      return { status: 200, data: { customer } };
    }
    throw new HttpError(405, "Панель меняет только карточки клиентов. Остальные изменения — через Codex и npm run office", "read_only");
  }

  async function handle(req, res) {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? "").toLowerCase())) throw new HttpError(421, "Панель доступна только по адресу 127.0.0.1", "host_not_allowed");
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (!url.pathname.startsWith("/api/customers")) {
          res.setHeader("allow", "GET, HEAD");
          throw new HttpError(405, "Панель только читает данные. Изменения — через Codex и npm run office", "read_only");
        }
        assertSameOrigin(req);
        const result = await writeCustomer(req, url);
        return sendJson(req, res, result.status, { data: result.data, meta: { generatedAt: now().toISOString() } });
      }
      if (!url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, req, res);
      return sendJson(req, res, 200, await api(url));
    } catch (error) {
      if (error instanceof CustomerError) {
        // Сообщение без контактных значений, кандидаты — только client_id
        return sendJson(req, res, error.status, { error: { code: error.code, message: error.message, candidates: error.candidates } });
      }
      const status = error instanceof HttpError ? error.status : error instanceof OfficeDbMissingError ? 503 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof OfficeDbMissingError ? "database_missing" : "internal_error";
      if (status === 500) {
        console.error("Ошибка панели офиса:", error);
        closeDb();
      }
      const message = status === 500 ? "Внутренняя ошибка сервера панели. Подробности в консоли сервера" :
        code === "database_missing" ? "База офиса не создана. Выполните npm run office:init и npm run office:import" : error.message;
      return sendJson(req, res, status, { error: { code, message } });
    }
  }

  async function api(url) {
    const route = routes.find(([pattern]) => typeof pattern === "string" ? pattern === url.pathname : pattern.test(url.pathname));
    if (!route) throw new HttpError(404, "Нет такого раздела API", "not_found");
    if (url.pathname === "/api/health") return { data: route[1](), meta: { generatedAt: now().toISOString() } };

    const conn = connection();
    const business = repo.getBusiness(conn);
    if (!business) throw new HttpError(503, "В базе нет проекции профиля. Выполните npm run office:init", "business_missing");
    const current = now();
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > 100) throw new HttpError(400, "Слишком длинный поисковый запрос", "bad_request");
    const ctx = { params: url.searchParams, q: q || undefined, business, now: current.toISOString(), day: zonedDayRange(current, business.time_zone) };
    const provider = await customerProvider();
    // Поиск по имени и телефону клиента: CustomerProvider возвращает client_id, SQL ищет по ним
    if (ctx.q && provider && url.pathname !== "/api/customers") {
      ctx.qClientIds = (await provider.listCustomers({ q: ctx.q }).catch(() => ({ items: [] }))).items.map((customer) => customer.id);
    }
    const match = typeof route[0] === "string" ? [] : route[0].exec(url.pathname).slice(1).map(decodeURIComponent);
    const data = await route[1](conn, ctx, ...match);
    if (url.pathname !== "/api/customers") await enrichCustomerRefs(data, provider ?? unavailableProvider);
    return { data, meta: { generatedAt: ctx.now, timeZone: business.time_zone, demoMode: business.demo_mode === 1, currency: business.currency } };
  }

  // Изменение клиента — только из своей страницы: JSON, собственный заголовок и тот же Origin.
  // Сторонний сайт не может отправить такой запрос без CORS-разрешения, которого сервер не даёт
  function assertSameOrigin(req) {
    if (req.headers["x-frontsmith-office"] !== "1") throw new HttpError(403, "Запрос не из панели офиса", "forbidden");
    if (req.headers.origin && !allowedOrigins.has(String(req.headers.origin).toLowerCase())) throw new HttpError(403, "Запрос не из панели офиса", "forbidden");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Ожидается application/json", "unsupported_media_type");
  }

  const server = createServer((req, res) => { handle(req, res); });
  server.on("close", () => { closeAll(); });
  return { server, port, host, close: () => new Promise((resolve) => server.close(() => closeAll().then(resolve))) };
}

const unavailableProvider = { resolveDisplayData: async () => new Map() };

function customerRow(summary, contact) {
  return {
    id: summary.id,
    is_demo: summary.is_demo,
    vehicle_count: summary.vehicle_count,
    active_inquiries: summary.active_inquiries,
    active_orders: summary.active_orders,
    vehicles_label: summary.vehicles_label,
    displayName: contact?.displayName ?? null,
    phoneDisplay: contact?.phoneDisplay ?? null,
    email: contact?.email ?? null,
    tags: contact?.tags ?? [],
    contactStatus: contact ? "ok" : "pending_migration"
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, "Слишком большой запрос", "payload_too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "Ожидается JSON-объект", "bad_request");
  }
}

function schedule(conn, ctx) {
  const from = ctx.params.get("from");
  const days = Number(ctx.params.get("days") ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new HttpError(400, "days: от 1 до 31", "bad_request");
  let start = ctx.day.start;
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new HttpError(400, "from: дата ГГГГ-ММ-ДД", "bad_request");
    start = zonedDayRange(new Date(`${from}T12:00:00Z`), ctx.business.time_zone).start;
  }
  // Середина последнего дня периода устойчива к переходам на летнее время
  const endDay = zonedDayRange(new Date(Date.parse(start) + (days - 0.5) * 86_400_000), ctx.business.time_zone).end;
  const status = ctx.params.get("status");
  const statuses = status ? [oneOf(status, Object.keys(appointmentStatuses), "status")] : undefined;
  return { from: start, to: endDay, appointments: repo.listAppointments(conn, { from: start, to: endDay, statuses }) };
}

function dateFilter(value) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "Дата: ожидается существующий день YYYY-MM-DD", "bad_request");
  }
  return value;
}

function statusFilter(params, dictionary, groups) {
  const status = params.get("status");
  if (!status || status === "all") return {};
  if (groups[status]) return { statuses: groups[status] };
  return { status: oneOf(status, Object.keys(dictionary), "status") };
}

function oneOf(value, allowed, field) {
  if (value === null || value === undefined || value === "") return undefined;
  if (!allowed.includes(value)) throw new HttpError(400, `${field}: допустимо ${allowed.join(", ")}`, "bad_request");
  return value;
}

function activeFilter(value) {
  if (!value || value === "all") return undefined;
  if (value === "yes") return true;
  if (value === "no") return false;
  throw new HttpError(400, "active: yes, no или all", "bad_request");
}

function uuid(value) {
  if (!uuidPattern.test(value)) throw new HttpError(400, "Некорректный идентификатор", "bad_request");
  return value;
}

function found(value, label) {
  if (!value) throw new HttpError(404, `${label} не найден(а)`, "not_found");
  return value;
}

// Разделы панели по бизнес-профилю: отраслевые (автомобили, заказ-наряды) только в своём профиле
function profileModules() {
  const file = businessPath("business.json");
  let profile = null;
  try {
    profile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    profile = null;
  }
  return officeModules(profile);
}

function publicBusiness(business) {
  const { id, name, business_type, phone, email, city, address, time_zone, currency, demo_mode, booking_url, synced_at } = business;
  return { id, name, business_type, phone, email, city, address, time_zone, currency, demo_mode, booking_url, synced_at };
}

async function serveStatic(pathname, req, res) {
  const entry = staticFiles[pathname];
  if (!entry) throw new HttpError(404, "Не найдено", "not_found");
  const body = await readFile(path.join(publicDir, entry[0]));
  res.writeHead(200, { ...securityHeaders, "content-type": entry[1], "cache-control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : body);
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const portArg = process.argv.indexOf("--port");
  const port = Number(portArg === -1 ? process.env.FRONTSMITH_OFFICE_PORT ?? defaultOfficePort : process.argv[portArg + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Порт панели: целое число 1024–65535");
  if ([4173, 4174].includes(port)) throw new Error("Порты 4173/4174 заняты предпросмотром сайта и демонстрации");
  const { server } = createOfficeServer({ port });
  server.listen(port, host, () => {
    console.log(`Панель офиса Frontsmith: http://${host}:${port}`);
    console.log(`База: ${officeDbExists() ? officeDbPath() : `ещё не создана (${officeDbPath()})`}. Клиенты — через CRM Frontsmith (crmkit запускается автоматически)`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
}
