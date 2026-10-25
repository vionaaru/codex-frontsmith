// Запись на услугу из диалога: инструменты Host для AI-диспетчера и подтверждение
// записи посетителем в форме канала.
//
//   модель: find_booking_slots → offer_booking ─┐
//   посетитель: форма канала (время, имя, телефон, согласие) → confirm()
//     → CustomerProvider.createCustomer → bookSlot (повторная проверка, обращение, запись)
//   модель: get_booking_status → честный итог: запрос принят или запись подтверждена
//
// Модель не получает контакты: их принимает форма канала и передаёт CustomerProvider,
// модели остаются услуга, время, статус и номер записи. Подтверждать запись сразу можно
// только если владелец разрешил это в профиле (booking.autoConfirm) — это проверяет
// confirm(), а не инструкции модели. Обработчики инструментов не бросают исключений:
// бизнес-ошибка возвращается модели кодом, чтобы ход диалога не прерывался.
import { randomUUID } from "node:crypto";
import { CustomerError } from "../../office/customers/contract.mjs";
import { BookingConflictError, availableSlots, bookSlot, bookingSettings, findBookableService, parseSlotKey, slotKey, slotLabel, slotProblem } from "../../office/lib/booking.mjs";
import { OfficeValidationError } from "../../office/lib/domain.mjs";
import { createContext } from "../../office/lib/operations.mjs";
import { vocabularyFor } from "../../scripts/lib/blueprints.mjs";

export const BOOKING_TOOLS = ["find_booking_slots", "offer_booking", "get_booking_status"];
const ACTOR = "AI-диспетчер сайта";

export class BookingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const PROBLEMS = {
  slot_taken: "это время уже занято",
  too_soon: "это время слишком близко",
  too_far: "запись на эту дату ещё не открыта",
  outside_hours: "это время вне рабочего расписания",
  schedule_not_configured: "расписание для записи не настроено"
};

const shortRef = (id) => String(id ?? "").slice(0, 8);

// db — соединение офисной базы с записью; provider — CustomerProvider на том же соединении;
// profile() — актуальный business.json (настройки читаются на каждый вызов)
export class BookingDesk {
  #db;
  #provider;
  #store;
  #profile;
  #now;
  #log;
  #confirming = new Set();

  constructor({ db, provider, store, profile, now = () => new Date(), log = () => {} }) {
    this.#db = db;
    this.#provider = provider;
    this.#store = store;
    this.#profile = profile;
    this.#now = now;
    this.#log = log;
  }

  async #settings() {
    const profile = await this.#profile();
    return { profile, settings: bookingSettings(profile) };
  }

  // Инструменты Host для публичных диалогов. Диалог определяется по thread Codex, а не по
  // аргументам модели: модель не может действовать от имени чужого диалога
  tools() {
    const guard = (fn) => async (args, { threadId }) => {
      const conversation = this.#store.byThread(threadId);
      if (!conversation || !this.#store.tools(conversation).includes(fn.name)) return "booking_unavailable: в этом диалоге запись недоступна";
      try {
        const result = await fn.call(this, args ?? {}, conversation);
        // В журнал — только код результата, без аргументов и текста
        this.#log({ event: "booking_tool", conversation: conversation.id, tool: fn.name, result: String(result).match(/^[a-z_]+(?=:)/)?.[0] ?? "slots" });
        return result;
      } catch (error) {
        this.#log({ event: "booking_tool_failed", conversation: conversation.id, code: error.code ?? "error" });
        return "booking_unavailable: система записи сейчас недоступна. Не называй время и не обещай запись; предложи связаться с компанией";
      }
    };
    return [
      {
        name: "find_booking_slots",
        description: "Свободное время для записи на услугу по расписанию компании. service — код или название услуги из каталога; date — с какой даты искать (ГГГГ-ММ-ДД), необязательно.",
        inputSchema: { type: "object", properties: { service: { type: "string" }, date: { type: "string" } }, required: ["service"], additionalProperties: false },
        handler: guard(this.find_booking_slots)
      },
      {
        name: "offer_booking",
        description: "Показать посетителю форму записи на выбранные услугу и время. Вызывай, когда посетитель выбрал время из find_booking_slots. Запись не создаётся: посетитель сам проверяет время, указывает контакты и подтверждает в форме.",
        inputSchema: { type: "object", properties: { service: { type: "string" }, start: { type: "string", description: "Время из find_booking_slots, ГГГГ-ММ-ДДTЧЧ:ММ" } }, required: ["service", "start"], additionalProperties: false },
        handler: guard(this.offer_booking)
      },
      {
        name: "get_booking_status",
        description: "Итог записи в этом диалоге: ждёт формы, запрос принят (время не подтверждено) или запись подтверждена.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: guard(this.get_booking_status)
      }
    ];
  }

  #unavailable(settings) {
    if (!settings.enabled) return "booking_disabled: запись через чат выключена владельцем. Не предлагай время; предложи связаться с компанией";
    if (!settings.configured) return "schedule_not_configured: рабочие часы для записи не настроены. Не называй и не придумывай время; предложи связаться с компанией";
    return null;
  }

  #serviceList(services) {
    return services.map((service) => `- ${service.code}: ${service.name}`).join("\n");
  }

  #slotLines(slots) {
    return slots.map((slot) => `- ${slot.key} — ${slot.label}`).join("\n");
  }

  async find_booking_slots({ service: query, date }, conversation) {
    const { settings } = await this.#settings();
    const unavailable = this.#unavailable(settings);
    if (unavailable) return unavailable;
    const { service, matches } = findBookableService(this.#db, query);
    if (!service) return matches.length ? `service_not_found: уточни услугу. Услуги каталога:\n${this.#serviceList(matches)}` : "no_services: в каталоге нет услуг для записи";
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : null;
    const slots = availableSlots(this.#db, settings, service, { now: this.#now(), fromDate });
    this.#log({ event: "booking_slots", conversation: conversation.id, count: slots.length });
    if (!slots.length) return `no_slots: свободного времени на «${service.name}» в ближайшие ${settings.horizonDays} дн. нет. Предложи другую дату или связаться с компанией`;
    const duration = service.duration_minutes ? `${service.duration_minutes} мин` : `около ${settings.defaultDurationMinutes} мин (ориентир)`;
    return [
      `Услуга: ${service.code} — ${service.name}, длительность ${duration}.`,
      `Свободное время (часовой пояс компании ${settings.timeZone}):`,
      this.#slotLines(slots),
      "Предложи посетителю несколько вариантов. Когда он выберет, вызови offer_booking со значением start из списка. Контакты в чате не спрашивай: их посетитель укажет в форме."
    ].join("\n");
  }

  async offer_booking({ service: query, start }, conversation) {
    const { settings } = await this.#settings();
    const unavailable = this.#unavailable(settings);
    if (unavailable) return unavailable;
    const { service } = findBookableService(this.#db, query);
    if (!service) return "service_not_found: сначала найди услугу через find_booking_slots";
    let startsAt;
    try {
      startsAt = parseSlotKey(start, settings.timeZone);
    } catch {
      return "invalid_start: используй значение start из find_booking_slots (ГГГГ-ММ-ДДTЧЧ:ММ)";
    }
    const problem = slotProblem(this.#db, settings, service, startsAt, this.#now());
    if (problem) {
      const slots = availableSlots(this.#db, settings, service, { now: this.#now(), fromDate: slotKey(startsAt, settings.timeZone).slice(0, 10), limit: 4 });
      return `slot_unavailable: ${PROBLEMS[problem] ?? "время недоступно"}.${slots.length ? ` Свободные варианты:\n${this.#slotLines(slots)}` : " Предложи другую дату."}`;
    }
    const offer = this.#store.offer(conversation.id, { serviceCode: service.code, serviceName: service.name, startsAt: startsAt.toISOString(), clientId: conversation.client_id ?? randomUUID() });
    this.#log({ event: "booking_offered", conversation: conversation.id, offer: offer.id });
    return [
      `offer_created: посетителю показана форма записи: «${service.name}», ${slotLabel(startsAt, settings.timeZone)}.`,
      settings.autoConfirm
        ? "После подтверждения в форме система проверит время и подтвердит запись, если оно свободно."
        : "После отправки формы компания получит запрос и подтвердит время отдельно.",
      "Попроси посетителя проверить время, указать имя и телефон в форме и нажать кнопку. Запись ещё НЕ создана: не говори, что посетитель записан, пока get_booking_status не вернёт confirmed."
    ].join("\n");
  }

  // Статус предложения с учётом решения сотрудника: подтверждённая или отменённая в офисе
  // предварительная запись меняет итог для посетителя и модели
  #status(offer) {
    if (!offer.appointment_id) return offer.status;
    const appointment = this.#db.prepare("SELECT status FROM appointments WHERE id = ?").get(offer.appointment_id);
    if (appointment?.status === "cancelled") return "declined";
    if (["confirmed", "arrived", "completed"].includes(appointment?.status)) return "confirmed";
    return offer.status;
  }

  async get_booking_status(_args, conversation) {
    const { settings } = await this.#settings();
    const offer = this.#store.latestOffer(conversation.id);
    if (!offer) return "no_booking: в этом диалоге записи нет";
    const when = slotLabel(new Date(offer.starts_at), settings.timeZone);
    const status = this.#status(offer);
    if (status === "declined") return `declined: компания отклонила запрос на запись «${offer.service_name}», ${when}. Запись не состоится. Предложи выбрать другое время или связаться с компанией`;
    if (status === "confirmed" && offer.status === "requested") return `confirmed: компания подтвердила запись — «${offer.service_name}», ${when}, номер ${shortRef(offer.appointment_id)}`;
    if (offer.status === "offered") return `waiting_for_form: посетитель ещё не отправил форму записи на «${offer.service_name}», ${when}. Запись не создана`;
    if (offer.status === "requested") return `requested: запрос на запись «${offer.service_name}», ${when} принят, номер ${shortRef(offer.appointment_id)}. Время ещё НЕ подтверждено: компания подтвердит его отдельно. Не говори, что запись подтверждена`;
    return `confirmed: запись подтверждена — «${offer.service_name}», ${when}, номер ${shortRef(offer.appointment_id)}`;
  }

  // Состояние формы для канала: без контактов, только услуга, время и варианты
  async pending(conversationId) {
    const offer = this.#store.latestOffer(conversationId);
    if (!offer) return null;
    const { settings } = await this.#settings();
    const startsAt = new Date(offer.starts_at);
    const view = {
      id: offer.id,
      status: this.#status(offer),
      service: offer.service_name,
      start: slotKey(startsAt, settings.timeZone),
      label: slotLabel(startsAt, settings.timeZone),
      mode: settings.autoConfirm ? "auto" : "request",
      reference: offer.appointment_id ? shortRef(offer.appointment_id) : null
    };
    if (offer.status !== "offered") return view;
    const { service } = findBookableService(this.#db, offer.service_code);
    const options = service ? availableSlots(this.#db, settings, service, { now: this.#now(), fromDate: view.start.slice(0, 10), limit: 6 }) : [];
    return { ...view, options: options.map((slot) => ({ start: slot.key, label: slot.label })) };
  }

  // Подтверждение посетителем: контакты → CustomerProvider, запись → bookSlot.
  // Повтор для уже обработанного предложения возвращает прежний итог, не создавая дубль
  async confirm(conversationId, { offerId, start, name, phone, consent }) {
    if (consent !== true) throw new BookingError(400, "consent_required", "Нужно согласие на обработку контактов для записи");
    const offer = this.#store.getOffer(offerId);
    if (!offer || offer.conversation_id !== conversationId) throw new BookingError(404, "offer_not_found", "Форма записи устарела");
    if (offer.status === "requested" || offer.status === "confirmed") return this.pending(conversationId);
    if (offer.status !== "offered") throw new BookingError(409, "offer_closed", "Форма записи устарела: попросите AI-помощника предложить время заново");
    if (this.#confirming.has(offer.id)) throw new BookingError(409, "booking_in_progress", "Запись уже оформляется");
    this.#confirming.add(offer.id);
    try {
      return await this.#confirm(conversationId, offer, { start, name, phone });
    } finally {
      this.#confirming.delete(offer.id);
    }
  }

  async #confirm(conversationId, offer, { start, name, phone }) {
    const { profile, settings } = await this.#settings();
    if (this.#unavailable(settings)) throw new BookingError(409, "booking_disabled", "Запись через чат сейчас недоступна");
    const { service } = findBookableService(this.#db, offer.service_code);
    if (!service || service.code !== offer.service_code) throw new BookingError(409, "service_unavailable", "Услуга больше недоступна для записи");
    let startsAt;
    try {
      startsAt = parseSlotKey(start ?? slotKey(new Date(offer.starts_at), settings.timeZone), settings.timeZone);
    } catch {
      throw new BookingError(400, "invalid_start", "Выберите время из списка");
    }
    const taken = () => new BookingError(409, "slot_unavailable", "Это время уже недоступно: выберите другое");
    // Ранняя проверка — чтобы не создавать клиента для заведомо занятого времени.
    // Окончательная — в транзакции bookSlot
    if (slotProblem(this.#db, settings, service, startsAt, this.#now())) throw taken();

    let customer;
    try {
      customer = await this.#provider.createCustomer({ displayName: name, phone }, { clientId: offer.client_id, isDemo: settings.isDemo, allowSharedPhone: true, actor: ACTOR, source: "ai_dispatcher" });
    } catch (error) {
      if (error instanceof CustomerError && error.code === "invalid_input") throw new BookingError(400, "invalid_contact", error.message);
      throw new BookingError(503, "crm_unavailable", "Не удалось сохранить контакты. Попробуйте позже");
    }
    this.#store.setClient(conversationId, customer.customer.id);

    const ctx = createContext(this.#db, { actor: ACTOR, source: "ai_dispatcher", now: this.#now, vocabulary: vocabularyFor(profile) });
    const label = slotLabel(startsAt, settings.timeZone);
    let result;
    try {
      result = bookSlot(ctx, {
        settings,
        service,
        startsAt,
        customerId: customer.customer.id,
        externalId: `chat:${offer.id}`,
        description: `Запись через AI-чат сайта: ${service.name}, ${label}`,
        autoConfirm: settings.autoConfirm,
        confirmationBasis: "Клиент выбрал время и подтвердил запись в форме на сайте; автоподтверждение разрешено владельцем (booking.autoConfirm)"
      });
    } catch (error) {
      if (error instanceof BookingConflictError) throw taken();
      if (error instanceof OfficeValidationError) throw new BookingError(409, "booking_rejected", "Запись не создана: проверьте услугу и время");
      throw error;
    }
    const status = result.appointment.status === "confirmed" ? "confirmed" : "requested";
    this.#store.completeOffer(offer.id, { status, startsAt: startsAt.toISOString(), inquiryId: result.inquiryId, appointmentId: result.appointment.id });
    this.#log({ event: `booking_${status}`, conversation: conversationId, offer: offer.id, duplicate: result.duplicate });
    return this.pending(conversationId);
  }
}
