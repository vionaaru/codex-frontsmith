import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

const websiteRoot = "website";
const websiteFiles = ["index.html", "styles.css", "script.js", "frontsmith-mark.svg", "favicon.svg"];
const testPort = "4183";
const demoPort = "4184";
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-regression-"));
const root = path.join(testRoot, "business");
const testEnv = {
  ...process.env,
  FRONTSMITH_BUSINESS_ROOT: root,
  CONTACT_DELIVERY_MODE: "dry-run",
  CONTACT_TO_EMAIL: "projects@acme.com",
  CONTACT_FROM_EMAIL: "Acme <hello@acme.com>",
  CONTACT_SUBJECT_PREFIX: "Заявка с сайта",
  FRONTSMITH_TENANT_ID: "acme"
};
const deployCheckEnv = {
  ...testEnv,
  CONTACT_DELIVERY_MODE: "resend",
  RESEND_API_KEY: "re_test_frontsmith"
};
const originalWebsite = new Map();

for (const file of websiteFiles) {
  originalWebsite.set(file, await readFile(path.join(websiteRoot, file), "utf8"));
}

try {
  await run("npm", ["run", "check"]);
  await run("npm", ["run", "bootstrap"]);
  await assertExists(path.join(root, "business.json"));
  await assertExists(path.join(websiteRoot, "index.html"));
  await run("npm", ["run", "launch:status"]);

  const defaultProfile = JSON.parse(await readFile(path.join(root, "business.json"), "utf8"));
  assertEqual(defaultProfile.businessType, "Автосервис", "тип бизнеса автосервиса");
  assertEqual(defaultProfile.businessName, "АвтоРитм", "название демонстрационного автосервиса");
  assertEqual(defaultProfile.demoMode, true, "демонстрационный режим профиля");
  assertEqual(defaultProfile.services.length, 8, "восемь услуг автосервиса");
  assertEqual(defaultProfile.pricingPolicy.mode, "demo", "демонстрационные цены");
  assertEqual(defaultProfile.pricingPolicy.ownerApprovedForLiveQuotes, false, "цены не согласованы для реальных предложений");
  const seedProfile = JSON.parse(await readFile("blueprints/auto-service/business.example.json", "utf8"));
  assertEqual(JSON.stringify(defaultProfile.services), JSON.stringify(seedProfile.services), "услуги, цены и длительности сохранены из шаблона");
  assertEqual(new URL(defaultProfile.bookingUrl).origin, "https://example.com", "внешний адрес записи");
  await run("npm", ["run", "first-run:status"]);
  const defaultReadiness = await readFile(path.join(root, "launch", "first-run-readiness.md"), "utf8");
  assertDoesNotInclude(defaultReadiness, "Все обязательные поля профиля для первого запуска заполнены.", "демонстрационный профиль не готов к рабочему запуску");
  assertIncludes(defaultReadiness.toLowerCase(), "демонстра", "отчёт явно обозначает демонстрационный режим");
  assertIncludes(defaultReadiness, "До запуска владелец должен заполнить поля: 10.", "демонстрационные данные не считаются подтверждёнными сведениями бизнеса");
  const defaultWebsite = await readFile(path.join(websiteRoot, "index.html"), "utf8");
  assertIncludes(defaultWebsite, '<html lang="ru">', "русский язык после персонализации сайта");
  assertIncludes(defaultWebsite, "/assets/auto-workshop.png", "изображение автомобильной мастерской");
  assertDoesNotInclude(defaultWebsite, "acme-kitchen-remodel", "сайт не содержит фотографии кухни");
  assertAutoServices(defaultWebsite, defaultProfile);
  const defaultProfileBefore = await readFile(path.join(root, "business.json"), "utf8");
  await runRejected("npm", ["run", "bootstrap"]);
  assertEqual(await readFile(path.join(root, "business.json"), "utf8"), defaultProfileBefore, "повторная настройка не перезаписывает профиль");
  assertEqual(await readFile(path.join(websiteRoot, "index.html"), "utf8"), defaultWebsite, "отказ повторной настройки не меняет сайт");

  const malformedProfilePath = path.join(testRoot, "invalid-booking-profile.json");
  await writeFile(malformedProfilePath, JSON.stringify({ ...defaultProfile, bookingUrl: "/booking" }));
  const publicFilesBefore = new Map();
  for (const file of websiteFiles) publicFilesBefore.set(file, await readFile(path.join(websiteRoot, file), "utf8"));
  await runRejected("npm", ["run", "bootstrap", "--", "--profile", malformedProfilePath]);
  assertEqual(await readFile(path.join(root, "business.json"), "utf8"), defaultProfileBefore, "неверный адрес записи не заменяет приватный профиль");
  for (const [file, before] of publicFilesBefore) {
    assertEqual(await readFile(path.join(websiteRoot, file), "utf8"), before, "неверный адрес записи не меняет публичный файл " + file);
  }

  const legacyProfile = {
    ...defaultProfile,
    businessName: "Acme",
    businessType: "Local Service Business",
    demoMode: false,
    websiteUrl: "https://acme.com",
    contact: { ...defaultProfile.contact, phone: "1-800-123-ACME", email: "projects@acme.com", city: "Local", state: "ST" },
    serviceAreas: ["Your City", "Nearby Communities", "Surrounding Service Area"],
    services: ["Kitchen Remodeling", "Bathroom Remodeling", "Living Spaces"].map(name => ({ name })),
    brandVoice: "Clear, practical, respectful, detail-oriented, and homeowner-friendly."
  };
  await writeFile(path.join(root, "business.json"), JSON.stringify(legacyProfile));
  await run("npm", ["run", "first-run:status"]);
  const legacyReadiness = await readFile(path.join(root, "launch", "first-run-readiness.md"), "utf8");
  assertIncludes(legacyReadiness, "До запуска владелец должен заполнить поля: 10.", "старые английские примеры также требуют заполнения");

  await rm(root, { recursive: true, force: true });

  await run("npm", [
    "run", "bootstrap", "--",
    "--business-name", "АвтоРитм",
    "--business-type", "Автосервис",
    "--service-areas", "Москва,Ближайшие районы",
    "--phone", "+7 (495) 123-45-67",
    "--email", "service@avtoritm.example",
    "--website-url", "https://avtoritm.example",
    "--city", "Москва",
    "--state", "Москва"
  ]);

  await assertExists(path.join(root, "business.json"));
  await assertExists(path.join(root, "customer-inquiries", "README.md"));
  await assertExists(path.join(root, "estimates", "README.md"));
  await assertExists(path.join(root, "extensions", "README.md"));
  await assertExists(path.join(root, "launch", "launch-checklist.md"));
  await assertExists(path.join(root, "launch", "website-review.md"));
  await assertExists(path.join(root, "settings", "integrations.md"));

  for (const file of websiteFiles) {
    await assertExists(path.join(websiteRoot, file));
  }

  const business = JSON.parse(await readFile(path.join(root, "business.json"), "utf8"));
  const vercelConfig = JSON.parse(await readFile("vercel.json", "utf8"));
  assertEqual(business.businessName, "АвтоРитм", "business name");
  assertEqual(business.contact.email, "service@avtoritm.example", "contact email");
  assertEqual(business.websiteUrl, "https://avtoritm.example", "URL сайта");
  assertEqual(vercelConfig.outputDirectory, "dist/frontsmith-demo", "Vercel output directory");
  assertEqual(vercelConfig.framework, null, "Vercel framework");
  assertEqual(vercelConfig.buildCommand, "npm run build:demo", "Vercel build command");
  assertEqual(vercelConfig.functions["api/contact.js"].maxDuration, 10, "contact function duration");
  assertEqual(vercelConfig.redirects?.[0]?.source, "/", "Vercel default host root redirect source");
  assertEqual(vercelConfig.redirects?.[0]?.has?.[0]?.type, "host", "Vercel default host root redirect match type");
  assertEqual(vercelConfig.redirects?.[0]?.has?.[0]?.value, "frontsmith.vercel.app", "Vercel default host root redirect source host");
  assertEqual(
    vercelConfig.redirects?.[0]?.destination,
    "https://frontsmith.neurapath.ai/",
    "Vercel default host root redirect destination"
  );
  assertEqual(vercelConfig.redirects?.[0]?.permanent, true, "Vercel default host root redirect permanence");
  assertEqual(vercelConfig.redirects?.[1]?.source, "/:path*", "Vercel default host path redirect source");
  assertEqual(vercelConfig.redirects?.[1]?.has?.[0]?.type, "host", "Vercel default host path redirect match type");
  assertEqual(vercelConfig.redirects?.[1]?.has?.[0]?.value, "frontsmith.vercel.app", "Vercel default host path redirect source host");
  assertEqual(
    vercelConfig.redirects?.[1]?.destination,
    "https://frontsmith.neurapath.ai/:path*",
    "Vercel default host path redirect destination"
  );
  assertEqual(vercelConfig.redirects?.[1]?.permanent, true, "Vercel default host path redirect permanence");

  const homepage = await readFile(path.join(websiteRoot, "index.html"), "utf8");
  assertIncludes(homepage, "АвтоРитм", "homepage business name");
  assertIncludes(homepage, "Компьютерная диагностика", "homepage kitchen service");
  assertIncludes(homepage, "Шиномонтаж", "homepage bathroom service");
  assertIncludes(homepage, "Развал-схождение", "homepage living service");
  assertIncludes(homepage, "Контакты · нерабочие образцы", "контакты явно помечены как демонстрационные");
  assertIncludes(homepage, business.contact.phone, "телефон показан текстом из профиля");
  assertIncludes(homepage, business.contact.email, "почта показана текстом из профиля");
  assertDoesNotInclude(homepage, 'href="tel:', "нерабочие контакты не предлагают звонок");
  assertDoesNotInclude(homepage, "https://wa.me/", "демонстрационные контакты не предлагают WhatsApp");
  assertDoesNotInclude(homepage, 'href="mailto:', "демонстрационные контакты не предлагают отправку письма");
  assertIncludes(homepage, 'rel="canonical"', "canonical metadata");
  assertIncludes(homepage, 'property="og:image"', "Open Graph image metadata");
  assertIncludes(homepage, 'name="twitter:card"', "Twitter card metadata");
  assertIncludes(homepage, 'name="twitter:image:alt"', "Twitter image alt metadata");
  assertIncludes(homepage, 'action="/api/contact"', "contact API form action");
  assertIncludes(homepage, 'data-intake-status', "contact status message");
  assertIncludes(homepage, "https://avtoritm.example", "canonical URL");
  assertDoesNotInclude(homepage, ["Base", "ment"].join(""), "legacy extra service");
  assertDoesNotInclude(homepage, ".html", "extensionless website routes");
  assertNoTokens(homepage, "homepage");
  assertIncludes(homepage, 'data-demo-mode="true"', "демонстрационная форма не отправляет реальные заявки");
  assertAutoServices(homepage, business);
  const websiteScript = await readFile(path.join(websiteRoot, "script.js"), "utf8");
  await assertDemoFormLocal(websiteScript);
  assertServiceFilters(homepage, websiteScript, business);

  await run("npm", [
    "run",
    "prepare:reply",
    "--",
    "--name",
    "Иван",
    "--project",
    "Компьютерная диагностика",
    "--notes",
    "Клиент заметил индикатор неисправности двигателя и хочет понять результаты диагностики."
  ]);
  const replyDraftPath = path.join(root, "customer-inquiries", "компьютерная-диагностика-reply-draft.md");
  await assertExists(replyDraftPath);
  const replyDraft = await readFile(replyDraftPath, "utf8");
  assertIncludes(replyDraft, "Черновик ответа клиенту", "reply draft title");
  assertIncludes(replyDraft, "Статус: черновик, нужна проверка владельцем, не отправлен", "reply draft status");
  assertIncludes(replyDraft, "Краткая сводка", "reply draft executive summary");
  assertIncludes(replyDraft, "Сведения о клиенте", "reply draft customer context");
  assertIncludes(replyDraft, "Повторный контакт", "reply draft follow-up tracking");
  assertIncludes(replyDraft, "Проверка владельцем", "reply draft owner review");
  assertIncludes(replyDraft, "Чек-лист отправки", "reply draft send checklist");
  assertIncludes(replyDraft, "Передача коннектору", "reply draft connector handoff");
  assertIncludes(replyDraft, "Материалы", "reply draft artifacts");
  assertIncludes(
    replyDraft,
    ".frontsmith/business/customer-inquiries/компьютерная-диагностика-reply-draft.md",
    "reply draft artifact path"
  );
  assertIncludes(replyDraft, "Границы безопасности", "reply draft safety boundary");
  assertIncludes(replyDraft, "Ничего не отправлено", "reply draft send boundary");
  assertDoesNotInclude(replyDraft, testRoot, "reply draft temporary root path");

  await run("npm", [
    "run",
    "prepare:estimate",
    "--",
    "--project",
    "Компьютерная диагностика",
    "--scope",
    "Считывание кодов ошибок, проверка электронных систем и рекомендации по дальнейшей диагностике."
  ]);
  const estimateDraftPath = path.join(root, "estimates", "компьютерная-диагностика-estimate-draft.md");
  await assertExists(estimateDraftPath);
  const estimateDraft = await readFile(estimateDraftPath, "utf8");
  assertIncludes(estimateDraft, "Заготовка сметы", "estimate draft title");
  assertIncludes(estimateDraft, "Статус: заготовка, нужна проверка владельцем, не отправлена", "estimate draft status");
  assertIncludes(estimateDraft, "Краткая сводка", "estimate draft executive summary");
  assertIncludes(estimateDraft, "Известный объём работ", "estimate draft scope captured");
  assertIncludes(estimateDraft, "- Считывание кодов ошибок", "estimate draft scope item");
  assertIncludes(estimateDraft, "Что нужно до расчёта цены", "estimate draft missing before pricing");
  assertIncludes(estimateDraft, "Вопросы владельцу", "estimate draft owner questions");
  assertIncludes(estimateDraft, "Структура предложения", "estimate draft proposal outline");
  assertIncludes(estimateDraft, "Правила расчёта", "estimate draft pricing rules");
  assertIncludes(estimateDraft, "Проверка владельцем", "estimate draft owner review");
  assertIncludes(estimateDraft, "Передача коннектору", "estimate draft connector handoff");
  assertIncludes(estimateDraft, "Материалы", "estimate draft artifacts");
  assertIncludes(
    estimateDraft,
    ".frontsmith/business/estimates/компьютерная-диагностика-estimate-draft.md",
    "estimate draft artifact path"
  );
  assertIncludes(
    estimateDraft,
    ".frontsmith/business/customer-inquiries/компьютерная-диагностика-reply-draft.md",
    "estimate draft related reply path"
  );
  assertIncludes(estimateDraft, "Границы безопасности", "estimate draft safety boundary");
  assertIncludes(estimateDraft, "Ничего не отправлено", "estimate draft send boundary");
  assertDoesNotInclude(estimateDraft, testRoot, "estimate draft temporary root path");

  await run("npm", [
    "run",
    "prepare:extension",
    "--",
    "--capability",
    "Запись на консультацию",
    "--connector",
    "Google Calendar",
    "--goal",
    "Подготовить согласуемый владельцем процесс записи на консультации."
  ]);
  const extensionPlanPath = path.join(root, "extensions", "запись-на-консультацию-extension-plan.md");
  await assertExists(extensionPlanPath);
  const extensionPlan = await readFile(extensionPlanPath, "utf8");
  assertIncludes(extensionPlan, "План расширения", "extension plan title");
  assertIncludes(extensionPlan, "Статус: черновик плана, нужна проверка владельцем, не подключено", "extension plan status");
  assertIncludes(extensionPlan, "Краткая сводка", "extension plan executive summary");
  assertIncludes(extensionPlan, "Границы процесса", "extension plan workflow boundary");
  assertIncludes(extensionPlan, "Границы навыка", "extension plan skill boundary");
  assertIncludes(extensionPlan, "Границы коннектора", "extension plan connector boundary");
  assertIncludes(extensionPlan, "Проверка владельцем", "extension plan owner review");
  assertIncludes(extensionPlan, "Чек-лист внедрения", "extension plan implementation checklist");
  assertIncludes(extensionPlan, ".frontsmith/business/extensions/запись-на-консультацию-extension-plan.md", "extension plan artifact path");
  assertIncludes(extensionPlan, "Границы безопасности", "extension plan safety boundary");
  assertIncludes(extensionPlan, "не подключает сервисы", "extension plan live-action boundary");
  assertDoesNotInclude(extensionPlan, testRoot, "extension plan temporary root path");

  await run("npm", [
    "run",
    "prepare:connected-action",
    "--",
    "--action-type",
    "email",
    "--title",
    "Отправить сообщение после консультации",
    "--target",
    "Повторный контакт с клиентом",
    "--evidence",
    "Заметки о клиенте от владельца"
  ]);
  const connectedActionMarkdownPath = path.join(root, "connected-actions", "email-отправить-сообщение-после-консультации-receipt.md");
  const connectedActionJsonPath = path.join(root, "connected-actions", "email-отправить-сообщение-после-консультации-receipt.json");
  await assertExists(connectedActionMarkdownPath);
  await assertExists(connectedActionJsonPath);
  const connectedActionReceipt = await readFile(connectedActionMarkdownPath, "utf8");
  const connectedActionRecord = JSON.parse(await readFile(connectedActionJsonPath, "utf8"));
  assertEqual(connectedActionRecord.schema, "frontsmith.connected_action_receipt.v0.1", "connected-action schema");
  assertEqual(connectedActionRecord.mode, "dry_run", "connected-action mode");
  assertEqual(connectedActionRecord.adapter_boundary.live_adapter_enabled, false, "connected-action live adapter boundary");
  assertIncludes(connectedActionReceipt, "Запись подключаемого действия", "connected-action receipt title");
  assertIncludes(connectedActionReceipt, "Ссылки Neura", "connected-action Neura refs");
  assertIncludes(connectedActionReceipt, "registry-ref-pending", "connected-action registry ref");
  assertIncludes(connectedActionReceipt, "relay-action-card-pending", "connected-action relay action card ref");
  assertIncludes(connectedActionReceipt, "pending_until_connected_mode_preflight", "connected-action decision receipt boundary");
  assertIncludes(connectedActionReceipt, "Заблокированные адаптеры", "connected-action blocked adapters");
  assertIncludes(connectedActionReceipt, ".frontsmith/business/connected-actions/email-отправить-сообщение-после-консультации-receipt.md", "connected-action markdown artifact path");
  assertIncludes(connectedActionReceipt, ".frontsmith/business/connected-actions/email-отправить-сообщение-после-консультации-receipt.json", "connected-action json artifact path");
  assertIncludes(connectedActionReceipt, "не отправляет письма", "connected-action send boundary");
  assertDoesNotInclude(connectedActionReceipt, testRoot, "connected-action temporary root path");

  await run("npm", ["run", "launch:status"]);
  await assertExists(path.join(root, "launch", "launch-status.md"));

  await run("npm", ["run", "first-run:status"]);
  const firstRunReadiness = await readFile(path.join(root, "launch", "first-run-readiness.md"), "utf8");
  assertIncludes(firstRunReadiness, "Готовность первого запуска", "first-run readiness title");
  assertIncludes(firstRunReadiness, "Проверка профиля бизнеса", "first-run business profile review");
  assertIncludes(firstRunReadiness, "Нужны данные владельца", "first-run owner input section");
  assertIncludes(firstRunReadiness, "Границы согласования владельцем", "first-run approval boundary");
  assertIncludes(firstRunReadiness, "Границы безопасности", "first-run safety boundary");
  assertIncludes(firstRunReadiness, ".frontsmith/business/launch/first-run-readiness.md", "first-run artifact path");
  assertIncludes(firstRunReadiness, "не отправляет письма", "first-run send boundary");
  assertDoesNotInclude(firstRunReadiness, testRoot, "first-run temporary root path");

  await run("npm", ["run", "owner:brief"]);
  await assertExists(path.join(root, "activity", "owner-brief.md"));
  const ownerBrief = await readFile(path.join(root, "activity", "owner-brief.md"), "utf8");
  assertIncludes(ownerBrief, "Сводка владельца", "owner brief title");
  assertIncludes(ownerBrief, "Краткая сводка", "owner brief executive summary");
  assertIncludes(ownerBrief, "Изменения", "owner brief changed section");
  assertIncludes(ownerBrief, "Ожидает проверки", "owner brief waiting section");
  assertIncludes(ownerBrief, "Заблокировано", "owner brief blocked section");
  assertIncludes(ownerBrief, "Требует согласования", "owner brief approval section");
  assertIncludes(ownerBrief, "Следующие действия", "owner brief next actions");
  assertIncludes(ownerBrief, "Материалы", "owner brief artifacts");
  assertIncludes(ownerBrief, ".frontsmith/business/customer-inquiries/компьютерная-диагностика-reply-draft.md", "owner brief reply artifact path");
  assertIncludes(ownerBrief, ".frontsmith/business/estimates/компьютерная-диагностика-estimate-draft.md", "owner brief estimate artifact path");
  assertIncludes(ownerBrief, "Границы безопасности", "owner brief safety boundary");
  assertDoesNotInclude(ownerBrief, testRoot, "owner brief temporary root path");

  await run("npm", ["run", "update:website"]);
  await run("npm", ["run", "update:website"]);
  assertAutoServices(await readFile(path.join(websiteRoot, "index.html"), "utf8"), business);
  assertEqual(JSON.stringify(JSON.parse(await readFile(path.join(root, "business.json"), "utf8")).services), JSON.stringify(business.services), "обновления сайта сохраняют профиль восьми услуг");
  const websiteReview = await readFile(path.join(root, "launch", "website-review.md"), "utf8");
  const websiteActivity = await readFile(path.join(root, "activity", "latest-website-update.md"), "utf8");
  assertIncludes(websiteReview, "Проверка сайта", "website review title");
  assertIncludes(websiteReview, "Статус: предпросмотр, нужна проверка владельцем, не опубликован", "website review status");
  assertIncludes(websiteReview, "Краткая сводка", "website review executive summary");
  assertIncludes(websiteReview, "Изменённые файлы", "website review changed files");
  assertIncludes(websiteReview, "Обновлено из профиля бизнеса", "website review business profile");
  assertIncludes(websiteReview, "Связь профиля и сайта", "website review source summary");
  assertIncludes(websiteReview, "Проверка владельцем", "website review owner review");
  assertIncludes(websiteReview, "Локальный предпросмотр", "website review local preview");
  assertIncludes(websiteReview, "Препятствия публикации", "website review blockers");
  assertIncludes(websiteReview, "Материалы", "website review artifacts");
  assertIncludes(websiteReview, ".frontsmith/business/launch/website-review.md", "website review artifact path");
  assertIncludes(websiteReview, ".frontsmith/business/activity/latest-website-update.md", "website review activity path");
  assertIncludes(websiteReview, "Границы безопасности", "website review safety boundary");
  assertDoesNotInclude(websiteReview, testRoot, "website review temporary root path");
  assertIncludes(websiteActivity, "Последнее обновление сайта", "website activity title");
  assertIncludes(websiteActivity, "Статус: локальное обновление, нужна проверка владельцем", "website activity status");
  assertIncludes(websiteActivity, "Краткая сводка", "website activity executive summary");
  assertIncludes(websiteActivity, "Изменённые файлы", "website activity changed files");
  assertIncludes(websiteActivity, "Перед публикацией", "website activity deployment review");
  assertIncludes(websiteActivity, "Материалы", "website activity artifacts");
  assertIncludes(websiteActivity, "Границы безопасности", "website activity safety boundary");
  assertDoesNotInclude(websiteActivity, testRoot, "website activity temporary root path");
  await run("npm", ["run", "check"]);
  await run("npm", ["run", "deploy:check"], deployCheckEnv);
  await assertExists(path.join("dist", "frontsmith-demo", "index.html"));
  await assertExists(path.join("dist", "frontsmith-demo", "website", "index.html"));

  const demoHomepage = await readFile(path.join("dist", "frontsmith-demo", "index.html"), "utf8");
  assertTextIncludes(demoHomepage, "Настройте цифровой офис в Codex", "demo hero");
  assertIncludes(demoHomepage, "Что делает Frontsmith", "demo module list");
  assertIncludes(demoHomepage, "Работа с клиентами", "demo customer desk");
  assertIncludes(demoHomepage, 'href="/website"', "demo website preview link");
  assertIncludes(demoHomepage, "https://github.com/neurarelay/frontsmith", "demo GitHub setup path");

  const builtWebsite = await readFile(path.join("dist", "frontsmith-demo", "website", "index.html"), "utf8");
  assertIncludes(builtWebsite, 'href="/website/styles.css"', "built website stylesheet path");
  assertIncludes(builtWebsite, 'src="/website/script.js"', "built website script path");
  assertDoesNotInclude(builtWebsite, 'href="./styles.css"', "built website relative stylesheet path");

  const demoPreview = spawn(process.execPath, ["scripts/preview-demo.mjs", "--port", demoPort, "--quiet"], {
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForPreview(demoPreview, "Предпросмотр демонстрации Frontsmith");
    for (const route of ["/", "/website", "/styles.css", "/script.js", "/frontsmith-mark.svg", "/website/styles.css"]) {
      const response = await fetch(`http://127.0.0.1:${demoPort}${route}`);
      if (!response.ok) {
        throw new Error(`Ошибка маршрута предпросмотра демонстрации: ${route} вернул ${response.status}`);
      }
    }
  } finally {
    await stopPreview(demoPreview);
  }

  const preview = spawn(process.execPath, ["scripts/preview-website.mjs", "--port", testPort], {
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForPreview(preview, "Предпросмотр сайта Frontsmith");
    for (const route of ["/", "/styles.css", "/script.js", "/frontsmith-mark.svg", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png"]) {
      const response = await fetch(`http://127.0.0.1:${testPort}${route}`);
      if (!response.ok) {
        throw new Error(`Ошибка маршрута предпросмотра: ${route} вернул ${response.status}`);
      }
      if (route.endsWith(".png") && response.headers.get("content-type") !== "image/png") {
        throw new Error(`Маршрут предпросмотра вернул неправильный тип PNG: ${route}`);
      }
    }

    const invalidContact = await fetch(`http://127.0.0.1:${testPort}/api/contact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Нет контактов" })
    });
    assertEqual(invalidContact.status, 400, "invalid contact request status");

    const validContact = await fetch(`http://127.0.0.1:${testPort}/api/contact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Иван",
        email: "jamie@example.com",
        phone: "",
        preferred_contact: "Email",
        project_type: "Компьютерная диагностика",
        project_notes: "Нужна диагностика индикатора неисправности двигателя."
      })
    });
    const validContactBody = await validContact.json();
    assertEqual(validContact.status, 200, "valid contact request status");
    assertEqual(validContactBody.ok, true, "valid contact request result");
    assertEqual(validContactBody.id, "dry-run", "valid contact dry-run id");
  } finally {
    await stopPreview(preview);
  }

  console.log("Регрессионные тесты Frontsmith пройдены.");
} finally {
  await restoreWebsite();
  await rm(testRoot, { recursive: true, force: true });
}

async function run(command, args, env = testEnv) {
  await new Promise((resolve, reject) => {
    const npmCli = env.npm_execpath;
    if (command === "npm" && !npmCli) {
      reject(new Error("Не найден npm CLI: запускайте регрессионные тесты через npm run test:regression или npm test."));
      return;
    }
    const executable = command === "npm" ? process.execPath : command;
    const commandArgs = command === "npm" ? [npmCli, ...args] : args;
    const child = spawn(executable, commandArgs, { env, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} завершилась с кодом ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function runRejected(command, args, env = testEnv) {
  let rejected = false;
  try { await run(command, args, env); }
  catch (error) {
    if (!/завершилась с кодом [1-9]/.test(error.message)) throw error;
    rejected = true;
  }
  assertEqual(rejected, true, "некорректная операция завершилась отказом");
}

function assertAutoServices(html, profile) {
  const cards = [...html.matchAll(/<article\b[^>]*class="service-card"[^>]*>[\s\S]*?<\/article>/g)].map(match => match[0]);
  assertEqual(cards.length, 8, "восемь карточек услуг после обновления");
  for (const service of profile.services) {
    const card = cards.find(value => value.includes(service.name));
    assertEqual(Boolean(card), true, "карточка услуги " + service.name);
    const price = service.priceFrom === 0 ? "Бесплатно" : "от " + new Intl.NumberFormat("ru-RU", {
      style: "currency", currency: profile.currency, maximumFractionDigits: 0
    }).format(service.priceFrom);
    assertIncludes(card, price, "цена услуги " + service.name);
    assertIncludes(card, `href="${profile.bookingUrl}"`, "ссылка записи услуги " + service.name);
    assertIncludes(card, 'rel="noopener noreferrer"', "безопасная внешняя ссылка записи " + service.name);
    assertIncludes(card, String(service.durationMinutes), "длительность услуги " + service.name);
    assertIncludes(card, `data-service-category="${service.category}"`, "категория услуги " + service.name);
  }
}

async function assertDemoFormLocal(source) {
  const marker = 'intakeForm.addEventListener("submit", async (event) => {';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n});', start);
  assertEqual(start >= 0 && end > start, true, "найден обработчик формы");
  const handler = source.slice(start + marker.length, end);
  let requests = 0;
  let mailDrafts = 0;
  let busyChanges = 0;
  let prevented = false;
  let status = "";
  await runInNewContext(`(async (event) => {${handler}\n})(event)`, {
    event: { preventDefault() { prevented = true; } },
    intakeForm: { dataset: { demoMode: "true" }, action: "/api/contact" },
    validateIntakeForm: () => true,
    intakePayload: () => ({ name: "Иван", email: "ivan@example.com" }),
    setIntakeStatus(message) { status = message; },
    setSubmitting() { busyChanges++; },
    fetch() { requests++; throw new Error("Демо-форма попыталась отправить запрос"); },
    fallbackMailto() { mailDrafts++; }
  });
  assertEqual(prevented, true, "демо-форма отменяет стандартную отправку");
  assertEqual(requests, 0, "демо-форма не вызывает fetch");
  assertEqual(mailDrafts, 0, "демо-форма не открывает почтовую отправку");
  assertEqual(busyChanges, 0, "демо-форма возвращается до сетевой отправки");
  assertIncludes(status, "Данные никуда не отправлены", "результат локальной проверки формы");
}

function assertServiceFilters(html, source, profile) {
  const categories = ["all", ...new Set(profile.services.map(service => service.category))];
  const buttons = categories.map(category => {
    assertIncludes(html, `data-service-filter="${category}"`, "фильтр категории " + category);
    return {
      dataset: { serviceFilter: category },
      classList: { toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, handler) { this.click = handler; }
    };
  });
  const cards = profile.services.map(service => ({ dataset: { serviceCategory: service.category }, hidden: false }));
  const status = { textContent: "" };
  const marker = "const serviceFilters =";
  assertEqual(source.includes(marker), true, "логика фильтрации существует");
  runInNewContext(source.slice(source.indexOf(marker)), {
    document: {
      querySelectorAll(selector) { return selector === "[data-service-filter]" ? buttons : cards; },
      querySelector() { return status; }
    }
  });
  for (const button of buttons) {
    button.click();
    const category = button.dataset.serviceFilter;
    const expected = category === "all" ? 8 : profile.services.filter(service => service.category === category).length;
    assertEqual(cards.filter(card => !card.hidden).length, expected, "фильтр показывает только свою категорию " + category);
    assertEqual(button["aria-pressed"], "true", "активный фильтр обозначен для доступности");
    assertEqual(status.textContent, `Показано услуг: ${expected}`, "число услуг после фильтрации");
  }
}

async function restoreWebsite() {
  for (const [file, content] of originalWebsite.entries()) {
    await writeFile(path.join(websiteRoot, file), content);
  }
}

async function assertExists(file) {
  try {
    await access(file);
  } catch {
    throw new Error(`Ожидался существующий файл: ${file}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Ожидалось ${label}: ${expected}, получено ${actual}`);
  }
}

function assertIncludes(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`Ожидалось, что ${label} содержит ${expected}`);
  }
}

function assertTextIncludes(content, expected, label) {
  assertIncludes(content.replace(/&nbsp;/g, " "), expected, label);
}

function assertDoesNotInclude(content, expected, label) {
  if (content.includes(expected)) {
    throw new Error(`Ожидалось, что ${label} не содержит ${expected}`);
  }
}

function assertNoTokens(content, label) {
  if (/\{\{[a-zA-Z0-9]+\}\}/.test(content)) {
    throw new Error(`В ${label} найден незаменённый маркер сайта`);
  }
}

async function waitForPreview(child, readyText) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (output.includes(readyText)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Сервер предпросмотра не запустился. Вывод: ${output}`);
}

async function stopPreview(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("close", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 1000);
  });
}
