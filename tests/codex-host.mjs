// Граница Privacy Service ↔ Codex Host на тестовых двойниках App Server и Privacy Service.
// Двойник App Server — отдельный процесс на stdio; его журнал показывает всё, что
// фактически дошло до App Server. Реальный Codex и pii-guard здесь не запускаются.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../services/codex-host/app-server-client.mjs";
import { CodexHost } from "../services/codex-host/codex-host.mjs";
import { assertOutside, codexEnv, defaultHostRoot } from "../services/codex-host/codex-home.mjs";
import { PrivacyClient, PrivacyProcessingError } from "../services/codex-host/privacy-client.mjs";
import { startFakePrivacyService } from "../services/codex-host/testing/fake-privacy-service.mjs";
import { getTestCustomerTool } from "../services/codex-host/testing/test-customer-tool.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(repo, "services", "codex-host", "testing", "fake-app-server.mjs");
const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const ORIGINALS = [PERSON, "Ивана Петрова", PHONE, "Мария Сидорова"];

const root = await mkdtemp(path.join(os.tmpdir(), "frontsmith-codex-host-"));
const privacy = await startFakePrivacyService();
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

async function setup(label) {
  const log = path.join(root, `${label}.jsonl`);
  const workspace = path.join(root, `${label}-workspace`);
  const client = AppServerClient.spawn({
    codexBin: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_APP_SERVER_LOG: log },
    cwd: root
  });
  const seen = [];
  const host = new CodexHost({
    client,
    privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }),
    workspace,
    tools: [getTestCustomerTool()],
    diagnostics: { logFile: path.join(root, `${label}-diag.jsonl`), captureModelVisible: (entry) => seen.push(entry) }
  });
  const received = async () => {
    if (!existsSync(log)) return [];
    return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  return { host, seen, received, diag: path.join(root, `${label}-diag.jsonl`) };
}

const noOriginals = (text) => ORIGINALS.every((value) => !text.includes(value));

try {
  await check("prepare возвращает Host только текст: mapping и normalized_text отброшены", async () => {
    const client = new PrivacyClient({ baseUrl: privacy.url, token: privacy.token });
    const { privacySessionId } = await client.createSession("demo-tenant");
    const prepared = await client.prepare({ tenantId: "demo-tenant", privacySessionId, text: `${PERSON}, тел. ${PHONE}`, source: "user" });
    assert.deepEqual(Object.keys(prepared).sort(), ["replacements", "text"]);
    assert.ok(noOriginals(JSON.stringify(prepared)));
    for (const name of ["getMapping", "get_mapping", "dumpSession", "getOriginalPhone", "getOriginalPerson"]) {
      assert.equal(typeof client[name], "undefined");
    }
  });

  const main = await setup("main");
  let conversation;
  await check("Host проверяет готовность и открывает thread с инструментом Host", async () => {
    await main.host.start();
    conversation = await main.host.openConversation({ tenantId: "demo-tenant" });
    const start = (await main.received()).find((entry) => entry.method === "thread/start");
    assert.equal(start.params.sandbox, "read-only");
    assert.deepEqual(start.params.dynamicTools.map((tool) => tool.name), ["get_test_customer"]);
    assert.match(start.params.developerInstructions, /<PII/);
  });

  let first;
  await check("оригинал отсутствует в turn/start, тег PII присутствует", async () => {
    first = await main.host.send(conversation.conversationId, `Клиент ${PERSON}, телефон ${PHONE}.\nЗапомни, что он обратился по ремонту подвески.`);
    const turns = (await main.received()).filter((entry) => entry.kind === "turn_start");
    assert.equal(turns.length, 1);
    assert.ok(noOriginals(turns[0].text), "App Server получил исходные ПД");
    assert.match(turns[0].text, /<PII type="PERSON" id="1" \/>/);
    assert.match(turns[0].text, /<PII type="PHONE_NUMBER" id="1" \/>/);
    assert.ok(main.seen.every((entry) => noOriginals(entry.text)));
  });

  await check("двухходовый диалог: тот же псевдоним, ответ восстановлен локально", async () => {
    const second = await main.host.send(conversation.conversationId, "Что мы знаем про Ивана Петрова?");
    const turns = (await main.received()).filter((entry) => entry.kind === "turn_start");
    assert.ok(noOriginals(turns[1].text));
    assert.match(turns[1].text, /<PII type="PERSON" id="1" \/>/);
    assert.equal(second.modelText, '<PII type="PERSON" id="1" /> обращался по ремонту подвески');
    assert.equal(second.text, `${PERSON} обращался по ремонту подвески`);
    assert.ok(first.text.includes(PERSON));
  });

  await check("восстановленный ответ не возвращается в историю Codex", async () => {
    const all = await main.received();
    assert.ok(all.every((entry) => noOriginals(JSON.stringify(entry))), "в журнале App Server есть исходные ПД");
  });

  await check("результат инструмента очищается до модели", async () => {
    const result = await main.host.send(conversation.conversationId, "Найди клиента из CRM и покажи карточку.");
    const tool = (await main.received()).find((entry) => entry.kind === "tool_output");
    assert.equal(tool.success, true);
    assert.ok(noOriginals(tool.text), "исходное имя или телефон в model-visible tool result");
    assert.match(tool.text, /<PII type="PERSON" id="1" \/>/);
    assert.deepEqual(result.toolCalls, ["get_test_customer"]);
    assert.equal(result.text, `Карточка: ${PERSON} ${PHONE}`);
  });

  await check("запросы одобрения команд отклоняются Host", async () => {
    const result = await main.host.send(conversation.conversationId, "выполни команду");
    assert.equal(result.text, "Команда: decline");
    assert.deepEqual(main.host.approvals.at(-1), { method: "item/commandExecution/requestApproval", decision: { decision: "decline" } });
  });

  await check("диагностический журнал содержит SHA-256 и счётчики, без текста", async () => {
    const lines = (await readFile(main.diag, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).sort(), ["chars", "kind", "pii_tags", "sha256", "thread_id", "ts"]);
      assert.match(line.sha256, /^[0-9a-f]{64}$/);
    }
  });

  await check("разные privacy sessions не смешиваются", async () => {
    const other = await main.host.openConversation({ tenantId: "demo-tenant" });
    const reply = await main.host.send(other.conversationId, "Клиент Мария Сидорова, перезвонить завтра.");
    assert.equal(reply.modelText, '<PII type="PERSON" id="1" /> обращался по ремонту подвески');
    assert.equal(reply.text, "Мария Сидорова обращался по ремонту подвески");
  });
  main.host.close();

  const turnStarts = async (env) => (await env.received()).filter((entry) => entry.kind === "turn_start").length;

  await check("Privacy Service недоступен: turn/start не вызывается", async () => {
    const env = await setup("down");
    await env.host.start();
    const conv = await env.host.openConversation({ tenantId: "demo-tenant" });
    const host = new CodexHost({
      client: AppServerClient.spawn({ codexBin: process.execPath, args: [fakeServer], env: { ...process.env, FAKE_APP_SERVER_LOG: path.join(root, "down2.jsonl") }, cwd: root }),
      privacy: new PrivacyClient({ baseUrl: "http://127.0.0.1:9", token: "x", timeoutMs: 2000 }),
      workspace: path.join(root, "down-workspace")
    });
    await assert.rejects(host.start(), (error) => error instanceof PrivacyProcessingError && error.code === "privacy_processing_failed");
    host.close();
    privacy.mode.prepareFails = true;
    await assert.rejects(env.host.send(conv.conversationId, `Клиент ${PERSON}`), { code: "privacy_processing_failed" });
    privacy.mode.prepareFails = false;
    assert.equal(await turnStarts(env), 0);
    env.host.close();
  });

  await check("NER отключён: клиентский диалог блокируется", async () => {
    const env = await setup("ner");
    privacy.mode.ner = false;
    await assert.rejects(env.host.start(), (error) => error.code === "privacy_processing_failed" && error.reason.includes("ner_disabled"));
    privacy.mode.ner = true;
    await env.host.start();
    const conv = await env.host.openConversation({ tenantId: "demo-tenant" });
    privacy.mode.ner = false;
    await assert.rejects(env.host.send(conv.conversationId, `Клиент ${PERSON}`), { code: "privacy_processing_failed" });
    await assert.rejects(env.host.openConversation({ tenantId: "demo-tenant" }), { code: "privacy_processing_failed" });
    privacy.mode.ner = true;
    assert.equal(await turnStarts(env), 0);
    env.host.close();
  });

  await check("хранилище состояния недоступно: turn/start не вызывается", async () => {
    const env = await setup("store");
    await env.host.start();
    const conv = await env.host.openConversation({ tenantId: "demo-tenant" });
    privacy.mode.store = false;
    await assert.rejects(env.host.send(conv.conversationId, `Клиент ${PERSON}`), { code: "privacy_processing_failed" });
    privacy.mode.store = true;
    assert.equal(await turnStarts(env), 0);
    env.host.close();
  });

  await check("отказ Privacy Service на результате инструмента не отдаёт оригинал модели", async () => {
    const env = await setup("tool-fail");
    await env.host.start();
    const conv = await env.host.openConversation({ tenantId: "demo-tenant" });
    privacy.mode.failSource = "tool";
    try {
      await assert.rejects(env.host.send(conv.conversationId, "Найди клиента из CRM и покажи карточку."), { code: "privacy_processing_failed" });
    } finally {
      privacy.mode.failSource = null;
    }
    const output = (await env.received()).find((entry) => entry.kind === "tool_output");
    assert.equal(output.success, false);
    assert.equal(output.text, "privacy_processing_failed");
    env.host.close();
  });

  await check("окружение App Server без OPENAI_API_KEY и с отдельным CODEX_HOME", async () => {
    const env = codexEnv("C:\\codex-host-home", { PATH: "x", OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "y", OPENAI_BASE_URL: "z", CODEX_HOME: "D:\\other" });
    assert.deepEqual(env, { PATH: "x", CODEX_HOME: "C:\\codex-host-home" });
    assert.throws(() => assertOutside(path.join(repo, ".frontsmith", "business", "x"), [repo]));
    assert.doesNotThrow(() => assertOutside(defaultHostRoot(), [repo, path.join(repo, ".frontsmith")]));
  });

  await check("runtime-БД и mapping не попадают в Git", async () => {
    for (const file of ["services/privacy/privacy.sqlite", "services/privacy/data/privacy.sqlite-wal", "services/codex-host/runtime/turns.jsonl"]) {
      execFileSync("git", ["check-ignore", "-q", file], { cwd: repo });
    }
    const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "services"], { cwd: repo, encoding: "utf8" });
    assert.ok(!/\.(sqlite3?|db)(-|$)/m.test(tracked));
    assert.ok(!/runtime\//.test(tracked));
  });
} finally {
  await privacy.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(`Codex Host: ${passed} проверок пройдено.`);
