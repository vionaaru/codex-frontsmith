// Панель офиса. Бизнес-данные — только чтение из локального GET API, обновление обычным polling.
// Карточки клиентов создаются и редактируются здесь: сервер передаёт их в CustomerProvider (CRM)
const POLL_MS = 20000;
const main = document.querySelector("#main");
const state = { meta: null, route: null, results: null, hasData: false, lastOk: null, seq: 0, loading: false };

// Категории услуг — из словаря бизнес-профиля (/api/meta → vocabulary.serviceCategories)
const categoryLabels = () => state.meta?.vocabulary?.serviceCategories ?? {};
const entityLabels = { business: "Профиль", customer: "Клиент", vehicle: "Автомобиль", service: "Услуга", inquiry: "Обращение", work_order: "Заказ", order_item: "Позиция", appointment: "Запись", task: "Задача", database: "База" };
const eventSources = { cli: "команда CLI", import: "импорт", seed: "учебный набор", migration: "инициализация", panel: "панель" };

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
  schedule: { nav: "schedule", title: "Расписание", intro: () => `Записи на время из локальной базы${bookingSynced() ? ". Внешний Booking Flow сюда не синхронизируется" : ""}`, controls: scheduleControls, endpoint: (p) => `/api/schedule?${pick(p, ["from", "status"], { days: "7" })}`, render: renderSchedule }
};
const detailRoutes = { customers: "customer", "customer-edit": "customerEdit", vehicles: "vehicle", inquiries: "inquiry", orders: "order" };

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
    if (view && link.dataset.nav === view.nav) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
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
  document.title = `${business?.name ?? "Офис"} · панель офиса`;
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
  return el("div", {}, [...days.values()].map((list) => el("section", { class: "day" }, panel(capitalize(fmtDay(list[0].starts_at)), list.map(appointmentRow), ""))));
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Запуск ---

document.querySelector("[data-refresh]").addEventListener("click", () => load());
window.addEventListener("hashchange", setupRoute);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);

// Словарь статусов нужен фильтрам до первой отрисовки; без него раздел всё равно покажет честную ошибку
fetchJson("/api/meta").then((meta) => { state.meta = meta.data; }).catch(() => {}).finally(setupRoute);
