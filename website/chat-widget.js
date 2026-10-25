// AI-чат сайта: виджет ChatCops (vendor/chatcops/chatcops.min.js, MIT, CoderCops)
// и веб-канал Frontsmith /api/chat. Ответы готовит AI-помощник через Codex App Server;
// сайт не обращается к модели напрямую.
//
// Чат открывает только посетитель: кнопка в углу или элементы с data-chat-open.
// Автоматического всплытия и приветственных пузырей нет. Видимая история хранится
// в браузере посетителя, контекст разговора — на сервере Frontsmith.
//
// Форма записи: когда AI-помощник предложил время, сайт показывает форму с вариантами
// времени из расписания компании, именем, телефоном и согласием. Контакты уходят
// напрямую серверу Frontsmith (CustomerProvider), в чат и модели они не передаются.
(function () {
  "use strict";

  var ChatCops = window.ChatCops;
  if (!ChatCops) return;

  var siteName = document.querySelector('meta[property="og:site_name"]');
  var name = (siteName && siteName.content) || "Компания";

  ChatCops.init({
    apiUrl: "/api/chat",
    // Ответ Codex может занять больше 30 секунд; сервер держит поток комментариями keepalive
    timeout: 120000,
    locale: "ru",
    pageContext: false,
    persistHistory: true,
    theme: { accent: "#ffad45", textColor: "#111820", bgColor: "#fffdf8", fontFamily: "Arial, sans-serif", borderRadius: 4, position: "bottom-right" },
    branding: { name: name, subtitle: "AI-помощник" },
    welcomeMessage: "Здравствуйте! Я AI-помощник. Отвечаю по сведениям с сайта компании и помогаю записаться на услугу. Если ответа нет, так и скажу",
    strings: {
      inputPlaceholder: "Напишите вопрос…",
      sendButton: "Отправить",
      closeButton: "Закрыть",
      openChat: "Задать вопрос AI",
      defaultName: "AI-помощник",
      defaultSubtitle: "AI-помощник",
      errorGeneric: "Не удалось получить ответ. Попробуйте ещё раз",
      errorNetwork: "Нет связи с сайтом. Проверьте подключение",
      errorRateLimit: "Слишком много сообщений. Подождите немного",
      errorRateLimitWait: "Слишком много сообщений. Повторите через {seconds} с",
      errorBudget: "Лимит этого разговора исчерпан",
      errorBudgetDaily: "AI-помощник исчерпал лимит на сегодня. Свяжитесь с нами по контактам на сайте",
      errorUnavailable: "AI-помощник сейчас недоступен, сообщение не обработано. Свяжитесь с нами по контактам на сайте",
      errorCutOff: "Ответ оборвался. Попробуйте ещё раз",
      typingIndicator: "Готовлю ответ…",
      newConversation: "Новый разговор",
      retryButton: "Повторить",
      regenerateButton: "Другой ответ"
    }
  });

  // Повторная генерация ответа каналом не поддерживается: кнопку скрываем внутри Shadow DOM
  var host = document.getElementById("chatcops-root");
  var shadow = host && host.shadowRoot;
  if (shadow) {
    var style = document.createElement("style");
    style.textContent = ".cc-message-regenerate{display:none!important}";
    shadow.appendChild(style);
  }

  document.querySelectorAll("[data-chat-open]").forEach(function (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      ChatCops.open();
    });
  });

  // --- Форма записи ---

  var SESSION_KEY = "chatcops-session:/api/chat";
  var shownOffer = null;

  function session() {
    try {
      var saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
      return saved.token && saved.conversationId ? saved : null;
    } catch (error) {
      return null;
    }
  }

  function api(path, body) {
    var saved = session();
    if (!saved) return Promise.resolve(null);
    body.conversationId = saved.conversationId;
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + saved.token },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  var css = document.createElement("style");
  css.textContent = [
    ".fs-booking{position:fixed;inset:0;z-index:10010;display:flex;align-items:center;justify-content:center;background:#11182080;padding:16px;font-family:Arial,sans-serif;color:#111820}",
    ".fs-booking[hidden]{display:none}",
    ".fs-booking-card{width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow:auto;background:#fffdf8;border-radius:4px;padding:22px;box-shadow:0 18px 50px #11182040}",
    ".fs-booking h2{margin:0 0 4px;font-size:20px;line-height:1.25}",
    ".fs-booking p{margin:0 0 14px;font-size:14px;line-height:1.45;color:#3c454e}",
    ".fs-booking fieldset{border:0;margin:0 0 14px;padding:0;display:grid;gap:6px}",
    ".fs-booking legend,.fs-booking label.fs-field{font-size:13px;font-weight:700;margin-bottom:4px}",
    ".fs-booking .fs-slot{display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid #d8d8d1;border-radius:4px;font-size:14px;cursor:pointer}",
    ".fs-booking .fs-slot:has(input:checked){border-color:#111820;background:#f5f2eb}",
    ".fs-booking label.fs-field{display:grid;gap:4px;margin-bottom:12px}",
    ".fs-booking input[type=text],.fs-booking input[type=tel]{font:inherit;font-size:16px;padding:10px 12px;border:1px solid #d8d8d1;border-radius:4px;font-weight:400}",
    ".fs-booking .fs-consent{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4;margin-bottom:14px}",
    ".fs-booking .fs-error{color:#a12b1f;font-size:14px;margin:0 0 12px}",
    ".fs-booking .fs-actions{display:flex;gap:10px;flex-wrap:wrap}",
    ".fs-booking button{font:inherit;font-size:14px;font-weight:700;padding:13px 18px;border-radius:4px;border:1px solid #111820;cursor:pointer}",
    ".fs-booking .fs-primary{background:#ffad45;border-color:#ffad45;color:#111820}",
    ".fs-booking .fs-secondary{background:transparent;color:#111820}",
    ".fs-booking button:disabled{opacity:.6;cursor:wait}",
    "@media (max-width:480px){.fs-booking{align-items:flex-end;padding:0}.fs-booking-card{max-width:none;max-height:92dvh;border-radius:4px 4px 0 0}}"
  ].join("");
  document.head.appendChild(css);

  var overlay = el("div", { class: "fs-booking", role: "dialog", "aria-modal": "true", "aria-labelledby": "fs-booking-title" });
  overlay.hidden = true;
  document.body.appendChild(overlay);

  function close() {
    overlay.hidden = true;
    overlay.textContent = "";
  }

  // Сообщение в чат после отправки формы: AI-помощник проверит итог записи и ответит
  function tellAssistant(text) {
    var input = shadow && shadow.querySelector("textarea");
    var send = shadow && shadow.querySelector(".cc-send-btn");
    if (!input || !send) return;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }

  function showResult(offer) {
    overlay.textContent = "";
    var confirmed = offer.status === "confirmed";
    overlay.appendChild(el("div", { class: "fs-booking-card" }, [
      el("h2", { id: "fs-booking-title", text: confirmed ? "Вы записаны" : "Запрос на запись отправлен" }),
      el("p", { text: offer.service + ", " + offer.label + (offer.reference ? ". Номер " + offer.reference : "") }),
      el("p", { text: confirmed ? "Время подтверждено. Если планы изменятся, свяжитесь с нами по контактам на сайте" : "Время ещё не подтверждено: компания свяжется с вами, чтобы подтвердить запись" }),
      el("div", { class: "fs-actions" }, [buttonClose("Готово")])
    ]));
    overlay.hidden = false;
  }

  function buttonClose(text) {
    var button = el("button", { type: "button", class: "fs-secondary", text: text });
    button.addEventListener("click", close);
    return button;
  }

  function showForm(offer, message) {
    overlay.textContent = "";
    var auto = offer.mode === "auto";
    var options = offer.options || [];
    var form = el("form", { novalidate: "novalidate" });
    var error = el("p", { class: "fs-error", role: "alert" });
    error.hidden = !message;
    error.textContent = message || "";

    var slots = el("fieldset", {}, [el("legend", { text: "Время" })]);
    if (!options.length) {
      slots.appendChild(el("p", { text: "Свободного времени для этой услуги сейчас нет. Напишите AI-помощнику, чтобы подобрать другую дату" }));
    }
    var selected = options.some(function (option) { return option.start === offer.start; }) ? offer.start : options.length ? options[0].start : null;
    options.forEach(function (option) {
      var radio = el("input", { type: "radio", name: "start", value: option.start });
      radio.checked = option.start === selected;
      slots.appendChild(el("label", { class: "fs-slot" }, [radio, el("span", { text: option.label })]));
    });

    var nameInput = el("input", { type: "text", name: "name", autocomplete: "name", maxlength: "200", required: "required" });
    var phoneInput = el("input", { type: "tel", name: "phone", autocomplete: "tel", maxlength: "40", required: "required", placeholder: "+7 900 000-00-00" });
    var consent = el("input", { type: "checkbox", name: "consent" });
    var submit = el("button", { type: "submit", class: "fs-primary", text: auto ? "Записаться" : "Отправить запрос" });
    submit.disabled = !options.length;

    form.appendChild(el("h2", { id: "fs-booking-title", text: "Запись: " + offer.service }));
    form.appendChild(el("p", { text: auto ? "Проверьте время и укажите контакты. Запись подтвердится сразу, если время ещё свободно" : "Проверьте время и укажите контакты. Компания получит запрос и подтвердит время" }));
    form.appendChild(slots);
    form.appendChild(el("label", { class: "fs-field" }, [el("span", { text: "Имя" }), nameInput]));
    form.appendChild(el("label", { class: "fs-field" }, [el("span", { text: "Телефон" }), phoneInput]));
    form.appendChild(el("label", { class: "fs-consent" }, [consent, el("span", { text: "Даю согласие на обработку имени и телефона для записи. Они передаются компании, а не AI-помощнику" })]));
    form.appendChild(error);
    form.appendChild(el("div", { class: "fs-actions" }, [submit, buttonClose("Не сейчас")]));

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var chosen = form.querySelector("input[name=start]:checked");
      var fail = function (text) { error.textContent = text; error.hidden = false; };
      if (!chosen) return fail("Выберите время");
      if (!nameInput.value.trim()) return fail("Укажите имя");
      if (!phoneInput.value.trim()) return fail("Укажите телефон");
      if (!consent.checked) return fail("Нужно согласие на обработку контактов");
      submit.disabled = true;
      api("/api/chat/booking/confirm", { offerId: offer.id, start: chosen.value, name: nameInput.value, phone: phoneInput.value, consent: true }).then(function (result) {
        if (result && result.ok && result.data.offer) {
          shownOffer = result.data.offer.id;
          showResult(result.data.offer);
          tellAssistant("Форма записи отправлена");
          return;
        }
        var data = (result && result.data) || {};
        if (data.offer && data.offer.status === "offered") return showForm(data.offer, (data.error && data.error.message) || "Это время недоступно");
        submit.disabled = false;
        fail((data.error && data.error.message) || "Не удалось отправить форму. Попробуйте ещё раз");
      }, function () {
        submit.disabled = false;
        fail("Нет связи с сайтом. Попробуйте ещё раз");
      });
    });

    overlay.appendChild(el("div", { class: "fs-booking-card" }, [form]));
    overlay.hidden = false;
    nameInput.focus();
  }

  // Новое предложение записи открывает форму один раз; после перезагрузки страницы неотправленная форма открывается снова
  function checkBooking() {
    api("/api/chat/booking", {}).then(function (result) {
      var offer = result && result.ok && result.data.offer;
      if (!offer || offer.status !== "offered" || offer.id === shownOffer) return;
      shownOffer = offer.id;
      showForm(offer);
    }, function () {});
  }

  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
  ChatCops.on("message", function (message) {
    if (message && message.role === "assistant") checkBooking();
  });
  checkBooking();
})();
