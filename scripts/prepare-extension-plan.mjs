import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const capability = readArg("--capability") ?? "Запись на консультацию";
const goal =
  readArg("--goal") ??
  "Подготовить согласуемый владельцем процесс записи на консультации.";
const connector = readArg("--connector") ?? "Google Calendar";
const root = businessRoot();
const business = await readBusinessProfile();
const outputDir = path.join(root, "extensions");
const file = path.join(outputDir, `${slugify(capability)}-extension-plan.md`);

await mkdir(outputDir, { recursive: true });
await writeFile(file, extensionPlan({ business, capability, goal, connector, file }));

console.log(`Подготовлен план расширения: ${file}`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
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

function extensionPlan({ business, capability, goal, connector, file }) {
  const workflowSlug = slugify(capability);

  return `# План расширения

Бизнес: ${business.businessName}
Возможность: ${capability}
Статус: черновик плана, нужна проверка владельцем, не подключено
Создано: ${new Date().toISOString()}

## Краткая сводка

План расширения готов к проверке владельцем. Он определяет процесс, границы навыка и коннектора, согласования и файлы для возможности «${capability.toLowerCase()}». Коннекторы не запускались.

## Запрашиваемая возможность

- Возможность: ${capability}
- Цель: ${goal}
- Коннектор: ${connector}
- Режим по умолчанию: пробный запуск и проверка владельцем

## Границы процесса

- Создайте или обновите \`workflows/${workflowSlug}.md\` до добавления внешних действий
- Храните заметки бизнеса в \`.frontsmith/business/extensions/\`
- Записывайте предлагаемые действия в журнал до обращения к сервисам
- Требуйте согласия владельца перед отправкой, публикацией, записью, экспортом, загрузкой или настройкой сервисов

## Границы навыка

- Вход навыка: согласованный профиль бизнеса, сведения о клиенте и правила владельца
- Выход навыка: Markdown для проверки, чек-лист или черновик плана действий
- Навык не должен выдумывать цены, сроки, юридические утверждения или обещания клиенту
- Навык должен указывать созданные файлы и конкретное необходимое согласование

## Границы коннектора

- ${connector}: подготовка действий только после согласия владельца
- Gmail: черновик или отправка только после согласия владельца
- Google Drive: сохранение файлов только после согласия владельца
- Neura: контролируемая предварительная проверка перед значимым внешним действием в подключённом режиме

## Проверка владельцем

- Проверьте, нужна ли возможность «${capability.toLowerCase()}» в основном процессе бизнеса
- Проверьте коннектор, поля данных и правила согласования
- Уточните, что считается внешним действием
- Согласуйте порядок отмены или отката до выполнения

## Чек-лист внедрения

- Добавьте инструкцию процесса
- Добавьте или обновите локальный скрипт
- Добавьте регрессионные проверки
- Добавьте пробный режим до внешних действий коннектора
- Обновите README и инструкции оператора после реализации процесса

## Материалы

- План расширения: \`${displayPath(file)}\`
- Профиль бизнеса: \`${displayPath(businessPath("business.json"))}\`

## Границы безопасности

Этот план расширения хранится локально. Он не подключает сервисы, не отправляет сообщения, не публикует материалы, не назначает встречи, не загружает файлы, не экспортирует данные и не выполняет внешние действия.
`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
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
