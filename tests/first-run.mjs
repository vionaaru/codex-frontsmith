// First-run чистой установки Frontsmith на полностью пустом каталоге данных:
// npm run bootstrap → повторный bootstrap → npm run frontsmith → первый клиент через
// CustomerProvider → shutdown → legacy-база без автоматического переноса.
//
// Установка пользователя не используется: свой каталог данных, каталог бизнеса, CODEX_HOME
// Host и свободные порты. Подписка ChatGPT не используется: в пустом CODEX_HOME входа нет,
// поэтому проверяется путь «Codex: sign-in required» (офис готов, AI нет).
// Чистая установка получает универсальный профиль generic-service; автосервис проверяется
// явным --blueprint auto-service во втором каталоге бизнеса того же каталога данных.
//
// Runtime (uv, Python, pii-guard, веса NER, crmkitd) по умолчанию берётся из уже подготовленного
// каталога данных пользователя через junction <тест>/runtime → <data-root>/runtime: повторного
// скачивания ~2 ГБ нет, CRM, состояние Privacy, CODEX_HOME и бизнес-данные теста — свои.
// FRONTSMITH_FIRST_RUN_RUNTIME=none — полностью пустой каталог данных со скачиванием (~40 мин).
// Не входит в npm test.
//
//   npm run test:first-run
//   FRONTSMITH_FIRST_RUN_PARENT=D:\tmp npm run test:first-run   где создать временный каталог
//   FRONTSMITH_FIRST_RUN_RUNTIME=D:\Frontsmith npm run test:first-run   каталог данных с готовым runtime
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ROOT_POINTER, dataRoot, runtimePaths, runtimeStatus } from "../services/privacy/runtime.mjs";
import { CrmkitClient } from "../services/crm/client.mjs";
import { crmPaths, freePort } from "../services/crm/runtime.mjs";
import { CORE_OFFICE_MODULES } from "../scripts/lib/blueprints.mjs";
import { listMigrations, openOfficeDb } from "../office/lib/db.mjs";
import { IVAN, IVAN_PII, buildLegacyFixture, scanForPii } from "./fixtures/legacy-customers.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Системный диск может быть почти заполнен: по умолчанию — рядом с каталогом данных Frontsmith
const parent = process.env.FRONTSMITH_FIRST_RUN_PARENT ? path.resolve(process.env.FRONTSMITH_FIRST_RUN_PARENT) : path.join(dataRoot(), "runtime", "tmp");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "frontsmith-first-run-"));
const cacheRoot = process.env.FRONTSMITH_FIRST_RUN_RUNTIME === "none" ? null : path.resolve(process.env.FRONTSMITH_FIRST_RUN_RUNTIME ?? dataRoot());
const runtimeCache = cacheRoot && runtimeStatus(runtimePaths(cacheRoot)).ready && existsSync(crmPaths(cacheRoot).marker) ? path.join(cacheRoot, "runtime") : null;
if (runtimeCache) symlinkSync(runtimeCache, path.join(root, "runtime"), "junction");
console.log(runtimeCache ? `runtime: подготовленный ${runtimeCache} (junction, без скачивания)` : "runtime: пустой, скачивается заново");
const pointerBefore = existsSync(DATA_ROOT_POINTER) ? readFileSync(DATA_ROOT_POINTER, "utf8") : null;
const ports = { office: await freePort(), crm: await freePort(), privacy: await freePort() };
const env = {
  ...process.env,
  FRONTSMITH_DATA_ROOT: root,
  FRONTSMITH_BUSINESS_ROOT: path.join(root, "business"),
  FRONTSMITH_CODEX_HOST_ROOT: path.join(root, "codex-host"),
  FRONTSMITH_OFFICE_PORT: String(ports.office),
  FRONTSMITH_CRM_PORT: String(ports.crm),
  FRONTSMITH_PRIVACY_PORT: String(ports.privacy)
};
delete env.FRONTSMITH_CRM_URL;
const latest = Math.max(...listMigrations().map((migration) => migration.version));
const officeDb = path.join(root, "business", "office.sqlite");
const autoRoot = path.join(root, "auto-business");
const AUTO_WORDS = /АвтоРитм|автомоб|автосервис|ремонт|VIN|Booking Flow|auto-workshop/i;
let passed = 0;
let office = null;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function run(script, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, script), ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        if (process.env.FRONTSMITH_TEST_VERBOSE === "1") process.stdout.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// npm run frontsmith как дочерний процесс с IPC: ready/failed/stopped и команда shutdown
function startFrontsmith() {
  const child = fork(path.join(repo, "scripts", "frontsmith.mjs"), [], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output += chunk; });
  }
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frontsmith не стал готов за 15 минут:\n${output}`)), 900_000);
    child.on("message", (message) => {
      if (message.type === "ready") { clearTimeout(timer); resolve(message); }
      if (message.type === "failed") { clearTimeout(timer); reject(new Error(`frontsmith: ${message.code}\n${output}`)); }
    });
    exited.then((code) => { clearTimeout(timer); reject(new Error(`frontsmith завершился с кодом ${code}:\n${output}`)); });
  });
  return { child, ready, exited, output: () => output };
}

async function api(method, pathname, body) {
  const url = `http://127.0.0.1:${ports.office}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json", "x-frontsmith-office": "1", origin: `http://127.0.0.1:${ports.office}` } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

try {
  await check("каталог данных пуст, npm run frontsmith без bootstrap прерывается с CRM_NOT_READY", async () => {
    assert.deepEqual(readdirSync(root), runtimeCache ? ["runtime"] : []);
    const result = await run("scripts/frontsmith.mjs");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /CRM_NOT_READY/);
    assert.equal(await portFree(ports.office), true, "офис не должен запускаться без обязательных компонентов");
  });

  let first;
  await check("npm run bootstrap готовит чистую установку одной командой", async () => {
    first = await run("scripts/bootstrap.mjs");
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /fresh install/);
    assert.match(first.output, /Frontsmith bootstrap complete/);
    for (const label of ["Business DB:    ready", "CRM:            ready", "Privacy:        ready", "CustomerModule: ready"]) assert.ok(first.output.includes(label), label);
    assert.match(first.output, /бизнес-профиль: generic-service/);
  });

  await check("чистая установка — универсальный профиль: не «АвтоРитм», услуг нет, сайт без автосервиса", async () => {
    const profile = JSON.parse(readFileSync(path.join(root, "business/business.json"), "utf8"));
    assert.equal(profile.blueprint, "generic-service");
    assert.notEqual(profile.businessName, "АвтоРитм");
    assert.deepEqual(profile.services, []);
    assert.doesNotMatch(JSON.stringify(profile), AUTO_WORDS);
    assert.doesNotMatch(readFileSync(path.join(root, "business/website/index.html"), "utf8"), AUTO_WORDS);
  });

  await check("структура каталога данных: runtime (privacy, crmkit), crm, privacy, codex-host, business", async () => {
    for (const file of [
      "runtime/privacy-runtime.json", "runtime/privacy-env", "runtime/uv", "runtime/python", "runtime/privacy-models",
      "runtime/crmkit/0.9.1/crmkit-runtime.json", "crm/crmkit.db", "crm/crmkit.yaml", "crm/credential.json", "privacy",
      "codex-host/home/config.toml", "business/business.json", "business/office.sqlite"
    ]) assert.ok(existsSync(path.join(root, file)), file);
    assert.equal(readFileSync(path.join(root, "codex-host/home/config.toml"), "utf8").includes('forced_login_method = "chatgpt"'), true);
  });

  await check("чистая business DB: актуальная схема, клиентов 0, колонок и карантина ПД нет", async () => {
    const db = openOfficeDb({ file: officeDb, readonly: true });
    try {
      assert.equal(db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v, latest);
      assert.deepEqual(db.prepare("PRAGMA table_info(customers)").all().map((column) => column.name), ["id", "is_demo", "created_at", "updated_at", "revision"]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 0, "bootstrap не создаёт учебных клиентов");
      assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_customer_contacts").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM customer_provider_links").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM services").get().n, 0, "автомобильные услуги не создаются");
      assert.equal(db.prepare("SELECT count(*) AS n FROM vehicles").get().n, 0);
      assert.notEqual(db.prepare("SELECT name FROM business").get().name, "АвтоРитм");
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
  });

  await check("Codex: без входа bootstrap сообщает Codex authentication required и не падает", async () => {
    assert.ok(/Codex authentication required\.\s+Run: npm run codex-host:login/.test(first.output) || /Codex CLI не найден/.test(first.output), first.output);
  });

  await check("повторный bootstrap идемпотентен: ничего не скачивает и не меняет данные", async () => {
    const files = ["business/office.sqlite", "business/business.json", "crm/credential.json", "crm/crmkit.yaml", "runtime/privacy-runtime.json", "runtime/crmkit/0.9.1/crmkit-runtime.json"];
    const before = Object.fromEntries(files.map((file) => [file, sha(path.join(root, file))]));
    const binary = statSync(path.join(root, "runtime/crmkit/0.9.1", process.platform === "win32" ? "crmkitd.exe" : "crmkitd")).mtimeMs;
    const privacyState = listing(path.join(root, "privacy"));
    const second = await run("scripts/bootstrap.mjs");
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /existing current install/);
    assert.match(second.output, /уже подготовлен/);
    assert.match(second.output, /уже установлен: crmkitd v0\.9\.1/);
    assert.doesNotMatch(second.output, /скачивание|первая установка скачивает/);
    for (const file of files) assert.equal(sha(path.join(root, file)), before[file], `${file} не изменён`);
    assert.equal(statSync(path.join(root, "runtime/crmkit/0.9.1", process.platform === "win32" ? "crmkitd.exe" : "crmkitd")).mtimeMs, binary);
    assert.deepEqual(listing(path.join(root, "privacy")), privacyState, "состояние псевдонимизации не сброшено");
    assert.equal(JSON.parse(readFileSync(path.join(root, "business/business.json"), "utf8")).blueprint, "generic-service", "профиль сохранён");
  });

  let ready;
  await check("npm run frontsmith поднимает crmkit, Privacy Service и офис; офис готов, AI — нет без входа", async () => {
    office = startFrontsmith();
    ready = await office.ready;
    assert.equal(ready.office, `http://127.0.0.1:${ports.office}`);
    assert.deepEqual({ crm: ready.status.crm, privacy: ready.status.privacy, customers: ready.status.customers, office: ready.status.office }, { crm: "ready", privacy: "ready", customers: "ready", office: "ready" });
    assert.ok(["login_required", "cli_missing"].includes(ready.status.codex), ready.status.codex);
    assert.equal(ready.officeReady, true);
    assert.equal(ready.aiReady, false);
    assert.deepEqual(ready.ports, ports, "внутренние порты из конфигурации");
    assert.ok(alive(ready.pids.crm) && alive(ready.pids.privacy), "crmkit и Privacy Service — дочерние процессы");
    const out = office.output();
    assert.match(out, /Frontsmith ready/);
    assert.match(out, /CODEX_NOT_AUTHENTICATED|CODEX_NOT_INSTALLED/);
    const credential = JSON.parse(readFileSync(path.join(root, "crm/credential.json"), "utf8"));
    assert.equal(out.includes(credential.token), false, "токен CRM не выводится");
  });

  await check("панель generic: без отраслевых модулей, все разделы и статика отвечают без ошибок", async () => {
    const meta = await api("GET", "/api/meta");
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.data.modules, CORE_OFFICE_MODULES);
    assert.notEqual(meta.body.data.business.name, "АвтоРитм");
    for (const route of ["/api/overview", "/api/inquiries", "/api/tasks", "/api/services", "/api/schedule", "/api/events"]) {
      const response = await api("GET", route);
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    }
    assert.deepEqual((await api("GET", "/api/services")).body.data, [], "демонстрационных услуг нет");
    for (const file of ["/", "/app.js", "/styles.css"]) assert.equal((await fetch(`http://127.0.0.1:${ports.office}${file}`)).status, 200, file);
    assert.doesNotMatch(await (await fetch(`http://127.0.0.1:${ports.office}/`)).text(), /автосервис/i);
  });

  await check("раздел «Клиенты»: пустой список, поиск без результатов", async () => {
    const list = await api("GET", "/api/customers");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, []);
    assert.deepEqual((await api("GET", `/api/customers?q=${encodeURIComponent("Петров")}`)).body.data, []);
  });

  let clientId;
  await check("первый клиент создаётся через UI API → CustomerProvider → crmkit и получает client_id", async () => {
    const created = await api("POST", "/api/customers", { displayName: IVAN.name, phone: IVAN.phone, email: IVAN.email });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    clientId = created.body.data.customer.id;
    assert.match(clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const card = await api("GET", `/api/customers/${clientId}`);
    assert.equal(card.status, 200);
    assert.equal(card.body.data.contactStatus, "ok");
    assert.equal(card.body.data.contact.displayName, IVAN.name);
    const found = await api("GET", `/api/customers?q=${encodeURIComponent("Петров")}`);
    assert.deepEqual(found.body.data.map((row) => row.id), [clientId]);
    const updated = await api("PATCH", `/api/customers/${clientId}`, { notes: "Синтетическая заметка", version: card.body.data.contact.version });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
  });

  await check("PII первого клиента — в crmkit, связь client_id ↔ контакт сохранена", async () => {
    const credential = JSON.parse(readFileSync(path.join(root, "crm/credential.json"), "utf8"));
    const client = new CrmkitClient({ baseUrl: `http://127.0.0.1:${ports.crm}`, token: credential.token });
    const page = await client.request("GET", `/contacts?custom.frontsmith_client_id=${clientId}&limit=5`);
    assert.equal(page.items.length, 1);
    const contact = page.items[0];
    assert.deepEqual({ name: contact.name, phone: contact.phone, email: contact.email }, { name: IVAN.name, phone: "+79161234567", email: IVAN.email });
    const db = openOfficeDb({ file: officeDb, readonly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM customers WHERE id = ?").get(clientId).n, 1);
      const link = db.prepare("SELECT provider, provider_instance, external_id FROM customer_provider_links WHERE client_id = ?").get(clientId);
      assert.deepEqual(link, { provider: "crmkit", provider_instance: credential.workspaceId, external_id: contact.id });
    } finally {
      db.close();
    }
  });

  await check("PII первого клиента отсутствуют в business DB (ячейки, файл и WAL)", async () => {
    const scan = scanForPii(officeDb, [...IVAN_PII, "Иван", "Петров", "916 123-45-67", "Синтетическая заметка"]);
    assert.deepEqual(Object.entries(scan.cells).filter(([, n]) => n), []);
    assert.deepEqual(scan.bytes, {});
  });

  await check("новая копия базы — в каталоге данных вне рабочей области Codex", async () => {
    const result = await run("scripts/office.mjs", ["backup"]);
    assert.equal(result.code, 0, result.output);
    const file = /: (.+\.sqlite)\s*$/m.exec(result.output)[1].trim();
    assert.equal(path.dirname(file), path.join(root, "backups", "office"));
    const relative = path.relative(repo, file);
    assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "копия вне репозитория");
    assert.equal(existsSync(path.join(root, "business", "backups")), false, "в каталоге бизнеса копий нет");
    const rejected = await run("scripts/office.mjs", ["backup", "--to", path.join(repo, ".frontsmith", "first-run-test.sqlite")]);
    assert.equal(rejected.code, 1);
    assert.match(rejected.output, /рабочей области Codex/);
  });

  await check("shutdown: офис, Privacy Service и crmkit завершены, порты свободны", async () => {
    office.child.send({ type: "shutdown" });
    const code = await Promise.race([office.exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 60_000))]);
    assert.equal(code, 0, office.output());
    assert.match(office.output(), /Frontsmith остановлен/);
    for (const [name, port] of Object.entries(ports)) assert.equal(await portFree(port), true, `порт ${name} ${port} свободен`);
    for (const [name, pid] of Object.entries(ready.pids)) if (pid) assert.equal(alive(pid), false, `процесс ${name} ${pid} завершён`);
    office = null;
  });

  await check("auto-service явным --blueprint: каталог автосервиса и отраслевые разделы панели", async () => {
    const result = await run("scripts/bootstrap.mjs", ["--blueprint", "auto-service"], { FRONTSMITH_BUSINESS_ROOT: autoRoot });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /fresh install/);
    assert.match(result.output, /бизнес-профиль: auto-service/);
    const profile = JSON.parse(readFileSync(path.join(autoRoot, "business.json"), "utf8"));
    assert.equal(profile.blueprint, "auto-service");
    assert.equal(profile.businessName, "АвтоРитм");
    const db = openOfficeDb({ file: path.join(autoRoot, "office.sqlite"), readonly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM services").get().n, 8);
      assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 0, "учебные клиенты не создаются");
    } finally {
      db.close();
    }
    const port = await freePort();
    const server = spawn(process.execPath, [path.join(repo, "office/server.mjs"), "--port", String(port)], { cwd: repo, env: { ...env, FRONTSMITH_BUSINESS_ROOT: autoRoot, FRONTSMITH_CRM_URL: `http://127.0.0.1:${await freePort()}` }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((resolve, reject) => {
        server.stdout.on("data", (chunk) => { if (String(chunk).includes("Панель офиса")) resolve(); });
        server.on("exit", (code) => reject(new Error(`панель завершилась с кодом ${code}`)));
      });
      const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json();
      assert.deepEqual(meta.data.modules, [...CORE_OFFICE_MODULES, "vehicles", "work-orders", "work-results"]);
      assert.equal(meta.data.business.name, "АвтоРитм");
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/services`)).json()).data.length, 8);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/orders`)).status, 200);
    } finally {
      server.kill();
    }
  });

  await check("повторный bootstrap существующей установки сохраняет выбранный профиль, --blueprint его не заменяет", async () => {
    const before = { auto: sha(path.join(autoRoot, "business.json")), generic: sha(path.join(root, "business/business.json")) };
    for (const extra of [["--blueprint", "generic-service"]]) {
      const result = await run("scripts/bootstrap.mjs", extra, { FRONTSMITH_BUSINESS_ROOT: autoRoot });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /existing current install/);
      assert.match(result.output, /бизнес-профиль: auto-service/);
      assert.equal(sha(path.join(autoRoot, "business.json")), before.auto, "АвтоРитм не заменён на generic");
    }
    assert.equal(sha(path.join(root, "business/business.json")), before.generic);
  });

  await check("legacy-установка определяется, контакты не переносятся без явной команды", async () => {
    const legacyRoot = path.join(root, "legacy-business");
    mkdirSync(legacyRoot, { recursive: true });
    copyFileSync(path.join(root, "business/business.json"), path.join(legacyRoot, "business.json"));
    buildLegacyFixture(path.join(legacyRoot, "office.sqlite"));
    const result = await run("scripts/bootstrap.mjs", [], { FRONTSMITH_BUSINESS_ROOT: legacyRoot });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /legacy install requiring migration/);
    assert.match(result.output, /Legacy customer storage detected\.\s+Run:\s+npm run crm:migrate-customers -- --dry-run/);
    const db = openOfficeDb({ file: path.join(legacyRoot, "office.sqlite"), readonly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_customer_contacts").get().n, 2, "контакты остались в карантине");
      assert.equal(db.prepare("SELECT count(*) AS n FROM customer_provider_links").get().n, 0, "в CRM ничего не перенесено");
    } finally {
      db.close();
    }
    assert.equal(readdirSync(path.join(root, "crm", "backups")).filter((name) => /^office-before-bootstrap-.+\.sqlite$/.test(name)).length, 1, "копия до миграции — в каталоге CRM");
  });

  await check("указатель каталога данных пользователя не изменён", async () => {
    assert.equal(existsSync(DATA_ROOT_POINTER) ? readFileSync(DATA_ROOT_POINTER, "utf8") : null, pointerBefore);
  });

  console.log(`first-run: ${passed} проверок пройдено`);
} finally {
  if (office) {
    office.child.kill();
    await office.exited;
  }
  // FRONTSMITH_FIRST_RUN_KEEP=1 — оставить каталог для разбора сбоя (повтор не скачивает заново).
  // Junction на общий runtime снимается до удаления: удаление не должно пройти внутрь кэша
  const link = path.join(root, "runtime");
  if (process.env.FRONTSMITH_FIRST_RUN_KEEP === "1") console.error(`каталог теста оставлен: ${root}`);
  else {
    if (runtimeCache && existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
    if (runtimeCache && existsSync(link)) console.error(`! junction runtime не снят, каталог теста оставлен: ${root}`);
    else rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
  if (existsSync(root) && process.env.FRONTSMITH_FIRST_RUN_KEEP !== "1") console.error(`! временный каталог не удалён: ${root}`);
}
