const header = document.querySelector("[data-header]");
const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
const navClose = document.querySelector("[data-nav-close]");
const navBackdrop = document.querySelector("[data-nav-backdrop]");
const intakeForm = document.querySelector("[data-intake-form]");
const intakeError = document.querySelector("[data-intake-error]");
const intakeStatus = document.querySelector("[data-intake-status]");
const intakeSubmit = document.querySelector("[data-intake-submit]");
const contactEmail = document.querySelector("[data-contact-email]");
const contactPhone = document.querySelector("[data-contact-phone]");

function syncHeader() {
  header.classList.toggle("scrolled", window.scrollY > 16);
}

function closeNav() {
  document.body.classList.remove("nav-open");
  header.classList.remove("nav-active");
  nav.classList.remove("open");
  navToggle.setAttribute("aria-expanded", "false");
  navToggle.setAttribute("aria-label", "Открыть меню");
}

function targetFromHash(hash) {
  if (!hash || hash === "#") return null;
  if (hash === "#top") return document.getElementById("top");

  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return document.getElementById(hash.slice(1));
  }
}

function scrollToTarget(target, hash, behavior = "smooth") {
  const headerOffset = Math.round(header.getBoundingClientRect().height);
  const targetTop = target === document.getElementById("top")
    ? 0
    : Math.max(0, Math.round(window.scrollY + target.getBoundingClientRect().top - headerOffset));

  window.scrollTo({ top: targetTop, behavior });

  if (hash && window.location.hash !== hash) {
    history.pushState(null, "", hash);
  }
}

function scrollAfterNavClose(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

syncHeader();
window.addEventListener("scroll", syncHeader, { passive: true });

navToggle.addEventListener("click", () => {
  const isOpen = nav.classList.toggle("open");
  document.body.classList.toggle("nav-open", isOpen);
  header.classList.toggle("nav-active", isOpen);
  navToggle.setAttribute("aria-expanded", String(isOpen));
  navToggle.setAttribute("aria-label", isOpen ? "Закрыть меню" : "Открыть меню");
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;

  const anchor = event.target.closest('a[href^="#"]');
  if (!anchor) return;

  const target = targetFromHash(anchor.hash);
  if (!target) return;

  event.preventDefault();
  closeNav();

  scrollAfterNavClose(() => {
    scrollToTarget(target, anchor.hash);
  });
});

window.addEventListener("load", () => {
  if (window.location.hash) {
    const target = targetFromHash(window.location.hash);
    if (target) {
      requestAnimationFrame(() => {
        scrollToTarget(target, window.location.hash, "auto");
      });
    }
  }
});

navBackdrop.addEventListener("click", closeNav);
navClose.addEventListener("click", closeNav);

function closeCustomSelects(except = null) {
  document.querySelectorAll("[data-custom-select].open").forEach((select) => {
    if (select === except) return;
    select.classList.remove("open");
    select.querySelector(".custom-select-button")?.setAttribute("aria-expanded", "false");
  });
}

function resetCustomSelects() {
  document.querySelectorAll("[data-custom-select]").forEach((select) => {
    const field = select.closest(".custom-select-field");
    const valueInput = field?.querySelector("[data-custom-select-value]");
    const label = select.querySelector("[data-custom-select-label]");
    const options = [...select.querySelectorAll(".custom-select-option")];
    const selected = options[0];

    if (!selected) return;

    const value = selected.dataset.value ?? selected.textContent.trim();
    valueInput.value = value;
    label.textContent = selected.textContent.trim();
    options.forEach((item) => item.setAttribute("aria-selected", String(item === selected)));
  });
}

document.querySelectorAll("[data-custom-select]").forEach((select) => {
  const field = select.closest(".custom-select-field");
  const valueInput = field?.querySelector("[data-custom-select-value]");
  const label = select.querySelector("[data-custom-select-label]");
  const button = select.querySelector(".custom-select-button");
  const options = [...select.querySelectorAll(".custom-select-option")];

  button.addEventListener("click", () => {
    const isOpen = select.classList.toggle("open");
    button.setAttribute("aria-expanded", String(isOpen));
    closeCustomSelects(select);
  });

  options.forEach((option) => {
    option.addEventListener("click", () => {
      const value = option.dataset.value ?? option.textContent.trim();
      valueInput.value = value;
      label.textContent = option.textContent.trim();
      options.forEach((item) => item.setAttribute("aria-selected", String(item === option)));
      closeCustomSelects();
      button.focus();
    });
  });

  select.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCustomSelects();
      button.focus();
    }
  });
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest("[data-custom-select]")) {
    closeCustomSelects();
  }
});

function setIntakeError(message, fields = []) {
  intakeError.textContent = message;
  intakeError.hidden = !message;
  if (message) setIntakeStatus("");

  [contactEmail, contactPhone].forEach((field) => {
    field.classList.toggle("is-invalid", fields.includes(field));
  });
}

function setIntakeStatus(message, type = "success") {
  intakeStatus.textContent = message;
  intakeStatus.hidden = !message;
  intakeStatus.dataset.status = type;
  if (message) setIntakeError("");
}

function validateIntakeForm() {
  const email = contactEmail.value.trim();
  const phone = contactPhone.value.trim();

  if (!email && !phone) {
    setIntakeError("Укажите электронную почту или телефон, чтобы мы могли ответить", [contactEmail, contactPhone]);
    return false;
  }

  if (email && !contactEmail.validity.valid) {
    setIntakeError("Укажите корректный адрес электронной почты или оставьте поле пустым и укажите телефон", [contactEmail]);
    return false;
  }

  setIntakeError("");
  return true;
}

function intakePayload() {
  return Object.fromEntries(new FormData(intakeForm).entries());
}

function fallbackMailto(payload) {
  const fallbackAction = intakeForm.dataset.fallbackAction || "mailto:";
  const subject = `Заявка на проект${payload.name ? ` от ${payload.name}` : ""}`;
  const body = [
    "Заявка на проект",
    "",
    fieldLine("Имя", payload.name),
    fieldLine("Электронная почта", payload.email),
    fieldLine("Телефон", payload.phone),
    fieldLine("Предпочтительный способ связи", displayOption(payload.preferred_contact)),
    fieldLine("Тип проекта", displayOption(payload.project_type)),
    fieldLine("Адрес объекта", payload.project_location),
    fieldLine("Желаемые сроки", payload.ideal_timeline),
    fieldLine("Бюджет", payload.budget_comfort),
    "",
    "Описание проекта",
    payload.project_notes || "Не указано"
  ]
    .filter((line) => line !== null)
    .join("\n");
  const separator = fallbackAction.includes("?") ? "&" : "?";

  setIntakeStatus("Открываем почтовое приложение для отправки заявки", "notice");
  window.location.href = `${fallbackAction}${separator}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function fieldLine(label, value) {
  return value ? `${label}: ${value}` : null;
}

function displayOption(value) {
  return {
    Email: "Электронная почта",
    Phone: "Телефон",
    "Kitchen remodeling": "Ремонт кухни",
    "Bathroom remodeling": "Ремонт ванной",
    "Living spaces": "Жилые помещения",
    Other: "Другое"
  }[value] || value;
}

function setSubmitting(isSubmitting) {
  intakeSubmit.disabled = isSubmitting;
  intakeForm.setAttribute("aria-busy", String(isSubmitting));
  intakeSubmit.textContent = isSubmitting ? "Отправляем заявку" : intakeForm.dataset.demoMode === "true" ? "Проверить вопрос" : "Отправить заявку";
}

intakeForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!validateIntakeForm()) {
    (contactEmail.classList.contains("is-invalid") ? contactEmail : contactPhone).focus();
    return;
  }

  const payload = intakePayload();
  if (intakeForm.dataset.demoMode === "true") {
    setIntakeStatus("Учебный вопрос проверен. Данные никуда не отправлены и запись не создана. Для выбора времени откройте Booking Flow.", "success");
    return;
  }
  setSubmitting(true);
  setIntakeStatus("");

  try {
    const response = await fetch(intakeForm.action, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => null);

    if (response.ok && result?.ok) {
      intakeForm.reset();
      resetCustomSelects();
      setIntakeStatus("Заявка отправлена. Мы ответим выбранным вами способом связи");
      return;
    }

    if (result?.code === "contact_not_configured" || response.status === 404) {
      fallbackMailto(payload);
      return;
    }

    setIntakeError(result?.error || "Не удалось отправить заявку. Попробуйте позже");
  } catch {
    fallbackMailto(payload);
  } finally {
    setSubmitting(false);
  }
});

[contactEmail, contactPhone].forEach((field) => {
  field.addEventListener("input", () => {
    if (!intakeError.hidden) validateIntakeForm();
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeNav();
    closeCustomSelects();
  }
});

const serviceFilters = [...document.querySelectorAll("[data-service-filter]")];
serviceFilters.forEach((button) => {
  button.addEventListener("click", () => {
    const category = button.dataset.serviceFilter;
    serviceFilters.forEach((filter) => {
      const selected = filter === button;
      filter.classList.toggle("is-active", selected);
      filter.setAttribute("aria-pressed", String(selected));
    });
    let visibleCount = 0;
    document.querySelectorAll("[data-service-category]").forEach((card) => {
      card.hidden = category !== "all" && card.dataset.serviceCategory !== category;
      if (!card.hidden) visibleCount++;
    });
    const status = document.querySelector("[data-service-filter-status]");
    if (status) status.textContent = `Показано услуг: ${visibleCount}`;
  });
});
