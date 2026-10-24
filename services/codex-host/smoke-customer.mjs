// Реальный сквозной smoke-test Customer Module: синтетический клиент в тестовом crmkit →
// get_customer_context (CustomerProvider) → Privacy Service (настоящий pii-guard + NER) →
// Codex App Server → Codex по подписке ChatGPT → restore.
// CRM пользователя не используется: отдельный временный экземпляр crmkit и офисная база.
// Не входит в `npm test`: тратит лимиты подписки.
//
//   npm run smoke:crm-codex
//
// Выход: 0 — PASS, 1 — FAIL, 2 — SKIPPED (не подготовлен runtime или нет входа ChatGPT).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "../privacy/runtime.mjs";
import { CrmkitClient } from "../crm/client.mjs";
import { crmPaths, crmStatus, freePort, provisionCredential, readCredential, runMigrations, startCrmkit, writeConfig } from "../crm/runtime.mjs";
import { migrate, openOfficeDb } from "../../office/lib/db.mjs";
import { CrmkitProvider } from "../../office/customers/crmkit-provider.mjs";
import { AiRuntimeUnavailable, startAiRuntime } from "./ai-runtime.mjs";
import { codexEnv } from "./codex-home.mjs";
import { getCustomerContextTool } from "./tools/customer-context.mjs";

const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const ORIGINALS = [PERSON, "Иван", "Петров", PHONE, "+79161234567", "916 123-45-67", "123-45-67", "9161234567"];
const clean = (text) => ORIGINALS.every((value) => !text.includes(value));
const oneLine = (text) => text.replace(/\s+/g, " ").slice(0, 200);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const installed = crmPaths();
if (!crmStatus(installed).ready) {
  console.log("SKIPPED  CRM не подготовлен: npm run crm:bootstrap");
  process.exit(2);
}
const base = path.join(dataRoot(), "runtime", "tmp");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, "smoke-crm-"));
const paths = { ...crmPaths(root), binary: installed.binary, marker: installed.marker, runtime: installed.runtime };
let crm;
let runtime;
let db;
let exitCode = 1;
try {
  mkdirSync(paths.dataDir, { recursive: true });
  writeConfig(paths);
  runMigrations(paths);
  await provisionCredential(paths);
  crm = await startCrmkit({ paths, port: await freePort() });
  const credential = readCredential(paths);
  db = openOfficeDb({ file: path.join(root, "office.sqlite") });
  migrate(db);
  const provider = new CrmkitProvider({ db, client: new CrmkitClient({ baseUrl: crm.url, token: credential.token }), workspaceId: credential.workspaceId });
  const { customer } = await provider.createCustomer({ displayName: PERSON, phone: PHONE, notes: "Синтетический клиент smoke-теста" });
  console.log(`Тестовый crmkit: ${crm.url}; client_id ${customer.id}`);

  const seen = [];
  try {
    runtime = await startAiRuntime({ crm: false, tools: [getCustomerContextTool(provider)], model: process.env.FRONTSMITH_CODEX_MODEL, diagnostics: { captureModelVisible: (entry) => seen.push(entry) } });
  } catch (error) {
    if (error instanceof AiRuntimeUnavailable) {
      console.log(`SKIPPED  ${error.message}`);
      exitCode = 2;
      throw error;
    }
    throw error;
  }
  const health = runtime.privacyHealth;
  console.log(`Privacy Service: pii-guard ${health.pii_guard_version} (${health.pii_guard_commit.slice(0, 7)}), NER=${health.ner_enabled}; ${runtime.codexVersion}; вход ChatGPT, API key: НЕТ`);

  const conversation = await runtime.host.openConversation({ tenantId: "smoke-tenant" });
  const reply = await runtime.host.send(conversation.conversationId,
    `Вызови инструмент get_customer_context с client_id ${customer.id} и перескажи контакт клиента одной строкой.`);
  const inputs = seen.filter((entry) => entry.kind === "turn_input");
  const tools = seen.filter((entry) => entry.kind === "tool_output");
  check("turn/start без исходных ПД", inputs.every((entry) => clean(entry.text)));
  check("модель вызвала get_customer_context", reply.toolCalls.includes("get_customer_context"), reply.toolCalls.join(","));
  check("model-visible результат инструмента: PERSON и PHONE_NUMBER тегами, без оригиналов",
    tools.length >= 1 && tools.every((entry) => clean(entry.text) && /<PII type="PERSON"/.test(entry.text) && /<PII type="PHONE_NUMBER"/.test(entry.text)),
    tools.map((entry) => oneLine(entry.text)).join(" | "));
  check("ответ модели только с псевдонимами", clean(reply.modelText), oneLine(reply.modelText));
  check("ответ оператору восстановлен локально", reply.text.includes("Петров") || reply.text.includes("916"), oneLine(reply.text));
  try {
    const read = await runtime.client.request("thread/read", { threadId: conversation.threadId, includeTurns: true });
    check("история thread App Server без исходных ПД", clean(JSON.stringify(read)));
  } catch (error) {
    console.log(`NOT CHECKED  thread/read (${error.message})`);
  }
  const env = JSON.stringify(codexEnv(runtime.codexHome));
  check("окружение App Server без токена и адреса crmkit", !env.includes(credential.token) && !env.includes(crm.url));
  exitCode = results.every(Boolean) ? 0 : 1;
} catch (error) {
  if (exitCode !== 2) check("сквозной прогон без ошибок", false, error.code ?? error.message);
} finally {
  await runtime?.stop();
  await crm?.stop();
  db?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (exitCode !== 2) console.log(exitCode === 0 ? "Smoke Customer Module: PASS" : "Smoke Customer Module: FAIL");
process.exitCode = exitCode;
