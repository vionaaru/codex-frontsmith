import { createHash, randomUUID } from "node:crypto";

// Машинные статусы совпадают с CHECK в миграции 001. Подписи — только для людей.
// Здесь нейтральные подписи универсального профиля; отраслевой профиль переопределяет их
// в blueprint.json → vocabulary (см. profileVocabulary). Идентификаторы не меняются

export const inquiryStatuses = {
  new: { label: "Новое", transitions: ["in_progress", "waiting_customer", "converted", "closed"] },
  in_progress: { label: "В работе", transitions: ["waiting_customer", "converted", "closed"] },
  waiting_customer: { label: "Ждёт клиента", transitions: ["in_progress", "converted", "closed"] },
  converted: { label: "Оформлено", transitions: [] },
  closed: { label: "Закрыто", transitions: ["in_progress"] }
};

export const workOrderStatuses = {
  draft: { label: "Черновик", transitions: ["awaiting_approval", "cancelled"] },
  awaiting_approval: { label: "Ждёт согласования", transitions: ["draft", "approved", "cancelled"] },
  approved: { label: "Согласован", transitions: ["in_progress", "cancelled"] },
  in_progress: { label: "В работе", transitions: ["ready", "cancelled"] },
  ready: { label: "Готов к выдаче", transitions: ["completed", "in_progress"] },
  completed: { label: "Выдан", transitions: [] },
  cancelled: { label: "Отменён", transitions: [] }
};

export const costApprovalStatuses = {
  not_requested: { label: "Не запрашивалось" },
  requested: { label: "Запрошено у клиента" },
  approved: { label: "Клиент согласовал" },
  declined: { label: "Клиент отказался" }
};

export const appointmentStatuses = {
  tentative: { label: "Предварительно", transitions: ["confirmed", "cancelled"] },
  confirmed: { label: "Подтверждена", transitions: ["arrived", "no_show", "cancelled"] },
  arrived: { label: "Клиент пришёл", transitions: ["completed"] },
  completed: { label: "Завершена", transitions: [] },
  no_show: { label: "Не пришёл", transitions: [] },
  cancelled: { label: "Отменена", transitions: [] }
};

export const taskStatuses = {
  open: { label: "Открыта", transitions: ["in_progress", "done", "cancelled"] },
  in_progress: { label: "Выполняется", transitions: ["open", "done", "cancelled"] },
  done: { label: "Сделано", transitions: ["open"] },
  cancelled: { label: "Отменена", transitions: ["open"] }
};

export const inquirySources = {
  phone: "Телефон",
  website: "Сайт",
  booking_flow: "Booking Flow",
  walk_in: "Личный визит",
  messenger: "Мессенджер",
  email: "Почта",
  local_file: "Локальный файл",
  demo_seed: "Учебный набор",
  other: "Другое"
};

export const appointmentSources = {
  phone: "Телефон",
  website: "Сайт",
  booking_flow: "Booking Flow",
  walk_in: "Личный визит",
  messenger: "Мессенджер",
  email: "Почта",
  demo_seed: "Учебный набор",
  other: "Другое"
};

export const activeInquiryStatuses = ["new", "in_progress", "waiting_customer"];
export const activeWorkOrderStatuses = ["draft", "awaiting_approval", "approved", "in_progress", "ready"];
export const openTaskStatuses = ["open", "in_progress"];
export const upcomingAppointmentStatuses = ["tentative", "confirmed", "arrived"];

// Категории услуг каталога: машинный ключ → подпись. Неизвестный ключ показывается как есть
export const serviceCategories = {
  consultation: "Консультация",
  service: "Услуги",
  project: "Проектные работы",
  support: "Сопровождение",
  other: "Другое"
};

export const vocabulary = {
  inquiry: inquiryStatuses,
  workOrder: workOrderStatuses,
  costApproval: costApprovalStatuses,
  appointment: appointmentStatuses,
  task: taskStatuses,
  inquirySources,
  appointmentSources,
  serviceCategories
};

// Словарь бизнес-профиля: нейтральная база + подписи из blueprint.json → vocabulary.
// Переопределяются только подписи существующих ключей статусов и источников; категории
// услуг профиль задаёт целиком. Переходы и машинные ключи не меняются
export function profileVocabulary(overrides = {}) {
  const result = {};
  for (const [name, dictionary] of Object.entries(vocabulary)) {
    const custom = overrides?.[name] ?? {};
    if (name === "serviceCategories") {
      result[name] = Object.keys(custom).length ? { ...custom } : { ...dictionary };
      continue;
    }
    result[name] = Object.fromEntries(Object.entries(dictionary).map(([key, value]) => {
      const label = typeof custom[key] === "string" ? custom[key] : null;
      if (typeof value === "string") return [key, label ?? value];
      return [key, { ...value, label: label ?? value.label }];
    }));
  }
  return result;
}

export class OfficeValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = "OFFICE_VALIDATION";
  }
}

export function assertTransition(dictionary, from, to, entityLabel) {
  if (!(to in dictionary)) {
    throw new OfficeValidationError(`Неизвестный статус «${to}» для ${entityLabel}. Допустимо: ${Object.keys(dictionary).join(", ")}`);
  }
  if (from === to) throw new OfficeValidationError(`${entityLabel}: статус уже «${dictionary[to].label}»`);
  if (!dictionary[from].transitions.includes(to)) {
    const allowed = dictionary[from].transitions.map((status) => status).join(", ") || "нет";
    throw new OfficeValidationError(`${entityLabel}: переход ${from} → ${to} не разрешён. Из «${dictionary[from].label}» можно: ${allowed}`);
  }
}

// Деньги: целые копейки. Ввод из CLI — строка рублей с не более чем двумя знаками
export function parseRubles(value, field = "сумма") {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new OfficeValidationError(`${field}: ожидается неотрицательная сумма в рублях, например 1500 или 1499.90`);
  }
  const [whole, fraction = ""] = text.split(".");
  const kopecks = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(kopecks)) throw new OfficeValidationError(`${field}: слишком большая сумма`);
  return kopecks;
}

export function parseQuantity(value) {
  const text = String(value ?? "1").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(text)) throw new OfficeValidationError("Количество: ожидается число до трёх знаков после запятой");
  const [whole, fraction = ""] = text.split(".");
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (milli <= 0) throw new OfficeValidationError("Количество должно быть больше нуля");
  return milli;
}

export function lineAmount(unitPriceKopecks, quantityMilli) {
  return Math.floor((unitPriceKopecks * quantityMilli + 500) / 1000);
}

export function rublesFromKopecks(kopecks) {
  return kopecks === null || kopecks === undefined ? null : kopecks / 100;
}

// Принимает «2026-10-14 10:00» в часовом поясе бизнеса или ISO с явным смещением
export function parseInstant(value, field, timeZone) {
  const text = String(value ?? "").trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
  if (local && timeZone) {
    const [, year, month, day, hour, minute] = local.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new OfficeValidationError(`${field}: некорректная дата`);
    return zonedTime(year, month, day, hour, minute, timeZone).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new OfficeValidationError(`${field}: укажите «ГГГГ-ММ-ДД ЧЧ:ММ» по времени бизнеса или ISO со смещением, например 2026-10-14T10:00+03:00`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new OfficeValidationError(`${field}: некорректная дата`);
  return date.toISOString();
}

// Ключи сопоставления. Правило госномера — также в генерируемой колонке миграции 002; тест сверяет их.
// Телефон нормализует CustomerProvider (office/customers/contract.mjs): в офисной базе его нет
const plateLetters = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" };

export function plateKey(value) {
  const text = String(value ?? "").replace(/[ \- ]/g, "")
    .replace(/[АВЕКМНОРСТУХавекмнорстух]/g, (letter) => plateLetters[letter.toUpperCase()]);
  // SQLite upper() меняет только ASCII
  return text ? text.replace(/[a-z]/g, (letter) => letter.toUpperCase()) : null;
}

export function vinKey(value) {
  const text = String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
  return text || null;
}

// Фактическая дата завершения: ISO UTC, не в будущем (допуск на расхождение часов — 5 минут)
export function assertCompletedAt(value, now) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new OfficeValidationError("Дата завершения: ожидается ISO 8601 UTC, например 2026-10-14T15:30:00.000Z");
  }
  if (Date.parse(text) > now.getTime() + 5 * 60_000) throw new OfficeValidationError("Дата завершения не может быть в будущем");
  return new Date(text).toISOString();
}

export function newId() {
  return randomUUID();
}

// Стабильный UUID (вариант v5) для импортируемых и учебных записей: повторный импорт находит ту же запись
export function stableId(namespace, key) {
  const bytes = createHash("sha1").update(`frontsmith-office:${namespace}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Границы календарного дня в часовом поясе бизнеса, результат в UTC
export function zonedDayRange(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const start = zonedTime(Number(parts.year), Number(parts.month), Number(parts.day), 0, 0, timeZone);
  const end = zonedTime(Number(parts.year), Number(parts.month), Number(parts.day) + 1, 0, 0, timeZone);
  return { start: start.toISOString(), end: end.toISOString(), date: `${parts.year}-${parts.month}-${parts.day}` };
}

// Локальное время timeZone → Date (UTC); устойчиво к переходам на летнее время
export function zonedTime(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = timeZoneOffsetMs(new Date(guess), timeZone);
  const candidate = new Date(guess - offset);
  const correction = timeZoneOffsetMs(candidate, timeZone) - offset;
  return new Date(candidate.getTime() - correction);
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
