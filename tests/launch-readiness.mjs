import { access, readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const config = JSON.parse(await readFile("frontsmith.config.json", "utf8"));
const blueprint = JSON.parse(await readFile("blueprints/auto-service/blueprint.json", "utf8"));
const sampleBusiness = JSON.parse(await readFile("blueprints/auto-service/business.example.json", "utf8"));
const genericBlueprint = JSON.parse(await readFile("blueprints/generic-service/blueprint.json", "utf8"));
const genericBusiness = JSON.parse(await readFile("blueprints/generic-service/business.example.json", "utf8"));
const readme = await readFile("README.md", "utf8");
const operatorGuide = await readFile("docs/operator/start-here.md", "utf8");
const packageSpec = await readFile("docs/product/package-spec.md", "utf8");
const architecture = await readFile("docs/product/architecture.md", "utf8");
const launchScenarios = await readFile("docs/product/launch-scenarios.md", "utf8");
const extensionGuide = await readFile("docs/developer/extension-guide.md", "utf8");
const codexWorkflowProof = await readFile("docs/walkthroughs/codex-workflow-proof.md", "utf8");
const relayProofMap = await readFile("docs/product/relay-proof-map.md", "utf8");

const requiredCapabilities = [
  "business-setup",
  "owner-brief",
  "website",
  "customer-desk",
  "ongoing-customer-communication",
  "estimates-proposals",
  "launch-plan",
  "activity-log",
  "settings-integrations",
  "extension-planning",
  "connected-action-receipts"
];

const requiredScripts = {
  check: "node scripts/check.mjs",
  bootstrap: "node scripts/bootstrap.mjs",
  "business:init": "node scripts/business-init.mjs",
  frontsmith: "node scripts/frontsmith.mjs",
  "owner:brief": "node scripts/prepare-owner-brief.mjs",
  "prepare:reply": "node scripts/prepare-customer-reply.mjs",
  "prepare:estimate": "node scripts/prepare-estimate-draft.mjs",
  "prepare:extension": "node scripts/prepare-extension-plan.mjs",
  "prepare:connected-action": "node scripts/prepare-connected-action-receipt.mjs",
  "first-run:status": "node scripts/first-run-readiness.mjs",
  "update:website": "node scripts/update-website.mjs",
  "launch:status": "node scripts/launch-status.mjs",
  "build:demo": "node scripts/build-demo.mjs",
  "preview:demo": "node scripts/preview-demo.mjs",
  "preview:website": "node scripts/preview-website.mjs",
  "deploy:check": "node scripts/build-demo.mjs --quiet && node scripts/deploy-check.mjs",
  "office:init": "node scripts/office.mjs init",
  "office:import": "node scripts/office.mjs import",
  "office:seed": "node scripts/office.mjs seed",
  "office:backup": "node scripts/office.mjs backup",
  "office:restore": "node scripts/office.mjs restore",
  "office:serve": "node office/server.mjs",
  test: "npm run test:launch && npm run test:regression && npm run test:office && npm run test:install && npm run test:codex-host && npm run test:conversation",
  "test:launch": "node tests/launch-readiness.mjs",
  "test:regression": "node tests/regression.mjs",
  "test:office": "node tests/office.mjs && node tests/work-reports.mjs && node tests/customers.mjs && node tests/generic-profile.mjs && node tests/profile-vocabulary.mjs && node tests/website-update.mjs",
  "test:install": "node tests/vendor.mjs && node tests/data-root.mjs",
  "release:check": "node scripts/release-check.mjs",
  diagnostics: "node scripts/diagnostics.mjs",
  "crm:bootstrap": "node services/crm/bootstrap.mjs",
  "crm:start": "node services/crm/start.mjs",
  "crm:migrate-customers": "node scripts/crm-migrate-customers.mjs",
  "test:codex-host": "node tests/codex-host.mjs",
  "test:conversation": "node tests/conversation.mjs && node tests/booking.mjs && node tests/handoff.mjs",
  "test:first-run": "node tests/first-run.mjs"
};

const requiredFiles = [
  "THIRD_PARTY_NOTICES.md",
  "vendor/manifest.json",
  "vendor/README.md",
  "docs/testing/external-first-run.md",
  "blueprints/auto-service/blueprint.json",
  "blueprints/auto-service/business.example.json",
  "blueprints/generic-service/blueprint.json",
  "blueprints/generic-service/business.example.json",
  "blueprints/generic-service/website/index.html",
  "website/assets/auto-workshop.png",
  "scripts/prepare-extension-plan.mjs",
  "scripts/prepare-connected-action-receipt.mjs",
  "workflows/prepare-extension-plan.md",
  "workflows/prepare-connected-action.md",
  "docs/product/launch-scenarios.md",
  "docs/product/relay-proof-map.md",
  "docs/walkthroughs/codex-workflow-proof.md",
  "docs/developer/extension-guide.md",
  "tests/regression.mjs",
  "docs/assets/frontsmith-control-panel.png",
  "docs/assets/frontsmith-acme-website.png"
];

const requiredScenarioLabels = [
  "Настройка бизнеса",
  "Сводка владельца",
  "Работа с клиентами",
  "Сметы и предложения",
  "Обновление сайта",
  "Планирование расширений",
  "Карта подтверждений Relay",
  "Статус запуска",
  "Предпросмотр сайта",
  "Пробная отправка формы",
  "Сборка Панели демонстрации",
  "Готовность к публикации",
  "Соответствие репозитория обещаниям"
];

for (const file of requiredFiles) {
  await assertExists(file);
}

assertEqual(packageJson.private ?? false, false, "package metadata is ready for public GitHub release");
assertEqual(packageJson.license, "MIT", "package license");
assertIncludes(packageJson.repository?.url ?? "", "github.com/vionaaru/codex-frontsmith", "repository URL");
assertIncludes(packageJson.homepage ?? "", "codex-frontsmith.example", "homepage URL");

for (const [script, command] of Object.entries(requiredScripts)) {
  assertEqual(packageJson.scripts?.[script], command, `npm script ${script}`);
}

assertEqual(config.defaultBlueprint, "generic-service", "универсальный профиль по умолчанию");
assertEqual(genericBusiness.blueprint, "generic-service", "стартовый профиль ссылается на свой blueprint");
assertEqual(genericBusiness.demoMode, false, "универсальный профиль не учебный");
assertEqual(genericBusiness.services.length, 0, "универсальный профиль без готового каталога услуг");
assertEqual(genericBlueprint.officeModules.length, 0, "отраслевые разделы панели выключены");
assertEqual(/авто|автомоб|АвтоРитм|VIN/i.test(JSON.stringify(genericBusiness)), false, "в универсальном профиле нет автосервисных сведений");
assertEqual(blueprint.officeModules.join(","), "vehicles,work-orders,work-results", "отраслевые разделы автосервиса");
assertEqual(sampleBusiness.businessName, "АвтоРитм", "название демонстрационного бизнеса");
assertEqual(sampleBusiness.businessType, "Автосервис", "тип демонстрационного бизнеса");
assertEqual(sampleBusiness.demoMode, true, "демонстрационный режим");
assertEqual(sampleBusiness.services.length, 8, "восемь демонстрационных услуг");
assertEqual(sampleBusiness.pricingPolicy.mode, "demo", "демонстрационные цены");
assertEqual(sampleBusiness.pricingPolicy.ownerApprovedForLiveQuotes, false, "демоценами нельзя формировать реальные предложения");
assertEqual(new URL(sampleBusiness.bookingUrl).origin, "https://example.com", "внешняя запись в Booking Flow");
assertEqual(sampleBusiness.integrations.booking.localImportEnabled, false, "импорт заявок записи не включён");
assertEqual(sampleBusiness.integrations.email.status, "disabled", "почта отключена по умолчанию");
assertEqual(sampleBusiness.integrations.calendar.status, "not_connected", "календарь не подключён");
assertEqual(config.primaryInterface, "codex", "primary interface");
assertEqual(config.deployableOutput, "website", "deployable output");
assertEqual(config.safety?.liveActionsDefault, "disabled", "live actions default");
assertEqual(config.safety?.ownerApprovalRequired, true, "owner approval required");

for (const capability of requiredCapabilities) {
  assertIncludes(config.defaultCapabilities, capability, `config capability ${capability}`);
  assertIncludes(blueprint.capabilities, capability, `blueprint capability ${capability}`);
  assertIncludes(genericBlueprint.capabilities, capability, `generic blueprint capability ${capability}`);
}

for (const scenario of requiredScenarioLabels) {
  assertIncludes(launchScenarios, scenario, `launch scenario ${scenario}`);
}

for (const command of [
  "npm run bootstrap",
  "npm run codex-host:login",
  "npm run frontsmith",
  "npm run owner:brief",
  "npm run prepare:reply",
  "npm run prepare:estimate",
  "npm run prepare:extension",
  "npm run prepare:connected-action",
  "npm run first-run:status",
  "npm run update:website",
  "npm run launch:status",
  "npm run deploy:check",
  "npm test"
]) {
  assertIncludes(readme, command, `README command ${command}`);
}

assertIncludes(readme, "docs/assets/frontsmith-control-panel.png", "README Control Panel screenshot");
assertIncludes(readme, "docs/assets/frontsmith-acme-website.png", "README Acme website screenshot");
assertIncludes(readme, "docs/walkthroughs/codex-workflow-proof.md", "README walkthrough proof");
assertIncludes(readme, "docs/product/relay-proof-map.md", "README Relay proof map");

for (const doc of [
  ["README", readme],
  ["Operator guide", operatorGuide],
  ["Package spec", packageSpec],
  ["Architecture", architecture],
  ["Extension guide", extensionGuide],
  ["Launch scenarios", launchScenarios]
]) {
  assertSafetyBoundary(doc[1], doc[0]);
}

assertIncludes(operatorGuide, "Подготовь план расширения", "operator extension prompt");
assertIncludes(operatorGuide, "first-run-readiness.md", "operator first-run readiness output");
assertIncludes(packageSpec, "Требования к расширениям", "package extension requirement");
assertIncludes(packageSpec, "Требования к записи подключённого действия", "package connected-action receipt requirement");
assertIncludes(packageSpec, "docs/product/relay-proof-map.md", "package Relay proof map");
assertIncludes(architecture, ".frontsmith/business/extensions/", "architecture extension folder");
assertIncludes(extensionGuide, "Планирование расширений", "developer extension workflow");
assertIncludes(extensionGuide, "Запись действия через подключённый сервис", "developer connected-action workflow");
assertIncludes(launchScenarios, "не должны отправлять письма, публиковать сайт, менять DNS, подключать провайдеров", "launch gate safety");
assertIncludes(launchScenarios, "Квитанция подключённого действия", "connected-action launch scenario");
for (const section of [
  "Сводка владельца",
  "Черновик ответа в модуле «Работа с клиентами»",
  "Подготовка сметы",
  "Обновление и предпросмотр сайта",
  "Планирование расширения и квитанция подключённого действия"
]) {
  assertIncludes(codexWorkflowProof, section, `walkthrough section ${section}`);
}
assertIncludes(codexWorkflowProof, "Создаваемые файлы", "walkthrough generated files");
assertIncludes(codexWorkflowProof, "Границы согласования", "walkthrough approval boundary");
for (const phrase of [
  "Может ли процесс подтвердить полномочия до выполнения действия?",
  "Ответ в модуле «Работа с клиентами»",
  "Подготовка сметы",
  "Обновление сайта",
  "Квитанция подключённого действия",
  "заготовку ссылки Neura Relay Action Card",
  "По умолчанию Frontsmith не выполняет дальнейшие внешние действия"
]) {
  assertIncludes(relayProofMap, phrase, `Relay proof map ${phrase}`);
}
assertSafetyBoundary(relayProofMap, "Relay proof map");

console.log("Проверка требований готовности Frontsmith пройдена.");

async function assertExists(file) {
  try {
    await access(file);
  } catch {
    throw new Error(`Ожидался существующий файл: ${file}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Ожидалось ${label}: ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(value, expected, label) {
  const matches = Array.isArray(value)
    ? value.includes(expected)
    : String(value ?? "").includes(expected);

  if (!matches) {
    throw new Error(`Ожидалось, что ${label} содержит ${expected}`);
  }
}

function assertSafetyBoundary(content, label) {
  const normalized = String(content).toLowerCase();
  for (const [boundary, pattern] of [
    ["согласование владельца", /соглас|одобр/],
    ["отправка сообщений", /отправ/],
    ["публикация", /публи/]
  ]) {
    if (!pattern.test(normalized)) {
      throw new Error(`${label} должен описывать границу безопасности: ${boundary}`);
    }
  }
}
