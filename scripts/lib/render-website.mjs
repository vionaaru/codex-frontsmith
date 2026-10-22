import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot, businessWebsiteRoot, websiteSourceRoot } from "./paths.mjs";
import { loadServiceCatalog } from "../../office/lib/catalog.mjs";

const websiteFiles = ["index.html"];

export async function renderWebsite() {
  const root = businessRoot();
  const websiteRoot = businessWebsiteRoot();
  const profilePath = businessPath("business.json");
  const profile = JSON.parse(await readRequiredFile(profilePath, missingInstanceMessage(profilePath)));
  const catalog = await loadServiceCatalog(profile);
  const business = { ...profile, services: catalog.services };
  const activityDir = path.join(root, "activity");
  const launchDir = path.join(root, "launch");
  const replacements = buildReplacements(business);

  await mkdir(websiteRoot, { recursive: true });
  await mkdir(activityDir, { recursive: true });
  await mkdir(launchDir, { recursive: true });

  await cp(websiteSourceRoot, websiteRoot, { recursive: true, force: false, errorOnExist: false });
  // HTML читается из шаблона при каждом обновлении; рабочие значения записываются только в приватную копию.
  for (const file of websiteFiles) {
    const current = await readWebsiteFile(file);
    await writeWebsiteFile(path.join(websiteRoot, file), updateWebsiteFile(current, replacements));
  }
  for (const file of ["styles.css", "script.js"]) {
    await cp(path.join(websiteSourceRoot, file), path.join(websiteRoot, file));
  }

  const reviewPath = path.join(launchDir, "website-review.md");
  const activityPath = path.join(activityDir, "latest-website-update.md");

  await writeFile(reviewPath, websiteReview(business, { root, catalog }));
  await writeFile(activityPath, latestWebsiteUpdate(business, { root }));

  return {
    business: profile,
    catalog,
    websiteDir: websiteRoot,
    reviewPath,
    activityPath,
    reviewDisplayPath: businessDisplayPath(root, "launch", "website-review.md"),
    activityDisplayPath: businessDisplayPath(root, "activity", "latest-website-update.md")
  };
}

async function readRequiredFile(file, message = null) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(message ?? `Не найден обязательный файл: ${file}`);
    }
    throw error;
  }
}

function missingInstanceMessage(profilePath) {
  return `Рабочие данные бизнеса не найдены: ${profilePath}. Сначала выполните npm run bootstrap.`;
}

function buildReplacements(business) {
  const websiteUrl = canonicalWebsiteUrl(business.websiteUrl ?? "http://localhost:4173");
  const bookingUrl = validatedBookingUrl(business.bookingUrl);
  const socialImage = absoluteUrl(websiteUrl, business.media?.socialImage ?? business.media?.heroImage ?? defaultImages.hero);
  const brandInitials = business.businessName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

  return {
    seoTitle: escapeHtml(business.seoTitle || `${business.businessName} | ${business.businessType || "Услуги"}`),
    seoDescription: escapeHtml(seoDescription(business)),
    canonicalUrl: escapeHtml(websiteUrl),
    ogTitle: escapeHtml(`${business.businessName} | ${displayLine(business.tagline)}`),
    ogImage: escapeHtml(socialImage),
    ogImageAlt: escapeHtml(business.media?.heroImageAlt || `Услуги ${business.businessName}`),
    businessName: escapeHtml(business.businessName),
    businessType: escapeHtml(business.businessType),
    logoImage: escapeHtml(business.media?.logoImage || "/avtoritm-mark.svg"),
    brandAriaLabel: escapeHtml(`${business.businessName} — в начало страницы`),
    telegramUrl: escapeHtml(business.contact.telegramUrl || "#contact"),
    whatsappUrl: escapeHtml(business.contact.whatsappUrl || "#contact"),
    mapsUrl: escapeHtml(business.contact.mapsUrl || "#contact"),
    reviewsUrl: escapeHtml(business.contact.mapsUrl ? `${business.contact.mapsUrl.replace(/\/+$/, "")}/reviews/` : "#contact"),
    directionsText: escapeHtml(`${business.contact.city}, ${business.contact.address || "Адрес уточняйте перед визитом"}. Перед первым визитом уточните въезд и расположение бокса.`),
    brandTagline: escapeHtml(displayLine(business.brandTagline ?? business.businessType ?? "Услуги")),
    tagline: escapeHtml(displayLine(business.tagline)),
    summary: escapeHtml(displayLine(business.summary)),
    brandInitials: escapeHtml(brandInitials),
    phone: escapeHtml(business.contact.phone),
    phoneTel: escapeHtml(`tel:${phoneHref(business.contact.phone)}`),
    whatsappHref: escapeHtml(whatsappHref(business.contact.phone)),
    email: escapeHtml(business.contact.email),
    emailMailto: escapeHtml(`mailto:${business.contact.email}`),
    city: escapeHtml(business.contact.city),
    state: escapeHtml(business.contact.state),
    cityState: escapeHtml([...new Set([business.contact.city, business.contact.state].filter(Boolean))].join(", ")),
    heroImage: escapeHtml(business.media?.heroImage ?? defaultImages.hero),
    heroImageAlt: escapeHtml(business.media?.heroImageAlt || `Услуги ${business.businessName}`),
    bookingUrl: escapeHtml(bookingUrl),
    bookingLabel: escapeHtml(business.bookingLabel || "Записаться"),
    hoursLabel: escapeHtml(business.hours?.label || "Время работы уточняйте перед визитом"),
    address: escapeHtml(business.contact.address || "Адрес уточняйте перед визитом"),
    pricingNote: escapeHtml(business.pricingPolicy?.note || "Стоимость согласуется до начала работ"),
    demoNotice: escapeHtml(business.demoMode ? "Учебная демонстрация. Контакты и цены — примеры. Запись открывается во внешнем сервисе; заявки не импортируются в Frontsmith." : ""),
    kitchenImage: escapeHtml(business.media?.kitchenImage ?? defaultImages.kitchen),
    bathroomImage: escapeHtml(business.media?.bathroomImage ?? defaultImages.bathroom),
    livingImage: escapeHtml(business.media?.livingImage ?? defaultImages.living),
    craftImage: escapeHtml(business.media?.craftImage ?? defaultImages.craft),
    faqImage: escapeHtml(business.media?.faqImage ?? defaultImages.faq),
    contactImage: escapeHtml(business.media?.contactImage ?? defaultImages.contact),
    servicesTitle: escapeHtml(`Услуги | ${business.businessName}`),
    servicesDescription: escapeHtml(
      `${business.services.map((service) => service.name).join(", ")} — ${business.businessName}`
    ),
    contactTitle: escapeHtml(`Контакты | ${business.businessName}`),
    contactDescription: escapeHtml(`Свяжитесь с ${business.businessName}, чтобы обсудить услугу`),
    decisionIntro: escapeHtml(
      "Начните с задачи, пожеланий и удобного времени"
    ),
    frontOfficePromise: escapeHtml(
      business.summary || `${business.businessName}: понятные услуги и согласование работ до начала выполнения.`
    ),
    serviceAreaIntro: escapeHtml(
      "Уточните удобное место и время обслуживания перед записью."
    ),
    homepageContactText: escapeHtml(
      "Выберите услугу и удобный способ связи"
    ),
    contactCta: escapeHtml(`Связаться с ${business.businessName}`),
    servicesIntro: escapeHtml(
      "Выберите услугу"
    ),
    servicesContactText: escapeHtml(
      "Расскажите о проекте и выберите следующий шаг"
    ),
    contactIntro: escapeHtml(
      "Расскажите о проекте перед первым звонком"
    ),
    projectTypeDefault: escapeHtml(displayServiceName(business.services[0]?.name ?? "Услуга")),
    serviceCards: serviceCards(business.services, business),
    serviceRows: serviceRows(business.services),
    serviceOptions: serviceOptions(business.services),
    serviceAreaPills: serviceAreaPills(business.serviceAreas),
    serviceAreaList: serviceAreaList(business.serviceAreas),
    currentYear: String(new Date().getFullYear())
  };
}

const defaultImages = Object.fromEntries(
  ["hero", "kitchen", "bathroom", "living", "craft", "faq", "contact"]
    .map((key) => [key, "/assets/auto-workshop.png"])
);

export function validatedBookingUrl(value) {
  if (!value) return "#contact";
  const raw = String(value).trim();
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("bookingUrl должен быть абсолютной ссылкой HTTP или HTTPS"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("bookingUrl должен использовать HTTP или HTTPS без учётных данных");
  }
  return raw;
}

const phoneKeypad = {
  A: "2",
  B: "2",
  C: "2",
  D: "3",
  E: "3",
  F: "3",
  G: "4",
  H: "4",
  I: "4",
  J: "5",
  K: "5",
  L: "5",
  M: "6",
  N: "6",
  O: "6",
  P: "7",
  Q: "7",
  R: "7",
  S: "7",
  T: "8",
  U: "8",
  V: "8",
  W: "9",
  X: "9",
  Y: "9",
  Z: "9"
};

function phoneHref(phone) {
  let href = "";
  for (const char of String(phone).toUpperCase()) {
    if (/\d/.test(char)) href += char;
    if (char === "+" && href.length === 0) href += char;
    if (phoneKeypad[char]) href += phoneKeypad[char];
  }
  return href;
}

function whatsappHref(phone) {
  const digits = phoneHref(phone).replace(/^\+/, "");
  return digits ? `https://wa.me/${digits}` : "#contact";
}

function canonicalWebsiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "http://localhost:4173";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function absoluteUrl(base, value) {
  const raw = String(value ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${base}${raw}`;
  return `${base}/${raw.replace(/^\/+/, "")}`;
}

function seoDescription(business) {
  if (business.seoDescription) return business.seoDescription;
  return `${displayLine(business.summary)} от ${business.businessName}: понятный объём работ, практические рекомендации, сроки и удобная связь`;
}

function updateWebsiteFile(content, replacements) {
  return replaceMarkedContent(replaceMarkedAttributes(content, replacements), "text", replacements)
    .replace(replacePattern("html"), (match, open, tag, key, inner, close) => {
      return `${open}${replacementFor(replacements, key)}${close}`;
    });
}

export function renderWebsiteHtml(content, business) {
  return updateWebsiteFile(content, buildReplacements(business));
}

function replaceMarkedContent(content, type, replacements) {
  return content.replace(replacePattern(type), (match, open, tag, key, inner, close) => {
    return `${open}${replacementFor(replacements, key)}${close}`;
  });
}

function replacePattern(type) {
  return new RegExp(
    `(<([a-zA-Z0-9-]+)\\b(?=[^>]*\\bdata-frontsmith-${type}="([^"]+)")[^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
    "g"
  );
}

function replaceMarkedAttributes(content, replacements) {
  return content.replace(/<[^>]+data-frontsmith-attrs="([^"]+)"[^>]*>/g, (tag, spec) => {
    return spec.split(",").reduce((updatedTag, instruction) => {
      const [attribute, key] = instruction.split(":").map((part) => part.trim());
      if (!attribute || !key) {
        throw new Error(`Неверная инструкция атрибута сайта: ${instruction}`);
      }
      return setAttribute(updatedTag, attribute, replacementFor(replacements, key));
    }, tag);
  });
}

function setAttribute(tag, attribute, value) {
  const pattern = new RegExp(`\\s${escapeRegExp(attribute)}="[^"]*"`);
  if (pattern.test(tag)) {
    return tag.replace(pattern, ` ${attribute}="${value}"`);
  }
  return tag.replace(/\/?>$/, (ending) => ` ${attribute}="${value}"${ending}`);
}

function replacementFor(replacements, key) {
  if (!(key in replacements)) {
    throw new Error(`Нет подстановки сайта: ${key}`);
  }
  return replacements[key];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoLegacyTokens(content, file) {
  if (/\{\{[a-zA-Z0-9]+\}\}/.test(content)) {
    throw new Error(`В ${file} найден устаревший шаблонный маркер`);
  }
}

function assertHasMarkers(content, file) {
  if (!content.includes("data-frontsmith-")) {
    throw new Error(`В файле ${file} нет маркеров обновления Frontsmith`);
  }
}

async function readWebsiteFile(file) {
  const content = await readRequiredFile(path.join(websiteSourceRoot, file));
  assertNoLegacyTokens(content, file);
  assertHasMarkers(content, file);
  return content;
}

async function writeWebsiteFile(file, content) {
  assertNoLegacyTokens(content, file);
  await writeFile(file, content);
}

function serviceCards(services, business) {
  const bookingUrl = validatedBookingUrl(business.bookingUrl);
  const currency = business.currency || "RUB";
  const cards = services.map((service, index) => {
    const price = service.priceFrom === 0 ? "Бесплатно" :
      typeof service.priceFrom === "number" && Number.isFinite(service.priceFrom) && service.priceFrom > 0
        ? `от ${new Intl.NumberFormat("ru-RU", { style: "currency", currency, maximumFractionDigits: 0 }).format(service.priceFrom)}`
        : "По согласованию";
    const duration = Number.isFinite(service.durationMinutes) && service.durationMinutes > 0
      ? `${service.durationMinutes} мин` : "Время уточняется";
    const external = bookingUrl.startsWith("http:") || bookingUrl.startsWith("https:");
    return `<article class="service-card" data-service-category="${escapeHtml(service.category || "general")}">
            <header class="service-card-header">
              <span class="item-index">${String(index + 1).padStart(2, "0")}</span>
              <h3 class="service-name">${escapeHtml(service.name)}</h3>
            </header>
            <p class="service-description">${escapeHtml(service.description || "Объём работ согласуется перед выполнением.")}</p>
            <footer class="service-meta"><strong class="service-price">${escapeHtml(price)}</strong><span class="service-duration">${escapeHtml(duration)}</span></footer>
            <a class="booking-link" data-booking-link href="${escapeHtml(bookingUrl)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(business.bookingLabel || "Записаться")}</a>
          </article>`;
  }).join("\n          ");
  return `\n          ${cards}\n        `;
}

function displayServiceName(name) {
  return String(name);
}

function serviceRows(services) {
  const rows = services
    .map(
      (service) => `<li>
            <strong>${escapeHtml(service.name)}</strong>
            <span>${escapeHtml(service.description)}</span>
          </li>`
    )
    .join("\n          ");
  return `\n          ${rows}\n        `;
}

function serviceOptions(services) {
  const serviceNames = services.map((service) => displayServiceName(service.name));
  const options = [...serviceNames, "Другое"]
    .filter((name, index, names) => names.indexOf(name) === index)
    .map((service, index) => {
      const name = escapeHtml(service);
      return `<button class="custom-select-option" type="button" role="option" data-value="${name}" aria-selected="${index === 0 ? "true" : "false"}">${name}</button>`;
    })
    .join("\n                  ");
  return `\n              ${options}\n            `;
}

function serviceAreaPills(serviceAreas) {
  const pills = serviceAreas.map((area) => `<span>${escapeHtml(area)}</span>`).join("\n          ");
  return `\n          ${pills}\n        `;
}

function serviceAreaList(serviceAreas) {
  const areas = serviceAreas.map((area) => `<li>${escapeHtml(area)}</li>`).join("\n          ");
  return `\n          ${areas}\n        `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayLine(value) {
  return String(value).trim().replace(/[.!?]+$/g, "");
}

function websiteReview(profile, { root, catalog }) {
  return `# Проверка сайта

Бизнес: ${profile.businessName}
Статус: предпросмотр, нужна проверка владельцем, не опубликован
Обновлено: ${new Date().toISOString()}

## Краткая сводка

Сайт обновлён из локального профиля ${profile.businessName}. До публикации проверьте тексты, контакты, услуги, территорию обслуживания, метаданные поиска и соцсетей, доставку заявок. Сайт не опубликован.

## Изменённые файлы

- ${businessDisplayPath(root, "website", "index.html")}
- ${businessDisplayPath(root, "launch", "website-review.md")}
- ${businessDisplayPath(root, "activity", "latest-website-update.md")}

## Обновлено из профиля бизнеса

- Название бизнеса: ${profile.businessName}
- URL сайта: ${canonicalWebsiteUrl(profile.websiteUrl)}
- Телефон: ${profile.contact.phone}
- Email: ${profile.contact.email}
- Территория обслуживания: ${profile.serviceAreas.join(", ")}
- Услуги: ${profile.services.map((service) => service.name).join(", ")}
- Источник прайса: ${catalog.note}
- Тон общения: ${profile.brandVoice}

## Связь профиля и сайта

- Исходный профиль: ${businessDisplayPath(root, "business.json")}
- Шаблон сайта: website/index.html (код в Git)
- Рабочий сайт: ${businessDisplayPath(root, "website", "index.html")} (данные вне Git)
- Проверка запуска: ${businessDisplayPath(root, "launch", "website-review.md")}
- Запись действия: ${businessDisplayPath(root, "activity", "latest-website-update.md")}

## Проверка владельцем

- Проверьте название бизнеса, URL сайта, телефон, email, город и регион
- Проверьте названия и описания услуг, территорию обслуживания
- Проверьте обещания главной страницы, призывы к действию и способы связи
- Убедитесь, что публичные утверждения не преувеличивают возможности бизнеса
- Согласуйте фотографии для публичного использования
- Проверьте переменные доставки заявок до использования формы

## Локальный предпросмотр

1. Выполните \`npm run preview:website\`
2. Откройте адрес локального предпросмотра
3. Учебный \`/website\` в сборке панели демонстрации не содержит приватных данных бизнеса

## Препятствия публикации

- Перед публикацией нужно согласие владельца
- До публикации проверьте проект Vercel и настройки домена
- До использования формы настройте переменные Resend и доставки заявок
- Изменения DNS и сервисов заблокированы до явного согласования

## Материалы

- Рабочий сайт: ${businessDisplayPath(root, "website", "index.html")}
- Исходники сайта: website/index.html
- Стили сайта: website/styles.css
- Скрипт сайта: website/script.js
- Обработчик формы: api/contact.js
- Материалы проверки: ${businessDisplayPath(root, "launch", "website-review.md")}
- Запись действия: ${businessDisplayPath(root, "activity", "latest-website-update.md")}

## Границы безопасности

Это локальное обновление сайта. Оно не публикует сайт, не меняет DNS, не подключает сервисы, не настраивает Resend и не отправляет сообщения клиентам.
`;
}

function latestWebsiteUpdate(profile, { root }) {
  return `# Последнее обновление сайта

Бизнес: ${profile.businessName}
Статус: локальное обновление, нужна проверка владельцем
Обновлено: ${new Date().toISOString()}

## Краткая сводка

Сайт обновлён из профиля бизнеса, материалы проверки сохранены. Сайт готов к локальному предпросмотру, но не к публикации.

## Изменённые файлы

- ${businessDisplayPath(root, "website", "index.html")}
- ${businessDisplayPath(root, "launch", "website-review.md")}
- ${businessDisplayPath(root, "activity", "latest-website-update.md")}

## Обновлено

- Сведения о бизнесе и способы связи
- Услуги и территория обслуживания
- Тексты главной страницы и призывы к действию
- SEO, canonical и метаданные Open Graph и Twitter
- Выбранные способы связи и переход к записи

## Перед публикацией

- Проверьте локально через \`npm run preview:website\`
- Выполните \`npm run deploy:check\`
- Проверьте ${businessDisplayPath(root, "launch", "website-review.md")}
- Явно согласуйте публикацию, DNS и настройку доставки заявок

## Материалы

- Рабочий сайт: ${businessDisplayPath(root, "website", "index.html")}
- Материалы проверки: ${businessDisplayPath(root, "launch", "website-review.md")}
- Запись действия: ${businessDisplayPath(root, "activity", "latest-website-update.md")}

## Границы безопасности

Обновление не публиковало сайт, не меняло DNS, не настраивало доставку заявок и не отправляло сообщения клиентам.
`;
}

function businessDisplayPath(root, ...segments) {
  return toPosix(path.join(".frontsmith", "business", ...segments));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
