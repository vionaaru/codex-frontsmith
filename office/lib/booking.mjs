// Запись на услугу по расписанию компании: свободные интервалы и создание записи.
// Один общий календарь компании: занятым считается время любой записи в статусах
// tentative, confirmed и arrived. Услуги и длительность — из каталога офиса, рабочие часы,
// шаг и правила — из профиля компании (business.json → booking, иначе hours).
// Модуль не знает о каналах и AI: его вызывают доверенные процессы Frontsmith.
import { OfficeValidationError, zonedDayRange, zonedTime } from "./domain.mjs";
import { createAppointment, createInquiry, setAppointmentStatus } from "./operations.mjs";

export const BUSY_APPOINTMENT_STATUSES = ["tentative", "confirmed", "arrived"];

export class BookingConflictError extends Error {
  constructor(message = "Это время уже занято") {
    super(message);
    this.code = "slot_unavailable";
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value) {
  const match = TIME.exec(String(value ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return Boolean(value);
  } catch {
    return false;
  }
}

// Настройки записи. Без рабочих дней и часов интервалы не предлагаются: часы не выдумываются.
//   booking.enabled         false — запись через AI выключена
//   booking.autoConfirm     true — владелец разрешил сразу подтверждать запись после согласия клиента
//   booking.hours           { days: [1..7, 1 — понедельник], start: "10:00", end: "19:00" }; иначе hours профиля
//   booking.slotStepMinutes шаг начала записи, по умолчанию 30
//   booking.defaultDurationMinutes длительность услуги без duration_minutes в каталоге, по умолчанию 60
//   booking.minNoticeMinutes минимум до начала записи, по умолчанию 60
//   booking.horizonDays     на сколько дней вперёд открыта запись, по умолчанию 14
export function bookingSettings(profile) {
  const booking = profile?.booking ?? {};
  const source = booking.hours ?? profile?.hours ?? null;
  const missing = [];
  let hours = null;
  if (source) {
    const days = Array.isArray(source.days) ? [...new Set(source.days.map(Number))].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7) : [];
    const start = minutes(source.start);
    const end = minutes(source.end);
    if (days.length && start !== null && end !== null && end > start) hours = { days: days.sort(), start, end };
  }
  if (!hours) missing.push("рабочие дни и часы: booking.hours или hours в business.json ({ \"days\": [1, 2, 3, 4, 5], \"start\": \"10:00\", \"end\": \"19:00\" })");
  const timeZone = profile?.timeZone;
  if (!validTimeZone(timeZone)) missing.push("часовой пояс: timeZone в business.json (например, Europe/Moscow)");
  return {
    enabled: booking.enabled !== false,
    autoConfirm: booking.autoConfirm === true,
    timeZone,
    hours,
    slotStepMinutes: integer(booking.slotStepMinutes, 30, 5, 240),
    defaultDurationMinutes: integer(booking.defaultDurationMinutes, 60, 5, 24 * 60),
    minNoticeMinutes: integer(booking.minNoticeMinutes, 60, 0, 14 * 24 * 60),
    horizonDays: integer(booking.horizonDays, 14, 1, 90),
    isDemo: profile?.demoMode === true,
    configured: missing.length === 0,
    missing
  };
}

// Локальные дата и время в часовом поясе компании
function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// «2026-10-27T10:00» — время интервала в часовом поясе компании; так интервал видят модель и посетитель
export function slotKey(date, timeZone) {
  const local = localParts(date, timeZone);
  return `${local.date}T${String(Math.floor(local.minutes / 60)).padStart(2, "0")}:${String(local.minutes % 60).padStart(2, "0")}`;
}

export function parseSlotKey(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) throw new OfficeValidationError("Время записи: ожидается ГГГГ-ММ-ДДTЧЧ:ММ");
  const date = zonedTime(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), timeZone);
  if (slotKey(date, timeZone) !== match[0]) throw new OfficeValidationError("Такого времени нет в календаре компании");
  return date;
}

export function slotLabel(date, timeZone) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
}

function isoWeekday(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function durationMinutes(service, settings) {
  return service.duration_minutes ?? settings.defaultDurationMinutes;
}

// Активная услуга каталога по коду или названию. matches — варианты, если однозначной нет
export function findBookableService(db, query) {
  const text = String(query ?? "").trim().toLowerCase();
  const services = db.prepare("SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order, name").all();
  if (!text) return { service: null, matches: services };
  const exact = services.find((service) => service.code === text || service.name.toLowerCase() === text);
  if (exact) return { service: exact, matches: [exact] };
  const partial = services.filter((service) => service.name.toLowerCase().includes(text) || text.includes(service.name.toLowerCase()));
  return { service: partial.length === 1 ? partial[0] : null, matches: partial.length ? partial : services };
}

function busyIntervals(db, from, to) {
  return db.prepare(`SELECT starts_at, ends_at FROM appointments
    WHERE status IN (${BUSY_APPOINTMENT_STATUSES.map(() => "?").join(", ")}) AND ends_at > ? AND starts_at < ?`)
    .all(...BUSY_APPOINTMENT_STATUSES, from.toISOString(), to.toISOString())
    .map((row) => [Date.parse(row.starts_at), Date.parse(row.ends_at)]);
}

// Причина, по которой интервал нельзя занять, или null. Проверяется и при выдаче интервалов,
// и непосредственно перед сохранением записи
export function slotProblem(db, settings, service, startsAt, now) {
  if (!settings.configured) return "schedule_not_configured";
  const duration = durationMinutes(service, settings);
  const local = localParts(startsAt, settings.timeZone);
  const { start, end, days } = settings.hours;
  if (!days.includes(isoWeekday(local.date))) return "outside_hours";
  if (local.minutes < start || local.minutes + duration > end || (local.minutes - start) % settings.slotStepMinutes !== 0) return "outside_hours";
  if (startsAt.getTime() < now.getTime() + settings.minNoticeMinutes * 60_000) return "too_soon";
  const today = zonedDayRange(now, settings.timeZone).date;
  if (local.date > addDays(today, settings.horizonDays - 1)) return "too_far";
  const endsAt = startsAt.getTime() + duration * 60_000;
  if (busyIntervals(db, startsAt, new Date(endsAt)).some(([from, to]) => from < endsAt && to > startsAt.getTime())) return "slot_taken";
  return null;
}

// Свободные интервалы услуги начиная с даты fromDate (ГГГГ-ММ-ДД, по умолчанию сегодня)
export function availableSlots(db, settings, service, { now = new Date(), fromDate = null, limit = 8, perDay = 4 } = {}) {
  if (!settings.configured) return [];
  const today = zonedDayRange(now, settings.timeZone).date;
  const last = addDays(today, settings.horizonDays - 1);
  const duration = durationMinutes(service, settings);
  const slots = [];
  for (let day = fromDate && fromDate > today ? fromDate : today; day <= last && slots.length < limit; day = addDays(day, 1)) {
    if (!settings.hours.days.includes(isoWeekday(day))) continue;
    const [year, month, date] = day.split("-").map(Number);
    let taken = 0;
    for (let minute = settings.hours.start; minute + duration <= settings.hours.end && slots.length < limit && taken < perDay; minute += settings.slotStepMinutes) {
      const startsAt = zonedTime(year, month, date, Math.floor(minute / 60), minute % 60, settings.timeZone);
      if (slotProblem(db, settings, service, startsAt, now)) continue;
      slots.push({ key: slotKey(startsAt, settings.timeZone), label: slotLabel(startsAt, settings.timeZone), startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + duration * 60_000).toISOString() });
      taken += 1;
    }
  }
  return slots;
}

// Обращение и запись одной транзакцией с блокировкой записи (BEGIN IMMEDIATE): повторная
// проверка интервала и вставка не разделяются другим писателем. externalId — ключ
// идемпотентности: повтор той же операции возвращает уже созданную запись.
// autoConfirm — только по разрешению владельца; иначе запись предварительная (tentative)
export function bookSlot(ctx, { settings, service, startsAt, customerId, externalId, description, autoConfirm, confirmationBasis }) {
  const db = ctx.db;
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM appointments WHERE source = 'website' AND external_id = ?").get(externalId);
    if (existing) return { appointment: existing, inquiryId: existing.inquiry_id, duplicate: true };
    const problem = slotProblem(db, settings, service, startsAt, ctx.now());
    if (problem) throw new BookingConflictError(problem === "slot_taken" ? "Это время уже занято" : "Это время недоступно для записи");
    const endsAt = new Date(startsAt.getTime() + durationMinutes(service, settings) * 60_000);
    const inquiry = createInquiry(ctx, { customerId, serviceCode: service.code, source: "website", externalId, description, isDemo: settings.isDemo });
    let appointment = createAppointment(ctx, {
      inquiryId: inquiry.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      source: "website",
      externalId,
      note: autoConfirm ? "Записан через AI-чат сайта" : "Запрос через AI-чат сайта: подтвердите время с клиентом",
      isDemo: settings.isDemo
    });
    if (autoConfirm) appointment = setAppointmentStatus(ctx, { id: appointment.id, status: "confirmed", basis: confirmationBasis });
    return { appointment, inquiryId: inquiry.id, duplicate: false };
  }).immediate();
}
