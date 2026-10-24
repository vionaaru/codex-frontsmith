// Тесты Privacy Service на управляемом Python runtime, без Docker:
//   1. pytest: логика сервиса и настоящий pii-guard с NER (PERSON, PHONE_NUMBER,
//      русские формы имени, форматы телефонов, state, изоляция сессий);
//   2. настоящий процесс сервиса: /health и HTTP-поток prepare/restore;
//   3. fail closed на настоящем сервисе через CodexHost и двойник App Server,
//      счётчик turn/start должен остаться 0.
//
//   npm run test:privacy        (после npm run privacy:bootstrap)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerClient } from "../codex-host/app-server-client.mjs";
import { CodexHost } from "../codex-host/codex-host.mjs";
import { PrivacyClient, PrivacyProcessingError } from "../codex-host/privacy-client.mjs";
import { SERVICE_DIR, runtimePaths, runtimeStatus, serviceEnv, startPrivacyService } from "./runtime.mjs";

const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const PORT = 4311;
const paths = runtimePaths();
const status = runtimeStatus(paths);
if (!status.ready) {
  console.error(`FAIL  Privacy runtime: ${status.reason}. Выполните npm run privacy:bootstrap`);
  process.exit(1);
}

// ── 1. pytest ────────────────────────────────────────────────────
console.log("pytest: логика сервиса и настоящий pii-guard + NER");
const pytest = spawnSync(paths.python, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "-rs", "tests"], {
  cwd: SERVICE_DIR,
  env: serviceEnv(paths, { token: "test-token-not-a-secret", dbPath: ":memory:", extra: { FRONTSMITH_REQUIRE_NER: "1" } }),
  stdio: "inherit"
});
if (pytest.status !== 0) {
  console.error("FAIL  pytest");
  process.exit(1);
}

// ── 2–3. настоящий процесс ───────────────────────────────────────
const root = mkdtempSync(path.join(os.tmpdir(), "frontsmith-privacy-test-"));
const fakeServer = path.join(SERVICE_DIR, "..", "codex-host", "testing", "fake-app-server.mjs");
const clients = [];
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

function hostFor(service, label) {
  const log = path.join(root, `${label}.jsonl`);
  const client = AppServerClient.spawn({ codexBin: process.execPath, args: [fakeServer], env: { ...process.env, FAKE_APP_SERVER_LOG: log }, cwd: root });
  clients.push(client.process);
  const host = new CodexHost({
    client,
    privacy: new PrivacyClient({ baseUrl: service?.url ?? `http://127.0.0.1:${PORT}`, token: service?.token ?? "x", timeoutMs: 5000 }),
    workspace: path.join(root, `${label}-workspace`)
  });
  const turnStarts = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"kind":"turn_start"')).length : 0;
  return { host, turnStarts };
}

const rejectsPrivacy = (promise) => assert.rejects(promise, (error) => error instanceof PrivacyProcessingError && error.code === "privacy_processing_failed");

let service;
try {
  await check("настоящий сервис: /health ready, NER загружен из поставки без Hugging Face cache, PERSON и PHONE_NUMBER доступны", async () => {
    // Пустой HF_HOME и HF_HUB_OFFLINE=1: веса берутся только из vendor/ner-model
    const noHubCache = mkdtempSync(path.join(root, "no-hub-cache-"));
    service = await startPrivacyService({ port: PORT, dbPath: path.join(root, "privacy.sqlite"), paths, extraEnv: { HF_HOME: noHubCache } });
    const health = service.health;
    assert.equal(health.ready, true);
    assert.equal(health.ner_enabled, true);
    assert.equal(health.pii_guard_commit, status.marker.piiGuardCommit);
    assert.equal(health.ner_revision, status.marker.nerRevision);
    assert.equal(health.ner_model, status.marker.nerModel);
    assert.ok(["PERSON", "PHONE_NUMBER"].every((entity) => health.available_entity_types.includes(entity)));
  });

  await check("настоящий сервис: слушает только 127.0.0.1, без токена — 401", async () => {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:/);
    const response = await fetch(`${service.url}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant_id: "t" }) });
    assert.equal(response.status, 401);
  });

  await check("настоящий сервис: prepare/restore по HTTP", async () => {
    const client = new PrivacyClient({ baseUrl: service.url, token: service.token });
    const { privacySessionId } = await client.createSession("test-tenant");
    const prepared = await client.prepare({ tenantId: "test-tenant", privacySessionId, text: `${PERSON}, телефон ${PHONE}`, source: "user" });
    assert.ok(!prepared.text.includes("Иван") && !prepared.text.includes("Петров") && !prepared.text.includes("123-45-67"), prepared.text);
    assert.match(prepared.text, /<PII type="PERSON"/);
    assert.match(prepared.text, /<PII type="PHONE_NUMBER"/);
    const restored = await client.restoreFinalForRecipient({ tenantId: "test-tenant", privacySessionId, text: prepared.text, recipient: "operator" });
    assert.ok(restored.includes("Петров") && restored.includes("916"), restored);
  });

  await check("fail closed: pii-guard вернул ошибку на prepare — turn/start = 0", async () => {
    const { host, turnStarts } = hostFor(service, "prepare-error");
    await host.start();
    const conversation = await host.openConversation({ tenantId: "test-tenant" });
    // Больше 32 base64-блобов: настоящий pii-guard отказывается (Base64BudgetExceeded).
    const blob = Buffer.from(`${PERSON} ${PHONE}`, "utf8").toString("base64");
    await rejectsPrivacy(host.send(conversation.conversationId, `Клиент ${PERSON}. ${Array(40).fill(blob).join(" ")}`));
    assert.equal(turnStarts(), 0);
    host.close();
  });

  await check("fail closed: процесс Privacy Service остановлен — turn/start = 0", async () => {
    const { host, turnStarts } = hostFor(service, "down");
    await host.start();
    const conversation = await host.openConversation({ tenantId: "test-tenant" });
    await service.stop();
    await rejectsPrivacy(host.send(conversation.conversationId, `Клиент ${PERSON}, телефон ${PHONE}`));
    assert.equal(turnStarts(), 0);
    host.close();
  });

  await check("fail closed: веса NER не загрузились — сервис not_ready, Host не стартует, turn/start = 0", async () => {
    // Каталог модели без файлов: локальная загрузка не удаётся, в сеть сервис не идёт
    const emptyModels = mkdtempSync(path.join(root, "no-models-"));
    service = await startPrivacyService({ port: PORT, dbPath: path.join(root, "privacy.sqlite"), paths, requireReady: false, extraEnv: { HF_HOME: emptyModels, PII_GUARD_NER_MODEL: emptyModels } });
    assert.equal(service.health.ready, false);
    assert.equal(service.health.ner_enabled, false);
    assert.ok(service.health.reasons.includes("entity_unavailable:PHONE_NUMBER"), service.health.reasons.join(","));
    const { host, turnStarts } = hostFor(service, "ner");
    await rejectsPrivacy(host.start());
    await rejectsPrivacy(host.openConversation({ tenantId: "test-tenant" }));
    assert.equal(turnStarts(), 0);
    host.close();
    await service.stop();
  });

  await check("fail closed: state SQLite недоступна — сервис not_ready, Host не стартует, turn/start = 0", async () => {
    // Путь к БД указывает на каталог: SQLite не открывается.
    service = await startPrivacyService({ port: PORT, dbPath: root, paths, requireReady: false });
    assert.equal(service.health.ready, false);
    assert.equal(service.health.state_store_ready, false);
    assert.ok(service.health.reasons.includes("state_store_unavailable"));
    const { host, turnStarts } = hostFor(service, "store");
    await rejectsPrivacy(host.start());
    assert.equal(turnStarts(), 0);
    host.close();
    await service.stop();
  });
  console.log(`\nPrivacy Service: ${passed} проверок настоящего процесса пройдено`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await service?.stop();
  // Двойники App Server держат каталог как cwd: дождаться их завершения.
  await Promise.all(clients.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => { child.once("exit", resolve); child.kill(); })));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
