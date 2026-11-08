// Панель офиса. Бизнес-данные — только чтение из локального GET API, обновление обычным polling.
// Карточки клиентов создаются и редактируются здесь: сервер передаёт их в CustomerProvider (CRM)
const POLL_MS = 20000;
const main = document.querySelector("#main");
const state = { meta: null, route: null, results: null, hasData: false, lastOk: null, seq: 0, loading: false };

// Категории услуг — из словаря бизнес-профиля (/api/meta → vocabulary.serviceCategories)
const categoryLabels = () => state.meta?.vocabulary?.serviceCategories ?? {};
const entityLabels = { business: "Профиль", customer: "Клиент", vehicle: "Автомобиль", service: "Услуга", inquiry: "Обращение", work_order: "Заказ", order_item: "Позиция", appointment: "Запись", task: "Задача", database: "База" };
const eventSources = { cli: "команда CLI", import: "импорт", seed: "учебный набор", migration: "инициализация", panel: "панель", ai_dispatcher: "AI-диспетчер сайта" };

// --- DOM ---

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const unknown = (text = "не указано") => el("span", { class: "unknown" }, text);
const valueOr = (value, text) => (value === null || value === undefined || value === "" ? unknown(text) : value);
const demoBadge = (row) => (row?.is_demo ? el("span", { class: "badge demo", title: "Учебная запись, не реальные данные" }, "учебная") : null);

function badge(kind, status) {
  const label = state.meta?.vocabulary?.[kind]?.[status];
  return el("span", { class: `badge s-${status}` }, typeof label === "string" ? label : label?.label ?? status);
}

function label(kind, key) {
  const value = state.meta?.vocabulary?.[kind]?.[key];
  return typeof value === "string" ? value : value?.label ?? key;
}

// --- Форматирование во времени бизнеса ---

const tz = () => state.meta?.business?.time_zone ?? "Europe/Moscow";
const currency = () => state.meta?.business?.currency ?? "RUB";

function fmt(iso, options) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: tz(), ...options }).format(new Date(iso));
}
const fmtDateTime = (iso) => fmt(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtTime = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso) => fmt(iso, { weekday: "long", day: "numeric", month: "long" });
const fmtDateKey = (iso) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
// Календарный день отчёта не является моментом времени в часовом поясе бизнеса
const fmtPerformedDay = (day) => day ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${day}T00:00:00Z`)) : null;

function money(kopecks, code = currency()) {
  if (kopecks === null || kopecks === undefined) return null;
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: code, minimumFractionDigits: kopecks % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(kopecks / 100);
}

function duration(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const hours = Math.floor(minutes / 60);
  return [hours ? `${hours} ч` : null, minutes % 60 ? `${minutes % 60} мин` : null].filter(Boolean).join(" ");
}

function quantity(milli) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(milli / 1000);
}

// Разделы бизнес-профиля из /api/meta. До первого ответа — все: прежнее поведение панели
const has = (module) => !state.meta?.modules || state.meta.modules.includes(module);
const bookingSynced = () => Boolean(state.meta?.business?.booking_url);
const text = (value) => (typeof value === "function" ? value() : value);

function vehicleName(row, prefix = "vehicle_") {
  const make = row[`${prefix}make`];
  if (!make) return null;
  return [make, row[`${prefix}model`], row[`${prefix}year`] ? `${row[`${prefix}year`]}` : null].filter(Boolean).join(" ");
}

function dueBadge(task) {
  if (!task.due_at) return el("span", { class: "badge" }, "без срока");
  const overdue = ["open", "in_progress"].includes(task.status) && Date.parse(task.due_at) < Date.now();
  return el("span", { class: `badge${overdue ? " overdue" : ""}` }, `${overdue ? "просрочено · " : ""}${fmtDateTime(task.due_at)}`);
}

// --- Маршрутизация ---

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "") || "overview";
  const [pathPart, query = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  return { name: parts[0] ?? "overview", id: parts[1] ?? null, params: new URLSearchParams(query) };
}

function setParam(key, value) {
  const route = state.route;
  if (value) route.params.set(key, value); else route.params.delete(key);
  const query = route.params.toString();
  history.replaceState(null, "", `#/${route.name}${route.id ? `/${route.id}` : ""}${query ? `?${query}` : ""}`);
  load();
}

const views = {
  dispatcher: { nav:'dispatcher',form:true,title:'AI-диспетчер',intro:'Подготовьте публичные сведения, сохраните черновик, проверьте и утвердите. Пустые разделы допустимы',endpoint:()=>'/api/dispatcher',render:renderDispatcher },
  overview: { nav: "overview", title: "Обзор офиса", intro: () => has("work-orders") ? "Выполненные работы за месяц, активные заказы и ближайшие действия" : "Активные обращения, задачи и ближайшие записи", endpoint: (p) => `/api/overview?${pick(p, ["month"])}`, render: renderOverview },
  customers: { nav: "customers", title: "Клиенты", intro: () => `Поиск по имени, телефону, email${has("vehicles") ? " или автомобилю" : ""}. Контакты хранятся в CRM Frontsmith`, controls: customerControls, endpoint: (p) => `/api/customers?${pick(p, ["q"])}`, render: renderCustomers },
  customer: { nav: "customers", endpoint: (p, id) => `/api/customers/${id}`, render: renderCustomer },
  "customer-new": { nav: "customers", form: true, title: "Новый клиент", intro: "Контакты сохраняются в CRM Frontsmith. В базе офиса остаётся только идентификатор клиента", render: () => customerForm(null) },
  customerEdit: { nav: "customers", form: true, endpoint: (p, id) => `/api/customers/${id}`, render: (c) => customerForm(c) },
  vehicle: { nav: "customers", module: "vehicles", endpoint: (p, id) => `/api/vehicles/${id}`, render: renderVehicle },
  work: { nav: "work", title: () => has("work-orders") ? "Обращения и заказы" : "Обращения", intro: () => has("work-orders") ? "Обращение — запрос клиента. Заказ работ — отдельная запись с позициями и согласованием стоимости" : "Запросы клиентов: статус, услуга, ответственный и следующие действия", controls: workControls, endpoint: workEndpoint, render: renderWork },
  results: { nav: "results", module: "work-results", title: "Выполненные работы", intro: "Ремонты по дню выполнения, итоговая стоимость и фактические трудозатраты", controls: resultControls, endpoint: (p) => `/api/orders?performed=yes&${pick(p, ["q", "from", "to", "status"])}`, render: renderResults },
  inquiry: { nav: "work", endpoint: (p, id) => `/api/inquiries/${id}`, render: renderInquiry },
  order: { nav: "work", module: "work-orders", endpoint: (p, id) => `/api/orders/${id}`, render: renderOrder },
  tasks: { nav: "tasks", title: "Задачи", intro: () => `Следующие действия по обращениям${has("work-orders") ? " и заказам" : ""}`, controls: taskControls, endpoint: (p) => `/api/tasks?${pick(p, ["q", "due"], { status: "open" })}`, render: renderTasks },
  services: { nav: "services", title: "Услуги и цены", intro: "Каталог из базы офиса. Сайт берёт прайс из этого же каталога при npm run update:website", controls: serviceControls, endpoint: (p) => `/api/services?${pick(p, ["q", "category", "active"])}`, render: renderServices },
  schedule: { nav: "schedule", title: "Расписание", intro: () => `Записи на время из локальной базы${bookingSynced() ? ". Внешний Booking Flow сюда не синхронизируется" : ""}. Предварительные записи с сайта подтверждаются или отклоняются здесь`, controls: scheduleControls, endpoint: (p) => `/api/schedule?${pick(p, ["from", "status"], { days: "7" })}`, render: renderSchedule },
  dialogs: { nav: "dialogs", title: "Диалоги", intro: "Разговоры посетителей сайта с AI-помощником. Сверху — те, где посетитель ждёт сотрудника", controls: dialogControls, endpoint: (p) => `/api/conversations?${pick(p, ["status"])}`, render: renderDialogs },
  // Страница диалога не перерисовывается общим обновлением: ответ сотрудника не теряется,
  // новые сообщения подгружает собственный опрос страницы
  dialog: { nav: "dialogs", form: true, endpoint: (p, id) => `/api/conversations/${id}`, render: renderDialog }
};
const detailRoutes = { customers: "customer", "customer-edit": "customerEdit", vehicles: "vehicle", inquiries: "inquiry", orders: "order", dialogs: "dialog" };

function pick(params, keys, defaults = {}) {
  const out = new URLSearchParams();
  for (const key of [...keys, ...Object.keys(defaults)]) {
    const value = params.get(key) ?? defaults[key];
    if (value) out.set(key, value);
  }
  return out.toString();
}

function resolveView(route) {
  const view = route.id && detailRoutes[route.name] ? views[detailRoutes[route.name]] : views[route.name] ?? null;
  // Раздел, которого нет в бизнес-профиле, не открывается и не запрашивает данные
  return view?.module && !has(view.module) ? null : view;
}

function setupRoute() {
  state.route = parseRoute();
  state.hasData = false;
  const view = resolveView(state.route);
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (view && link.dataset.nav === view.nav) { link.setAttribute("aria-current", "page"); link.scrollIntoView({ block: "nearest", inline: "nearest" }); } else link.removeAttribute("aria-current");
  }
  main.replaceChildren();
  if (!view) {
    main.append(errorState("Раздел не найден", "Проверьте адрес или вернитесь к обзору", el("a", { href: "#/overview" }, "Открыть обзор")));
    return;
  }
  if (view.title) {
    main.append(el("div", { class: "page-head" }, el("div", {}, el("h1", { tabindex: "-1" }, text(view.title))), view.intro ? el("p", {}, text(view.intro)) : null));
  }
  if (view.controls) main.append(view.controls(state.route.params));
  state.results = el("div", {}, el("p", { class: "loading" }, "Загрузка данных…"));
  main.append(state.results);
  load({ focus: true });
}

// --- Загрузка и polling ---

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch {
    throw Object.assign(new Error("Сервер панели недоступен. Проверьте, что запущен npm run office:serve"), { code: "offline" });
  }
  let body = null;
  try { body = await response.json(); } catch { /* тело не JSON */ }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `Ошибка ${response.status}`), { code: body?.error?.code ?? "http_error", status: response.status });
  return body;
}

async function load({ focus = false } = {}) {
  const route = state.route;
  const view = resolveView(route);
  if (!view) return;
  // Форма не перерисовывается при обновлении: введённое оператором не теряется
  if (view.form && state.hasData) return;
  const seq = ++state.seq;
  setSync("loading");
  try {
    const [meta, payload] = await Promise.all([fetchJson("/api/meta"), view.endpoint ? fetchJson(view.endpoint(route.params, route.id)) : { data: null, meta: {} }]);
    if (seq !== state.seq) return;
    state.meta = meta.data;
    applyMeta(meta.data, payload.meta);
    state.results.replaceChildren(view.render(payload.data, payload.meta));
    main.classList.remove("stale");
    state.hasData = true;
    state.lastOk = new Date();
    setSync("ok");
    if (focus) (main.querySelector("h1") ?? main).focus({ preventScroll: true });
  } catch (error) {
    if (seq !== state.seq) return;
    setSync("error", error);
    if (state.hasData) {
      main.classList.add("stale");
    } else {
      state.results.replaceChildren(failure(error));
    }
  }
}

function applyMeta(meta) {
  const business = meta.business;
  for (const node of document.querySelectorAll("[data-business-name]")) node.textContent = business?.name ?? "Офис";
  document.title = `${state.waiting ? `(${state.waiting}) ` : ""}${business?.name ?? "Офис"} · панель офиса`;
  document.querySelector("[data-demo-notice]").hidden = !business?.demo_mode;
  document.querySelector("[data-booking-notice]").hidden = !business?.booking_url;
  for (const link of document.querySelectorAll("[data-nav-module]")) link.hidden = !has(link.dataset.navModule);
  const work = document.querySelector('[data-nav="work"]');
  if (work) work.textContent = has("work-orders") ? "Обращения и заказы" : "Обращения";
}

function setSync(status, error) {
  const dot = document.querySelector("[data-sync-dot]");
  const text = document.querySelector("[data-sync-text]");
  const banner = document.querySelector("[data-sync-error]");
  const time = state.lastOk ? fmt(state.lastOk.toISOString(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  dot.className = `sync-dot ${status === "ok" ? "ok" : status === "error" ? "stale" : ""}`;
  const show = (prefix, value) => text.replaceChildren(el("span", { class: "sync-label" }, prefix), value);
  if (status === "loading") {
    if (!time) text.textContent = "Загрузка…";
    return;
  }
  if (status === "ok") {
    show("Обновлено ", time);
    banner.hidden = true;
    return;
  }
  if (time) show("Данные на ", `${time} · устарели`); else text.textContent = "Нет данных";
  banner.hidden = !state.hasData;
  banner.textContent = `Не удалось обновить данные: ${error.message}. ${state.hasData ? `Ниже показано последнее успешно загруженное состояние на ${time}` : ""}`;
}

function failure(error) {
  if (error.code === "database_missing") {
    return errorState("База офиса ещё не создана", "Панель не показывает нули вместо отсутствующих данных. Подготовьте офис:",
      el("pre", {}, el("code", {}, "npm run bootstrap\nnpm run frontsmith")), el("p", {}, "Учебный набор при необходимости: npm run office:seed"));
  }
  if (error.status === 404) return errorState("Запись не найдена", error.message, el("a", { href: "#/overview" }, "Вернуться к обзору"));
  return errorState("Не удалось загрузить данные", `${error.message}. Показатели не отображаются, пока данные недоступны`, el("button", { type: "button", class: "sync-button", onclick: () => load() }, "Повторить"));
}

function errorState(title, text, ...extra) {
  return el("section", { class: "error-state", role: "alert" }, el("h1", { tabindex: "-1" }, title), el("p", {}, text), extra);
}

// --- Общие блоки ---

function panel(title, items, empty, link) {
  return el("section", { class: "panel" },
    el("h2", {}, el("span", {}, title), link ? el("a", { href: link[0] }, link[1]) : null),
    items.length ? el("ul", { class: "rows" }, items.map((item) => el("li", {}, item))) : el("p", { class: "empty" }, empty));
}

function row({ href, title, side, sub }) {
  return el(href ? "a" : "div", { class: "row", href }, el("span", { class: "row-title" }, title), el("span", { class: "row-side" }, side), sub ? el("span", { class: "row-sub" }, sub) : null);
}

const taskRow = (task) => row({
  href: task.work_order_id ? `#/orders/${task.work_order_id}` : task.inquiry_id ? `#/inquiries/${task.inquiry_id}` : null,
  title: task.title,
  side: [demoBadge(task), dueBadge(task), badge("task", task.status)],
  sub: [task.work_order_number ? `Заказ ${task.work_order_number}` : task.inquiry_id ? "Обращение" : "Задача офиса", task.customer_name ? ` · ${task.customer_name}` : "", task.assignee ? ` · ${task.assignee}` : ""].join("")
});

const appointmentRow = (item) => row({
  href: item.work_order_id ? `#/orders/${item.work_order_id}` : `#/inquiries/${item.inquiry_id}`,
  title: `${fmtDateTime(item.starts_at)}–${fmtTime(item.ends_at)} · ${item.customer_name ?? "клиент не указан"}`,
  side: [demoBadge(item), badge("appointment", item.status)],
  sub: [item.vehicle_label, item.work_order_number ? `заказ ${item.work_order_number}` : "по обращению", label("appointmentSources", item.source),
    item.status === "tentative" ? "не подтверждена" : item.confirmation_basis ? `основание: ${item.confirmation_basis}` : null].filter(Boolean).join(" · ")
});

const inquiryRow = (item) => row({
  href: `#/inquiries/${item.id}`,
  title: `${item.customer_name}${item.service_name ? ` · ${item.service_name}` : ""}`,
  side: [demoBadge(item), badge("inquiry", item.status)],
  sub: `${item.description} · ${label("inquirySources", item.source)} · ${fmtDateTime(item.received_at)}`
});

const orderRow = (item) => row({
  href: `#/orders/${item.id}`,
  title: `${item.number} · ${item.customer_name}`,
  side: [demoBadge(item), badge("workOrder", item.status), el("strong", {}, money(item.final_total_kopecks ?? item.approved_total_kopecks ?? item.estimate_kopecks, item.currency))],
  sub: [vehicleName(item), item.vehicle_plate,
    item.performed_on ? `выполнено: ${fmtPerformedDay(item.performed_on)}` : item.planned_start_at ? `план: ${fmtDateTime(item.planned_start_at)}` : "дата не назначена",
    item.workReport?.works?.join("; "),
    item.performed_on ? duration(item.actual_duration_minutes) ?? item.workReport?.durationNote ?? "трудозатраты не записаны" : null,
    `согласование: ${label("costApproval", item.cost_approval).toLowerCase()}`].filter(Boolean).join(" · ")
});

const eventRow = (event) => row({
  title: event.summary,
  side: [demoBadge(event), el("span", {}, fmtDateTime(event.occurred_at))],
  sub: [...new Set([entityLabels[event.entity_type] ?? event.entity_type, event.actor, eventSources[event.source] ?? event.source])].join(" · ")
});

function facts(pairs) {
  return el("dl", { class: "facts" }, pairs.filter(Boolean).map(([term, value]) => el("div", {}, el("dt", {}, term), el("dd", {}, value))));
}

function detailHead(crumb, title, badges, sub) {
  return el("div", { class: "page-head" },
    el("div", {}, el("p", { class: "crumbs" }, el("a", { href: crumb[0] }, crumb[1])), el("h1", { tabindex: "-1" }, title)),
    el("div", { class: "row-side" }, badges), sub ? el("p", {}, sub) : null);
}

function searchField(params, placeholder) {
  let timer;
  return el("label", { class: "field" }, "Поиск",
    el("input", { type: "search", value: params.get("q") ?? "", placeholder, maxlength: "100", autocomplete: "off",
      oninput: (event) => { clearTimeout(timer); timer = setTimeout(() => setParam("q", event.target.value.trim()), 250); } }));
}

function selectField(text, key, params, options, fallback = "") {
  const current = params.get(key) ?? fallback;
  return el("label", { class: "field" }, text,
    el("select", { onchange: (event) => setParam(key, event.target.value) },
      options.map(([value, caption]) => el("option", { value, selected: value === current }, caption))));
}

function statusOptions(kind, groups) {
  return [...groups, ...Object.entries(state.meta?.vocabulary?.[kind] ?? {}).map(([key, value]) => [key, value.label])];
}

// --- Обзор ---

function renderOverview(data) {
  const c = data.counts;
  const estimate = data.activeOrdersEstimate;
  const orders = has("work-orders");
  const fragment = el("div");
  if (has("work-results")) fragment.append(renderMonthlyWork(data.monthlyWork));
  fragment.append(el("div", { class: "kpis" },
    kpi("Активные обращения", c.activeInquiries, "#/work?kind=inquiries&status=active", "новые, в работе, ждут клиента"),
    !orders ? null : kpi("Активные заказы", c.activeWorkOrders, "#/work?kind=orders&status=active", "от черновика до выдачи"),
    kpi("Просрочено задач", c.overdueTasks, "#/tasks?due=overdue", "срок прошёл", c.overdueTasks > 0),
    kpi("Задачи сегодня", c.todayTasks, "#/tasks?due=today", "до конца дня"),
    !orders ? null : kpi("Стоимость активных заказов", estimate.mixedCurrencies ? "разные валюты" : money(estimate.total, estimate.currency ?? currency()) ?? money(0), "#/work?kind=orders&status=active", "итог, согласованная сумма или оценка; оплаты не учитываются")));
  if (c.demoRecords > 0) {
    fragment.append(el("p", { class: "note" }, `В базе ${c.demoRecords} учебных и ${c.realRecords} рабочих записей клиентов, обращений, заказов, задач и записей на время`));
  }
  fragment.append(el("div", { class: "grid-2" },
    !has("work-results") ? null : panel("Последние выполненные работы", data.recentPerformedWork.map(orderRow), "Ремонтов с днём выполнения пока нет", ["#/results", "все"]),
    panel("Просроченные задачи", data.overdueTasks.map(taskRow), "Просроченных задач нет", ["#/tasks?due=overdue", "все"]),
    panel("Задачи на сегодня", data.todayTasks.map(taskRow), "На сегодня задач со сроком нет", ["#/tasks?due=today", "все"]),
    panel("Ближайшие записи", data.upcomingAppointments.map(appointmentRow), bookingSynced() ? "Ближайших записей нет. Booking Flow не синхронизируется: внешние записи здесь не видны" : "Ближайших записей нет", ["#/schedule", "расписание"]),
    panel("Последние события", data.recentEvents.map(eventRow), "Журнал пока пуст"),
    panel("Активные обращения", data.activeInquiries.map(inquiryRow), "Активных обращений нет", ["#/work?kind=inquiries&status=active", "все"]),
    !orders ? null : panel("Активные заказы", data.activeWorkOrders.map(orderRow), "Активных заказов нет", ["#/work?kind=orders&status=active", "все"])));
  return fragment;
}

function renderMonthlyWork(data) {
  const [year, month] = data.month.split("-").map(Number);
  const caption = capitalize(new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1))));
  const monthLink = (step, text) => {
    const date = new Date(Date.UTC(year, month - 1 + step, 1));
    const targetYear = date.getUTCFullYear();
    return el("a", { class: "month-button", href: targetYear >= 1000 && targetYear <= 9999 ? `#/overview?month=${date.toISOString().slice(0, 7)}` : null,
      "aria-label": text, "aria-disabled": targetYear < 1000 || targetYear > 9999 ? "true" : null }, step < 0 ? "←" : "→");
  };
  const amount = (value) => data.mixedCurrencies ? "Разные валюты" : value === null ? "Не указана" : money(value, data.currency);
  return el("section", { class: "monthly-dashboard", "aria-label": "Выполненные работы за месяц" },
    el("div", { class: "month-head" }, el("h2", {}, "Выполненные работы"),
      el("nav", { class: "month-nav", "aria-label": "Выбор месяца" }, monthLink(-1, "Предыдущий месяц"), el("strong", { "aria-live": "polite" }, caption), monthLink(1, "Следующий месяц"))),
    el("div", { class: "month-totals" },
      el("div", {}, el("span", {}, "Стоимость выполненных работ"), el("strong", {}, amount(data.totalKopecks))),
      el("div", {}, el("span", {}, "Выполнено ремонтов"), el("strong", {}, data.orders))),
    el("div", { class: "chart-legend" }, el("span", { class: "legend-cost" }, `Стоимость · ${data.currency}`), el("span", { class: "legend-count" }, "Количество ремонтов")),
    el("div", { class: "month-chart", tabindex: "0", role: "region", "aria-label": "График по дням месяца, доступна горизонтальная прокрутка" }, monthlyChart(data, caption)),
    data.orders === 0 ? el("p", { class: "note" }, "За этот месяц выполненных ремонтов пока нет") : null,
    data.mixedCurrencies ? el("p", { class: "note" }, "Стоимость в разных валютах не суммируется. На графике показано только количество ремонтов") : null,
    data.missingTotals ? el("p", { class: "note" }, `У ${data.missingTotals} ремонтов не указана итоговая стоимость. Сумма учитывает только известные итоги`) : null,
    el("p", { class: "note" }, "По дню выполнения · итоговая стоимость заказа · оплаты не учитываются"),
    el("details", { class: "chart-data" }, el("summary", {}, "Данные по дням"),
      el("div", { class: "table-wrap" }, el("table", {},
        el("caption", { class: "sr-only" }, `Выполненные ремонты · ${caption}`),
        el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "День"), el("th", { scope: "col", class: "num" }, "Ремонты"), el("th", { scope: "col", class: "num" }, "Стоимость"))),
        el("tbody", {}, data.days.map(day => el("tr", {},
          el("td", {}, el("a", { href: `#/results?from=${day.date}&to=${day.date}` }, fmtPerformedDay(day.date))),
          el("td", { class: "num" }, day.orders),
          el("td", { class: "num" }, amount(day.totalKopecks), day.missingTotals ? el("div", { class: "note" }, `Без суммы: ${day.missingTotals}`) : null))))))));
}

function monthlyChart(data, caption) {
  const svg = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  };
  const width = 1120, height = 310, left = 90, right = 54, top = 32, bottom = 38;
  const plotHeight = height - top - bottom;
  const step = (width - left - right) / data.days.length;
  const maxTotal = Math.max(10000, ...data.days.map(day => day.totalKopecks ?? 0));
  const unit = 10 ** Math.floor(Math.log10(maxTotal / 4));
  const costScale = Math.ceil(maxTotal / (4 * unit)) * 4 * unit;
  const countScale = Math.max(4, Math.ceil(Math.max(...data.days.map(day => day.orders)) / 4) * 4);
  const x = (index) => left + step * (index + 0.5);
  const y = (value, scale) => top + plotHeight * (1 - value / scale);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Стоимость и количество выполненных ремонтов по дням · ${caption}` },
    svg("title", {}, `Выполненные работы · ${caption}`),
    svg("desc", {}, "Столбцы — стоимость по левой шкале, линия — количество по правой. Точные значения доступны в таблице «Данные по дням»"));
  const compactMoney = (value) => new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value / 100);
  for (let tick = 0; tick <= 4; tick++) {
    const level = y(tick, 4);
    root.append(svg("line", { x1: left, x2: width - right, y1: level, y2: level, class: "chart-grid" }),
      svg("text", { x: left - 12, y: level + 4, "text-anchor": "end", class: "chart-axis" }, data.mixedCurrencies ? "—" : compactMoney(costScale * tick / 4)),
      svg("text", { x: width - right + 12, y: level + 4, class: "chart-axis" }, countScale * tick / 4));
  }
  root.append(svg("text", { x: left, y: 16, class: "chart-axis" }, data.currency), svg("text", { x: width - right, y: 16, "text-anchor": "end", class: "chart-axis" }, "ремонты"));
  data.days.forEach((day, index) => {
    const value = day.totalKopecks;
    if (value !== null && value > 0) root.append(svg("rect", { x: x(index) - step * 0.28, y: y(value, costScale), width: step * 0.56, height: plotHeight * value / costScale, class: "chart-bar" },
      svg("title", {}, `${fmtPerformedDay(day.date)}: ${money(value, data.currency)}${day.missingTotals ? " · есть ремонты без суммы" : ""}`)));
    root.append(svg("text", { x: x(index), y: height - 13, "text-anchor": "middle", class: "chart-axis" }, index + 1));
  });
  root.append(svg("polyline", { points: data.days.map((day, index) => `${x(index)},${y(day.orders, countScale)}`).join(" "), class: "chart-count-line" }));
  data.days.forEach((day, index) => root.append(svg("circle", { cx: x(index), cy: y(day.orders, countScale), r: 3.5, class: "chart-count-dot" },
    svg("title", {}, `${fmtPerformedDay(day.date)}: ремонтов — ${day.orders}; стоимость — ${data.mixedCurrencies ? "разные валюты" : day.totalKopecks === null ? "не указана" : money(day.totalKopecks, data.currency)}`))));
  return root;
}

function kpi(title, value, href, hint, alert = false) {
  return el("a", { class: `kpi${alert ? " alert" : ""}`, href }, el("span", {}, title), el("strong", {}, value), el("small", {}, hint));
}

// --- Клиенты и автомобили ---

function customerControls(params) {
  return el("div", { class: "filters" }, searchField(params, has("vehicles") ? "Имя, телефон, email, авто" : "Имя, телефон, email"),
    el("a", { class: "primary-button", href: "#/customer-new" }, "Новый клиент"));
}

const contactStatusText = {
  pending_migration: "контакты ещё не перенесены в CRM",
  unavailable: "CRM недоступен",
  missing: "контакт не найден в CRM"
};

const customerTitle = (c) => c.displayName ?? el("span", { class: "unknown" }, `Клиент ${c.id.slice(0, 8)} · ${contactStatusText[c.contactStatus] ?? "без контактов"}`);

function renderCustomers(rows) {
  if (!rows.length) return el("p", { class: "empty panel" }, state.route.params.get("q") ? "По запросу никого не найдено" : "Клиентов пока нет. Нажмите «Новый клиент»");
  return el("div", { class: "table-wrap" }, el("table", { class: "stack" },
    el("thead", {}, el("tr", {}, el("th", {}, "Клиент"), el("th", {}, "Телефон"), has("vehicles") ? el("th", {}, "Автомобили") : null, el("th", { class: "num" }, "Активно"))),
    el("tbody", {}, rows.map((c) => el("tr", {},
      el("td", { class: "wide" }, el("a", { href: `#/customers/${c.id}` }, el("strong", {}, customerTitle(c))), " ", demoBadge(c)),
      el("td", { "data-label": "Телефон" }, valueOr(c.phoneDisplay)),
      has("vehicles") ? el("td", { "data-label": "Авто", class: "wide" }, valueOr(c.vehicles_label, "нет автомобилей")) : null,
      el("td", { class: "num", "data-label": "Активно" }, has("work-orders") ? `${c.active_inquiries} обр. · ${c.active_orders} зак.` : `${c.active_inquiries} обр.`))))));
}

// Карточка: контакты из CRM и бизнес-данные офиса по одному client_id
function renderCustomer(c) {
  const contact = c.contact;
  const contactBlock = contact
    ? el("section", { class: "card" },
      facts([["Телефон", valueOr(contact.phoneDisplay)], ["Email", valueOr(contact.email)], ["Заметка", valueOr(contact.notes, "нет")],
        ["Теги", contact.tags.length ? contact.tags.join(", ") : unknown("нет")], ["Добавлен", fmtDateTime(c.created_at)],
        ["Хранение", `CRM Frontsmith (${contact.provider}) · client_id ${c.id}`]]),
      el("p", { class: "card-actions" }, el("a", { class: "primary-button", href: `#/customer-edit/${c.id}` }, "Изменить контакты")))
    : el("section", { class: "card" }, el("p", { class: "notice-inline" }, c.contactStatus === "pending_migration"
      ? ["Контакты клиента ещё в прежней базе офиса. Перенос в CRM: ", el("code", {}, "npm run crm:migrate-customers -- --dry-run")]
      : `Контакты недоступны: ${contactStatusText[c.contactStatus] ?? "CRM не ответил"}. Бизнес-данные ниже показаны по client_id ${c.id}`));
  return el("div", {},
    detailHead(["#/customers", "Клиенты"], contact?.displayName ?? `Клиент ${c.id.slice(0, 8)}`, demoBadge(c)),
    contactBlock,
    has("vehicles") ? el("h2", { class: "section-title" }, "Автомобили") : null,
    !has("vehicles") ? null : panel("Автомобили клиента", c.vehicles.map((v) => row({ href: `#/vehicles/${v.id}`, title: [v.make, v.model, v.year].filter(Boolean).join(" "), side: demoBadge(v), sub: [v.plate ? `номер ${v.plate}` : "номер не указан", v.mileage_km !== null ? `пробег ${v.mileage_km.toLocaleString("ru-RU")} км` : "пробег не указан"].join(" · ") })), "Автомобилей нет"),
    el("div", { class: "grid-2" },
      panel("Обращения", c.inquiries.map(inquiryRow), "Обращений нет"),
      has("work-orders") ? panel("Заказы работ", c.workOrders.map(orderRow), "Заказов нет") : null),
    el("h2", { class: "section-title" }, "Журнал"),
    panel("События клиента", c.events.map(eventRow), "Событий нет"));
}

function renderVehicle(v) {
  return el("div", {},
    detailHead([`#/customers/${v.customer_id}`, v.customer_name], [v.make, v.model, v.year].filter(Boolean).join(" "), demoBadge(v)),
    el("section", { class: "card" }, facts([
      ["Владелец", el("a", { href: `#/customers/${v.customer_id}` }, v.customer_name)],
      ["Марка и модель", [v.make, v.model].filter(Boolean).join(" ")],
      ["Год", valueOr(v.year)],
      ["Пробег", v.mileage_km === null ? unknown() : `${v.mileage_km.toLocaleString("ru-RU")} км`],
      ["Госномер", valueOr(v.plate)],
      ["VIN", valueOr(v.vin)]])),
    el("div", { class: "grid-2" },
      panel("Обращения по автомобилю", v.inquiries.map(inquiryRow), "Обращений нет"),
      panel("Заказы по автомобилю", v.workOrders.map(orderRow), "Заказов нет")));
}

// Форма клиента. requestId создаётся один раз на форму: повторная отправка не создаёт дубль
function customerForm(customer) {
  const requestId = crypto.randomUUID();
  const contact = customer?.contact ?? null;
  if (customer && !contact) {
    return errorState("Контакты недоступны", "Редактирование возможно только для клиента, контакты которого уже в CRM", el("a", { href: `#/customers/${customer.id}` }, "Вернуться к карточке"));
  }
  const field = (labelText, attrs) => el("label", { class: "field" }, labelText, attrs.rows ? el("textarea", attrs) : el("input", attrs));
  const message = el("div", { class: "form-message", role: "alert", hidden: true });
  const shared = el("label", { class: "check", hidden: true }, el("input", { type: "checkbox", name: "allowSharedPhone" }), "Это другой человек с тем же номером: сохранить");
  const submit = el("button", { type: "submit", class: "primary-button" }, customer ? "Сохранить" : "Создать клиента");
  const form = el("form", { class: "customer-form panel-body", novalidate: true },
    field("Имя *", { name: "displayName", required: true, maxlength: "200", autocomplete: "off", value: contact?.displayName ?? "" }),
    field("Телефон", { name: "phone", type: "tel", maxlength: "40", autocomplete: "off", placeholder: "+7 916 123-45-67", value: contact?.phoneDisplay ?? "" }),
    field("Email", { name: "email", type: "email", maxlength: "254", autocomplete: "off", value: contact?.email ?? "" }),
    field("Заметка", { name: "notes", rows: "4", maxlength: "4000" }),
    field("Теги через запятую", { name: "tags", maxlength: "400", autocomplete: "off", value: contact?.tags?.join(", ") ?? "" }),
    shared, message,
    el("p", { class: "card-actions" }, submit, el("a", { href: customer ? `#/customers/${customer.id}` : "#/customers" }, "Отмена")));
  form.elements.notes.value = contact?.notes ?? "";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const value = (name) => String(data.get(name) ?? "").trim() || null;
    const body = { displayName: value("displayName"), phone: value("phone"), email: value("email"), notes: value("notes"),
      tags: String(data.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean), allowSharedPhone: data.get("allowSharedPhone") === "on" };
    if (customer) body.version = contact.version; else body.requestId = requestId;
    submit.disabled = true;
    message.hidden = true;
    try {
      const response = await fetch(customer ? `/api/customers/${customer.id}` : "/api/customers", {
        method: customer ? "PATCH" : "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-frontsmith-office": "1" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = payload?.error ?? { message: `Ошибка ${response.status}` };
        message.replaceChildren(el("strong", {}, error.message),
          error.candidates?.length ? el("span", {}, " Карточки: ", error.candidates.map((id, index) => [index ? ", " : "", id ? el("a", { href: `#/customers/${id}` }, id.slice(0, 8)) : "контакт вне Frontsmith"])) : null);
        message.hidden = false;
        if (error.code === "phone_in_use") shared.hidden = false;
        return;
      }
      location.hash = `#/customers/${payload.data.customer.id}`;
    } catch {
      message.replaceChildren(el("strong", {}, "Сервер панели недоступен. Данные формы сохранены на странице, повторите отправку"));
      message.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return el("div", {},
    customer ? detailHead([`#/customers/${customer.id}`, contact.displayName], "Изменить контакты") : null,
    el("section", { class: "panel" }, form));
}

// --- Обращения и заказы ---

function workKind(params) {
  return params.get("kind") === "orders" && has("work-orders") ? "orders" : "inquiries";
}

function workEndpoint(params) {
  return `/api/${workKind(params)}?${pick(params, ["q"], { status: "active" })}`;
}

function workControls(params) {
  const kind = workKind(params);
  const link = (value, caption) => el("a", { href: `#/work?kind=${value}`, "aria-current": kind === value ? "page" : null }, caption);
  const statuses = kind === "orders" ? statusOptions("workOrder", [["active", "Активные"], ["all", "Все"]]) : statusOptions("inquiry", [["active", "Активные"], ["all", "Все"]]);
  return el("div", { class: "filters" },
    has("work-orders") ? el("nav", { class: "segmented", "aria-label": "Тип записей" }, link("inquiries", "Обращения"), link("orders", "Заказы работ")) : null,
    selectField("Статус", "status", params, statuses, "active"),
    searchField(params, kind === "orders" ? "Номер, клиент, авто" : "Клиент, услуга, описание"));
}

function renderWork(rows) {
  const kind = workKind(state.route.params);
  const filtered = state.route.params.get("q") || !["active", null].includes(state.route.params.get("status"));
  const empty = filtered ? "Под фильтр ничего не попало" : kind === "orders" ? "Активных заказов нет" : "Активных обращений нет";
  return panel(kind === "orders" ? `Заказы работ: ${rows.length}` : `Обращения: ${rows.length}`, rows.map(kind === "orders" ? orderRow : inquiryRow), empty);
}

function resultControls(params) {
  const dateField = (caption, key) => el("label", { class: "field" }, caption,
    el("input", { type: "date", value: params.get(key) ?? "", onchange: (event) => setParam(key, event.target.value) }));
  return el("div", { class: "filters" }, dateField("Выполнено с", "from"), dateField("По", "to"),
    selectField("Выдача", "status", params, [["", "Все"], ["ready", "Готов к выдаче"], ["completed", "Выдан"]]),
    searchField(params, "Работа, клиент, авто, номер"));
}

function renderResults(rows) {
  return el("div", {},
    panel(`Выполненные ремонты: ${rows.length}`, rows.map(orderRow), "За выбранный период и по условиям поиска ремонтов нет"),
    el("p", { class: "note" }, "Показано до 200 ремонтов, сначала последние по дню выполнения. Для более ранних работ задайте период. День выполнения и выдача автомобиля учитываются отдельно. Итоговая стоимость не означает оплату"));
}

function renderInquiry(i) {
  return el("div", {},
    detailHead(["#/work?kind=inquiries", "Обращения"], `Обращение · ${i.customer_name}`, [demoBadge(i), badge("inquiry", i.status)]),
    el("section", { class: "card" },
      el("p", {}, i.description),
      facts([
        ["Клиент", el("a", { href: `#/customers/${i.customer_id}` }, i.customer_name)],
        !has("vehicles") ? null : ["Автомобиль", i.vehicle_id ? el("a", { href: `#/vehicles/${i.vehicle_id}` }, vehicleName(i)) : unknown()],
        ["Услуга", valueOr(i.service_name, "не выбрана")],
        ["Источник", label("inquirySources", i.source)],
        i.external_id ? ["Внешний ID", i.external_id] : null,
        ["Ответственный", valueOr(i.assignee, "не назначен")],
        ["Получено", fmtDateTime(i.received_at)],
        i.closed_at ? ["Закрыто", fmtDateTime(i.closed_at)] : null])),
    el("div", { class: "grid-2" },
      !has("work-orders") ? null : panel("Заказы из обращения", i.workOrders.map((o) => orderRow({ ...o, customer_name: i.customer_name, vehicle_make: i.vehicle_make, vehicle_model: i.vehicle_model, vehicle_year: i.vehicle_year })), "Заказ не оформлен: обращение не равно заказу"),
      panel("Задачи", i.tasks.map(taskRow), "Задач нет"),
      panel("Записи на время", i.appointments.map(appointmentRow), "Записей нет"),
      panel("Журнал", i.events.map(eventRow), "Событий нет")));
}

function renderOrder(o) {
  const total = o.items.reduce((sum, item) => sum + item.amount_kopecks, 0);
  return el("div", {},
    detailHead(["#/work?kind=orders", "Заказы работ"], `Заказ ${o.number}`, [demoBadge(o), badge("workOrder", o.status), badge("costApproval", o.cost_approval)]),
    el("section", { class: "card" }, facts([
      ["Клиент", el("a", { href: `#/customers/${o.customer_id}` }, o.customer_name)],
      ["Автомобиль", el("a", { href: `#/vehicles/${o.vehicle_id}` }, vehicleName(o))],
      ["Обращение", o.inquiry ? el("a", { href: `#/inquiries/${o.inquiry.id}` }, `от ${fmtDateTime(o.inquiry.received_at)}`) : unknown("без обращения")],
      ["Мастер", valueOr(o.assignee, "не назначен")],
      ["План начала", valueOr(fmtDateTime(o.planned_start_at), "не назначено")],
      ["План окончания", valueOr(fmtDateTime(o.planned_end_at), "не назначено")],
      ["Согласование стоимости", o.cost_approval === "approved" ? `${money(o.approved_total_kopecks, o.currency)} · ${fmtDateTime(o.cost_approved_at)}` : label("costApproval", o.cost_approval)],
      ["Итоговая стоимость", valueOr(money(o.final_total_kopecks, o.currency), "не записана")],
      ["Фактическое время", valueOr(duration(o.actual_duration_minutes), "не записано")],
      ["День выполнения", valueOr(fmtPerformedDay(o.performed_on), "не записан")],
      ["Выдан", valueOr(fmtDateTime(o.completed_at), "ещё не выдан")],
      o.note ? ["Заметка", o.note] : null])),
    o.workReport ? el("section", { class: "card" },
      el("h2", {}, "Выполненные работы"),
      el("ul", { class: "work-list" }, o.workReport.works.map((work) => el("li", {}, work))),
      facts([
        ["Основание отчёта", valueOr(o.workReport.basis)],
        o.workReport.durationNote ? ["Пояснение длительности", o.workReport.durationNote] : null])) : null,
    el("h2", { class: "section-title" }, "Позиции"),
    o.items.length ? el("div", { class: "table-wrap" }, el("table", { class: "stack" },
      el("thead", {}, el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Тип"), el("th", { class: "num" }, "Цена"), el("th", { class: "num" }, "Кол-во"), el("th", { class: "num" }, "Сумма"))),
      el("tbody", {}, o.items.map((item) => el("tr", {},
        el("td", { class: "wide" }, item.title, priceDrift(item)),
        el("td", { "data-label": "Тип" }, item.kind === "service" ? "работа" : "запчасть"),
        el("td", { class: "num", "data-label": "Цена" }, money(item.unit_price_kopecks, item.currency)),
        el("td", { class: "num", "data-label": "Кол-во" }, quantity(item.quantity_milli)),
        el("td", { class: "num", "data-label": "Сумма" }, money(item.amount_kopecks, item.currency))))),
      el("tfoot", {}, el("tr", {}, el("td", { colspan: "4" }, "Оценочная стоимость по позициям"), el("td", { class: "num" }, money(total, o.currency)))))) : el("p", { class: "empty panel" }, o.final_total_kopecks !== null || o.approved_total_kopecks !== null ? "Позиций нет: стоимость записана общей суммой без разбивки на работы и запчасти" : "Позиций пока нет"),
    el("p", { class: "note" }, o.items.length
      ? "Это оценка по позициям заказа, а не выручка: оплаты в офисе пока не учитываются. Цены позиций — снимок на момент добавления"
      : "Стоимость заказа не означает оплату. Оплаты в офисе пока не учитываются"),
    el("div", { class: "grid-2" },
      panel("Задачи", o.tasks.map(taskRow), "Задач нет"),
      panel("Записи на время", o.appointments.map(appointmentRow), "Записей нет")),
    el("h2", { class: "section-title" }, "Журнал"),
    panel("События заказа", o.events.map(eventRow), "Событий нет"));
}

function priceDrift(item) {
  if (item.kind !== "service" || item.current_base_price_kopecks === null || item.current_base_price_kopecks === undefined) return null;
  if (item.current_base_price_kopecks === item.unit_price_kopecks) return null;
  return el("div", { class: "note" }, `В каталоге сейчас ${money(item.current_base_price_kopecks, item.currency)}; заказ сохранил прежнюю цену`);
}

// --- Задачи ---

function taskControls(params) {
  return el("div", { class: "filters" },
    selectField("Срок", "due", params, [["", "Любой"], ["overdue", "Просрочено"], ["today", "Сегодня"], ["later", "Позже"], ["none", "Без срока"]]),
    selectField("Статус", "status", params, statusOptions("task", [["open", "Открытые"], ["all", "Все"]]), "open"),
    searchField(params, "Задача, клиент, ответственный"));
}

function renderTasks(rows) {
  const filtered = state.route.params.get("q") || state.route.params.get("due") || !["open", null].includes(state.route.params.get("status"));
  return panel(`Задачи: ${rows.length}`, rows.map(taskRow), filtered ? "Под фильтр задач не попало" : "Открытых задач нет");
}

// --- Услуги ---

function serviceControls(params) {
  return el("div", { class: "filters" },
    selectField("Категория", "category", params, [["", "Все"], ...Object.entries(categoryLabels())]),
    selectField("Показ", "active", params, [["", "Все услуги"], ["yes", "Активные"], ["no", "Скрытые"]]),
    searchField(params, "Название, описание, код"));
}

function renderServices(rows) {
  if (!rows.length) return el("p", { class: "empty panel" }, state.route.params.toString() ? "Под фильтр услуг не попало" : "Каталог услуг пуст. Добавьте услуги в профиль компании (business.json) и выполните npm run office:import");
  return el("div", {},
    el("div", { class: "table-wrap" }, el("table", { class: "stack" },
      el("thead", {}, el("tr", {}, el("th", {}, "Услуга"), el("th", {}, "Категория"), el("th", { class: "num" }, "Цена"), el("th", { class: "num" }, "Время"), el("th", {}, "Статус"))),
      el("tbody", {}, rows.map((s) => el("tr", {},
        el("td", { class: "wide" }, el("strong", {}, s.name), el("div", { class: "note" }, has("work-orders") ? `${s.code} · в заказах: ${s.order_item_count}, в обращениях: ${s.inquiry_count}` : `${s.code} · в обращениях: ${s.inquiry_count}`)),
        el("td", { "data-label": "Категория" }, categoryLabels()[s.category] ?? s.category),
        el("td", { class: "num", "data-label": "Цена" }, s.base_price_kopecks === null ? unknown("уточняется") : s.base_price_kopecks === 0 ? "бесплатно" : `от ${money(s.base_price_kopecks, s.currency)}`, s.is_demo_price ? el("div", {}, el("span", { class: "badge demo" }, "демо-цена")) : null),
        el("td", { class: "num", "data-label": "Время" }, s.duration_minutes ? `${s.duration_minutes} мин` : unknown("уточняется")),
        el("td", { "data-label": "Статус" }, s.is_active ? "активна" : "скрыта")))))),
    el("p", { class: "note" }, "Демо-цены не подтверждены владельцем. Изменить цену: npm run office -- service:price --code <код> --price <руб>"));
}

// --- Расписание ---

function scheduleControls(params) {
  const today = state.meta?.today?.date ?? "";
  return el("div", { class: "filters" },
    el("label", { class: "field" }, "С даты", el("input", { type: "date", value: params.get("from") ?? today, onchange: (event) => setParam("from", event.target.value) })),
    selectField("Период", "days", params, [["1", "1 день"], ["7", "7 дней"], ["14", "14 дней"]], "7"),
    selectField("Статус", "status", params, statusOptions("appointment", [["", "Любой"]])));
}

function renderSchedule(data) {
  const items = data.appointments;
  if (!items.length) {
    return el("p", { class: "empty panel" }, `С ${fmtDay(data.from)} записей нет${bookingSynced() ? ". Booking Flow не синхронизируется: записи внешнего сервиса здесь не отображаются" : ""}`);
  }
  const days = new Map();
  for (const item of items) {
    const key = fmtDateKey(item.starts_at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(item);
  }
  return el("div", {}, [...days.values()].map((list) => el("section", { class: "day" }, panel(capitalize(fmtDay(list[0].starts_at)), list.map(scheduleRow), ""))));
}

// Предварительная запись: сотрудник подтверждает или отклоняет её здесь. Сервер повторно
// проверяет время и пересечения с другими записями
function scheduleRow(item) {
  const node = appointmentRow(item);
  if (item.status !== "tentative") return node;
  const message = el("p", { class: "form-message", role: "alert", hidden: true });
  const decide = async (decision, button) => {
    button.disabled = true;
    try {
      await postJson(`/api/appointments/${item.id}/decision`, { decision });
      load();
    } catch (error) {
      message.textContent = error.message;
      message.hidden = false;
      button.disabled = false;
    }
  };
  const confirm = el("button", { type: "button", class: "sync-button", onclick: (event) => decide("confirm", event.target) }, "Подтвердить");
  const reject = el("button", { type: "button", class: "sync-button", onclick: (event) => { if (window.confirm("Отклонить запрос на запись? Время освободится")) decide("reject", event.target); } }, "Отклонить");
  return el("div", {}, node, el("p", { class: "card-actions inline-actions" }, confirm, reject), message);
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-frontsmith-office": "1" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Сервер панели недоступен. Повторите действие");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? `Ошибка ${response.status}`);
  return payload.data;
}

// --- Диалоги сайта ---

const dialogStatuses = { needs_human: "Ждёт сотрудника", active: "Ведёт AI", closed: "Закрыт" };
const handoffBy = { ai: "передал AI-помощник", visitor: "посетитель нажал «Позвать сотрудника»", operator: "сотрудник подключился сам" };
const roleLabels = { visitor: "Посетитель", assistant: "AI-помощник", operator: "Сотрудник", system: "Уведомление" };

function dialogBadge(status) {
  return el("span", { class: `badge s-${status === "needs_human" ? "new" : status === "active" ? "in_progress" : "closed"}` }, dialogStatuses[status] ?? status);
}

const visitorName = (item) => item.customer_id ? item.customer_name : `Посетитель ${item.id.slice(0, 8)}`;

function dialogControls(params) {
  return el("div", { class: "filters" }, selectField("Статус", "status", params, [["", "Все"], ["needs_human", "Ждут сотрудника"], ["active", "Ведёт AI"], ["closed", "Закрытые"]], ""));
}

function renderDialogs(rows) {
  if (!rows.length) return el("p", { class: "empty panel" }, "Разговоров с сайта пока нет");
  const waiting = rows.filter((item) => item.status === "needs_human");
  const rest = rows.filter((item) => item.status !== "needs_human");
  const dialogRow = (item) => row({
    href: `#/dialogs/${item.id}`,
    title: visitorName(item),
    side: [dialogBadge(item.status)],
    sub: [item.status === "needs_human" ? `причина: ${item.status_reason ?? "не указана"}${item.handoff_by ? ` (${handoffBy[item.handoff_by] ?? item.handoff_by})` : ""}` : null,
      item.last_message_at ? `последнее сообщение ${fmtDateTime(item.last_message_at)}${item.last_role === "visitor" ? " · от посетителя" : ""}` : null,
      `сообщений: ${item.message_count}`].filter(Boolean).join(" · ")
  });
  return el("div", { class: "grid" },
    waiting.length ? panel(`Ждут сотрудника · ${waiting.length}`, waiting.map(dialogRow), "") : null,
    rest.length ? panel("Остальные разговоры", rest.map(dialogRow), "") : null);
}

function messageNode(message) {
  return el("li", { class: `chat-msg chat-${message.role}` },
    el("span", { class: "chat-meta" }, `${roleLabels[message.role] ?? message.role} · ${fmtDateTime(message.createdAt)}`),
    el("span", { class: "chat-text" }, message.text));
}

function renderDialog(data) {
  const conversation = data.conversation;
  const id = conversation.id;
  const log = el("ol", { class: "chat-log", "aria-live": "polite" }, data.messages.map(messageNode));
  let lastSeq = data.messages.at(-1)?.seq ?? 0;
  const status = el("span", {}, dialogBadge(conversation.status));
  const reason = el("p", { class: "note" });
  const describe = (current) => {
    status.replaceChildren(dialogBadge(current.status));
    reason.textContent = current.status === "needs_human"
      ? `Причина передачи: ${current.status_reason ?? "не указана"}${current.handoff_by ? ` — ${handoffBy[current.handoff_by] ?? current.handoff_by}` : ""}. Пока разговор у сотрудника, AI не отвечает`
      : current.status === "active" ? "Разговор ведёт AI-помощник. Ответ сотрудника переведёт разговор на сотрудника" : "Разговор закрыт. Если посетитель напишет снова, ответит AI-помощник";
  };
  describe(conversation);

  const message = el("p", { class: "form-message", role: "alert", hidden: true });
  const textarea = el("textarea", { name: "text", rows: "4", maxlength: "4000", required: true, placeholder: "Ответ посетителю. Он появится в чате на сайте" });
  const submit = el("button", { type: "submit", class: "primary-button" }, "Отправить клиенту");
  const fail = (error) => { message.textContent = error.message; message.hidden = false; };
  const action = (path, label, confirmText) => el("button", { type: "button", class: "sync-button", onclick: async (event) => {
    if (confirmText && !window.confirm(confirmText)) return;
    event.target.disabled = true;
    try {
      describe((await postJson(`/api/conversations/${id}/${path}`, {})).conversation);
      await refresh();
    } catch (error) { fail(error); } finally { event.target.disabled = false; }
  } }, label);
  const form = el("form", { class: "chat-reply" }, el("label", { class: "field" }, "Ответ сотрудника", textarea), message,
    el("p", { class: "card-actions" }, submit, action("return-ai", "Вернуть AI", "Вернуть разговор AI-помощнику? Он увидит ответы сотрудника"), action("close", "Закрыть обращение", "Закрыть обращение?")));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    submit.disabled = true;
    message.hidden = true;
    try {
      await postJson(`/api/conversations/${id}/messages`, { text });
      textarea.value = "";
      await refresh();
    } catch (error) { fail(error); } finally { submit.disabled = false; }
  });

  // Новые сообщения посетителя и статус — без перезагрузки страницы
  async function refresh() {
    if (state.route?.name !== "dialogs" || state.route.id !== id) return;
    const fresh = (await fetchJson(`/api/conversations/${id}`)).data;
    for (const item of fresh.messages.filter((item) => item.seq > lastSeq)) log.append(messageNode(item));
    lastSeq = fresh.messages.at(-1)?.seq ?? lastSeq;
    describe(fresh.conversation);
  }
  const timer = setInterval(() => {
    if (state.route?.name !== "dialogs" || state.route.id !== id) return clearInterval(timer);
    if (!document.hidden) refresh().catch(() => {});
  }, 4000);

  return el("div", {},
    detailHead(["#/dialogs", "Диалоги"], visitorName(conversation), [status]),
    reason,
    el("section", { class: "panel" }, el("h2", {}, el("span", {}, "Переписка")), log),
    el("section", { class: "panel panel-body" }, form));
}

// Счётчик разговоров, ждущих сотрудника: обновляется на любой странице панели
async function pollDialogs() {
  const counter = document.querySelector("[data-dialogs-count]");
  try {
    const waiting = (await fetchJson("/api/conversations?status=needs_human")).data.length;
    state.waiting = waiting;
    counter.textContent = String(waiting);
    counter.hidden = waiting === 0;
    document.title = `${waiting ? `(${waiting}) ` : ""}${document.title.replace(/^\(\d+\) /, "")}`;
  } catch {
    counter.hidden = true;
  }
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Запуск ---

document.querySelector("[data-refresh]").addEventListener("click", () => load());
window.addEventListener("hashchange", setupRoute);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
pollDialogs();
setInterval(() => { if (!document.hidden) pollDialogs(); }, 10000);

// Словарь статусов нужен фильтрам до первой отрисовки; без него раздел всё равно покажет честную ошибку
fetchJson("/api/meta").then((meta) => { state.meta = meta.data; }).catch(() => {}).finally(setupRoute);

// Draft editor is a form: polling never replaces unsaved text.
function renderDispatcher(data) {
  let revision=data.revision;
  let dirty=false,busy=false;
  const buttons=[];
  const box=el('div',{class:'dispatcher-editor'});
  const ownerResults=state.results;
  const isCurrent=()=>box.isConnected&&state.results===ownerResults&&ownerResults.contains(box)&&state.route?.name==='dispatcher';
  const message=el('p',{role:'status','aria-live':'polite'});
  const input=(label,value,area=false)=>{
    const field=el(area?'textarea':'input',area?{rows:4,maxlength:2500}:{type:'text'});
    field.value=value??'';
    box.append(el('label',{class:'dispatcher-field'},el('strong',{},label),field));return field;
  };
  box.append(el('section',{class:'panel'},el('h2',{},'1. Источники и готовность'),
    el('p',{},'Профиль: '+data.sources.profile+' · каталог услуг: '+data.sources.catalog),
    el('p',{},data.sources.availability),
    el('p',{},data.readiness.booking?'Расписание настроено. Свободное время проверяется инструментом перед записью':'Для записи не хватает рабочих дней, часов или часового пояса в профиле. До настройки можно отвечать на известные вопросы'),
    el('p',{},data.active?'Утверждена версия '+data.active.version+(data.stale?' — источники изменились, дополнительные знания приостановлены':' — дополнительные знания доступны'):'Дополнительные знания ещё не утверждены. Черновик не используется в ответах'),
    data.stale&&data.active?.knowledge.schedule?el('p',{role:'alert'},'Запись через диспетчера приостановлена до повторной проверки и утверждения'):null,
    el('p',{},'Сотрудник не считается доступным онлайн. Передача создаёт очередь только при запуске полного офиса; мгновенный ответ не обещается'),
    el('p',{},'Неизвестные сведения оставляйте пустыми. Контакты клиентов сюда не вносите. Исходные документы храните отдельно; переносите сюда только разрешённые публичные выдержки')));
  box.append(el('h2',{},'2. Публичные знания'));
  const about=input('О компании — что известно достоверно',data.draft.about,true);
  const conditions=input('Условия обслуживания — ограничения, подготовка, порядок согласования',data.draft.conditions,true);
  const faq=input('Вопросы и ответы — каждый вопрос вместе с проверенным ответом',data.draft.faq,true);
  const source=input('Источник и дата проверки — для внедренца, клиенту не передаётся',data.draft.source,true);
  box.append(el('h2',{},'3. Услуги и объяснение цены'),el('p',{},'Добавление в каталог немедленно делает описание и цену доступными диспетчеру и следующей сборке сайта. Откат знаний услуги не удаляет. Каталог пока поддерживает только цену «от» и индивидуальную оценку; фиксированная цена и диапазон для этого действия будут отклонены. Публичное описание и каталог записи — отдельные шаги. Коды, названия и начальная цена существующих услуг должны совпадать с каталогом. Новые услуги можно добавить в каталог отдельной кнопкой после сохранения черновика; существующие записи не перезаписываются'));
  const list=el('div',{}),rows=[];
  function addService(service={code:'service-'+crypto.randomUUID().slice(0,8),name:'',kind:'estimate',min:'',max:'',conditions:''},changed=true) {
    const row=el('fieldset',{class:'panel dispatcher-service'});
    row.append(el('legend',{},'Услуга'));
    const field=(label,key,type='text')=>{const node=el('input',{type,maxlength:100});node.value=service[key]??'';row.append(el('label',{},label,node));return node};
    const code=field('Код — латиница и дефис','code'),name=field('Название','name');
    const kind=el('select',{});for(const [value,label] of [['estimate','Индивидуальная оценка'],['fixed','Фиксированная'],['from','От'],['range','Диапазон']])kind.append(el('option',{value},label));kind.value=service.kind;
    row.append(el('label',{},'Тип цены',kind));
    const min=field('Цена / нижняя граница','min','number'),max=field('Верхняя граница','max','number');min.step=max.step='0.01';min.min=max.min='0';
    const duration=field('Длительность для записи, минут (пусто — 60)','durationMinutes','number');duration.min='5';duration.max='1440';
    const conditions=el('textarea',{rows:3,maxlength:600});conditions.value=service.conditions;row.append(el('label',{},'Что влияет на стоимость',conditions));
    const update=()=>{min.disabled=kind.value==='estimate';max.disabled=kind.value!=='range'};kind.addEventListener('change',update);update();
    const entry={row,read:()=>({code:code.value,name:name.value,kind:kind.value,min:min.value,max:max.value,conditions:conditions.value,durationMinutes:duration.value?Number(duration.value):null})};rows.push(entry);
    row.append(el('button',{type:'button',onclick:()=>{rows.splice(rows.indexOf(entry),1);row.remove();markDirty()}},'Удалить из черновика'));list.append(row);if(changed)markDirty();
  }
  data.draft.services.forEach(service=>addService(service,false));box.append(list,el('button',{type:'button',onclick:()=>addService()},'Добавить описание услуги'));
  if(data.catalog.length)box.append(el('details',{},el('summary',{},'Посмотреть действующий каталог'),...data.catalog.map(s=>el('p',{},s.code+' · '+s.name+' · '+(s.price??'оценка') ))));
  const reviewed=el('input',{type:'checkbox'});
  const scheduleBox=el('fieldset',{class:'panel dispatcher-service'});
  scheduleBox.append(el('legend',{},'4. Локальное расписание'));
  const custom=el('input',{type:'checkbox'});custom.checked=Boolean(data.draft.schedule);
  scheduleBox.append(el('label',{},custom,' Задать отдельные часы записи диспетчера (иначе используется профиль компании)'));
  const schedule=data.draft.schedule??{timeZone:data.timeZone,days:[],start:'',end:'',slotStepMinutes:30,autoConfirm:false};
  const sf=(label,key,type='text')=>{const node=el('input',{type});node.value=schedule[key];scheduleBox.append(el('label',{},label,node));return node};
  const timeZone=sf('Часовой пояс (например Europe/Moscow)','timeZone'),start=sf('Начало работы','start','time'),end=sf('Конец работы','end','time'),step=sf('Шаг начала записи в минутах','slotStepMinutes','number');step.min='5';step.max='240';
  const days=[];for(const [index,name] of ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].entries()){const day=el('input',{type:'checkbox',value:index+1});day.checked=schedule.days.includes(index+1);days.push(day);scheduleBox.append(el('label',{},day,name))}
  const auto=el('input',{type:'checkbox'});auto.checked=schedule.autoConfirm;scheduleBox.append(el('label',{},auto,' Разрешить автоподтверждение свободной записи после формы клиента'),el('p',{},'Без автоподтверждения создаётся запрос на согласование. Длительность берётся из каталога, при отсутствии — 60 минут. Одновременно обслуживается одна запись; внешние календари не подключены. Минимум до начала: '+data.bookingLimits.minNoticeMinutes+' мин; горизонт записи: '+data.bookingLimits.horizonDays+' дн'));
  box.append(scheduleBox);
  box.append(el('h2',{},'5. Проверка и начало работы'),el('label',{},reviewed,' Я проверил публичность сведений, цены и противоречия с профилем, каталогом и исходными документами'));
  const catalogReviewed=el('input',{type:'checkbox'});
  box.append(el('label',{},catalogReviewed,' Разрешаю немедленно сделать описания и цены новых услуг публичными через каталог. Это действие не отменяется откатом знаний'));
  function refreshButtons() {
    for(const button of buttons){const action=button.dataset.action;button.disabled=busy||(action!=='save'&&dirty)||(action==='rollback'&&(!data.previous||data.previous.sourceHash!==data.sourceHash))||(action==='deactivate'&&!data.active);}
  }
  function markDirty(){dirty=true;reviewed.checked=false;catalogReviewed.checked=false;refreshButtons();message.textContent='Есть несохранённые изменения. Сначала сохраните черновик'}
  function edited(event){if(event.target!==reviewed&&event.target!==catalogReviewed)markDirty()}
  box.addEventListener('input',edited);box.addEventListener('change',edited);
  async function act(action) {
    if(busy)return;
    if(dirty&&action!=='save'){message.textContent='Сначала сохраните видимые изменения';return;}
    busy=true;const disabled=new Map(Array.from(box.querySelectorAll('input,textarea,select,button')).map(control=>[control,control.disabled]));
    disabled.forEach((value,control)=>control.disabled=true);refreshButtons();message.textContent='Сохранение…';
    try {
      const response=await fetch('/api/dispatcher',{method:'POST',headers:{'Content-Type':'application/json','x-frontsmith-office':'1'},body:JSON.stringify({revision,action,reviewed:reviewed.checked,publicCatalog:catalogReviewed.checked,draft:{about:about.value,conditions:conditions.value,faq:faq.value,source:source.value,schedule:custom.checked?{timeZone:timeZone.value,start:start.value,end:end.value,slotStepMinutes:Number(step.value),days:days.filter(d=>d.checked).map(d=>Number(d.value)),autoConfirm:auto.checked}:null,services:rows.map(r=>r.read())}})});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message??'Не удалось сохранить');
      if(!isCurrent())return;
      ownerResults.replaceChildren(renderDispatcher(payload.data));
      ownerResults.querySelector('[role=status]').textContent=action==='save'?'Черновик сохранён. Проверьте его перед утверждением':action==='publish'?'Сохранённая версия утверждена для ответов':action==='catalog'?'Новые услуги добавлены в каталог и доступны публично. Проверьте и утвердите дополнительные знания':action==='deactivate'?'Дополнительные знания и отдельные часы отключены; действует профиль компании. Каталог сохранён':'Предыдущая версия восстановлена';
    }catch(error){if(!isCurrent())return;busy=false;disabled.forEach((value,control)=>control.disabled=value);refreshButtons();message.textContent=error.message+(dirty?' Видимые правки сохранены в форме; сначала исправьте ошибку и сохраните черновик':'')}
  }
  for(const [action,label] of [['save','Сохранить черновик'],['catalog','Сделать новые услуги публичными и добавить в запись'],['publish','Утвердить сохранённый черновик'],['rollback','Вернуть предыдущую версию'],['deactivate','Вернуться к профилю без дополнительных знаний']]){const button=el('button',{type:'button','data-action':action,onclick:()=>act(action)},label);buttons.push(button);box.append(button)}
  refreshButtons();
  box.append(el('p',{},'Возврат к профилю отключает дополнительные знания и отдельное расписание, но не сам AI и не услуги каталога'),el('details',{},el('summary',{},'Проверить текст сохранённого черновика'),el('pre',{class:'dispatcher-preview'},data.preview)),message,...data.errors.map(error=>el('p',{role:'alert'},error)),el('p',{},'После утверждения проверьте виджет: неизвестный вопрос, цену без точной оценки, передачу человеку и время после обеда. AI-ответы требуют запуска полного офиса и входа ChatGPT. Утверждение не публикует сайт и не подключает сервисы'));
  return box;
}
