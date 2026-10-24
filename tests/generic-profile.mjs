// Универсальный профиль по умолчанию: business:init без флагов → generic-service, панель без
// отраслевых разделов, клиенты через CustomerProvider, копии базы вне рабочей области Codex,
// перенос старых копий без изменения исходных файлов. Автосервис — только явным --blueprint.
// CRM — двойник crmkit в памяти; настоящий first-run на чистом каталоге данных — npm run test:first-run
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-generic-"));
const root = path.join(testRoot, "business");
const data = path.join(testRoot, "data");
process.env.FRONTSMITH_BUSINESS_ROOT = root;
process.env.FRONTSMITH_ACTOR = "тест";
const { useFakeCrm } = await import("../services/crm/testing/fake-crmkit.mjs");
const fakeCrm = await useFakeCrm(data);
const { freePort } = await import("../services/crm/runtime.mjs");
const { createOfficeServer } = await import("../office/server.mjs");
const { CORE_OFFICE_MODULES, officeModules } = await import("../scripts/lib/blueprints.mjs");
const { IVAN, IVAN_PII, scanForPii } = await import("./fixtures/legacy-customers.mjs");

const AUTO_WORDS = /АвтоРитм|автомоб|автосервис|ремонт|VIN|Booking Flow|auto-workshop/i;
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
let passed = 0;

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

function node(script, ...args) {
  return execFileAsync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, env: process.env }).then((result) => result.stdout);
}

async function office(...args) {
  return node("scripts/office.mjs", ...args);
}

try {
  await check("business:init без флагов создаёт универсальный профиль", async () => {
    await node("scripts/business-init.mjs");
    const profile = JSON.parse(await readFile(path.join(root, "business.json"), "utf8"));
    assert.equal(profile.blueprint, "generic-service");
    assert.notEqual(profile.businessName, "АвтоРитм");
    assert.deepEqual(profile.services, [], "автомобильные услуги не создаются");
    assert.equal(profile.demoMode, false);
    assert.doesNotMatch(JSON.stringify(profile), AUTO_WORDS);
    const site = await readFile(path.join(root, "website", "index.html"), "utf8");
    assert.doesNotMatch(site, AUTO_WORDS, "сайт без автосервисных текстов");
    assert.match(site, /Новая компания/);
  });

  await check("офисная база: каталог услуг пуст, клиентов нет", async () => {
    await office("init");
    assert.match(await office("import"), /Каталог: добавлено 0/);
    const db = new Database(path.join(root, "office.sqlite"), { readonly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM services").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM vehicles").get().n, 0);
      assert.equal(db.prepare("SELECT name FROM business").get().name, "Новая компания");
    } finally {
      db.close();
    }
  });

  await check("модули панели: generic — только универсальные, автосервис и старый профиль — отраслевые", async () => {
    assert.deepEqual(officeModules({ blueprint: "generic-service" }), CORE_OFFICE_MODULES);
    assert.deepEqual(officeModules({ blueprint: "auto-service" }), [...CORE_OFFICE_MODULES, "vehicles", "work-orders", "work-results"]);
    assert.deepEqual(officeModules({ businessName: "Профиль без blueprint" }), officeModules({ blueprint: "auto-service" }), "существующая установка не теряет разделы");
  });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body ? { "content-type": "application/json", "x-frontsmith-office": "1", origin: base } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json().catch(() => null), text: response.headers.get("content-type")?.includes("json") ? null : await response.text().catch(() => null) };
  };
  const instance = createOfficeServer({ port });
  await new Promise((resolve) => instance.server.listen(port, "127.0.0.1", resolve));
  try {
    await check("панель generic: meta без отраслевых модулей, все разделы отвечают без ошибок", async () => {
      const meta = await api("GET", "/api/meta");
      assert.equal(meta.status, 200);
      assert.deepEqual(meta.body.data.modules, CORE_OFFICE_MODULES);
      const vocabulary = meta.body.data.vocabulary;
      assert.equal(vocabulary.inquiry.converted.label, "Оформлено");
      assert.equal(vocabulary.inquiry.closed.label, "Закрыто");
      assert.equal(vocabulary.serviceCategories.consultation, "Консультация");
      assert.doesNotMatch(JSON.stringify(vocabulary), /заказ|Ремонт|Диагностика|Обслуживание|в сервис|приехал/, "словарь generic без автосервисных подписей");
      assert.equal(meta.body.data.business.name, "Новая компания");
      assert.equal(meta.body.data.business.booking_url, null);
      for (const route of ["/api/overview", "/api/customers", "/api/inquiries", "/api/tasks", "/api/services", "/api/schedule", "/api/events"]) {
        const response = await api("GET", route);
        assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
      }
      assert.deepEqual((await api("GET", "/api/services")).body.data, []);
    });

    await check("статика панели нейтральна, отраслевые разделы скрываются по модулям", async () => {
      const html = await (await fetch(`${base}/`)).text();
      assert.doesNotMatch(html, /автосервис/i);
      assert.match(html, /data-nav-module="work-results"/);
      assert.match(html, /data-booking-notice hidden/);
      const app = await (await fetch(`${base}/app.js`)).text();
      for (const module of ["vehicles", "work-orders", "work-results"]) assert.match(app, new RegExp(`has\\("${module}"\\)`));
    });

    let clientId;
    await check("первый клиент создаётся через CustomerProvider и виден в разделе «Клиенты»", async () => {
      const created = await api("POST", "/api/customers", { displayName: IVAN.name, phone: IVAN.phone, email: IVAN.email });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      clientId = created.body.data.customer.id;
      const card = await api("GET", `/api/customers/${clientId}`);
      assert.equal(card.status, 200);
      assert.equal(card.body.data.contact.displayName, IVAN.name);
      assert.deepEqual(card.body.data.vehicles, []);
      const list = await api("GET", "/api/customers");
      assert.deepEqual(list.body.data.map((row) => row.id), [clientId]);
      assert.equal(fakeCrm.contacts.length, 1, "контакт в CRM");
    });

    await check("контактные ПД первого клиента не записаны в business DB", async () => {
      await instance.close();
      const scan = scanForPii(path.join(root, "office.sqlite"), IVAN_PII);
      assert.deepEqual(Object.entries(scan.cells).filter(([, n]) => n), []);
      assert.deepEqual(scan.bytes, {});
    });
  } finally {
    await instance.close();
  }

  await check("auto-service при явном выборе: каталог и сайт автосервиса, отраслевые разделы", async () => {
    const autoRoot = path.join(testRoot, "auto-business");
    const env = { ...process.env, FRONTSMITH_BUSINESS_ROOT: autoRoot };
    await execFileAsync(process.execPath, [path.join(repo, "scripts/business-init.mjs"), "--blueprint", "auto-service"], { cwd: repo, env });
    const profile = JSON.parse(await readFile(path.join(autoRoot, "business.json"), "utf8"));
    assert.equal(profile.blueprint, "auto-service");
    assert.equal(profile.businessName, "АвтоРитм");
    assert.equal(profile.services.length, 8);
    assert.match(await readFile(path.join(autoRoot, "website", "index.html"), "utf8"), /Компьютерная диагностика/);
    assert.ok(officeModules(profile).includes("vehicles"));
    await assert.rejects(execFileAsync(process.execPath, [path.join(repo, "scripts/business-init.mjs")], { cwd: repo, env }), /уже существует/);
    assert.equal(JSON.parse(await readFile(path.join(autoRoot, "business.json"), "utf8")).blueprint, "auto-service", "повтор не меняет выбранный профиль");
  });

  await check("новая копия базы — в каталоге данных вне рабочей области Codex; --to в репозиторий отклоняется", async () => {
    const output = await office("backup");
    const file = /: (.+\.sqlite)\s*$/m.exec(output)[1].trim();
    assert.equal(path.dirname(file), path.join(data, "backups", "office"));
    const relative = path.relative(repo, file);
    assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "копия вне репозитория");
    assert.ok(!existsSync(path.join(root, "backups")), "в каталоге бизнеса копий нет");
    await assert.rejects(office("backup", "--to", path.join(repo, ".frontsmith", "generic-test.sqlite")), /рабочей области Codex/);
    assert.equal(existsSync(path.join(repo, ".frontsmith", "generic-test.sqlite")), false);
  });

  await check("backups:relocate: план без копирования, --confirm копирует SQLite с WAL/SHM без изменения исходных", async () => {
    const legacy = path.join(root, "backups");
    mkdirSync(path.join(legacy, "profile-before-x"), { recursive: true });
    await writeFile(path.join(legacy, "profile-before-x", "business.json"), "{}\n");
    // База в WAL с незафиксированной в основном файле записью: открытая во время копирования
    const dbFile = path.join(legacy, "office-old.sqlite");
    const writer = new Database(dbFile);
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('синтетика')");
    const sources = readdirSync(legacy).filter((name) => name.startsWith("office-old")).sort();
    assert.deepEqual(sources, ["office-old.sqlite", "office-old.sqlite-shm", "office-old.sqlite-wal"]);
    const plan = await node("scripts/backups-relocate.mjs");
    assert.match(plan, /office-old\.sqlite: SQLite \+ wal, shm/);
    assert.match(plan, /требуется решение владельца/);
    assert.doesNotMatch(plan, /синтетика/, "содержимое не выводится");
    const target = path.join(data, "backups", "workspace-legacy");
    assert.equal(existsSync(target), false, "план ничего не копирует");
    const before = Object.fromEntries(sources.map((name) => [name, sha(path.join(legacy, name))]));
    try {
      await node("scripts/backups-relocate.mjs", "--confirm");
      for (const [name, hash] of Object.entries(before)) {
        assert.equal(sha(path.join(legacy, name)), hash, `${name} не изменён`);
        assert.equal(sha(path.join(target, name)), hash, `${name} скопирован байт в байт`);
      }
      assert.match(await node("scripts/backups-relocate.mjs", "--confirm"), /SHA-256 совпадает/, "повтор не перезаписывает и не дублирует");
    } finally {
      writer.close();
    }
    assert.ok(existsSync(path.join(target, "profile-before-x", "business.json")));
    assert.ok(readdirSync(target).some((name) => /^manifest-.+\.json$/.test(name)));
    await assert.rejects(node("scripts/backups-relocate.mjs", "--confirm"), /ничего не перезаписано/, "изменившийся исходник не перезаписывает копию");
    const copy = new Database(path.join(target, "office-old.sqlite"), { readonly: true });
    try {
      assert.equal(copy.prepare("SELECT v FROM t").get().v, "синтетика", "копия читается");
    } finally {
      copy.close();
    }
  });

  console.log(`Generic profile: ${passed} проверок пройдено`);
} finally {
  await fakeCrm.close();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
