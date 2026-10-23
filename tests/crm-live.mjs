// Настоящий crmkitd v0.9.1 без Go и Docker: bootstrap, проверка SHA-256, повторный
// bootstrap, только 127.0.0.1, штатная авторизация, CrmkitProvider и перенос fixture.
// Работает во временном каталоге данных (не трогает CRM пользователя); скачивает
// релиз с GitHub дважды (обычная установка и проверка подменённой суммы).
//
//   npm run test:crm
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { dataRoot } from "../services/privacy/runtime.mjs";
import { CRMKIT, crmPaths, crmStatus, crmkitAsset, ensureCrm, readCredential, startCrmkit, freePort } from "../services/crm/runtime.mjs";
import { bootstrapCrm, installCrmkit } from "../services/crm/bootstrap.mjs";
import { CrmkitClient } from "../services/crm/client.mjs";
import { migrate, openOfficeDb } from "../office/lib/db.mjs";
import { CrmkitProvider } from "../office/customers/crmkit-provider.mjs";
import { migrateLegacyCustomers } from "../office/customers/migrate-legacy.mjs";
import { codexEnv } from "../services/codex-host/codex-home.mjs";
import { IVAN, IVAN_PII, MARIA, buildLegacyFixture, scanForPii } from "./fixtures/legacy-customers.mjs";

// Временный каталог — рядом с каталогом данных Frontsmith (на этой машине системный диск почти заполнен)
const base = path.join(dataRoot(), "runtime", "tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, "crm-live-"));
const paths = crmPaths(root);
const quiet = () => {};
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

let crm;
try {
  let first;
  await check("crm:bootstrap скачивает зафиксированный релиз, проверяет SHA-256 и готовит CRM", async () => {
    first = await bootstrapCrm(paths, { log: quiet });
    assert.equal(first.install.downloaded, true);
    assert.equal(first.install.sha256, crmkitAsset().sha256);
    assert.equal(first.install.version, `crmkitd ${CRMKIT.tag}`);
    assert.equal(first.provisioned, true);
    assert.equal(crmStatus(paths).ready, true);
    assert.ok(!paths.binary.toLowerCase().startsWith(process.cwd().toLowerCase()), "бинарник вне репозитория");
  });

  await check("подменённая контрольная сумма отклоняется", async () => {
    const key = `${process.platform}-${process.arch}`;
    const pinned = CRMKIT.sha256[key];
    CRMKIT.sha256[key] = "0".repeat(64);
    try {
      await assert.rejects(installCrmkit(crmPaths(path.join(root, "tampered"))), /SHA-256/);
    } finally {
      CRMKIT.sha256[key] = pinned;
    }
  });

  await check("повторный bootstrap идемпотентен: ничего не скачивает, токен и база те же", async () => {
    const before = { binary: statSync(paths.binary).mtimeMs, token: readCredential(paths).token };
    const again = await bootstrapCrm(paths, { log: quiet });
    assert.equal(again.install.downloaded, false);
    assert.equal(again.provisioned, false);
    assert.equal(statSync(paths.binary).mtimeMs, before.binary);
    assert.equal(readCredential(paths).token, before.token);
  });

  const port = await freePort();
  await check("crmkit запускается Frontsmith и слушает только 127.0.0.1; новый код входа не выдаётся", async () => {
    crm = await ensureCrm({ paths, port });
    assert.equal(crm.owned, true);
    const external = Object.values(os.networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
    if (external) {
      const reached = await new Promise((resolve) => {
        const req = request({ host: external, port, path: "/readyz", timeout: 2000 }, () => resolve(true));
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
      assert.equal(reached, false, `crmkit недоступен по ${external}`);
    }
    const anonymous = new CrmkitClient({ baseUrl: crm.url });
    await assert.rejects(anonymous.request("GET", "/contacts"), (error) => error.status === 401);
    await assert.rejects(anonymous.request("POST", "/auth/request", { email: "intruder@example.test" }), (error) => error.code === "email_failed");
    const reuse = await ensureCrm({ paths, port });
    assert.equal(reuse.owned, false, "второй процесс Frontsmith переиспользует запущенный crmkit");
  });

  await check("учётные данные crmkit не попадают в окружение Codex", () => {
    const { token } = readCredential(paths);
    const env = codexEnv(path.join(root, "codex-home"), { ...process.env, FRONTSMITH_CRM_TOKEN: token });
    assert.ok(!JSON.stringify(env).includes(token));
    assert.ok(!JSON.stringify(crm.client).includes(token), "клиент crmkit не сериализует токен");
  });

  const businessFile = path.join(root, "office.sqlite");
  const business = openOfficeDb({ file: businessFile });
  migrate(business);
  const provider = new CrmkitProvider({ db: business, client: crm.client, workspaceId: crm.workspaceId });
  let ivan;
  await check("CrmkitProvider на настоящем crmkit: создание, чтение, поиск, редактирование", async () => {
    ivan = (await provider.createCustomer({ displayName: "Иван Петров", phone: "+7(916)1234567", email: "ivan.live@example.test" })).customer;
    const read = await provider.getCustomer(ivan.id);
    assert.equal(read.phoneDisplay, "+7 916 123-45-67");
    assert.equal((await provider.searchCustomers("иван петров")).matches[0].id, ivan.id, "кириллица без учёта регистра");
    assert.equal((await provider.searchCustomers("8 916 123 45 67")).matches[0].id, ivan.id);
    const updated = await provider.updateCustomer(ivan.id, { notes: "Живой тест", phone: "8 916 123 45 68" }, { version: read.version, allowSharedPhone: true });
    assert.equal(updated.phone, "+79161234568");
    assert.equal(updated.id, ivan.id);
    await assert.rejects(provider.updateCustomer(ivan.id, { notes: "x" }, { version: read.version }), (error) => error.code === "version_conflict");
    const link = business.prepare("SELECT external_id FROM customer_provider_links WHERE client_id = ?").get(ivan.id);
    assert.match(link.external_id, /^c_/);
    assert.notEqual(link.external_id, ivan.id);
  });

  await check("настоящий crmkit: повтор создания и email-upsert не создают и не портят контакты", async () => {
    assert.equal((await provider.createCustomer({ displayName: "Иван Петров" }, { clientId: ivan.id })).status, "existing");
    await assert.rejects(provider.createCustomer({ displayName: "Самозванец", email: "IVAN.LIVE@example.test" }), (error) => error.code === "email_in_use");
    assert.equal((await provider.getCustomer(ivan.id)).displayName, "Иван Петров", "upsert crmkit не перезаписал контакт");
    const total = (await crm.client.request("GET", "/contacts?limit=200")).total;
    assert.equal(total, 1);
  });

  await check("перенос fixture на настоящем crmkit: client_id и связи сохранены, ПД ушли из офисной базы", async () => {
    const fixture = path.join(root, "legacy.sqlite");
    buildLegacyFixture(fixture);
    const legacy = openOfficeDb({ file: fixture });
    try {
      migrate(legacy);
      const legacyProvider = new CrmkitProvider({ db: legacy, client: crm.client, workspaceId: crm.workspaceId });
      const result = await migrateLegacyCustomers(legacy, legacyProvider);
      assert.deepEqual({ migrated: result.migrated, remaining: result.remaining }, { migrated: 2, remaining: 0 });
      assert.equal((await legacyProvider.getCustomer(IVAN.id)).phone, "+79161234567");
      assert.equal((await legacyProvider.getCustomer(MARIA.id)).phone, "+79037654321");
      assert.equal(legacy.prepare("SELECT customer_id FROM work_orders WHERE id = 'o-ivan'").get().customer_id, IVAN.id);
      assert.deepEqual(legacy.pragma("foreign_key_check"), []);
    } finally {
      legacy.close();
    }
    const scan = scanForPii(fixture, [...IVAN_PII, MARIA.name]);
    assert.deepEqual(Object.entries(scan.cells).filter(([, n]) => n), []);
    assert.deepEqual(scan.bytes, {});
  });
  business.close();
  console.log(`crmkit live: ${passed} проверок пройдено (${CRMKIT.tag}, ${crmkitAsset().file})`);
} finally {
  await crm?.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
