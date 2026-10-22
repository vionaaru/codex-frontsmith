import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot, businessWebsiteRoot } from "./lib/paths.mjs";

const root = businessRoot();
const business = await readBusinessProfile();
const checks = [
  ["Профиль бизнеса", path.join(root, "business.json")],
  ["Одностраничный сайт", path.join(businessWebsiteRoot(), "index.html")],
  ["Стили сайта", path.join(businessWebsiteRoot(), "styles.css")],
  ["Интерактивные элементы сайта", path.join(businessWebsiteRoot(), "script.js")],
  ["Обработчик формы заявки", path.join("api", "contact.js")],
  ["Настройки интеграций", path.join(root, "settings", "integrations.md")],
  ["Работа с клиентами", path.join(root, "customer-inquiries", "README.md")],
  ["Каталог смет", path.join(root, "estimates", "README.md")],
  ["Каталог расширений", path.join(root, "extensions", "README.md")]
];

const results = [];
for (const [label, file] of checks) {
  results.push({ label, file, ready: await exists(file) });
}

const defaultPhones = new Set(["(000) 000-0000", "1-800-123-ACME"]);
const defaultEmails = new Set(["hello@example.com", "projects@acme.com"]);
const defaultWebsiteUrls = new Set(["https://business.example"]);

const placeholders = [
  defaultPhones.has(business.contact.phone) ? "номер телефона" : null,
  defaultEmails.has(business.contact.email) ? "адрес email" : null,
  !business.websiteUrl || defaultWebsiteUrls.has(business.websiteUrl) ? "URL сайта" : null,
  ["Ваш город", "Local"].includes(business.contact.city) ? "город" : null,
  ["Регион", "ST"].includes(business.contact.state) ? "регион" : null
].filter(Boolean);

const readyCount = results.filter((item) => item.ready).length;
const contactDelivery = contactDeliveryStatus();
const status = launchStatus({ business, results, readyCount, placeholders, contactDelivery });
const output = path.join(root, "launch", "launch-status.md");
await writeFile(output, status);

console.log(`Статус запуска сохранён: ${output}`);
console.log(`Пройдено проверок: ${readyCount}/${results.length}`);
if (placeholders.length > 0) {
  console.log(`Владельцу нужно обновить: ${placeholders.join(", ")}`);
}
if (!contactDelivery.ready) {
  console.log(`Нужно настроить доставку заявок: ${contactDelivery.message}`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readBusinessProfile() {
  const profilePath = businessPath("business.json");
  try {
    return JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Рабочие данные бизнеса не найдены: ${profilePath}. Сначала выполните npm run bootstrap.`);
    }
    throw error;
  }
}

function contactDeliveryStatus() {
  const mode = process.env.CONTACT_DELIVERY_MODE ?? "";
  const missing = [
    mode !== "resend" ? "CONTACT_DELIVERY_MODE=resend" : null,
    process.env.RESEND_API_KEY ? null : "RESEND_API_KEY",
    process.env.CONTACT_TO_EMAIL ? null : "CONTACT_TO_EMAIL",
    process.env.CONTACT_FROM_EMAIL ? null : "CONTACT_FROM_EMAIL"
  ].filter(Boolean);

  if (missing.length === 0) {
    return { ready: true, message: "Доставка заявок формы по email настроена" };
  }

  return {
    ready: false,
    message: `Настройте ${missing.join(", ")} перед использованием доставки заявок`
  };
}

function launchStatus({ business, results, readyCount, placeholders, contactDelivery }) {
  const lines = results.map((item) => `- ${item.ready ? "Готово" : "Нужна проверка"}: ${item.label}`);
  const contactLines =
    placeholders.length === 0
      ? ["- Контактные данные заполнены"]
      : placeholders.map((item) => `- Замените пример: ${item}`);

  return `# Статус запуска

Бизнес: ${business.businessName}
Режим: ${business.demoMode ? "локальная учебная демонстрация, не рабочая публикация" : "проверка рабочего запуска"}

${business.demoMode ? "Заменить демонстрационные контакты и адрес, согласовать цены и сведения о бизнесе до рабочего запуска." : ""}

${business.bookingUrl ? `Внешняя запись: ${business.bookingUrl}. Локальная синхронизация обращений не подключена.` : ""}

## Готовность

Пройдено проверок: ${readyCount}/${results.length}.

${lines.join("\n")}

## Что обновить владельцу

${contactLines.join("\n")}

## Доставка заявок

- ${contactDelivery.ready ? "Готово" : "Нужна проверка"}: ${contactDelivery.message}

## Границы внешних действий

Сайт можно проверить локально. Публикация, подключение домена, отправка клиентам, настройка календаря и подключённый режим требуют явного согласия владельца.
`;
}
