// Профиль бизнеса и рабочие файлы в каталоге бизнеса: npm run business:init.
// Первая установка вызывает его из npm run bootstrap; повтор без --profile отклоняется
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderWebsite, validatedBookingUrl } from "./lib/render-website.mjs";
import { businessRoot } from "./lib/paths.mjs";
import { defaultBlueprintId, exampleProfileFile } from "./lib/blueprints.mjs";

// Стартовый профиль: --profile ФАЙЛ, --blueprint ID или профиль по умолчанию (frontsmith.config.json)
if (readArg("--profile") !== null && readArg("--blueprint") !== null) {
  throw new Error("Укажите либо --profile ФАЙЛ, либо --blueprint ID");
}
const profileFile = readArg("--profile") ?? exampleProfileFile(readArg("--blueprint") ?? defaultBlueprintId());
const explicitProfile = readArg("--profile") !== null || readArg("--blueprint") !== null;
const reset = process.argv.includes("--reset");
const skipWebsite = process.argv.includes("--skip-website");
const target = businessRoot();

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function readList(name, fallback = []) {
  const value = readArg(name);
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function createBusinessProfile() {
  const profile = JSON.parse(await readFile(profileFile, "utf8"));
  if (!profile.businessName || !Array.isArray(profile.services) || !profile.contact) {
    throw new Error("Профиль должен содержать businessName, services и contact");
  }
  if (readArg("--profile") === null) profile.blueprint ??= readArg("--blueprint") ?? defaultBlueprintId();

  const overrides = {
    "--business-name": "businessName", "--business-type": "businessType",
    "--brand-tagline": "brandTagline", "--tagline": "tagline",
    "--summary": "summary", "--brand-voice": "brandVoice"
  };
  for (const [flag, key] of Object.entries(overrides)) {
    const value = readArg(flag);
    if (value !== null) profile[key] = value;
  }
  if (readArg("--website-url") !== null) profile.websiteUrl = normalizeWebsiteUrl(readArg("--website-url"));
  if (readArg("--service-areas") !== null) profile.serviceAreas = readList("--service-areas");
  if (readArg("--services") !== null) {
    const known = new Map(profile.services.map((service) => [service.name.toLowerCase(), service]));
    profile.services = readList("--services").map((name) => ({
      ...(known.get(name.toLowerCase()) ?? {
        category: "general", priceFrom: null, durationMinutes: null,
        description: `Услуга «${name}»: объём работ и стоимость согласуются до начала выполнения.`
      }),
      name
    }));
  }
  profile.media = { ...profile.media };
  for (const key of ["hero", "kitchen", "bathroom", "living", "craft", "faq", "contact"]) {
    const value = readArg(`--${key}-image`);
    if (value !== null) profile.media[`${key}Image`] = value;
  }
  profile.contact = { ...profile.contact };
  for (const key of ["phone", "email", "city", "state"]) {
    const value = readArg(`--${key}`);
    if (value !== null) profile.contact[key] = value;
  }
  profile.approvalPolicy = {
    ...profile.approvalPolicy,
    ownerApprovalRequiredForLiveActions: true,
    liveActionsDefault: "disabled"
  };
  validatedBookingUrl(profile.bookingUrl);
  return profile;
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function normalizeWebsiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "http://localhost:4173";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

const business = await createBusinessProfile();
if (await exists(path.join(target, "business.json")) && !reset && !explicitProfile) {
  throw new Error("Профиль бизнеса уже существует. Для обновления сайта используйте npm run update:website. Для явной замены профиля передайте --profile FILE или --blueprint ID; --reset удаляет локальные рабочие данные.");
}
if (reset) {
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === path.parse(resolvedTarget).root || resolvedTarget === path.resolve(".") ||
      [process.env.USERPROFILE, process.env.HOME].filter(Boolean).some((value) => path.resolve(value) === resolvedTarget)) {
    throw new Error("Нельзя очищать корень диска, проекта или домашний каталог");
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

await mkdir(path.join(target, "activity"), { recursive: true });
await mkdir(path.join(target, "customer-inquiries"), { recursive: true });
await mkdir(path.join(target, "estimates"), { recursive: true });
await mkdir(path.join(target, "extensions"), { recursive: true });
await mkdir(path.join(target, "launch"), { recursive: true });
await mkdir(path.join(target, "settings"), { recursive: true });
await mkdir(path.join(target, "files"), { recursive: true });

await writeFile(
  path.join(target, "business.json"),
  `${JSON.stringify(business, null, 2)}\n`
);
await writeFile(
  path.join(target, "settings", "integrations.md"),
  integrationSettings(business)
);
await writeFile(
  path.join(target, "activity", "activity-log.md"),
  activityLog(business)
);
await writeFile(
  path.join(target, "launch", "launch-checklist.md"),
  launchChecklist(business)
);
await writeFile(
  path.join(target, "customer-inquiries", "README.md"),
  customerDeskReadme(business)
);
await writeFile(
  path.join(target, "estimates", "README.md"),
  estimatesReadme(business)
);
await writeFile(
  path.join(target, "extensions", "README.md"),
  extensionsReadme(business)
);

if (!skipWebsite) {
  await renderWebsite();
}

console.log(`Созданы рабочие данные Frontsmith для ${business.businessName}`);
console.log(`Каталог рабочих данных: ${target}`);
console.log(
  skipWebsite
    ? "Далее: npm run update:website"
    : "Рабочий сайт готов в приватном каталоге данных: website/ внутри каталога бизнеса"
);

function integrationSettings(profile) {
  return `# Настройки интеграций

Статус: ${profile.demoMode ? "локальная демонстрация" : "только черновик"}

- Внешняя запись: ${profile.bookingUrl || "не задана"} — обычная ссылка; импорт заявок и API-синхронизация не включены
- Почта: отключена
- Календарь: не подключён
- Neura: не подключена

## Базовые интеграции v1.0

- Vercel: публикация сайта после согласования
- Resend: доставка заявок после настройки домена и окружения
- Gmail: подготовка ответов и отправка только после согласования
- Google Drive: хранение материалов бизнеса и предложений
- Google Calendar: возможное расширение после отдельной настройки и согласования
- Neura: контроль значимых внешних действий в подключённом режиме

Внешняя ссылка записи не является подключённой интеграцией. Внешние действия отключены по умолчанию.
`;
}

function activityLog(profile) {
  return `# Журнал действий

Бизнес: ${profile.businessName}

## Создано

- Созданы локальные рабочие данные Frontsmith
- Создан профиль бизнеса
- Созданы настройки интеграций
- Создан чек-лист запуска
- Сайт обновлён из профиля бизнеса

## Безопасность

Внешние действия по умолчанию отключены. Публикация, исходящие сообщения клиентам, изменения сервисов и публичных материалов требуют согласия владельца.
`;
}

function launchChecklist(profile) {
  return `# Чек-лист запуска

Бизнес: ${profile.businessName}

## Готово

- Профиль бизнеса создан
- Список услуг создан: ${profile.services.length}
- Режим: ${profile.demoMode ? "локальная демонстрация" : "локальная рабочая область"}
- Внешняя запись: ${profile.bookingUrl || "не задана"}, без импорта и API-синхронизации
- Почта отключена, календарь не подключён
- Заметки о территории обслуживания созданы
- Каталог сайта обновлён
- Каталог работы с клиентами создан
- Каталог смет и предложений создан

## Проверка владельцем

- Проверьте название бизнеса, URL сайта, телефон, email, город и регион
- Проверьте названия и описания услуг
- Проверьте территорию обслуживания для планирования запуска
- Замените примеры согласованными сведениями о бизнесе
- Проверьте сайт перед публикацией
- Проверьте настройки интеграций до подключения

## Заблокировано до согласования

- Публикация через Vercel
- Подключение домена
- Отправка через Gmail
- Ссылки записи в календарь
- Включение подключённого режима Neura
`;
}

function customerDeskReadme(profile) {
  return `# Работа с клиентами

Бизнес: ${profile.businessName}

Храните здесь заметки по входящим обращениям, черновики ответов, повторные контакты и согласованные владельцем записи общения с клиентами.

Внешняя запись: ${profile.bookingUrl || "не задана"}. Это ссылка на сторонний сервис; заявки не импортируются в Frontsmith. Почта отключена, календарь не подключён.

Frontsmith помогает готовить ответы. Отправка сообщений клиентам требует явного согласия владельца.
`;
}

function estimatesReadme(profile) {
  return `# Сметы и предложения

Бизнес: ${profile.businessName}

Храните здесь описание объёма работ, заготовки смет, структуры предложений, допущения и замечания владельца.

Правило цен: ${profile.pricingPolicy?.note || "Стоимость согласуется с владельцем до отправки предложения."}

Frontsmith помогает структурировать смету. Итоговую цену можно указывать только по правилам владельца или после согласования сметы.
`;
}

function extensionsReadme(profile) {
  return `# Расширения

Бизнес: ${profile.businessName}

Храните здесь согласуемые владельцем планы добавления инструментов, навыков, коннекторов и процессов.

Frontsmith помогает спланировать расширение. Подключение сервисов, встречи, отправка сообщений, публикация, загрузка файлов, экспорт и внешние действия требуют явного согласия владельца.
`;
}
