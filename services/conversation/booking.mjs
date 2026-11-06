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
import { createHash, randomUUID } from "node:crypto";
import { CustomerError } from "../../office/customers/contract.mjs";
import { BookingConflictError, availableSlots, bookSlot, bookingSettings, findBookableService, parseSlotKey, slotKey, slotLabel, slotProblem } from "../../office/lib/booking.mjs";
import { OfficeValidationError } from "../../office/lib/domain.mjs";
import { createContext } from "../../office/lib/operations.mjs";
import { vocabularyFor } from "../../scripts/lib/blueprints.mjs";

import { readDispatcher, dispatcherProfile } from './dispatcher-settings.mjs';

import { withDispatcherLock } from './dispatcher-lock.mjs';

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
    const profile = await dispatcherProfile(await this.#profile());
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
        description: "Свободное время для записи на услугу по расписанию компании. service — код или название услуги из каталога; date — с какой даты искать (ГГГГ-ММ-ДД); timeFrom/timeTo — границы начала по местному времени ЧЧ:ММ, например 14:00–19:00. Список частичный, другие часы могут быть свободны.",
        inputSchema: { type: "object", properties: { service: { type: "string" }, date: { type: "string" }, timeFrom: { type: "string" }, timeTo: { type: "string" } }, required: ["service"], additionalProperties: false },
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
        description: "Итог записи в этом диалоге. Для конкретной формы передай offerId; без него — последнее предложение. Учитывай возвращённые id и статус: ожидание формы не означает оформленный запрос.",
        inputSchema: { type: "object", properties: { offerId: { type: "string" } }, additionalProperties: false },
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

  async find_booking_slots({ service: query, date, timeFrom, timeTo }, conversation) {
    const { settings } = await this.#settings();
    const unavailable = this.#unavailable(settings);
    if (unavailable) return unavailable;
    const { service, matches } = findBookableService(this.#db, query);
    if (!service) return matches.length ? `service_not_found: уточни услугу. Услуги каталога:\n${this.#serviceList(matches)}` : "no_services: в каталоге нет услуг для записи";
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : null;
    if ([timeFrom,timeTo].some(t=>t!==undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || timeFrom && timeTo && timeFrom>timeTo) return 'invalid_time: границы начала должны быть ЧЧ:ММ, от меньшего к большему';
    const slots = availableSlots(this.#db, settings, service, { now: this.#now(), fromDate, timeFrom, timeTo });
    this.#log({ event: "booking_slots", conversation: conversation.id, count: slots.length });
    if (!slots.length) return `no_slots: свободного времени на «${service.name}» в выбранном диапазоне начала в ближайшие ${settings.horizonDays} дн. не найдено. Это не означает, что другие часы заняты. Предложи другую дату или связаться с компанией`;
    const duration = service.duration_minutes ? `${service.duration_minutes} мин` : `около ${settings.defaultDurationMinutes} мин (ориентир)`;
    return [
      `Услуга: ${service.code} — ${service.name}, длительность ${duration}.`,
      `Несколько свободных вариантов, НЕ полный список. Для других часов повтори поиск с timeFrom/timeTo. Часовой пояс компании ${settings.timeZone}:`,
      this.#slotLines(slots),
      "Предложи посетителю несколько вариантов. Когда он выберет, вызови offer_booking со значением start из списка. Контакты в чате не спрашивай: их посетитель укажет в форме."
    ].join("\n");
  }

  async offer_booking(args, conversation) {
    return withDispatcherLock(()=>this.#offerBooking(args,conversation));
  }

  #terms(profile,settings,service) {
    const state=readDispatcher();
    const version=state.policyRevision??state.active?.version??0;
    const fingerprint=createHash('sha256').update(JSON.stringify({profile,settings,service,version,knowledge:state.active?.knowledge??null})).digest('hex');
    return {fingerprint,timeZone:settings.timeZone,autoConfirm:settings.autoConfirm,version};
  }

  #readTerms(offer) { try { return JSON.parse(offer.terms_json??'null'); } catch { return null; } }
  #readOptions(offer) { try { return JSON.parse(offer.options_json??'[]'); } catch { return []; } }
  #assertTerms(offer,profile,settings,service) {
    if(this.#readTerms(offer)?.fingerprint!==this.#terms(profile,settings,service).fingerprint)throw new BookingError(409,'offer_changed','Условия записи изменились. Выберите время заново и подтвердите новую форму');
  }

  async #offerBooking({ service: query, start }, conversation) {
    const { profile, settings } = await this.#settings();
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
    const key=slotKey(startsAt,settings.timeZone);
    const options=availableSlots(this.#db,settings,service,{now:this.#now(),fromDate:key.slice(0,10),timeFrom:key.slice(11),limit:6});
    const terms=this.#terms(profile,settings,service);
    const offer = this.#store.offer(conversation.id, { serviceCode: service.code, serviceName: service.name, startsAt: startsAt.toISOString(), clientId: conversation.client_id ?? randomUUID(),terms,options });
    this.#log({ event: "booking_offered", conversation: conversation.id, offer: offer.id });
    return [
      `offer_created: offerId=${offer.id}; посетителю показана форма записи: «${service.name}», ${slotLabel(startsAt, settings.timeZone)}.`,
      settings.autoConfirm
        ? "После подтверждения в форме система проверит время и подтвердит запись, если оно свободно."
        : "После отправки формы компания получит запрос и подтвердит время отдельно.",
      "Попроси посетителя проверить время, указать имя и телефон в форме и нажать кнопку. Запись ещё НЕ создана: не говори, что посетитель записан, пока get_booking_status не вернёт confirmed."
    ].join("\n");
  }

  // Статус предложения с учётом решения сотрудника: подтверждённая или отменённая в офисе
  // предварительная запись меняет итог для посетителя и модели
  #status(offer) {
    if(offer.office_status)return offer.office_status==='cancelled'?'declined':['confirmed','arrived','completed'].includes(offer.office_status)?'confirmed':'requested';
    if (!offer.appointment_id) return offer.status;
    const appointment = this.#db.prepare("SELECT status FROM appointments WHERE id = ?").get(offer.appointment_id);
    if (appointment?.status === "cancelled") return "declined";
    if (["confirmed", "arrived", "completed"].includes(appointment?.status)) return "confirmed";
    return offer.status;
  }

  // Office external_id is the authoritative durable receipt, even if the second DB write failed.
  #recoverOffer(offer) {
    let appointment;
    try { appointment=this.#db.prepare("SELECT * FROM appointments WHERE source='website' AND external_id=?").get('chat:'+offer.id); }
    catch { throw new BookingError(503,'booking_status_unknown','Не удалось проверить результат записи. Не считайте её отменённой или неоформленной; повторите проверку результата'); }
    if(!appointment) {
      if(offer.appointment_id||['requested','confirmed'].includes(offer.status))throw new BookingError(503,'booking_status_unknown','Данные о результате записи расходятся. Требуется проверка сотрудника; не создавайте новую запись до проверки');
      return offer;
    }
    const status=['confirmed','arrived','completed'].includes(appointment.status)?'confirmed':'requested';
    const receipt={status,startsAt:appointment.starts_at,inquiryId:appointment.inquiry_id,appointmentId:appointment.id};
    if(offer.status!==status||offer.appointment_id!==appointment.id||offer.inquiry_id!==appointment.inquiry_id||offer.starts_at!==appointment.starts_at){
      try {this.#store.completeOffer(offer.id,receipt);}
      catch {this.#log({event:'booking_receipt_recovery_pending',offer:offer.id});}
    }
    return {...offer,status,starts_at:appointment.starts_at,inquiry_id:appointment.inquiry_id,appointment_id:appointment.id,office_status:appointment.status};
  }

  async get_booking_status({offerId} = {}, conversation) {
    const view=await this.pending(conversation.id,offerId??null);
    if(!view)return 'no_booking: предложение для проверки не найдено в этом диалоге';
    const when=view.label+' ('+view.timeZone+')';
    if(view.status==='declined')return 'declined: компания отклонила запись «'+view.service+'», '+when;
    if(view.status==='confirmed')return (view.mode==='request'?'confirmed: компания подтвердила запись — «':'confirmed: запись подтверждена — «')+view.service+'», '+when+', номер '+view.reference;
    if(view.status==='requested')return 'requested: запрос на запись «'+view.service+'», '+when+' принят, номер '+view.reference+'. Время ещё НЕ подтверждено: компания подтвердит его отдельно';
    if(view.status==='stale')return 'offer_changed: условия прежней формы изменились. Найди время заново и предложи новую форму. Не объявляй результат оформления без проверенной квитанции';
    if(view.status==='withdrawn')return 'offer_closed: это предложение заменено. Не объявляй его оформленным; проверь нужную форму по offerId';
    if(view.status==='offered')return 'waiting_for_form: подтверждённого результата оформления этой формы пока нет. Если посетитель уже отправил её, повтори проверку результата; не создавай новую запись до проверки';
    return 'booking_status_unknown: достоверный результат не определён. Требуется повторная проверка или сотрудник';
  }

  async pending(conversationId, offerId = null) {
    const stored=offerId?this.#store.getOffer(offerId):this.#store.latestOffer(conversationId);
    if(!stored||stored.conversation_id!==conversationId)return null;
    return this.#offerView(this.#recoverOffer(stored));
  }

  async #offerView(offer) {
    const {profile,settings}=offer.appointment_id?{profile:null,settings:{timeZone:'UTC'}}:await this.#settings();
    const terms=this.#readTerms(offer),zone=terms?.timeZone??settings.timeZone;
    const startsAt=new Date(offer.starts_at);
    const view={id:offer.id,status:this.#status(offer),service:offer.service_name,start:slotKey(startsAt,zone),label:slotLabel(startsAt,zone),mode:terms?.autoConfirm?'auto':'request',timeZone:zone,termsVersion:terms?.version??null,reference:offer.appointment_id?shortRef(offer.appointment_id):null};
    if(offer.status!=='offered')return view;
    const {service}=findBookableService(this.#db,offer.service_code);
    if(!service||terms?.fingerprint!==this.#terms(profile,settings,service).fingerprint)return {...view,status:'stale',options:[]};
    const options=this.#readOptions(offer).filter(option=>!slotProblem(this.#db,settings,service,new Date(option.startsAt),this.#now()));
    return {...view,options:options.map(slot=>({start:slot.key,label:slot.label}))};
  }

  async confirm(conversationId,{offerId,start,name,phone,consent}) {
    if(consent!==true)throw new BookingError(400,'consent_required','Нужно согласие на обработку контактов для записи');
    const stored=this.#store.getOffer(offerId);
    if(!stored||stored.conversation_id!==conversationId)throw new BookingError(404,'offer_not_found','Форма записи устарела');
    const offer=this.#recoverOffer(stored);
    if(['requested','confirmed'].includes(offer.status))return this.#offerView(offer);
    if(offer.status!=='offered')throw new BookingError(409,'offer_closed','Форма записи устарела: попросите AI-помощника предложить время заново');
    if(this.#confirming.has(offer.id))throw new BookingError(409,'booking_in_progress','Запись уже оформляется');
    this.#confirming.add(offer.id);
    try {return await this.#confirm(conversationId,offer,{start,name,phone});}
    catch(error){
      // Serialize the final receipt/absence check with supported booking writers.
      return await withDispatcherLock(async()=>{
        let current=offer;
        try{current=this.#store.getOffer(offer.id)??offer;}catch{/* already authorized; recover from the office */}
        const recovered=this.#recoverOffer(current);
        if(recovered.appointment_id)return this.#offerView(recovered);
        throw error;
      });
    }finally{this.#confirming.delete(offer.id);}
  }

  async #confirm(conversationId,offer,{start,name,phone}) {
    const {profile,settings}=await this.#settings();
    if(this.#unavailable(settings))throw new BookingError(409,'booking_disabled','Запись через чат сейчас недоступна');
    const {service}=findBookableService(this.#db,offer.service_code);
    if(!service||service.code!==offer.service_code)throw new BookingError(409,'service_unavailable','Услуга больше недоступна для записи');
    this.#assertTerms(offer,profile,settings,service);
    const selected=this.#readOptions(offer).find(option=>option.key===(start??slotKey(new Date(offer.starts_at),this.#readTerms(offer).timeZone)));
    if(!selected)throw new BookingError(400,'invalid_start','Форма не содержит такого времени. Выберите время из списка');
    const startsAt=new Date(selected.startsAt);
    const taken=()=>new BookingError(409,'slot_unavailable','Это время уже недоступно: выберите другое');
    if(slotProblem(this.#db,settings,service,startsAt,this.#now()))throw taken();
    let customer;
    try{customer=await this.#provider.createCustomer({displayName:name,phone},{clientId:offer.client_id,isDemo:settings.isDemo,allowSharedPhone:true,actor:ACTOR,source:'ai_dispatcher'});}
    catch(error){
      if(error instanceof CustomerError&&error.code==='invalid_input')throw new BookingError(400,'invalid_contact',error.message);
      throw new BookingError(503,'crm_unavailable','Не удалось сохранить контакты. Попробуйте позже');
    }
    this.#store.setClient(conversationId,customer.customer.id);
    return withDispatcherLock(async()=>{
      const latest=this.#recoverOffer(this.#store.getOffer(offer.id)??offer);
      if(['requested','confirmed'].includes(latest.status))return this.#offerView(latest);
      if(latest.status!=='offered')throw new BookingError(409,'offer_changed','Предложение заменено. Выберите время заново');
      const current=await this.#settings();
      const currentService=findBookableService(this.#db,offer.service_code).service;
      if(!currentService)throw new BookingError(409,'offer_changed','Услуга изменилась. Выберите время заново');
      this.#assertTerms(offer,current.profile,current.settings,currentService);
      const ctx=createContext(this.#db,{actor:ACTOR,source:'ai_dispatcher',now:this.#now,vocabulary:vocabularyFor(profile)});
      let result;
      try{
        result=bookSlot(ctx,{settings,service,startsAt,customerId:customer.customer.id,externalId:'chat:'+offer.id,description:'Запись через AI-чат сайта: '+service.name+', '+slotLabel(startsAt,settings.timeZone),autoConfirm:settings.autoConfirm,assertCurrentTerms:()=>this.#assertTerms(offer,current.profile,current.settings,findBookableService(this.#db,offer.service_code).service),confirmationBasis:'Клиент выбрал время и подтвердил запись в форме на сайте; автоподтверждение разрешено владельцем (booking.autoConfirm)'});
      }catch(error){
        if(error instanceof BookingConflictError)throw taken();
        if(error instanceof OfficeValidationError)throw new BookingError(409,'booking_rejected','Запись не создана: проверьте услугу и время');
        throw error;
      }
      const status=result.appointment.status==='confirmed'?'confirmed':'requested';
      this.#store.completeOffer(offer.id,{status,startsAt:result.appointment.starts_at,inquiryId:result.inquiryId,appointmentId:result.appointment.id});
      this.#log({event:'booking_'+status,conversation:conversationId,offer:offer.id,duplicate:result.duplicate});
      return this.pending(conversationId,offer.id);
    });
  }
}
