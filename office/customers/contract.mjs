// Customer Module Frontsmith: универсальный контракт CustomerProvider.
//
// Бизнес-модули (обращения, заказы, задачи, AI-операции) хранят и передают только
// client_id — `customers.id` офисной базы, стабильный UUID Frontsmith. Контактные
// данные (имя, телефон, email, заметки, теги) живут у провайдера: по умолчанию
// встроенный crmkit (CrmkitProvider), позже — адаптер CRM компании. Бизнес-модули
// не знают ни HTTP-путей провайдера, ни его токена, ни его идентификаторов.
//
//   searchCustomers(query, options)   → { kind: "phone" | "text", matches: Customer[], verdict }
//   getCustomer(clientId)             → Customer | null
//   createCustomer(input, options)    → { status: "created" | "existing" | "recovered", customer }
//   updateCustomer(clientId, input, options) → Customer
//   listCustomers(options)            → { items: Customer[], total }
//   resolveDisplayData(clientIds)     → Map<clientId, { displayName, phone } | { unavailable: true }>
//
// Customer — объект доверенного сервера и панели, в офисную SQLite не сохраняется:
//   { id, displayName, phone, phoneDisplay, email, notes, tags, isDemo, provider, version, createdAt, updatedAt }
export const CUSTOMER_PROVIDER_OPERATIONS = ["searchCustomers", "getCustomer", "createCustomer", "updateCustomer", "listCustomers", "resolveDisplayData"];

export function assertCustomerProvider(provider) {
  const missing = CUSTOMER_PROVIDER_OPERATIONS.filter((name) => typeof provider?.[name] !== "function");
  if (missing.length) throw new Error(`CustomerProvider без операций: ${missing.join(", ")}`);
  return provider;
}

const statuses = {
  invalid_input: 400,
  customer_not_found: 404,
  email_in_use: 409,
  phone_in_use: 409,
  version_conflict: 409,
  link_conflict: 409,
  contact_missing: 502,
  crm_unavailable: 503,
  crm_auth_failed: 503
};

// Текст ошибки не содержит контактных значений: его можно писать в журнал и отдавать браузеру.
// candidates — только client_id.
export class CustomerError extends Error {
  constructor(code, message, { candidates } = {}) {
    super(message);
    this.code = code;
    this.status = statuses[code] ?? 500;
    if (candidates) this.candidates = candidates;
  }
}

// Российские записи номера приводятся к +7XXXXXXXXXX: «+7 916 123-45-67», «8 916 123 45 67»,
// «+7(916)1234567», «89161234567», «9161234567». Иностранный номер — только с «+» и 8–15 цифрами.
// Нормализованный номер — тоже персональные данные: он не покидает слой CRM
export function normalizePhone(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const compact = text.replace(/[\s\-(). ]/g, "");
  if (!/^\+?\d+$/.test(compact)) throw new CustomerError("invalid_input", "Телефон: только цифры, пробелы, скобки, дефисы и «+»");
  const digits = compact.replace(/^\+/, "");
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) return `+7${digits.slice(1)}`;
  if (digits.length === 10 && !compact.startsWith("+")) return `+7${digits}`;
  if (compact.startsWith("+") && digits.length >= 8 && digits.length <= 15 && !digits.startsWith("7")) return `+${digits}`;
  throw new CustomerError("invalid_input", "Телефон: российский номер из 10–11 цифр или международный с «+»");
}

export function formatPhone(phone) {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone ?? "");
  return match ? `+7 ${match[1]} ${match[2]}-${match[3]}-${match[4]}` : phone ?? null;
}

// Запрос похож на номер: только цифры и знаки записи номера, не меньше 4 цифр
export function phoneQueryDigits(query) {
  const text = String(query ?? "").trim();
  if (!/^[\d\s\-().+ ]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.length === 11 && digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
}

export function normalizeEmail(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(text) || text.length > 254) throw new CustomerError("invalid_input", "Некорректный email клиента");
  return text;
}

const limits = { displayName: 200, notes: 4000, tag: 40, tags: 20 };

// partial — для updateCustomer: undefined не меняет поле, null или "" стирает
export function normalizeCustomerInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CustomerError("invalid_input", "Ожидается объект клиента");
  const allowed = ["displayName", "phone", "email", "notes", "tags"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new CustomerError("invalid_input", `Неизвестное поле клиента: ${key}`);
  const out = {};
  const text = (value, field, max) => {
    if (value === null) return null;
    if (typeof value !== "string") throw new CustomerError("invalid_input", `${field}: ожидается строка`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new CustomerError("invalid_input", `${field}: не длиннее ${max} символов`);
    return trimmed || null;
  };
  if (!partial || input.displayName !== undefined) {
    out.displayName = text(input.displayName ?? null, "Имя клиента", limits.displayName);
    if (!out.displayName) throw new CustomerError("invalid_input", "Не заполнено обязательное поле: имя клиента");
  }
  if (!partial || input.phone !== undefined) out.phone = input.phone === null ? null : normalizePhone(text(input.phone ?? null, "Телефон", 40));
  if (!partial || input.email !== undefined) out.email = normalizeEmail(text(input.email ?? null, "Email", 254));
  if (!partial || input.notes !== undefined) out.notes = text(input.notes ?? null, "Заметка", limits.notes);
  if (!partial || input.tags !== undefined) {
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.length > limits.tags) throw new CustomerError("invalid_input", `Теги: список до ${limits.tags} строк`);
    out.tags = [...new Set(tags.map((tag) => text(tag, "Тег", limits.tag)).filter(Boolean))];
  }
  return out;
}
