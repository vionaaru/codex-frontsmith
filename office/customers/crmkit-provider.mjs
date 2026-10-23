// CrmkitProvider: CustomerProvider поверх HTTP API встроенного crmkit.
//
// Связь client_id ↔ контакт crmkit авторитетно хранится в customer_provider_links
// офисной базы. Дополнительно у контакта есть custom.frontsmith_client_id — технический
// UUID без персональных данных: по нему повторная операция находит уже созданный контакт
// и не создаёт дубль, если связь не успела сохраниться.
//
// Особенности crmkit v0.9.1, которые учитывает адаптер:
//  - POST /contacts с существующим email обновляет чужой контакт (upsert), поэтому
//    конфликт по email проверяется до создания, а ответ «обновлён» считается ошибкой;
//  - поиск ?search= не сворачивает регистр кириллицы, поэтому текстовый поиск
//    выполняется здесь по списку контактов Frontsmith;
//  - фильтр custom.* поддерживает eq и like, но не in.
import { CrmError } from "../../services/crm/client.mjs";
import { CustomerError, formatPhone, normalizeCustomerInput, phoneQueryDigits } from "./contract.mjs";
import { assertClientId, getIdentity, getLink, linksByExternalId, newClientId, recordContactUpdate, saveLink } from "./identity.mjs";

export const CRMKIT_PROVIDER = "crmkit";
const MARK = "frontsmith_client_id";

const fold = (value) => String(value ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const byName = (a, b) => a.displayName.localeCompare(b.displayName, "ru", { sensitivity: "base" }) || a.id.localeCompare(b.id);

export class CrmkitProvider {
  name = CRMKIT_PROVIDER;
  capabilities = { read: true, create: true, update: true, search: true, phoneSearch: true };
  #db;
  #client;
  #instance;
  #cache = null;
  #cacheTtlMs;
  #now;

  constructor({ db, client, workspaceId, cacheTtlMs = 3000, now = () => new Date() }) {
    if (!workspaceId) throw new Error("CrmkitProvider: не указана рабочая область crmkit");
    this.#db = db;
    this.#client = client;
    this.#instance = workspaceId;
    this.#cacheTtlMs = cacheTtlMs;
    this.#now = now;
  }

  get instance() {
    return this.#instance;
  }

  #scope() {
    return { provider: CRMKIT_PROVIDER, instance: this.#instance };
  }

  async #call(method, pathname, body, options) {
    try {
      return await this.#client.request(method, pathname, body, options);
    } catch (error) {
      if (!(error instanceof CrmError)) throw error;
      if (error.status === 401) throw new CustomerError("crm_auth_failed", "CRM не принял учётные данные Frontsmith: выполните npm run crm:bootstrap");
      if (error.status === 404) throw new CustomerError("contact_missing", "Контакт клиента не найден в CRM");
      if (error.status === 412) throw new CustomerError("version_conflict", "Контакт изменён параллельно. Обновите карточку и повторите");
      if (error.status === 409) throw new CustomerError("email_in_use", "В CRM уже несколько контактов с этим email");
      if (error.status === 403) throw new CustomerError("crm_unavailable", "CRM отказал: достигнут лимит записей");
      if (error.status === 400) throw new CustomerError("invalid_input", "CRM не принял данные клиента");
      throw new CustomerError("crm_unavailable", "CRM недоступен. Запустите панель или npm run crm:start");
    }
  }

  // Все контакты Frontsmith одной страницей кэша: краткоживущий кэш в памяти, не на диске
  async #contacts() {
    if (this.#cache && this.#cache.until > Date.now()) return this.#cache.list;
    const list = [];
    let cursor = "";
    do {
      const page = await this.#call("GET", `/contacts?custom.${MARK}=like:-&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      list.push(...(page.items ?? []));
      cursor = page.next_cursor ?? "";
    } while (cursor);
    this.#cache = { list, until: Date.now() + this.#cacheTtlMs };
    return list;
  }

  #invalidate() {
    this.#cache = null;
  }

  #customer(contact, link) {
    return {
      id: link.clientId,
      displayName: contact.name,
      phone: contact.phone || null,
      phoneDisplay: formatPhone(contact.phone || null),
      email: contact.email || null,
      notes: contact.notes || null,
      tags: contact.tags ?? [],
      isDemo: link.isDemo,
      provider: CRMKIT_PROVIDER,
      version: contact.version,
      createdAt: contact.created_at,
      updatedAt: contact.updated_at
    };
  }

  async listCustomers({ q, limit = 500 } = {}) {
    const links = linksByExternalId(this.#db, this.#scope());
    let items = (await this.#contacts()).filter((contact) => links.has(contact.id)).map((contact) => this.#customer(contact, links.get(contact.id)));
    if (q) items = matchQuery(items, q);
    items.sort(byName);
    return { items: items.slice(0, limit), total: items.length };
  }

  // 0, 1 или несколько совпадений. Выбор при неоднозначности — за оператором, не за адаптером
  async searchCustomers(query, { limit = 20 } = {}) {
    const text = String(query ?? "").trim();
    if (!text) throw new CustomerError("invalid_input", "Пустой поисковый запрос");
    const { items, total } = await this.listCustomers({ q: text, limit });
    return { kind: phoneQueryDigits(text) ? "phone" : "text", matches: items, total, verdict: total === 0 ? "none" : total === 1 ? "single" : "multiple" };
  }

  async getCustomer(clientId) {
    assertClientId(clientId);
    const identity = getIdentity(this.#db, clientId);
    if (!identity) return null;
    const link = getLink(this.#db, clientId, this.#scope());
    if (!link) throw new CustomerError("contact_missing", "Контакты клиента ещё не перенесены в CRM: npm run crm:migrate-customers");
    const contact = await this.#call("GET", `/contacts/${encodeURIComponent(link.external_id)}`);
    return this.#customer(contact, { clientId, isDemo: identity.is_demo === 1 });
  }

  async #marked(clientId) {
    const page = await this.#call("GET", `/contacts?custom.${MARK}=${encodeURIComponent(clientId)}&limit=5`);
    return page.items ?? [];
  }

  // Конфликты проверяются по всем контактам рабочей области, не только по контактам Frontsmith
  async #conflicts({ email, phone }, { excludeExternalId = null, allowSharedPhone = false } = {}) {
    const links = linksByExternalId(this.#db, this.#scope());
    const others = (contacts) => contacts.filter((contact) => contact.id !== excludeExternalId);
    const candidates = (contacts) => [...new Set(contacts.map((contact) => links.get(contact.id)?.clientId ?? null))];
    if (email) {
      const found = others((await this.#call("GET", `/contacts?search=${encodeURIComponent(email)}&limit=50`)).items ?? [])
        .filter((contact) => fold(contact.email) === email);
      if (found.length) throw new CustomerError("email_in_use", "Клиент с таким email уже есть", { candidates: candidates(found) });
    }
    if (phone && !allowSharedPhone) {
      const found = others((await this.#call("GET", `/contacts?phone=${encodeURIComponent(phone)}&limit=50`)).items ?? []);
      if (found.length) throw new CustomerError("phone_in_use", "Этот телефон уже указан у клиента. Номер не доказывает, что это тот же человек: откройте карточку или подтвердите создание", { candidates: candidates(found) });
    }
  }

  // clientId — ключ идемпотентности: повтор с тем же значением возвращает того же клиента.
  // adoptIdentity — только для переноса существующего клиента (crm:migrate-customers)
  async createCustomer(input, { clientId = newClientId(), isDemo = false, allowSharedPhone = false, adoptIdentity = false, actor, source } = {}) {
    assertClientId(clientId);
    const fields = normalizeCustomerInput(input);
    const scope = this.#scope();
    if (getLink(this.#db, clientId, scope)) return { status: "existing", customer: await this.getCustomer(clientId) };
    const identity = getIdentity(this.#db, clientId);
    if (identity && !adoptIdentity) throw new CustomerError("link_conflict", "client_id уже занят клиентом без контактов в CRM");
    const demo = identity ? identity.is_demo === 1 : isDemo;
    const link = (contact) => {
      saveLink(this.#db, { clientId, ...scope, externalId: contact.id, isDemo: demo, actor, source, now: this.#now() });
      this.#invalidate();
      return this.#customer(contact, { clientId, isDemo: demo });
    };

    // Контакт создан, а связь — нет: продолжить без второго контакта
    const marked = await this.#marked(clientId);
    if (marked.length > 1) throw new CustomerError("link_conflict", "В CRM несколько контактов с одним client_id Frontsmith");
    if (marked.length === 1) return { status: "recovered", customer: link(marked[0]) };

    await this.#conflicts(fields, { allowSharedPhone });
    const body = { name: fields.displayName, tags: fields.tags, custom: { [MARK]: clientId } };
    if (fields.phone) body.phone = fields.phone;
    if (fields.email) body.email = fields.email;
    if (fields.notes) body.notes = fields.notes;
    const created = await this.#call("POST", "/contacts", body);
    this.#invalidate();
    if (created.__status !== 201 || created.custom?.[MARK] !== clientId) {
      throw new CustomerError("link_conflict", "CRM объединил данные с существующим контактом вместо создания нового");
    }
    return { status: "created", customer: link(created) };
  }

  async updateCustomer(clientId, input, { version, allowSharedPhone = false, actor, source } = {}) {
    assertClientId(clientId);
    const fields = normalizeCustomerInput(input, { partial: true });
    const changed = Object.keys(fields);
    if (!changed.length) throw new CustomerError("invalid_input", "Нет изменений");
    if (!getIdentity(this.#db, clientId)) throw new CustomerError("customer_not_found", "Клиент не найден");
    const link = getLink(this.#db, clientId, this.#scope());
    if (!link) throw new CustomerError("contact_missing", "Контакты клиента ещё не перенесены в CRM: npm run crm:migrate-customers");
    const current = await this.#call("GET", `/contacts/${encodeURIComponent(link.external_id)}`);
    if (version !== undefined && version !== null && Number(version) !== current.version) {
      throw new CustomerError("version_conflict", "Контакт изменён параллельно. Обновите карточку и повторите");
    }
    await this.#conflicts({
      email: fields.email && fields.email !== fold(current.email) ? fields.email : null,
      phone: fields.phone && fields.phone !== current.phone ? fields.phone : null
    }, { excludeExternalId: link.external_id, allowSharedPhone });
    const body = { version: current.version };
    if ("displayName" in fields) body.name = fields.displayName;
    if ("phone" in fields) body.phone = fields.phone ?? "";
    if ("email" in fields) body.email = fields.email ?? "";
    if ("notes" in fields) body.notes = fields.notes ?? "";
    if ("tags" in fields) body.tags = fields.tags;
    const updated = await this.#call("PATCH", `/contacts/${encodeURIComponent(link.external_id)}`, body);
    this.#invalidate();
    recordContactUpdate(this.#db, { clientId, fields: changed, actor, source, now: this.#now() });
    const identity = getIdentity(this.#db, clientId);
    return this.#customer(updated, { clientId, isDemo: identity.is_demo === 1 });
  }

  // Подписи для бизнес-записей: только имя и телефон для показа. Недоступный CRM не
  // превращается в угаданное имя — вызывающий получает unavailable
  async resolveDisplayData(clientIds) {
    const wanted = [...new Set(clientIds.filter(Boolean))];
    const result = new Map();
    if (!wanted.length) return result;
    const links = linksByExternalId(this.#db, this.#scope());
    const byClient = new Map([...links].map(([externalId, link]) => [link.clientId, externalId]));
    const contacts = new Map((await this.#contacts()).map((contact) => [contact.id, contact]));
    for (const clientId of wanted) {
      const contact = contacts.get(byClient.get(clientId));
      result.set(clientId, contact ? { displayName: contact.name, phone: formatPhone(contact.phone || null) } : { unavailable: true });
    }
    return result;
  }

  // Для предварительной проверки переноса: конфликт email с контактами CRM без исключения
  async emailConflict(email) {
    try {
      await this.#conflicts({ email, phone: null });
      return null;
    } catch (error) {
      if (error instanceof CustomerError && error.code === "email_in_use") return error.candidates;
      throw error;
    }
  }

  // Для восстановления и переноса: контакт crmkit с отметкой client_id
  async findMarkedContact(clientId) {
    const marked = await this.#marked(assertClientId(clientId));
    if (marked.length > 1) throw new CustomerError("link_conflict", "В CRM несколько контактов с одним client_id Frontsmith");
    return marked[0] ?? null;
  }
}

function matchQuery(items, query) {
  const digits = phoneQueryDigits(query);
  if (digits) return items.filter((item) => item.phone && item.phone.replace(/\D/g, "").includes(digits));
  const needle = fold(query);
  return items.filter((item) => fold(item.displayName).includes(needle) || fold(item.email).includes(needle) || item.tags.some((tag) => fold(tag) === needle));
}
