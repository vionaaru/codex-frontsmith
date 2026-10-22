// Локальный сервер панели офиса: только чтение, только 127.0.0.1.
// Браузер получает JSON-представления; SQL, путь к базе и приватные файлы наружу не отдаются
import { createServer } from "node:http";
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

export function createOfficeServer({ port = defaultOfficePort, dbFile = officeDbPath(), now = () => new Date() } = {}) {
  let db = null;
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

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

  const routes = [
    ["/api/health", () => ({ ok: true, database: officeDbExists(dbFile) ? "present" : "missing" })],
    ["/api/meta", (conn, ctx) => ({ business: publicBusiness(ctx.business), vocabulary, schemaVersion: schemaVersion(conn), today: ctx.day })],
    ["/api/overview", (conn, ctx) => {
      const month = ctx.params.get("month") ?? ctx.day.date.slice(0, 7);
      if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Месяц: YYYY-MM", "bad_request");
      return repo.overview(conn, { now: ctx.now, dayStart: ctx.day.start, dayEnd: ctx.day.end, month });
    }],
    ["/api/customers", (conn, ctx) => repo.listCustomers(conn, { q: ctx.q })],
    [/^\/api\/customers\/([^/]+)$/, (conn, ctx, id) => found(repo.getCustomer(conn, uuid(id)), "Клиент")],
    [/^\/api\/vehicles\/([^/]+)$/, (conn, ctx, id) => found(repo.getVehicle(conn, uuid(id)), "Автомобиль")],
    ["/api/inquiries", (conn, ctx) => repo.listInquiries(conn, { q: ctx.q, ...statusFilter(ctx.params, inquiryStatuses, { active: ["new", "in_progress", "waiting_customer"] }) })],
    [/^\/api\/inquiries\/([^/]+)$/, (conn, ctx, id) => found(repo.getInquiry(conn, uuid(id)), "Обращение")],
    ["/api/orders", (conn, ctx) => {
      const from = dateFilter(ctx.params.get("from"));
      const to = dateFilter(ctx.params.get("to"));
      if (from && to && from > to) throw new HttpError(400, "Начало периода позже окончания", "bad_request");
      return repo.listWorkOrders(conn, { q: ctx.q, from, to,
        performed: oneOf(ctx.params.get("performed"), ["yes"], "performed") === "yes",
        ...statusFilter(ctx.params, workOrderStatuses, { active: ["draft", "awaiting_approval", "approved", "in_progress", "ready"] }) });
    }],
    [/^\/api\/orders\/([^/]+)$/, (conn, ctx, id) => found(repo.getWorkOrder(conn, uuid(id)), "Заказ")],
    ["/api/tasks", (conn, ctx) => repo.listTasks(conn, { q: ctx.q, due: oneOf(ctx.params.get("due"), ["overdue", "today", "later", "none"], "due"), now: ctx.now, dayEnd: ctx.day.end, ...statusFilter(ctx.params, taskStatuses, { open: ["open", "in_progress"] }) })],
    ["/api/services", (conn, ctx) => repo.listServices(conn, { q: ctx.q, active: activeFilter(ctx.params.get("active")), category: ctx.params.get("category") || undefined })],
    ["/api/schedule", (conn, ctx) => schedule(conn, ctx)],
    ["/api/events", (conn) => repo.listEvents(conn, { limit: 100 })]
  ];

  async function handle(req, res) {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? "").toLowerCase())) throw new HttpError(421, "Панель доступна только по адресу 127.0.0.1", "host_not_allowed");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("allow", "GET, HEAD");
        throw new HttpError(405, "Панель только читает данные. Изменения — через Codex и npm run office", "read_only");
      }
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (!url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, req, res);
      return sendJson(req, res, 200, await api(url));
    } catch (error) {
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
    const match = typeof route[0] === "string" ? [] : route[0].exec(url.pathname).slice(1).map(decodeURIComponent);
    const data = route[1](conn, ctx, ...match);
    return { data, meta: { generatedAt: ctx.now, timeZone: business.time_zone, demoMode: business.demo_mode === 1, currency: business.currency } };
  }

  const server = createServer((req, res) => { handle(req, res); });
  server.on("close", closeDb);
  return { server, port, host, close: () => new Promise((resolve) => server.close(() => resolve())) };
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
    console.log(`Только чтение. База: ${officeDbExists() ? officeDbPath() : `ещё не создана (${officeDbPath()})`}`);
  });
}
