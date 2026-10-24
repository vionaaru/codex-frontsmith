// CLI офиса: инициализация, импорт, учебный набор, копии и узкие операции изменения.
// Изменения идут через прикладной слой office/lib — та же логика нужна будущим командам панели
import {
  assertHealthy,
  backupOfficeDb,
  listMigrations,
  migrate,
  officeDbExists,
  officeDbPath,
  openOfficeDb,
  restoreOfficeDb,
  schemaVersion
} from "../office/lib/db.mjs";
import { OfficeValidationError, parseInstant, parseQuantity, parseRubles } from "../office/lib/domain.mjs";
import { vocabularyFor } from "./lib/blueprints.mjs";
import { importCatalog, importDemoInquiryFile, readProfile, seedDemoData, syncBusinessProjection } from "../office/lib/import.mjs";
import { matchVehicleWithCustomers } from "../office/lib/matching.mjs";
import { connectCustomers } from "../office/customers/index.mjs";
import { CustomerError } from "../office/customers/contract.mjs";
import { registerWorkReport } from "../office/lib/work-reports.mjs";
import * as ops from "../office/lib/operations.mjs";
import { customerSummaries, getCustomer, getInquiry, getVehicle, getWorkOrder, listInquiries, listServices, listTasks, listWorkOrders, registerFunctions } from "../office/lib/repositories.mjs";

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

const commands = {
  init: { help: "создать или обновить базу (миграции) и проекцию профиля", run: init },
  import: { help: "импортировать каталог услуг и синтетическое обращение из файлов", run: importFiles },
  seed: { help: "добавить учебный набор клиентов, заказов, задач и записей", run: seed },
  status: { help: "путь, версия схемы и количество записей", run: status },
  statuses: { help: "словарь статусов и допустимых переходов", run: statuses },
  backup: { help: "согласованная копия через SQLite backup API [--to файл]", run: backup },
  restore: { help: "восстановить из копии: --from файл --confirm", run: restore },
  match: { help: "найти автомобиль для отчёта: [--vin VIN или последние 5+ символов] [--plate номер] [--phone телефон]", run: match },
  show: { help: "прочитать JSON: customer | vehicle | inquiry | order --id ID [--contacts — добавить контакты из CRM]", run: show },
  "report:register": { help: "один структурированный отчёт JSON через stdin [--dry-run]; поля описаны в office/README.md", run: async (c) => {
    let json = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) json += chunk;
    return registerWorkReport(c, JSON.parse(json.replace(/^\uFEFF/, '')), { dryRun: args['dry-run'] === true });
  } },
  list: { help: "список с ID: customers | inquiries | orders | tasks | services [--q текст] [--status s] [--contacts]", run: list },
  "customer:add": { help: "--name [--phone] [--email] [--note] [--shared-phone — номер уже есть у другого клиента]; контакты уходят в CRM", run: customerAdd },
  "customer:update": { help: "--id ID [--name] [--phone|none] [--email|none] [--note|none] [--version N] [--shared-phone]", run: customerUpdate },
  "vehicle:add": { help: "--customer ID --make [--model] [--year] [--mileage] [--vin] [--plate]", run: (c) => ops.addVehicle(c, { customerId: args.customer, make: args.make, model: args.model, year: args.year, mileageKm: args.mileage, vin: args.vin, plate: args.plate, note: args.note }) },
  "inquiry:add": { help: "--customer ID --source phone|website|walk_in|messenger|email|other --description [--vehicle ID] [--service код] [--assignee] [--external-id]", run: (c) => ops.createInquiry(c, { customerId: args.customer, vehicleId: args.vehicle, serviceCode: args.service, source: args.source, externalId: args["external-id"], description: args.description, assignee: args.assignee }) },
  "inquiry:status": { help: "--id ID --to in_progress|waiting_customer|closed [--note] [--revision N]", run: (c) => ops.setInquiryStatus(c, { id: args.id, status: args.to, note: args.note, revision: args.revision }) },
  "order:create": { help: "--inquiry ID | --customer ID --vehicle ID [--start \"ГГГГ-ММ-ДД ЧЧ:ММ\"] [--end ...] [--assignee] [--note]", run: (c, tz) => ops.createWorkOrder(c, { inquiryId: args.inquiry, customerId: args.customer, vehicleId: args.vehicle, plannedStartAt: time(args.start, "Начало", tz), plannedEndAt: time(args.end, "Окончание", tz), assignee: args.assignee, note: args.note }) },
  "order:item": { help: "--order ID --kind service --service код [--price руб] [--qty N] | --kind part --title текст --price руб [--qty N]", run: (c) => ops.addOrderItem(c, { workOrderId: args.order, kind: args.kind, serviceCode: args.service, title: args.title, unitPriceKopecks: args.price === undefined ? undefined : parseRubles(args.price, "Цена"), quantityMilli: parseQuantity(args.qty ?? "1") }) },
  "order:status": { help: "--id ID --to draft|awaiting_approval|in_progress|ready|completed|cancelled [--completed-at \"ГГГГ-ММ-ДД ЧЧ:ММ\"] [--note] [--revision N]", run: (c, tz) => ops.setWorkOrderStatus(c, { id: args.id, status: args.to, note: args.note, completedAt: time(args["completed-at"], "Дата завершения", tz), revision: args.revision }) },
  "order:cost": { help: "--id ID --decision approved|declined --basis \"кто, когда, как подтвердил\" [--total руб — только для заказа без позиций]", run: (c) => ops.decideOrderCost(c, { id: args.id, decision: args.decision, basis: args.basis, totalKopecks: args.total === undefined ? undefined : parseRubles(args.total, "Согласованная сумма"), revision: args.revision }) },
  "order:result": { help: "--id ID --basis \"откуда факты\" [--minutes N|none] [--total руб|none] [--completed-at \"ГГГГ-ММ-ДД ЧЧ:ММ\"]", run: (c, tz) => ops.recordWorkResult(c, { id: args.id, basis: args.basis, actualDurationMinutes: noneOr(args.minutes, (value) => value), finalTotalKopecks: noneOr(args.total, (value) => parseRubles(value, "Итоговая стоимость")), completedAt: args["completed-at"] === undefined ? undefined : time(args["completed-at"], "Дата завершения", tz, true), revision: args.revision }) },
  "appointment:add": { help: "--inquiry ID | --order ID --start \"ГГГГ-ММ-ДД ЧЧ:ММ\" --end ... --source phone|... [--note]", run: (c, tz) => ops.createAppointment(c, { inquiryId: args.inquiry, workOrderId: args.order, startsAt: time(args.start, "Начало", tz, true), endsAt: time(args.end, "Окончание", tz, true), source: args.source, externalId: args["external-id"], note: args.note }) },
  "appointment:status": { help: "--id ID --to confirmed|arrived|completed|no_show|cancelled [--basis] [--revision N]", run: (c) => ops.setAppointmentStatus(c, { id: args.id, status: args.to, basis: args.basis, revision: args.revision }) },
  "task:add": { help: "--title [--inquiry ID] [--order ID] [--due \"ГГГГ-ММ-ДД ЧЧ:ММ\"] [--assignee]", run: (c, tz) => ops.createTask(c, { inquiryId: args.inquiry, workOrderId: args.order, title: args.title, dueAt: time(args.due, "Срок", tz), assignee: args.assignee }) },
  "task:status": { help: "--id ID --to open|in_progress|done|cancelled [--revision N]", run: (c) => ops.setTaskStatus(c, { id: args.id, status: args.to, revision: args.revision }) },
  "service:price": { help: "--code код --price руб|none [--confirmed-by-owner] [--revision N]", run: (c) => ops.setServicePrice(c, { code: args.code, priceKopecks: args.price === "none" ? null : parseRubles(args.price, "Цена"), demoPrice: args["confirmed-by-owner"] ? false : undefined, revision: args.revision }) },
  "service:active": { help: "--code код --active yes|no", run: (c) => ops.setServiceActive(c, { code: args.code, active: yesNo(args.active), revision: args.revision }) }
};

try {
  if (!command || command === "help" || args.help) {
    printHelp();
  } else if (!commands[command]) {
    throw new OfficeValidationError(`Неизвестная команда: ${command}. Список: npm run office -- help`);
  } else if (["init", "import", "seed", "status", "statuses", "backup", "restore", "list", "match", "show", "customer:add", "customer:update"].includes(command)) {
    await commands[command].run();
  } else {
    await mutate(commands[command].run);
  }
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  if (error.code !== "OFFICE_VALIDATION" && error.code !== "OFFICE_DB_MISSING" && !String(error.code ?? "").startsWith("SQLITE_CONSTRAINT")) {
    console.error(error.stack);
  }
  process.exitCode = 1;
}

async function init() {
  const existed = officeDbExists();
  const profile = await readProfile();
  const db = openOfficeDb();
  try {
    const result = migrate(db);
    const sync = syncBusinessProjection(db, profile, { source: "migration", actor: "инициализация" });
    assertHealthy(db);
    console.log(`${existed ? "База офиса проверена" : "База офиса создана"}: ${officeDbPath()}`);
    console.log(`Миграции: ${result.applied.length ? `применены ${result.applied.join(", ")}` : "новых нет"}; версия схемы ${schemaVersion(db)}`);
    console.log(`Профиль: ${sync.changed.length ? `проекция обновлена (${sync.changed.join(", ")})` : "проекция совпадает с business.json"}`);
    console.log("Дальше: npm run office:import, при необходимости npm run office:seed");
  } finally {
    db.close();
  }
}

async function importFiles() {
  const db = openReady();
  try {
    const profile = await readProfile();
    const catalog = importCatalog(db, profile);
    const inquiry = await withCustomers(db, async (customers) => importDemoInquiryFile(db, { customers, vocabulary: await profileLabels() }));
    console.log(`Каталог: добавлено ${catalog.inserted.length}, уже в базе ${catalog.existing.length}`);
    for (const diff of catalog.differences) {
      console.log(`  ! ${diff.code}: в business.json другое значение (${diff.fields.join(", ")}). Источник истины — база; меняйте цену через service:price`);
    }
    const inquiryText = { inserted: "импортировано", existing: "уже в базе", missing: "файл не найден" }[inquiry.status];
    console.log(`Синтетическое обращение demo-inquiry.json: ${inquiryText}`);
    console.log("Markdown-черновики ответов и смет остаются файлами и не превращаются в заказы");
  } finally {
    db.close();
  }
}

async function seed() {
  const db = openReady();
  try {
    const result = await withCustomers(db, async (customers) => seedDemoData(db, { customers, vocabulary: await profileLabels() }));
    console.log(`Учебный набор: создано ${result.created.length ? result.created.join(", ") : "ничего"}; уже было ${result.skipped.length ? result.skipped.join(", ") : "ничего"}`);
    console.log("Все записи помечены is_demo = 1. Это не данные Booking Flow и не реальные клиенты");
  } finally {
    db.close();
  }
}

async function status() {
  if (!officeDbExists()) {
    console.log(`База офиса не создана: ${officeDbPath()}. Выполните npm run office:init`);
    return;
  }
  const db = openOfficeDb({ readonly: true });
  try {
    const version = schemaVersion(db);
    const latest = Math.max(...listMigrations().map((migration) => migration.version));
    console.log(`База: ${officeDbPath()}`);
    console.log(`Версия схемы: ${version}${version < latest ? ` (доступна ${latest}: выполните npm run office:init)` : ""}`);
    for (const table of ["services", "customers", "vehicles", "inquiries", "work_orders", "order_items", "appointments", "tasks", "activity_events"]) {
      const row = db.prepare(`SELECT count(*) AS n, ${table === "services" || table === "activity_events" ? "0" : "sum(is_demo)"} AS demo FROM ${table}`).get();
      console.log(`  ${table.padEnd(16)} ${String(row.n).padStart(4)}${row.demo ? `  (учебных ${row.demo})` : ""}`);
    }
    if (version >= 4) {
      const links = db.prepare("SELECT count(*) AS n FROM customer_provider_links").get().n;
      const legacy = db.prepare("SELECT count(*) AS n FROM legacy_customer_contacts").get().n;
      console.log(`  ${"crm links".padEnd(16)} ${String(links).padStart(4)}`);
      if (legacy) console.log(`  ! ${legacy} клиентов ждут переноса контактов в CRM: npm run crm:migrate-customers -- --dry-run`);
    }
  } finally {
    db.close();
  }
}

// Подписи статусов и категорий текущего бизнес-профиля; без профиля — нейтральные
async function profileLabels() {
  return vocabularyFor(await readProfile().catch(() => null));
}

async function statuses() {
  for (const [name, dictionary] of Object.entries(await profileLabels())) {
    console.log(`\n${name}`);
    for (const [key, value] of Object.entries(dictionary)) {
      const label = typeof value === "string" ? value : value.label;
      const transitions = typeof value === "object" && value.transitions ? ` → ${value.transitions.join(", ") || "—"}` : "";
      console.log(`  ${key.padEnd(18)} ${label}${transitions}`);
    }
  }
}

async function backup() {
  const target = await backupOfficeDb({ destination: args.to });
  console.log(`Копия создана и проверена (integrity_check, foreign_key_check): ${target}`);
}

async function restore() {
  if (!args.from) throw new OfficeValidationError("Укажите копию: --from путь");
  if (!args.confirm) throw new OfficeValidationError("Восстановление заменит текущую базу. Остановите панель и повторите с --confirm");
  try {
    const result = await restoreOfficeDb({ source: args.from });
    console.log(`База восстановлена из ${args.from}`);
    if (result.safetyCopy) console.log(`Прежнее состояние сохранено: ${result.safetyCopy}`);
  } catch (error) {
    if (["EBUSY", "EPERM"].includes(error.code)) throw new OfficeValidationError("Файл базы занят другим процессом. Остановите npm run office:serve и повторите");
    throw error;
  }
}

// Без --contacts вывод не содержит контактных данных: только client_id и бизнес-факты
async function list() {
  const kind = rest[0];
  const db = registerFunctions(openReady({ readonly: true }));
  try {
    const filters = { q: args.q, status: args.status };
    const withContacts = args.contacts === true;
    const label = (labels, id) => labels?.get(id)?.displayName ?? `клиент ${id.slice(0, 8)}`;
    const contactLabels = async (rows) => (withContacts ? withCustomers(db, (customers) => customers.resolveDisplayData(rows.map((row) => row.customer_id))) : null);
    const rows = {
      customers: async () => {
        const summaries = customerSummaries(db);
        if (!withContacts) return [...summaries.values()].map((r) => [r.id, r.vehicles_label ?? "—", r.is_demo ? "учебный" : ""]);
        return withCustomers(db, async (customers) => (await customers.listCustomers({ q: args.q })).items
          .map((c) => [c.id, c.displayName, c.phoneDisplay ?? "—", summaries.get(c.id)?.vehicles_label ?? "—", c.isDemo ? "учебный" : ""]));
      },
      inquiries: async () => {
        const found = listInquiries(db, filters);
        const labels = await contactLabels(found);
        return found.map((r) => [r.id, r.status, label(labels, r.customer_id), r.service_name ?? "—", r.description.slice(0, 50)]);
      },
      orders: async () => {
        const found = listWorkOrders(db, filters);
        const labels = await contactLabels(found);
        return found.map((r) => [r.id, r.number, r.status, label(labels, r.customer_id), `${(r.estimate_kopecks / 100).toFixed(2)} ${r.currency}`]);
      },
      tasks: async () => listTasks(db, filters).map((r) => [r.id, r.status, r.due_at ?? "без срока", r.title]),
      services: async () => listServices(db, filters).map((r) => [r.code, r.is_active ? "активна" : "скрыта", r.base_price_kopecks === null ? "цена уточняется" : `${(r.base_price_kopecks / 100).toFixed(2)} ${r.currency}`, r.name])
    }[kind];
    if (!rows) throw new OfficeValidationError("Укажите: list customers | inquiries | orders | tasks | services");
    const result = await rows();
    if (!result.length) console.log("Ничего не найдено");
    for (const row of result) console.log(row.join("  ·  "));
  } finally {
    db.close();
  }
}

// Вывод — client_id и автомобили, без контактов клиента
async function match() {
  const db = openReady({ readonly: true });
  try {
    const input = { vin: args.vin, plate: args.plate, phone: args.phone };
    const result = args.phone
      ? await withCustomers(db, (customers) => matchVehicleWithCustomers(db, customers, input))
      : await matchVehicleWithCustomers(db, null, input);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

async function show() {
  const db = openReady({ readonly: true });
  try {
    const read = { customer: getCustomer, vehicle: getVehicle, inquiry: getInquiry, order: getWorkOrder }[rest[0]];
    if (!read || typeof args.id !== "string") throw new OfficeValidationError("show customer|vehicle|inquiry|order --id ID [--contacts]");
    const result = read(db, args.id);
    if (!result) throw new OfficeValidationError("Запись не найдена");
    if (rest[0] === "customer" && args.contacts === true) result.contact = await withCustomers(db, (customers) => customers.getCustomer(args.id));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

async function customerAdd() {
  const db = openReady();
  try {
    const result = await withCustomers(db, (customers) => customers.createCustomer(
      { displayName: stringOrNull(args.name), phone: stringOrNull(args.phone), email: stringOrNull(args.email), notes: stringOrNull(args.note) },
      { allowSharedPhone: args["shared-phone"] === true, actor: actor(), source: "cli" }
    ));
    console.log(`Готово: ${command} (${result.status})`);
    console.log(JSON.stringify({ id: result.customer.id, provider: result.customer.provider }, null, 2));
  } finally {
    db.close();
  }
}

async function customerUpdate() {
  const db = openReady();
  try {
    const input = {};
    if (args.name !== undefined) input.displayName = stringOrNull(args.name);
    for (const [arg, field] of [["phone", "phone"], ["email", "email"], ["note", "notes"]]) {
      if (args[arg] !== undefined) input[field] = args[arg] === "none" ? null : stringOrNull(args[arg]);
    }
    const customer = await withCustomers(db, (customers) => customers.updateCustomer(args.id, input,
      { version: args.version, allowSharedPhone: args["shared-phone"] === true, actor: actor(), source: "cli" }));
    console.log(`Готово: ${command}`);
    console.log(JSON.stringify({ id: customer.id, changed: Object.keys(input) }, null, 2));
  } finally {
    db.close();
  }
}

// CustomerProvider на одну команду: crmkit переиспользуется или запускается на время команды
async function withCustomers(db, fn) {
  let connection;
  try {
    connection = await connectCustomers({ db });
  } catch (error) {
    throw new OfficeValidationError(error.message);
  }
  try {
    return await fn(connection.provider);
  } catch (error) {
    if (error instanceof CustomerError) {
      const ids = error.candidates?.map((id) => id ?? "контакт вне Frontsmith").join(", ");
      throw new OfficeValidationError(`${error.message}${ids ? `. Клиенты: ${ids}` : ""}`);
    }
    throw error;
  } finally {
    await connection.stop();
  }
}

function actor() {
  return args.actor ?? process.env.FRONTSMITH_ACTOR ?? "оператор";
}

function stringOrNull(value) {
  return value === undefined || value === true ? null : String(value);
}

async function mutate(run) {
  const db = openReady();
  try {
    const timeZone = db.prepare("SELECT time_zone FROM business WHERE singleton = 1").get()?.time_zone ?? "Europe/Moscow";
    const ctx = ops.createContext(db, { actor: args.actor ?? process.env.FRONTSMITH_ACTOR ?? "оператор", source: "cli", vocabulary: await profileLabels() });
    const result = await run(ctx, timeZone);
    console.log(`Готово: ${command}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

function openReady({ readonly = false } = {}) {
  if (!officeDbExists()) throw new OfficeValidationError(`База офиса не создана: ${officeDbPath()}. Выполните npm run office:init`);
  const db = openOfficeDb({ readonly });
  const latest = Math.max(...listMigrations().map((migration) => migration.version));
  if (schemaVersion(db) !== latest) {
    db.close();
    throw new OfficeValidationError("Схема базы устарела. Выполните npm run office:init");
  }
  return db;
}

function time(value, field, timeZone, isRequired = false) {
  if (value === undefined || value === true) {
    if (isRequired) throw new OfficeValidationError(`${field}: обязательное поле`);
    return null;
  }
  return parseInstant(value, field, timeZone);
}

function noneOr(value, parse) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  if (value === true) throw new OfficeValidationError("Параметру нужно значение или none");
  return parse(value);
}

function yesNo(value) {
  if (["yes", "да", "true", "1"].includes(String(value).toLowerCase())) return true;
  if (["no", "нет", "false", "0"].includes(String(value).toLowerCase())) return false;
  throw new OfficeValidationError("--active: yes или no");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function printHelp() {
  console.log("Офис Frontsmith: npm run office -- <команда> [параметры]\n");
  for (const [name, { help }] of Object.entries(commands)) console.log(`  ${name.padEnd(20)} ${help}`);
  console.log("\nОбщие параметры изменений: --actor \"Имя\" (или FRONTSMITH_ACTOR), --revision N для защиты от устаревших правок");
  console.log("Время: «ГГГГ-ММ-ДД ЧЧ:ММ» по часовому поясу бизнеса или ISO со смещением");
}
