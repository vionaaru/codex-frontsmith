import { access, readFile } from "node:fs/promises";
import path from "node:path";

const ready = [];
const blockers = [];
const review = [];

const demoRoot = "demo";
const websiteRoot = "website";
const outputRoot = "dist/frontsmith-demo";
const requiredDemoFiles = ["index.html", "styles.css", "script.js", "robots.txt", "sitemap.xml", "llms.txt"];
const requiredWebsiteFiles = [
  "index.html",
  "styles.css",
  "script.js",
  "frontsmith-mark.svg",
  "favicon.svg",
  "favicon.png",
  "apple-touch-icon.png"
];
const requiredEnvKeys = ["RESEND_API_KEY", "CONTACT_TO_EMAIL", "CONTACT_FROM_EMAIL"];

await checkWebsiteFiles();
await checkVercelConfig();
await checkWebsiteMarkup();
await checkContactDelivery();

printReport();

if (blockers.length > 0) {
  process.exitCode = 1;
}

async function checkWebsiteFiles() {
  for (const file of requiredDemoFiles) {
    const fullPath = path.join(demoRoot, file);
    if (await exists(fullPath)) {
      pass(`Исходный файл демонстрации найден: ${fullPath}`);
    } else {
      block(`Отсутствует исходный файл демонстрации: ${fullPath}`);
    }
  }

  for (const file of requiredWebsiteFiles) {
    const fullPath = path.join(websiteRoot, file);
    if (await exists(fullPath)) {
      pass(`Ресурс сайта найден: ${fullPath}`);
    } else {
      block(`Отсутствует ресурс сайта: ${fullPath}`);
    }
  }

  for (const file of ["index.html", "styles.css", "script.js", "robots.txt", "sitemap.xml", "llms.txt", "frontsmith-mark.svg", "favicon.svg", "favicon.png", "apple-touch-icon.png", "website/index.html", "website/styles.css", "website/script.js"]) {
    const fullPath = path.join(outputRoot, file);
    if (await exists(fullPath)) {
      pass(`Ресурс сборки демонстрации найден: ${fullPath}`);
    } else {
      block(`Отсутствует ресурс сборки демонстрации: ${fullPath}`);
    }
  }

  if (await exists("api/contact.js")) {
    pass("Обработчик контактной формы найден: api/contact.js");
  } else {
    block("Отсутствует обработчик контактной формы: api/contact.js");
  }
}

async function checkVercelConfig() {
  let config;

  try {
    config = JSON.parse(await readFile("vercel.json", "utf8"));
    pass("vercel.json корректно читается");
  } catch (error) {
    block(`vercel.json должен содержать корректный JSON: ${error.message}`);
    return;
  }

  expectEqual(config.framework, null, "В Vercel выбран вариант фреймворка Other");
  expectEqual(config.buildCommand, "npm run build:demo", "Команда сборки Vercel готовит демонстрацию");
  expectEqual(config.outputDirectory, outputRoot, "Каталог результата Vercel содержит сборку демонстрации");
  expectEqual(config.cleanUrls, true, "В Vercel включены чистые URL");
  expectEqual(config.trailingSlash, false, "В Vercel отключены завершающие косые черты");
  expectEqual(config.functions?.["api/contact.js"]?.maxDuration, 10, "Задана максимальная длительность выполнения обработчика заявок");
  expectEqual(config.redirects?.length ?? 0, 0, "Перенаправления на внешний сайт по умолчанию отключены");

  review.push("Перед публикацией замените заглушку codex-frontsmith.example выбранным доменом в метаданных, сборке, robots.txt и sitemap.xml; проверьте проект Vercel и интеграцию с Git");
}

async function checkWebsiteMarkup() {
  let demoHtml;
  let demoScript;
  let html;
  let script;

  try {
    demoHtml = await readFile(path.join(demoRoot, "index.html"), "utf8");
    demoScript = await readFile(path.join(demoRoot, "script.js"), "utf8");
    html = await readFile(path.join(websiteRoot, "index.html"), "utf8");
    script = await readFile(path.join(websiteRoot, "script.js"), "utf8");
  } catch (error) {
    block(`Не удалось прочитать файлы сайта: ${error.message}`);
    return;
  }

  if (/\{\{[a-zA-Z0-9]+\}\}/.test(`${demoHtml}\n${html}`)) {
    block("Сайт содержит неподставленные маркеры шаблона");
  } else {
    pass("Демонстрация и сайт не содержат неподставленных маркеров шаблона");
  }

  if (/\bhref=["'][^"']+\.html(?:[#?][^"']*)?["']/.test(`${demoHtml}\n${html}`)) {
    block("Навигация демонстрации и сайта не должна ссылаться на маршруты .html");
  } else {
    pass("Навигация демонстрации и сайта использует чистые маршруты");
  }

  requireHtml(demoHtml, "<title", "SEO-заголовок демонстрации найден");
  requireHtml(demoHtml, 'name="description"', "SEO-описание демонстрации найдено");
  requireHtml(demoHtml, 'rel="canonical"', "Основной URL демонстрации найден");
  requireHtml(demoHtml, 'href="/llms.txt"', "Демонстрация содержит ссылку на llms.txt для ИИ");
  requireHtml(demoHtml, 'property="og:title"', "Заголовок Open Graph демонстрации найден");
  requireHtml(demoHtml, 'property="og:image"', "Изображение Open Graph демонстрации найдено");
  requireHtml(demoHtml, 'name="twitter:card"', "Метаданные карточки Twitter демонстрации найдены");
  requireHtml(demoHtml, 'href="/favicon.svg"', "Значок SVG демонстрации объявлен");
  requireHtml(demoHtml, 'href="/favicon.png"', "Резервный значок PNG демонстрации объявлен");
  requireHtml(demoHtml, 'href="/apple-touch-icon.png"', "Значок Apple touch демонстрации объявлен");
  requireHtml(demoHtml, 'href="/website"', "Демонстрация содержит ссылку на предварительный просмотр сайта-примера");
  requireText(demoHtml, "Настройте цифровой офис в Codex", "Демонстрация объясняет панель управления Frontsmith");
  requireHtml(demoHtml, "Что делает Frontsmith", "Демонстрация начинается со списка модулей цифрового офиса");
  requireHtml(demoHtml, "Работа с клиентами", "Демонстрация показывает текущую работу с клиентами");
  requireHtml(demoHtml, "https://github.com/vionaaru/codex-frontsmith", "Демонстрация содержит путь настройки через GitHub");
  requireScript(demoScript, "data-nav-toggle", "Скрипт мобильной навигации демонстрации найден");

  requireHtml(html, "<title", "SEO-заголовок найден");
  requireHtml(html, 'name="description"', "SEO-описание найдено");
  requireHtml(html, 'name="robots"', "Метаданные robots найдены");
  requireHtml(html, 'rel="canonical"', "Основной URL найден");
  requireHtml(html, 'property="og:title"', "Заголовок Open Graph найден");
  requireHtml(html, 'property="og:description"', "Описание Open Graph найдено");
  requireHtml(html, 'property="og:url"', "URL Open Graph найден");
  requireHtml(html, 'property="og:image"', "Изображение Open Graph найдено");
  requireHtml(html, 'property="og:image:alt"', "Альтернативный текст изображения Open Graph найден");
  requireHtml(html, 'name="twitter:card"', "Метаданные карточки Twitter найдены");
  requireHtml(html, 'name="twitter:title"', "Заголовок Twitter найден");
  requireHtml(html, 'name="twitter:description"', "Описание Twitter найдено");
  requireHtml(html, 'name="twitter:image"', "Изображение Twitter найдено");
  requireHtml(html, 'name="twitter:image:alt"', "Альтернативный текст изображения Twitter найден");
  requireHtml(html, 'href="/favicon.svg"', "Значок SVG объявлен");
  requireHtml(html, 'href="/favicon.png"', "Резервный значок PNG объявлен");
  requireHtml(html, 'href="/apple-touch-icon.png"', "Значок Apple touch объявлен");
  requireHtml(html, 'data-intake-form', "Маркер контактной формы найден");
  requireHtml(html, 'action="/api/contact"', "Контактная форма отправляет данные на /api/contact");
  requireHtml(html, 'data-fallback-action="mailto:', "Контактная форма содержит резервную отправку через mailto");
  requireHtml(html, 'data-intake-status', "Область статуса контактной формы найдена");
  requireHtml(html, 'name="website"', "Поле-ловушка контактной формы найдено");
  requireHtml(html, 'data-contact-email', "Поле проверки электронной почты в контактной форме найдено");
  requireHtml(html, 'data-contact-phone', "Поле проверки телефона в контактной форме найдено");
  requireScript(script, "fetch(intakeForm.action", "Контактная форма отправляет данные через настроенный обработчик");
  requireScript(script, "fallbackMailto", "Контактная форма содержит резервную отправку по почте");
  requireScript(script, "validateIntakeForm", "Клиентская проверка контактной формы найдена");

  await checkBuiltWebsitePreviewAssets();
  await checkBuiltAnalyticsInstrumentation();
  await checkRootAssetReferences(demoHtml);
  await checkRootAssetReferences(html);
  await checkImageReferences(demoHtml);
  await checkImageReferences(html);
}

async function checkBuiltWebsitePreviewAssets() {
  let builtWebsiteHtml;

  try {
    builtWebsiteHtml = await readFile(path.join(outputRoot, "website", "index.html"), "utf8");
  } catch (error) {
    block(`Не удалось прочитать собранный предварительный просмотр сайта: ${error.message}`);
    return;
  }

  requireHtml(builtWebsiteHtml, 'href="/website/styles.css"', "Собранный предварительный просмотр сайта загружает собственную таблицу стилей");
  requireHtml(builtWebsiteHtml, 'src="/website/script.js"', "Собранный предварительный просмотр сайта загружает собственный скрипт");
  requireHtml(
    builtWebsiteHtml,
    'href="https://codex-frontsmith.example/website"',
    "Собранный предварительный просмотр сайта использует основной URL просмотра Frontsmith"
  );
  requireHtml(
    builtWebsiteHtml,
    'content="https://codex-frontsmith.example/website"',
    "Собранный предварительный просмотр сайта использует URL просмотра Frontsmith в Open Graph"
  );

  if (builtWebsiteHtml.includes('href="./styles.css"') || builtWebsiteHtml.includes('src="./script.js"')) {
    block("Собранный предварительный просмотр сайта не должен загружать корневые ресурсы демонстрации по относительным путям");
  } else {
    pass("Собранный предварительный просмотр сайта исключает подмену ресурсов при разрешении относительных путей с чистыми URL");
  }
}

async function checkBuiltAnalyticsInstrumentation() {
  const analyticsScript = 'src="/_vercel/insights/script.js"';
  const analyticsQueue = "window.va = window.va || function";

  for (const file of ["index.html", "website/index.html"]) {
    let html;

    try {
      html = await readFile(path.join(outputRoot, file), "utf8");
    } catch (error) {
      block(`Не удалось прочитать собранный файл для проверки аналитики: ${error.message}`);
      continue;
    }

    requireHtml(html, analyticsQueue, `Собранный ${file} инициализирует очередь аналитики Vercel`);
    requireHtml(html, analyticsScript, `Собранный ${file} загружает скрипт аналитики Vercel`);
  }
}

async function checkRootAssetReferences(html) {
  const rootRefs = [
    ...html.matchAll(/\b(?:href|src|content)=["'](\/[^"'?#]+)(?:[?#][^"']*)?["']/g)
  ].map((match) => match[1]);

  for (const ref of rootRefs) {
    if (ref.startsWith("/api/")) continue;

    const file = path.join(outputRoot, ref.slice(1));
    if (await exists(file)) {
      pass(`Корневой ресурс найден: ${ref}`);
    } else {
      block(`Корневой ресурс не найден внутри website/: ${ref}`);
    }
  }
}

async function checkImageReferences(html) {
  const imageRefs = [
    ...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g),
    ...html.matchAll(/<meta\b[^>]*\b(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/g)
  ].map((match) => match[1]);

  for (const ref of imageRefs) {
    if (/^https?:\/\//i.test(ref)) {
      pass(`Ссылка на изображение абсолютная: ${trimUrl(ref)}`);
      continue;
    }

    if (!ref.startsWith("/")) {
      block(`Ссылка на изображение должна быть абсолютной или относительной от корня: ${ref}`);
      continue;
    }

    const file = path.join(outputRoot, ref.replace(/[?#].*$/, "").slice(1));
    if (await exists(file)) {
      pass(`Изображение найдено локально: ${ref}`);
    } else {
      block(`Изображение по ссылке не найдено внутри website/: ${ref}`);
    }
  }
}

async function checkContactDelivery() {
  let envExample;

  try {
    envExample = await readFile(".env.example", "utf8");
    pass(".env.example найден");
  } catch (error) {
    block(`Отсутствует .env.example: ${error.message}`);
    return;
  }

  for (const key of ["CONTACT_DELIVERY_MODE", "CONTACT_TO_EMAIL", "CONTACT_FROM_EMAIL", "CONTACT_SUBJECT_PREFIX", "FRONTSMITH_TENANT_ID", "RESEND_API_KEY"]) {
    if (envExample.includes(`${key}=`)) {
      pass(`Переменная окружения описана: ${key}`);
    } else {
      block(`.env.example должен описывать ${key}`);
    }
  }

  const missing = [
    process.env.CONTACT_DELIVERY_MODE === "resend" ? null : "CONTACT_DELIVERY_MODE=resend",
    ...requiredEnvKeys.filter((key) => !process.env[key])
  ].filter(Boolean);

  if (missing.length > 0) {
    block(`Отправка заявок не готова к работе. Настройте ${missing.join(", ")}`);
    return;
  }

  if (!emailLike(process.env.CONTACT_TO_EMAIL)) {
    block("CONTACT_TO_EMAIL должен содержать адрес электронной почты");
  } else {
    pass("CONTACT_TO_EMAIL выглядит корректно");
  }

  if (!emailLike(process.env.CONTACT_FROM_EMAIL)) {
    block("CONTACT_FROM_EMAIL должен содержать адрес электронной почты отправителя");
  } else {
    pass("CONTACT_FROM_EMAIL выглядит корректно");
  }

  if (process.env.RESEND_API_KEY === "re_xxxxxxxxx") {
    block("В RESEND_API_KEY осталась заготовка из примера");
  } else {
    pass("RESEND_API_KEY задан и отличается от заготовки в примере");
  }

  pass("Режим отправки заявок установлен в resend");
  review.push("После настройки переменных окружения Vercel отправьте одну одобренную тестовую заявку");
}

function requireHtml(html, token, label) {
  if (html.includes(token)) {
    pass(label);
  } else {
    block(label);
  }
}

function requireText(html, token, label) {
  const text = html.replace(/&nbsp;/g, " ");

  requireHtml(text, token, label);
}

function requireScript(script, token, label) {
  if (script.includes(token)) {
    pass(label);
  } else {
    block(label);
  }
}

function expectEqual(actual, expected, label) {
  if (actual === expected) {
    pass(label);
  } else {
    block(`${label}: ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
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

function emailLike(value) {
  return /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(String(value ?? ""));
}

function trimUrl(value) {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function pass(message) {
  ready.push(message);
}

function block(message) {
  blockers.push(message);
}

function printReport() {
  console.log("Проверка готовности Frontsmith к развёртыванию");
  console.log("");
  console.log("Готово");
  for (const item of ready) console.log(`- ${item}`);

  if (blockers.length > 0) {
    console.log("");
    console.log("Блокирующие проблемы");
    for (const item of blockers) console.log(`- ${item}`);
  }

  if (review.length > 0) {
    console.log("");
    console.log("Проверить перед развёртыванием");
    for (const item of review) console.log(`- ${item}`);
  }

  console.log("");
  console.log("Развёртывание, изменение DNS, изменение провайдера и отправка писем не выполнялись.");
}
