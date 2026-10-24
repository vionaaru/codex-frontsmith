import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const root = businessRoot();
const business = await readBusinessProfile();
const findings = buildFindings(business);
const output = businessPath("launch", "first-run-readiness.md");

await writeFile(output, renderReadiness({ business, findings }));

console.log(`Отчёт первого запуска сохранён: ${output}`);
console.log(`Заполнено полей: ${findings.customized.length}`);
if (findings.needsOwnerInput.length > 0) {
  console.log(`Нужны данные владельца: ${findings.needsOwnerInput.map((item) => item.label).join(", ")}`);
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

function buildFindings(profile) {
  const checks = [
    field("Название бизнеса", profile.businessName, ["Acme", "Новая компания", ""]),
    field("Тип бизнеса", profile.businessType, ["Местный сервисный бизнес", "Сервисная компания", "Local Service Business", ""]),
    field("URL сайта", profile.websiteUrl, ["https://business.example", ""]),
    field("Телефон", profile.contact?.phone, ["1-800-123-ACME", "(000) 000-0000", ""]),
    field("Email", profile.contact?.email, ["projects@acme.com", "hello@example.com", ""]),
    field("Город", profile.contact?.city, ["Ваш город", "Local", ""]),
    field("Регион", profile.contact?.state, ["Регион", "ST", ""]),
    field("Территория обслуживания", (profile.serviceAreas ?? []).join(", "), ["Ваш город, Ближайшие населённые пункты, Окрестности", "Your City, Nearby Communities, Surrounding Service Area", ""]),
    field("Услуги", (profile.services ?? []).map((service) => service.name).join(", "), ["Ремонт кухни, Ремонт ванной, Жилые помещения", "Kitchen Remodeling, Bathroom Remodeling, Living Spaces", ""]),
    field("Тон общения", profile.brandVoice, ["Ясный, практичный, уважительный тон с вниманием к деталям и потребностям владельца дома.", "Clear, practical, respectful, detail-oriented, and homeowner-friendly.", ""])
  ];

  if (profile.demoMode) {
    for (const item of checks) item.state = "demo";
  }

  return {
    customized: checks.filter((item) => item.state === "customized"),
    needsOwnerInput: checks.filter((item) => item.state !== "customized"),
    checks
  };
}

function field(label, value, placeholders) {
  const normalized = String(value ?? "").trim();
  const placeholderSet = new Set(placeholders.map((item) => item.toLowerCase()));
  const state = normalized && !placeholderSet.has(normalized.toLowerCase()) ? "customized" : "needs owner input";

  return {
    label,
    value: normalized || "не указано",
    state
  };
}

function renderReadiness({ business: profile, findings }) {
  const approvalItems = [
    "Согласуйте название, контакты, город и регион, территорию обслуживания и услуги до публикации.",
    "Согласуйте тексты, изображения, метаданные сайта и работу формы до публикации.",
    "Согласуйте ответы клиентам до отправки.",
    "Согласуйте допущения сметы и правила расчёта до использования предложения.",
    "Согласуйте настройку сервисов до действий с почтой, календарём, хранилищем, публикацией или подключённым режимом."
  ];

  return `# Готовность первого запуска

Бизнес: ${profile.businessName}
Режим: ${profile.demoMode ? "учебная демонстрация; цены, контакты и сведения не подтверждены для рабочего запуска" : "профиль для проверки владельцем"}
Обновлено: ${new Date().toISOString()}

## Краткая сводка

Frontsmith содержит локальные данные бизнеса и исходники сайта. ${findings.needsOwnerInput.length === 0 ? "Все обязательные поля профиля для первого запуска заполнены." : `До запуска владелец должен заполнить поля: ${findings.needsOwnerInput.length}.`} Сообщения не отправлены, сайт не опубликован, сервисы не подключены, DNS не изменён, внешние действия не выполнены.

## Проверка профиля бизнеса

| Поле | Состояние | Текущее значение |
| --- | --- | --- |
${findings.checks.map((item) => `| ${item.label} | ${item.state === "customized" ? "Заполнено" : item.state === "demo" ? "Демонстрационные данные" : "Нужны данные владельца"} | ${escapeTable(item.value)} |`).join("\n")}

## Созданные рабочие данные

- Профиль бизнеса: \`${displayPath(businessPath("business.json"))}\`
- Чек-лист запуска: \`${displayPath(businessPath("launch", "launch-checklist.md"))}\`
- Готовность первого запуска: \`${displayPath(output)}\`
- Файл сводки владельца: \`${displayPath(businessPath("activity", "owner-brief.md"))}\`
- Файл проверки сайта: \`${displayPath(businessPath("launch", "website-review.md"))}\`
- Каталог работы с клиентами: \`${displayPath(businessPath("customer-inquiries"))}\`
- Каталог смет: \`${displayPath(businessPath("estimates"))}\`
- Каталог расширений: \`${displayPath(businessPath("extensions"))}\`
- Исходники сайта: \`website/\`

## Нужны данные владельца

${findings.needsOwnerInput.length > 0 ? findings.needsOwnerInput.map((item) => `- ${item.label}: замените \`${item.value}\``).join("\n") : "- Нет"}

## Следующие команды

1. Выполните \`npm run owner:brief\` для создания сводки текущего состояния.
2. Выполните \`npm run update:website\` после изменений профиля бизнеса.
3. Выполните \`npm run launch:status\` для обновления готовности к запуску.
4. Выполните \`npm run deploy:check\` только с согласованными переменными доставки заявок или специально заданными безопасными примерами.

## Границы согласования владельцем

${approvalItems.map((item) => `- ${item}`).join("\n")}

## Границы безопасности

Этот отчёт хранится локально. Он не отправляет письма, не публикует сайт, не меняет DNS, не подключает сервисы, не загружает файлы, не назначает встречи и не включает подключённый режим.
`;
}

function displayPath(file) {
  const normalizedFile = path.normalize(file);
  const normalizedRoot = path.normalize(root);
  const relativeToBusiness = path.relative(normalizedRoot, normalizedFile);

  if (relativeToBusiness && !relativeToBusiness.startsWith("..") && !path.isAbsolute(relativeToBusiness)) {
    return toPosix(path.join(".frontsmith", "business", relativeToBusiness));
  }

  const relativeToProject = path.relative(process.cwd(), normalizedFile) || normalizedFile;
  return toPosix(relativeToProject);
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
