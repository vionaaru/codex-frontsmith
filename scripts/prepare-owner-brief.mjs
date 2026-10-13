import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const root = businessRoot();
const business = await readBusinessProfile();
const activityDir = path.join(root, "activity");
const output = path.join(activityDir, "owner-brief.md");

await mkdir(activityDir, { recursive: true });
await writeFile(output, await ownerBrief());

console.log(`Подготовлена сводка владельца: ${output}`);

async function ownerBrief() {
  const [
    websiteReady,
    websiteReview,
    launchStatus,
    integrationSettings,
    replyDrafts,
    estimateDrafts
  ] = await Promise.all([
    exists(path.join("website", "index.html")),
    readOptional(businessPath("launch", "website-review.md")),
    readOptional(businessPath("launch", "launch-status.md")),
    readOptional(businessPath("settings", "integrations.md")),
    listMarkdownFiles(businessPath("customer-inquiries")),
    listMarkdownFiles(businessPath("estimates"))
  ]);

  const hasLaunchStatus = Boolean(launchStatus);
  const hasIntegrationSettings = Boolean(integrationSettings);
  const replyCount = replyDrafts.length;
  const estimateCount = estimateDrafts.length;

  const summary = [
    websiteReady ? "сайт готов к проверке владельцем" : "сайт нужно восстановить или обновить",
    `Черновиков ответов на проверке: ${replyCount}`,
    `Черновиков смет на проверке: ${estimateCount}`,
    hasLaunchStatus ? "отчёт готовности к запуску есть" : "готовность к запуску нужно обновить",
    "внешние действия требуют согласования"
  ];

  const changed = [
    `Загружен профиль бизнеса ${business.businessName}`,
    websiteReady ? "Исходники сайта находятся в `website/index.html`" : "Исходники сайта отсутствуют",
    websiteReview ? `Материалы проверки сайта: \`${displayPath(businessPath("launch", "website-review.md"))}\`` : null,
    hasLaunchStatus ? `Статус запуска: \`${displayPath(businessPath("launch", "launch-status.md"))}\`` : null,
    replyCount > 0 ? `Черновиков ответов для проверки: ${replyCount}` : null,
    estimateCount > 0 ? `Черновиков смет для проверки: ${estimateCount}` : null
  ].filter(Boolean);

  const waiting = [
    websiteReady ? "Проверьте сайт перед публикацией" : "Восстановите или обновите сайт",
    replyCount > 0
      ? `Черновиков ответов, требующих проверки владельцем: ${replyCount}`
      : "Черновиков ответов на проверке нет",
    estimateCount > 0
      ? `Черновиков смет, требующих проверки владельцем: ${estimateCount}`
      : "Черновиков смет на проверке нет"
  ];

  const blockers = [
    hasLaunchStatus ? null : "Выполните `npm run launch:status` для обновления готовности к запуску",
    hasIntegrationSettings ? null : "Проверьте настройки интеграций до внешних действий",
    "Отправка, публикация, изменения сервисов и подключённый режим заблокированы до согласия владельца"
  ].filter(Boolean);

  const approvals = [
    "Согласуйте тексты сайта и контакты до публикации",
    replyCount > 0
      ? `Согласуйте ответ клиенту до отправки: \`${displayPath(replyDrafts[0])}\``
      : "Согласуйте следующий ответ клиенту до отправки",
    estimateCount > 0
      ? `Согласуйте допущения сметы до отправки предложения: \`${displayPath(estimateDrafts[0])}\``
      : "Согласуйте допущения сметы до отправки предложения",
    "Согласуйте настройку сервисов до включения подключённого режима"
  ];

  const nextActions = [
    "Проверьте сайт по адресу `/website` или через `npm run preview:website`",
    replyCount > 0
      ? `Проверьте черновик ответа клиенту: \`${displayPath(replyDrafts[0])}\``
      : "Подготовьте черновик ответа при следующем обращении",
    estimateCount > 0
      ? `Проверьте черновик сметы: \`${displayPath(estimateDrafts[0])}\``
      : "Подготовьте черновик сметы после уточнения объёма работ"
  ];

  const artifacts = [
    ["Профиль бизнеса", businessPath("business.json")],
    ["Проверка сайта", websiteReview ? businessPath("launch", "website-review.md") : null],
    ["Статус запуска", hasLaunchStatus ? businessPath("launch", "launch-status.md") : null],
    ["Настройки интеграций", hasIntegrationSettings ? businessPath("settings", "integrations.md") : null],
    ["Черновик ответа", replyDrafts[0] ?? null],
    ["Черновик сметы", estimateDrafts[0] ?? null]
  ];

  return `# Сводка владельца

Бизнес: ${business.businessName}
Режим: ${business.demoMode ? "демонстрационный автосервис; черновики не являются реальными обращениями" : "рабочий профиль"}
${business.bookingUrl ? `Внешняя запись: ${business.bookingUrl}; данные Booking Flow пока не импортируются.` : ""}
Обновлено: ${new Date().toISOString()}

## Краткая сводка

${business.businessName}: материалы для проверки владельцем: ${sentenceList(summary)}. Внешние действия с клиентами не выполнялись.

## Изменения

${markdownList(changed)}

## Ожидает проверки

${markdownList(waiting)}

## Заблокировано

${markdownList(blockers)}

## Требует согласования

${markdownList(approvals)}

## Следующие действия

${numberedList(nextActions)}

## Материалы

${artifacts.map(([label, file]) => `- ${label}: ${file ? `\`${displayPath(file)}\`` : "пока нет"}`).join("\n")}

## Границы безопасности

Эта сводка хранится локально. Она не отправляет письма, не публикует сайт, не меняет DNS, не подключает сервисы и не выполняет внешние действия.
`;
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

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function listMarkdownFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
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

function sentenceList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join("; ")}; ${items.at(-1)}`;
}

function markdownList(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- Нет";
}

function numberedList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
