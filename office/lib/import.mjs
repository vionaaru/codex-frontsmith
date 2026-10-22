// Явный идемпотентный импорт из файлов профиля и учебный набор.
// Повторный запуск ничего не удаляет, не перезаписывает и не дублирует
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { businessPath } from "../../scripts/lib/paths.mjs";
import { stableId, zonedDayRange } from "./domain.mjs";
import { insertEvent } from "./repositories.mjs";
import {
  addOrderItem,
  addVehicle,
  createAppointment,
  createContext,
  createCustomer,
  createInquiry,
  createTask,
  createWorkOrder,
  decideOrderCost,
  setAppointmentStatus,
  setInquiryStatus,
  setWorkOrderStatus
} from "./operations.mjs";

export async function readProfile() {
  const file = businessPath("business.json");
  if (!existsSync(file)) throw new Error(`Профиль бизнеса не найден: ${file}. Сначала выполните npm run bootstrap`);
  return JSON.parse(await readFile(file, "utf8"));
}

// Запись business — проекция business.json; редактировать профиль нужно в файле
export function syncBusinessProjection(db, profile, { source = "import", actor = "импорт профиля" } = {}) {
  const at = new Date().toISOString();
  const row = {
    id: stableId("business", "singleton"),
    name: String(profile.businessName ?? "").trim(),
    business_type: profile.businessType ?? null,
    phone: profile.contact?.phone ?? null,
    email: profile.contact?.email ?? null,
    city: profile.contact?.city ?? null,
    address: profile.contact?.address ?? null,
    time_zone: profile.timeZone || "Europe/Moscow",
    currency: profile.currency || "RUB",
    demo_mode: profile.demoMode ? 1 : 0,
    booking_url: profile.bookingUrl ?? null,
    profile_source: "business.json",
    synced_at: at,
    created_at: at,
    updated_at: at
  };
  new Intl.DateTimeFormat("ru-RU", { timeZone: row.time_zone });

  return db.transaction(() => {
    const current = db.prepare("SELECT * FROM business WHERE singleton = 1").get();
    const fields = ["name", "business_type", "phone", "email", "city", "address", "time_zone", "currency", "demo_mode", "booking_url"];
    const changed = current ? fields.filter((field) => current[field] !== row[field]) : fields;
    if (current && !changed.length) {
      db.prepare("UPDATE business SET synced_at = ? WHERE singleton = 1").run(at);
      return { changed: [] };
    }
    db.prepare(`INSERT INTO business (id, name, business_type, phone, email, city, address, time_zone, currency, demo_mode, booking_url, profile_source, synced_at, created_at, updated_at)
      VALUES (@id, @name, @business_type, @phone, @email, @city, @address, @time_zone, @currency, @demo_mode, @booking_url, @profile_source, @synced_at, @created_at, @updated_at)
      ON CONFLICT (singleton) DO UPDATE SET name = excluded.name, business_type = excluded.business_type, phone = excluded.phone, email = excluded.email,
        city = excluded.city, address = excluded.address, time_zone = excluded.time_zone, currency = excluded.currency, demo_mode = excluded.demo_mode,
        booking_url = excluded.booking_url, synced_at = excluded.synced_at, updated_at = excluded.updated_at`).run(row);
    insertEvent(db, {
      id: crypto.randomUUID(), occurred_at: at, entity_type: "business", entity_id: current?.id ?? row.id, action: current ? "profile_synced" : "created",
      actor, source, summary: current ? "Проекция профиля обновлена из business.json" : "Создана проекция профиля из business.json",
      details_json: JSON.stringify({ changed }), is_demo: row.demo_mode
    });
    return { changed };
  })();
}

export function importCatalog(db, profile) {
  const services = Array.isArray(profile.services) ? profile.services : [];
  const currency = profile.currency || "RUB";
  const demoPrice = profile.pricingPolicy?.ownerApprovedForLiveQuotes !== true;
  const at = new Date().toISOString();
  const result = { inserted: [], existing: [], differences: [] };

  db.transaction(() => {
    services.forEach((service, index) => {
      const code = String(service.id ?? "").trim();
      if (!/^[a-z0-9-]+$/.test(code)) throw new Error(`У услуги «${service.name}» нет стабильного кода id из латиницы, цифр и дефиса`);
      const price = typeof service.priceFrom === "number" && Number.isFinite(service.priceFrom) && service.priceFrom >= 0
        ? Math.round(service.priceFrom * 100) : null;
      const duration = Number.isInteger(service.durationMinutes) && service.durationMinutes > 0 ? service.durationMinutes : null;
      const existing = db.prepare("SELECT * FROM services WHERE code = ?").get(code);
      if (existing) {
        result.existing.push(code);
        const diff = [];
        if (existing.name !== service.name) diff.push("название");
        if (existing.base_price_kopecks !== price) diff.push("цена");
        if (existing.duration_minutes !== duration) diff.push("длительность");
        if (diff.length) result.differences.push({ code, fields: diff });
        return;
      }
      const id = stableId("service", code);
      db.prepare(`INSERT INTO services (id, code, name, description, category, base_price_kopecks, currency, duration_minutes, is_active, is_demo_price, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, code, String(service.name).trim(), service.description ?? null, service.category || "other",
        price, currency, duration, demoPrice ? 1 : 0, (index + 1) * 10, at, at);
      insertEvent(db, {
        id: crypto.randomUUID(), occurred_at: at, entity_type: "service", entity_id: id, action: "imported", actor: "импорт каталога", source: "import",
        summary: `Импортирована услуга «${service.name}» из business.json`, details_json: JSON.stringify({ code, priceKopecks: price, demoPrice }), is_demo: 0
      });
      result.inserted.push(code);
    });
  })();
  return result;
}

// Синтетическое обращение из customer-inquiries/demo-inquiry.json. Markdown-черновики остаются файлами
export async function importDemoInquiryFile(db) {
  const file = businessPath("customer-inquiries", "demo-inquiry.json");
  if (!existsSync(file)) return { status: "missing", file };
  const data = JSON.parse(await readFile(file, "utf8"));
  const externalId = String(data.id ?? "").trim();
  if (!externalId) throw new Error(`В ${file} нет поля id`);

  const existing = db.prepare("SELECT id FROM inquiries WHERE source = 'local_file' AND external_id = ?").get(externalId);
  if (existing) return { status: "existing", file, inquiryId: existing.id };

  const isDemo = data.demo === true;
  const ctx = createContext(db, { actor: "импорт файла", source: "import" });
  const ids = {
    customer: stableId("file-customer", externalId),
    vehicle: stableId("file-vehicle", externalId),
    inquiry: stableId("file-inquiry", externalId)
  };
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM customers WHERE id = ?").get(ids.customer)) {
      createCustomer(ctx, { id: ids.customer, fullName: data.customer?.name, email: data.customer?.email, phone: data.customer?.phone, note: data.note, isDemo });
    }
    const hasVehicle = Boolean(data.vehicle?.make);
    if (hasVehicle && !db.prepare("SELECT 1 FROM vehicles WHERE id = ?").get(ids.vehicle)) {
      addVehicle(ctx, { id: ids.vehicle, customerId: ids.customer, make: data.vehicle.make, model: data.vehicle.model, year: data.vehicle.year, mileageKm: data.vehicle.mileageKm, isDemo });
    }
    const serviceKnown = data.serviceId && db.prepare("SELECT 1 FROM services WHERE code = ?").get(data.serviceId);
    createInquiry(ctx, {
      id: ids.inquiry,
      customerId: ids.customer,
      vehicleId: hasVehicle ? ids.vehicle : null,
      serviceCode: serviceKnown ? data.serviceId : null,
      source: "local_file",
      externalId,
      description: data.symptoms || data.serviceName || "Описание не указано в файле",
      isDemo
    });
  })();
  return { status: "inserted", file, inquiryId: ids.inquiry };
}

// --- Учебный набор ---

const demoActor = "учебный набор";

export function seedDemoData(db, { now = new Date() } = {}) {
  const services = new Set(db.prepare("SELECT code FROM services").all().map((row) => row.code));
  const required = ["brake-pads", "oil-service", "air-conditioning", "tire-service", "suspension-diagnostics", "wheel-alignment", "computer-diagnostics"];
  const missing = required.filter((code) => !services.has(code));
  if (missing.length) throw new Error(`В каталоге нет услуг ${missing.join(", ")}. Сначала выполните npm run office:import`);

  const business = db.prepare("SELECT time_zone FROM business WHERE singleton = 1").get();
  if (!business) throw new Error("Нет проекции профиля бизнеса. Сначала выполните npm run office:init");

  const ctx = createContext(db, { actor: demoActor, source: "seed", now: () => now });
  const day = zonedDayRange(now, business.time_zone);
  const dayStart = Date.parse(day.start);
  const at = (dayOffset, hour, minute = 0) => new Date(dayStart + dayOffset * 86_400_000 + (hour * 60 + minute) * 60_000).toISOString();
  const ago = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const id = (key) => stableId("demo", key);
  const exists = (table, key) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id(key)));
  const result = { created: [], skipped: [] };

  const scenarios = [
    ["brakes", () => {
      customer("irina", "Демо-клиент Ирина", "+7 (000) 000-00-11");
      vehicle("irina-solaris", "irina", { make: "Hyundai", model: "Solaris", year: 2017, mileageKm: 128000, plate: "Х000ХХ 00" });
      inquiry("irina-brakes", "irina", "irina-solaris", "brake-pads", "phone", "Скрип при торможении спереди, усилился за последнюю неделю", 30);
      setInquiryStatus(ctx, { id: id("irina-brakes"), status: "in_progress" });
      createWorkOrder(ctx, { id: id("order-brakes"), number: "ДЕМО-0001", inquiryId: id("irina-brakes"), plannedStartAt: at(1, 10), plannedEndAt: at(1, 12), assignee: "Мастер Андрей" });
      addOrderItem(ctx, { workOrderId: id("order-brakes"), kind: "service", serviceCode: "brake-pads" });
      addOrderItem(ctx, { workOrderId: id("order-brakes"), kind: "part", title: "Колодки тормозные передние, комплект", unitPriceKopecks: 320000 });
      setWorkOrderStatus(ctx, { id: id("order-brakes"), status: "awaiting_approval" });
      decideOrderCost(ctx, { id: id("order-brakes"), decision: "approved", basis: "Учебный пример: клиент согласовал по телефону" });
      createAppointment(ctx, { id: id("appt-brakes"), workOrderId: id("order-brakes"), startsAt: at(1, 10), endsAt: at(1, 12), source: "phone" });
      setAppointmentStatus(ctx, { id: id("appt-brakes"), status: "confirmed", basis: "Учебный пример: клиент подтвердил время по телефону" });
      createTask(ctx, { id: id("task-brakes-parts"), workOrderId: id("order-brakes"), title: "Заказать колодки до вечера", dueAt: at(0, 17), assignee: "Администратор" });
    }],
    ["oil", () => {
      customer("sergey", "Демо-клиент Сергей", "+7 (000) 000-00-22");
      vehicle("sergey-camry", "sergey", { make: "Toyota", model: "Camry", year: 2019, mileageKm: 61200 });
      inquiry("sergey-oil", "sergey", "sergey-camry", "oil-service", "website", "Плановое ТО на 60 000 км: масло и фильтры", 50);
      createWorkOrder(ctx, { id: id("order-oil"), number: "ДЕМО-0002", inquiryId: id("sergey-oil"), plannedStartAt: at(0, 9), plannedEndAt: at(0, 11), assignee: "Мастер Илья" });
      addOrderItem(ctx, { workOrderId: id("order-oil"), kind: "service", serviceCode: "oil-service" });
      addOrderItem(ctx, { workOrderId: id("order-oil"), kind: "part", title: "Моторное масло 5W-30, литр", unitPriceKopecks: 95000, quantityMilli: 4500 });
      addOrderItem(ctx, { workOrderId: id("order-oil"), kind: "part", title: "Масляный фильтр", unitPriceKopecks: 78000 });
      setWorkOrderStatus(ctx, { id: id("order-oil"), status: "awaiting_approval" });
      decideOrderCost(ctx, { id: id("order-oil"), decision: "approved", basis: "Учебный пример: клиент согласовал при приёмке" });
      setWorkOrderStatus(ctx, { id: id("order-oil"), status: "in_progress" });
      createAppointment(ctx, { id: id("appt-oil"), workOrderId: id("order-oil"), startsAt: at(0, 9), endsAt: at(0, 11), source: "phone" });
      setAppointmentStatus(ctx, { id: id("appt-oil"), status: "confirmed", basis: "Учебный пример: подтверждено звонком накануне" });
      setAppointmentStatus(ctx, { id: id("appt-oil"), status: "arrived" });
      createTask(ctx, { id: id("task-oil-ready"), workOrderId: id("order-oil"), title: "Сообщить клиенту о готовности", dueAt: at(0, 18), assignee: "Администратор" });
    }],
    ["aircon", () => {
      customer("marina", "Демо-клиент Марина", null, "Предпочитает связь в мессенджере");
      vehicle("marina-polo", "marina", { make: "Volkswagen", model: "Polo", year: 2015 });
      inquiry("marina-ac", "marina", "marina-polo", "air-conditioning", "messenger", "Кондиционер почти не охлаждает салон", 70);
      setInquiryStatus(ctx, { id: id("marina-ac"), status: "waiting_customer", note: "Ждём удобное время визита" });
      createAppointment(ctx, { id: id("appt-ac"), inquiryId: id("marina-ac"), startsAt: at(2, 11), endsAt: at(2, 12), source: "messenger", note: "Время предложено, клиент ещё не подтвердил" });
      createTask(ctx, { id: id("task-ac-call"), inquiryId: id("marina-ac"), title: "Уточнить у клиента удобное время", dueAt: at(-1, 13), assignee: "Администратор" });
    }],
    ["tires", () => {
      customer("oleg", "Демо-клиент Олег", "+7 (000) 000-00-44");
      vehicle("oleg-vesta", "oleg", { make: "Lada", model: "Vesta", year: 2021, mileageKm: 34000 });
      inquiry("oleg-tires", "oleg", "oleg-vesta", "tire-service", "phone", "Сезонная смена шин, свои колёса на дисках", 3);
      setInquiryStatus(ctx, { id: id("oleg-tires"), status: "in_progress" });
      createTask(ctx, { id: id("task-tires-reply"), inquiryId: id("oleg-tires"), title: "Перезвонить и предложить время шиномонтажа", dueAt: at(0, 15), assignee: "Администратор" });
      inquiry("oleg-alignment", "oleg", "oleg-vesta", "wheel-alignment", "phone", "Спрашивал стоимость развал-схождения", 240);
      setInquiryStatus(ctx, { id: id("oleg-alignment"), status: "closed", note: "Клиент получил ориентир цены, запись не нужна" });
    }],
    ["suspension", () => {
      customer("pavel", "Демо-клиент Павел", "+7 (000) 000-00-55");
      vehicle("pavel-octavia", "pavel", { make: "Skoda", model: "Octavia", year: 2012, mileageKm: 214000 });
      createWorkOrder(ctx, { id: id("order-suspension"), number: "ДЕМО-0003", customerId: id("pavel"), vehicleId: id("pavel-octavia"), note: "Стук справа на неровностях", assignee: "Мастер Андрей" });
      addOrderItem(ctx, { workOrderId: id("order-suspension"), kind: "service", serviceCode: "suspension-diagnostics" });
      addOrderItem(ctx, { workOrderId: id("order-suspension"), kind: "service", serviceCode: "wheel-alignment" });
      setWorkOrderStatus(ctx, { id: id("order-suspension"), status: "awaiting_approval" });
      createTask(ctx, { id: id("task-suspension-approval"), workOrderId: id("order-suspension"), title: "Получить решение клиента по стоимости", dueAt: at(1, 11), assignee: "Администратор" });
    }]
  ];

  db.transaction(() => {
    for (const [key, build] of scenarios) {
      if (exists("customers", { brakes: "irina", oil: "sergey", aircon: "marina", tires: "oleg", suspension: "pavel" }[key])) {
        result.skipped.push(key);
        continue;
      }
      build();
      result.created.push(key);
    }
    const fileInquiry = db.prepare("SELECT id FROM inquiries WHERE source = 'local_file' AND is_demo = 1 ORDER BY created_at LIMIT 1").get();
    if (fileInquiry && !exists("tasks", "task-file-review")) {
      createTask(ctx, { id: id("task-file-review"), inquiryId: fileInquiry.id, title: "Проверить черновики ответа и сметы в customer-inquiries/ и estimates/", dueAt: at(0, 19), isDemo: true });
      result.created.push("file-review-task");
    }
  })();
  return result;

  function customer(key, fullName, phone, note) {
    createCustomer(ctx, { id: id(key), fullName, phone, note: note ?? "Учебная запись, не реальный клиент", isDemo: true });
  }
  function vehicle(key, customerKey, data) {
    addVehicle(ctx, { id: id(key), customerId: id(customerKey), ...data, isDemo: true });
  }
  function inquiry(key, customerKey, vehicleKey, serviceCode, source, description, hoursAgo) {
    createInquiry(ctx, { id: id(key), customerId: id(customerKey), vehicleId: id(vehicleKey), serviceCode, source, description, receivedAt: ago(hoursAgo), assignee: "Администратор", isDemo: true });
  }
}
