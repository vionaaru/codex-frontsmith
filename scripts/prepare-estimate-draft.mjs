import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const projectType = readArg("--project") ?? "Техническое обслуживание";
const scope = readArg("--scope") ?? "Объём работ нужно согласовать с владельцем до расчёта стоимости.";
const root = businessRoot();
const business = await readBusinessProfile();
const outputDir = path.join(root, "estimates");
const file = path.join(outputDir, `${slugify(projectType)}-estimate-draft.md`);
const relatedReplyFile = path.join(root, "customer-inquiries", `${slugify(projectType)}-reply-draft.md`);
const hasRelatedReply = await exists(relatedReplyFile);

await mkdir(outputDir, { recursive: true });
await writeFile(
  file,
  estimateDraft({
    business,
    projectType,
    scope,
    file,
    relatedReplyFile: hasRelatedReply ? relatedReplyFile : null
  })
);

console.log(`Подготовлен черновик сметы: ${file}`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
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

function estimateDraft({ business, projectType, scope, file, relatedReplyFile }) {
  const automotive = business.blueprint === "auto-service" || /автосервис/i.test(business.businessType);
  const missing = automotive
    ? ["Марка, модель, год, пробег и двигатель", "Симптомы и результаты диагностики", "Нужные запчасти и расходные материалы", "Согласованный объём работ", "Доступное время в Booking Flow"]
    : ["Фотографии объекта или заметки выезда", "Примерные размеры", "Ожидания по материалам и отделке", "Требования к срокам", "Приемлемый бюджет"];
  const catalogService = business.services.find(service => service.name.toLowerCase() === projectType.toLowerCase());
  const referencePrice = catalogService?.priceFrom;
  const priceLabel = Number.isFinite(referencePrice)
    ? (referencePrice === 0 ? "бесплатно" : `от ${new Intl.NumberFormat("ru-RU").format(referencePrice)} ₽ за работу`)
    : "по согласованию";
  const pricing = automotive
    ? `${business.pricingPolicy?.note ?? "Стоимость согласуется до начала работ."}\n\nУслуга: ${catalogService?.name ?? "точное совпадение в каталоге не найдено"}. Ориентир: ${priceLabel}. Это ${business.demoMode ? "учебная цена, не согласованная для отправки реальному клиенту" : "справочное значение, не итоговая смета"}. Запчасти и дополнительные работы считать отдельно. Не отправлять без согласия владельца.`
    : "Пока не заданы. Не указывайте итоговую цену, диапазон, предоплату или обязательства по срокам до получения правил владельца или согласования сметы.";
  return `# Заготовка сметы

Бизнес: ${business.businessName}
Проект: ${projectType}
Статус: заготовка, нужна проверка владельцем, не отправлена
Режим данных: ${business.demoMode ? "учебный пример, не реальный заказ" : "рабочий профиль"}
Создано: ${new Date().toISOString()}

## Краткая сводка

Заготовка сметы готова к проверке владельцем. Она описывает известный объём проекта «${projectType.toLowerCase()}», недостающие данные и структуру предложения без итоговой цены. Ничего не отправлено.

## Известный объём работ

${markdownList(scopeItems(scope))}

## Рабочие допущения

- Итоговый объём работ нужно подтвердить до расчёта цены
- Текущее состояние объекта может влиять на стоимость, сроки и материалы
- До отправки предложения нужны правила расчёта или согласованные диапазоны цен
- Отправка сметы или предложения требует согласия владельца

## Что нужно до расчёта цены

${markdownList(missing)}

## Вопросы владельцу

- Достаточно ли точен объём работ для подтверждения клиенту?
- Следующий шаг: звонок, выезд или дополнительные вопросы?
- Есть ли согласованные правила расчёта, диапазоны цен, исключения или минимальный объём заказа?
- Какие услуги, материалы или обещания сроков нужно исключить из предложения?

## Структура предложения

1. Краткое описание проекта
2. Подтверждённый объём работ
3. Допущения и исключения
4. Нерешённые вопросы материалов и отделки
5. Сроки и условия записи
6. Цена или диапазон только по согласованным правилам расчёта
7. Следующий шаг для согласования клиентом

## Правила расчёта

${pricing}

## Рекомендуемый следующий шаг

Перед предложением с ценой согласуйте объём работ с клиентом или назначьте консультацию.

## Проверка владельцем

- Проверьте точность объёма работ
- Добавляйте правила расчёта или диапазоны только после согласования
- Проверьте исключения и допущения
- Согласуйте следующий шаг с клиентом
- Согласуйте итоговую смету или предложение до отправки

## Передача коннектору

- Google Drive: сбор фотографий, замеров, примеров и файлов после согласования
- Google Calendar: запись на консультацию или выезд после согласования
- Gmail: отправка сметы или предложения только после согласия владельца
- Будущий навык расчёта: применять правила только после получения от владельца

## Материалы

- Черновик сметы: \`${displayPath(file)}\`
- Связанный ответ: ${relatedReplyFile ? `\`${displayPath(relatedReplyFile)}\`` : "пока нет"}
- Профиль бизнеса: \`${displayPath(businessPath("business.json"))}\`

## Границы безопасности

Этот черновик сметы хранится локально. Он не отправляет предложение, не устанавливает цену, не назначает выезд, не загружает файлы и не выполняет внешние действия.
`;
}

function scopeItems(value) {
  const items = value
    .split(/[;\n,]+/)
    .map((item) => sentenceCase(item.trim().replace(/^and\s+/i, "").replace(/\.$/, "")))
    .filter(Boolean);

  return items.length > 0 ? items : [value.trim()];
}

function sentenceCase(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function markdownList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function displayPath(targetFile) {
  const normalizedFile = path.normalize(targetFile);
  const normalizedRoot = path.normalize(root);
  const relativeToBusiness = path.relative(normalizedRoot, normalizedFile);

  if (relativeToBusiness && !relativeToBusiness.startsWith("..") && !path.isAbsolute(relativeToBusiness)) {
    return toPosix(path.join(".frontsmith", "business", relativeToBusiness));
  }

  const relativeToProject = path.relative(process.cwd(), normalizedFile) || normalizedFile;
  return toPosix(relativeToProject);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
