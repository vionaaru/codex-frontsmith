import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const inquiryName = readArg("--name") ?? "Новый клиент";
const projectType = readArg("--project") ?? "Техническое обслуживание";
const notes = readArg("--notes") ?? "Клиент попросил помочь определить объём работ и следующий шаг.";
const root = businessRoot();
const business = await readBusinessProfile();
const outputDir = path.join(root, "customer-inquiries");
const file = path.join(outputDir, `${slugify(projectType)}-reply-draft.md`);

await mkdir(outputDir, { recursive: true });
await writeFile(file, replyDraft({ business, inquiryName, projectType, notes, file }));

console.log(`Подготовлен черновик ответа клиенту: ${file}`);

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

function replyDraft({ business, inquiryName, projectType, notes, file }) {
  const automotive = business.blueprint === "auto-service" || /автосервис/i.test(business.businessType);
  const questions = automotive
    ? "Для подготовки к визиту укажите марку, модель, год выпуска, пробег и двигатель автомобиля. Опишите симптомы и когда они появляются. Если на панели есть сообщение об ошибке, приложите его фото. Точный диагноз и итоговую стоимость согласуем после проверки."
    : "Для первого разговора пришлите фотографии, укажите помещения, желаемые сроки, обязательные результаты и ограничения. После этого предложим следующий шаг: консультацию по телефону, выезд или подготовку сметы.";
  const nextStep = automotive
    ? "запросить данные автомобиля, пробег, симптомы и желаемую услугу"
    : "запросить фотографии, помещения, сроки и обязательные результаты";
  const booking = automotive && business.bookingUrl
    ? `Выбрать услугу и удобное время можно в отдельном сервисе записи: ${business.bookingUrl}. Это ссылка на Booking Flow; время не забронировано этим черновиком.`
    : "";
  return `# Черновик ответа клиенту

Бизнес: ${business.businessName}
Клиент: ${inquiryName}
Проект: ${projectType}
Статус: черновик, нужна проверка владельцем, не отправлен
Режим данных: ${business.demoMode ? "учебный пример, не реальное обращение" : "рабочий профиль"}
Создано: ${new Date().toISOString()}

## Краткая сводка

Черновик ответа готов к проверке владельцем. Он подтверждает обращение клиента ${inquiryName} по проекту «${projectType.toLowerCase()}», запрашивает необходимые сведения и не обещает цену или сроки. Ничего не отправлено.

## Сведения о клиенте

- Клиент: ${inquiryName}
- Проект: ${projectType}
- Заметки обращения: ${notes}
- Тон общения: ${business.brandVoice ?? "Ясный, практичный, уважительный тон, согласованный владельцем"}

## Черновик ответа

Здравствуйте, ${inquiryName}!

Спасибо за обращение в ${business.businessName}. Поможем определить объём работ по проекту «${projectType.toLowerCase()}» и следующий шаг до назначения встречи.

${questions}

${booking}

С уважением,
${business.businessName}

## Повторный контакт

- Текущее состояние: подготовлен первый черновик ответа
- Следующий шаг: ${nextStep}
- Повод для повторного контакта: клиент прислал сведения или владелец согласовал консультацию
- Связанная смета: готовить черновик после уточнения объёма работ для проверки владельцем

## Проверка владельцем

- Проверьте имя клиента и тип проекта
- Проверьте точность передачи заметок клиента
- Добавьте согласованные условия записи, если нужна консультация
- Согласуйте итоговый текст перед отправкой

## Чек-лист отправки

- Проверьте получателя и удобный канал связи
- Уберите утверждения, цены, даты и обещания, не согласованные владельцем
- Добавьте только согласованные ссылку записи, телефон или доступное время
- Отправляйте только после явного согласия владельца

## Передача коннектору

- Gmail: создание черновика или отправка только после согласия владельца
- Google Drive: сбор фотографий и файлов проекта после согласования
- Google Calendar: запись только после согласования консультации

## Материалы

- Черновик ответа: \`${displayPath(file)}\`
- Профиль бизнеса: \`${displayPath(businessPath("business.json"))}\`

## Границы безопасности

Этот черновик хранится локально. Он не отправляет письма или сообщения, не создаёт записи в календаре, не загружает файлы и не выполняет внешние действия.
`;
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
