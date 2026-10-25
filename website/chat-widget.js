// AI-чат сайта: виджет ChatCops (vendor/chatcops/chatcops.min.js, MIT, CoderCops)
// и веб-канал Frontsmith /api/chat. Ответы готовит AI-помощник через Codex App Server;
// сайт не обращается к модели напрямую.
//
// Чат открывает только посетитель: кнопка в углу или элементы с data-chat-open.
// Автоматического всплытия и приветственных пузырей нет. Видимая история хранится
// в браузере посетителя, контекст разговора — на сервере Frontsmith.
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
    welcomeMessage: "Здравствуйте! Я AI-помощник. Отвечаю по сведениям с сайта компании. Если ответа там нет, так и скажу и подскажу, как связаться с сотрудником",
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
  if (host && host.shadowRoot) {
    var style = document.createElement("style");
    style.textContent = ".cc-message-regenerate{display:none!important}";
    host.shadowRoot.appendChild(style);
  }

  document.querySelectorAll("[data-chat-open]").forEach(function (button) {
    button.hidden = false;
    button.addEventListener("click", function () {
      ChatCops.open();
    });
  });
})();
