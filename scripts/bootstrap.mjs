// Первичная подготовка Frontsmith одной командой. Docker, Python, Go и OpenAI API key не нужны.
//
// Установочные артефакты (crmkit, pii-guard, модель NER, uv, Python, wheels) берутся из vendor/
// репозитория и сверяются с vendor/manifest.json; из интернета Bootstrap ничего не скачивает.
//
//   npm run bootstrap                                    первый запуск спросит каталог данных
//   npm run bootstrap -- --data-root E:\Frontsmith       каталог данных без вопроса (запоминается)
//   npm run bootstrap -- --yes                           не спрашивать: путь по умолчанию или --data-root
//   npm run bootstrap -- --business-name "…" …          флаги профиля бизнеса для первой установки
//   npm run bootstrap -- --blueprint auto-service        отраслевой профиль вместо generic-service (первая установка)
//
//  0. поставка: файлы Git LFS на месте
//  1. каталог данных Frontsmith          7. миграции офисной базы
//  2. структура каталогов                8. CustomerProvider (crmkit)
//  3. Privacy runtime (uv → Python → pii-guard + NER)
//  4. crmkit runtime                     9. готовность Privacy Service
//  5. хранилище CRM                     10. готовность crmkit
//  6. профиль и офисная база            11. вход ChatGPT для Codex (только проверка)
//                                       12. итог
//
// Повторный запуск ничего не скачивает и не пересоздаёт: CRM, клиенты, состояние
// псевдонимизации, вход Codex и офисная база остаются как есть. Учебные клиенты не
// создаются (учебный набор — отдельно: npm run office:seed). Контакты клиентов прежней
// модели в CRM не переносятся автоматически: только npm run crm:migrate-customers.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { assertHealthy, backupOfficeDb, migrate, officeDbPath, openOfficeDb, schemaVersion } from "../office/lib/db.mjs";
import { importCatalog, readProfile, syncBusinessProjection } from "../office/lib/import.mjs";
import { CrmkitProvider } from "../office/customers/crmkit-provider.mjs";
import { bootstrapCrm } from "../services/crm/bootstrap.mjs";
import { crmPaths, ensureCrm, freePort, protectDir } from "../services/crm/runtime.mjs";
import { codexAuthStatus } from "../services/codex-host/ai-runtime.mjs";
import { DATA_ROOT_POINTER, rememberDataRoot, runtimePaths, runtimeStatus, startPrivacyService } from "../services/privacy/runtime.mjs";
import { LEGACY_HINT, foreignCrmLinks, inspectBusinessDb, inspectInstallation, latestSchema, projectRoot } from "./lib/installation.mjs";
import { businessRoot } from "./lib/paths.mjs";
import { dataRootPlan, looksInstalled, promptDataRoot, validateDataRoot } from "./lib/data-root.mjs";
import { VendorError, assertBundledPlatform, isLfsPointer, readManifest, vendorPath } from "./lib/vendor.mjs";
import { LEGACY_BLUEPRINT, defaultBlueprintId, officeModules } from "./lib/blueprints.mjs";

const args = process.argv.slice(2);
const status = { office: "not_ready", business: "not_ready", crm: "not_ready", privacy: "not_ready", customers: "not_ready", codex: "unknown" };
const say = (text = "") => console.log(text);
const step = (number, text) => say(`\n${number}. ${text}`);

class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

try {
  await bootstrap();
} catch (error) {
  const code = error instanceof BootstrapError ? error.code : "BOOTSTRAP_FAILED";
  console.error(`\n✗ ${code}: ${error.message}`);
  printSummary();
  process.exitCode = 1;
}

async function bootstrap() {
  if (args.includes("--reset")) {
    throw new BootstrapError("BOOTSTRAP_RESET_REFUSED", "bootstrap не удаляет рабочие данные. Пересоздать каталог бизнеса: npm run business:init -- --reset");
  }

  // ── 0. поставка ─────────────────────────────────────────────────
  // До выбора каталога и установки: настоящие файлы Git LFS, а не указатели
  step(0, "Поставка Frontsmith (vendor/)");
  try {
    assertBundledPlatform();
    const manifest = readManifest();
    const pointers = manifest.components.flatMap((item) => item.files ?? []).filter((file) => file.lfs && (!existsSync(vendorPath(file.path)) || isLfsPointer(vendorPath(file.path))));
    if (pointers.length) {
      throw new VendorError("LFS_OBJECTS_MISSING", `большие файлы не получены из Git LFS (${pointers.length} из ${manifest.components.flatMap((item) => item.files ?? []).filter((file) => file.lfs).length}), например ${pointers[0].path}.\n` +
        "   Выполните в каталоге Frontsmith:\n     git lfs install\n     git lfs pull\n   и повторите npm run bootstrap");
    }
  } catch (error) {
    throw new BootstrapError(error.code ?? "VENDOR_NOT_READY", error.message);
  }
  say("   crmkit, pii-guard, модель NER, uv, Python и wheels на месте (SHA-256 проверяется при установке)");

  // ── 1. каталог данных ───────────────────────────────────────────
  step(1, "Каталог данных Frontsmith");
  const root = await chooseDataRoot();
  say(`   данные бизнеса: ${path.resolve(businessRoot())}`);

  // ── 2. структура ────────────────────────────────────────────────
  step(2, "Структура каталогов");
  const crm = crmPaths(root);
  const privacy = runtimePaths(root);
  mkdirSync(privacy.runtime, { recursive: true });
  protectDir(privacy.stateDir);
  protectDir(crm.dataDir);
  mkdirSync(businessRoot(), { recursive: true });
  const before = inspectBusinessDb();
  if (before.kind === "foreign") throw new BootstrapError("BUSINESS_DB_NOT_READY", `${before.file} не является базой офиса Frontsmith`);
  say(`   runtime/, privacy/, crm/ — в каталоге данных; установка: ${installationLabel(before)}`);

  // ── 3. Privacy runtime ──────────────────────────────────────────
  step(3, "Privacy runtime (pii-guard + NER)");
  let privacyProbed = false;
  const prepared = runtimeStatus(privacy);
  if (prepared.ready) {
    say(`   уже подготовлен: Python ${prepared.marker.python}, pii-guard ${prepared.marker.piiGuardCommit.slice(0, 7)}, NER ${prepared.marker.nerRevision.slice(0, 7)}`);
  } else {
    say(`   подготовка (${prepared.reason}); установка из поставки, без сети`);
    runNode("services/privacy/bootstrap.mjs", [], "PRIVACY_NOT_READY");
    if (!runtimeStatus(privacy).ready) throw new BootstrapError("PRIVACY_NOT_READY", "Privacy runtime не подготовлен");
    privacyProbed = true;
  }

  // ── 4–5. crmkit и хранилище CRM ─────────────────────────────────
  step("4–5", "crmkit и хранилище CRM");
  try {
    await bootstrapCrm(crm, { log: (text) => say(`   ${text.trim()}`) });
  } catch (error) {
    throw new BootstrapError("CRM_NOT_READY", error.message);
  }
  status.crm = "ready";

  // ── 6–7. профиль бизнеса и офисная база ────────────────────────
  step("6–7", "Профиль бизнеса и офисная база");
  const install = inspectInstallation();
  const profileArgs = args.filter((value, index) => value !== "--data-root" && args[index - 1] !== "--data-root" && value !== "--yes");
  // Новая установка — профиль по умолчанию (frontsmith.config.json) или явный --blueprint.
  // Существующий business.json не перенастраивается: только явный --profile
  if (!install.profile) {
    say(`   профиль бизнеса создаётся (npm run business:init): ${flag("--blueprint") ?? (flag("--profile") ? "--profile" : `${defaultBlueprintId()}, профиль по умолчанию`)}`);
    runNode("scripts/business-init.mjs", profileArgs, "BUSINESS_DB_NOT_READY");
  } else if (profileArgs.includes("--profile")) {
    say("   профиль бизнеса заменяется явным --profile");
    runNode("scripts/business-init.mjs", profileArgs, "BUSINESS_DB_NOT_READY");
  } else {
    say(`   профиль бизнеса уже есть${profileArgs.length ? "; флаги профиля и --blueprint применяются только при первой установке (замена: npm run business:init -- --blueprint ID или --profile ФАЙЛ)" : ""}`);
  }
  const profile = await readProfile();
  say(`   бизнес-профиль: ${profile.blueprint ?? `${LEGACY_BLUEPRINT} (профиль без поля blueprint)`}; разделы офиса: ${officeModules(profile).join(", ")}`);
  await prepareBusinessDb(before, crm);
  status.business = "ready";

  // ── 8. CustomerProvider ─────────────────────────────────────────
  step(8, "CustomerProvider");
  await checkCustomers();

  // ── 9. Privacy Service ──────────────────────────────────────────
  step(9, "Готовность Privacy Service");
  if (privacyProbed) {
    say("   проверен при подготовке runtime: /health ready");
  } else {
    await probePrivacy(privacy);
  }
  status.privacy = "ready";

  // ── 10. crmkit ──────────────────────────────────────────────────
  step(10, "Готовность crmkit");
  say("   crmkitd отвечает /readyz на 127.0.0.1 и принимает токен Frontsmith; новый код входа не выдаётся");
  status.office = "ready";

  // ── 11. Codex ───────────────────────────────────────────────────
  step(11, "Вход ChatGPT для Codex");
  const codex = codexAuthStatus({ forbiddenRoots: [privacy.runtime, privacy.stateDir, crm.dataDir, crm.runtime] });
  status.codex = codex.state;
  if (codex.state === "ready") say(`   ${codex.version}, вход ChatGPT есть`);
  else if (codex.state === "login_required") say("   Codex authentication required.\n   Run: npm run codex-host:login");
  else say("   Codex CLI не найден: установите Codex или укажите CODEX_BIN. Офис работает без AI");

  printSummary(install);
}

// Первая установка: --data-root, интерактивный выбор или путь по умолчанию в неинтерактивном
// терминале. Существующая установка: сохранённый каталог, без вопросов и без переноса
async function chooseDataRoot() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes("--yes");
  let plan;
  try {
    plan = dataRootPlan({ requested: flag("--data-root"), interactive });
  } catch (error) {
    throw new BootstrapError(error.code, error.message);
  }
  const options = { projectRoot, workspaces: [path.resolve(businessRoot())].filter((dir) => !dir.startsWith(projectRoot)) };
  const labels = { env: "FRONTSMITH_DATA_ROOT", saved: `выбран ранее, ${DATA_ROOT_POINTER}`, existing: "существующая установка", flag: "--data-root", prompt: "выбран сейчас", default: "по умолчанию: неинтерактивный запуск без --data-root" };
  let result;
  if (plan.source === "prompt") {
    result = await promptDataRoot({ suggested: plan.root, validate: (candidate) => validateDataRoot(candidate, options) }).catch((error) => {
      throw new BootstrapError(error.code ?? "DATA_ROOT_INVALID", error.message);
    });
  } else {
    result = validateDataRoot(plan.root, { ...options, installed: looksInstalled(plan.root) });
    if (!result.ok) {
      const hint = plan.source === "saved" || plan.source === "existing" ? "" : "\n   Укажите другой каталог: npm run bootstrap -- --data-root E:\\Frontsmith";
      throw new BootstrapError("DATA_ROOT_INVALID", `${plan.root}:\n   ${result.problems.join("\n   ")}${hint}`);
    }
  }
  if (plan.remember) rememberDataRoot(result.root);
  say(`   ${result.root} (${labels[plan.source]})`);
  if (result.free !== null && result.free !== undefined) say(`   свободно: ${(result.free / 1024 ** 3).toFixed(1)} ГБ`);
  return result.root;
}

async function prepareBusinessDb(before, crm) {
  const file = officeDbPath();
  const profile = await readProfile();
  if (before.kind === "fresh") {
    // Новая установка: схема последней версии, клиентов нет. Клиенты создаются только
    // через CustomerProvider, в офисную базу попадает client_id
    const db = openOfficeDb({ file });
    try {
      const applied = migrate(db).applied;
      syncBusinessProjection(db, profile, { source: "migration", actor: "bootstrap" });
      const catalog = importCatalog(db, profile);
      assertHealthy(db);
      say(`   офисная база создана: ${file}`);
      say(`   миграции ${applied.join(", ")}; схема ${schemaVersion(db)}; услуг из профиля ${catalog.inserted.length}; клиентов 0`);
    } finally {
      db.close();
    }
    return;
  }
  if (before.schema < latestSchema()) {
    // Существующая установка со старой схемой. До миграции 004 база содержит контакты
    // клиентов, поэтому копия — в каталог CRM вне рабочей области Codex
    if (before.customers > 0) {
      protectDir(crm.backups);
      const copy = await backupOfficeDb({ file, destination: path.join(crm.backups, `office-before-bootstrap-${stamp()}.sqlite`) });
      say(`   копия до миграции (вне рабочей области Codex): ${copy}`);
    }
    const db = openOfficeDb({ file });
    try {
      const applied = migrate(db).applied;
      // Без проекции профиля — прерванная первая подготовка: досоздать как новую
      if (!before.business) {
        syncBusinessProjection(db, profile, { source: "migration", actor: "bootstrap" });
        importCatalog(db, profile);
      }
      assertHealthy(db);
      say(`   офисная база: применены миграции ${applied.join(", ")}; схема ${schemaVersion(db)}`);
    } finally {
      db.close();
    }
    return;
  }
  // Актуальная установка: только проверки, база не меняется
  const db = openOfficeDb({ file, readonly: before.business });
  try {
    if (!before.business) {
      syncBusinessProjection(db, profile, { source: "migration", actor: "bootstrap" });
      say("   проекция профиля бизнеса создана из business.json");
    }
    assertHealthy(db);
    say(`   офисная база: ${file}, схема ${schemaVersion(db)} актуальна, integrity_check ok, foreign_key_check пуст`);
  } finally {
    db.close();
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function checkCustomers() {
  const install = inspectInstallation();
  const foreign = foreignCrmLinks(install.business, install.crmWorkspace);
  if (foreign.length) {
    throw new BootstrapError("CRM_MISMATCH", "офисная база связана с другой рабочей областью crmkit: каталог данных и офисная база относятся к разным установкам");
  }
  let crm;
  const db = openOfficeDb();
  try {
    crm = await connectCrm();
    const provider = new CrmkitProvider({ db, client: crm.client, workspaceId: crm.workspaceId });
    const { total } = await provider.listCustomers({ limit: 1 });
    const { business } = install;
    const missing = business.links - total;
    say(`   crmkit ${crm.owned ? "запущен на время проверки" : "уже работает"}: клиентов в CRM ${total}, связей client_id ${business.links}, клиентов в офисной базе ${business.customers}`);
    if (missing > 0) say(`   ! ${missing} связей без контакта в CRM: карточки покажут «контакт недоступен»`);
    status.customers = missing > 0 ? "degraded" : "ready";
    if (business.legacyContacts > 0) {
      status.customers = "legacy";
      say(`   ${business.legacyContacts} клиентов прежней модели: контакты ещё в офисной базе, автоматически не переносятся`);
    }
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("CRM_NOT_READY", `CustomerProvider недоступен: ${error.code ?? ""} ${error.message}`.trim());
  } finally {
    await crm?.stop();
    db.close();
  }
}

// Штатный порт, если свободен или занят crmkit этой установки; иначе свободный
async function connectCrm() {
  try {
    return await ensureCrm();
  } catch (error) {
    if (error.code !== "crm_port_busy") throw error;
    return ensureCrm({ port: await freePort() });
  }
}

async function probePrivacy(paths) {
  const dir = mkdtempSync(path.join(paths.tmp, "bootstrap-probe-"));
  try {
    const service = await startPrivacyService({ paths, port: await freePort(), dbPath: path.join(dir, "probe.sqlite") });
    await service.stop();
    const health = service.health;
    say(`   pii-guard ${health.pii_guard_version} (${health.pii_guard_commit.slice(0, 7)}), NER=${health.ner_enabled}: /health ready`);
  } catch (error) {
    throw new BootstrapError("PRIVACY_NOT_READY", error.reason ?? error.message);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

function runNode(script, scriptArgs, code) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, script), ...scriptArgs], { cwd: projectRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new BootstrapError(code, `${script} завершился с кодом ${result.status}`);
}

function installationLabel(business) {
  return {
    fresh: "fresh install — новая установка",
    current: "existing current install — уже подготовлена",
    outdated: "existing install — будут применены миграции офисной базы",
    legacy: "legacy install requiring migration — контакты клиентов в офисной базе"
  }[business.kind] ?? business.kind;
}

function printSummary(install = null) {
  const label = (value) => ({ ready: "ready", not_ready: "not ready", login_required: "sign-in required", cli_missing: "CLI not found", degraded: "ready, есть связи без контакта", legacy: "legacy storage", unknown: "не проверено" }[value] ?? value);
  const ok = status.office === "ready";
  say(`\n${ok ? "Frontsmith bootstrap complete" : "Frontsmith bootstrap incomplete"}\n`);
  say(`Business DB:    ${label(status.business)}`);
  say(`CRM:            ${label(status.crm)}`);
  say(`Privacy:        ${label(status.privacy)}`);
  say(`CustomerModule: ${label(status.customers)}`);
  say(`Codex:          ${label(status.codex)}`);
  if (!ok) return;
  if (install?.business.kind === "legacy" || status.customers === "legacy") say(`\n${LEGACY_HINT}`);
  if (status.codex === "login_required") say("\nCodex authentication required.\nRun: npm run codex-host:login");
  say("\nДалее: npm run frontsmith");
}

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}
