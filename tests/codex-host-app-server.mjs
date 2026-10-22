// Настоящий `codex app-server` + Codex Host + двойник Privacy Service + синтетическая
// модель на 127.0.0.1. Проверяет на уровне HTTP-запросов к модели, что ни ввод, ни
// результат инструмента Host не несут исходных ПД, и что встроенных инструментов
// оболочки у модели нет. Внешних запросов и подписки не требует.
//
// Синтетический model provider здесь — только тестовый стенд без ключей. В рабочем
// контуре Host использует штатного провайдера OpenAI с входом ChatGPT.
//
//   npm run test:codex-host:app-server
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerClient } from "../services/codex-host/app-server-client.mjs";
import { CodexHost } from "../services/codex-host/codex-host.mjs";
import { HOST_CONFIG_TOML, codexEnv, findCodex } from "../services/codex-host/codex-home.mjs";
import { PrivacyClient } from "../services/codex-host/privacy-client.mjs";
import { startFakePrivacyService } from "../services/codex-host/testing/fake-privacy-service.mjs";
import { getTestCustomerTool } from "../services/codex-host/testing/test-customer-tool.mjs";

const ORIGINALS = ["Иван Петров", "Ивана Петрова", "Петров", "+7 916 123-45-67", "123-45-67"];
const TAG = /<PII\b[^>]*\/>/g;
const bodies = [];

function textOf(item) {
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) return item.content.map((part) => part?.text ?? "").join("\n");
  if (typeof item?.output === "string") return item.output;
  if (Array.isArray(item?.output)) return item.output.map((part) => part?.text ?? "").join("\n");
  return "";
}

// Решение синтетической модели по последнему элементу истории.
function decide(request) {
  const input = request.input ?? [];
  const last = input.at(-1);
  if (last?.type === "function_call_output") return { text: `Карточка: ${(textOf(last).match(TAG) ?? []).join(" ")}` };
  const user = input.filter((item) => item.role === "user").map(textOf);
  if (user.at(-1)?.includes("CRM")) return { call: "get_test_customer" };
  const person = input.map(textOf).join("\n").match(/<PII type="PERSON"[^>]*\/>/)?.[0];
  return { text: person ? `${person} обращался по ремонту подвески` : "Нет данных" };
}

function sse(res, request) {
  const decision = decide(request);
  const item = decision.call
    ? { type: "function_call", id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: decision.call, arguments: "{}", status: "completed" }
    : { type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: decision.text, annotations: [] }] };
  const id = `resp_${randomUUID()}`;
  const response = (status, output) => ({ id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: request.model, output, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("response.created", { response: response("in_progress", []) });
  event("response.output_item.added", { output_index: 0, item });
  if (item.type === "message") event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: decision.text });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: response("completed", [item]) });
  res.end();
}

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url.endsWith("/responses")) {
      const request = JSON.parse(body);
      bodies.push({ raw: body, request });
      return sse(res, request);
    }
    res.writeHead(404).end();
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const port = model.address().port;

const root = mkdtempSync(path.join(os.tmpdir(), "frontsmith-codex-host-real-"));
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
mkdirSync(home);
mkdirSync(workspace);
writeFileSync(
  path.join(home, "config.toml"),
  HOST_CONFIG_TOML.replace('forced_login_method = "chatgpt"\n', "").replace(
    "[windows]",
    `model = "synthetic"\nmodel_provider = "frontsmith_test"\n\n[model_providers.frontsmith_test]\nname = "Frontsmith synthetic test model"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "FRONTSMITH_TEST_DUMMY"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[windows]`
  )
);
const privacy = await startFakePrivacyService();
const client = AppServerClient.spawn({ codexBin: findCodex(), args: ["app-server", "--strict-config"], env: { ...codexEnv(home), FRONTSMITH_TEST_DUMMY: "not-a-secret" }, cwd: workspace });
const host = new CodexHost({ client, privacy: new PrivacyClient({ baseUrl: privacy.url, token: privacy.token }), workspace, tools: [getTestCustomerTool()] });
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

try {
  await host.start();
  const conversation = await host.openConversation({ tenantId: "demo-tenant" });
  const first = await host.send(conversation.conversationId, "Клиент Иван Петров, телефон +7 916 123-45-67.\nЗапомни, что он обратился по ремонту подвески.");
  const second = await host.send(conversation.conversationId, "Что мы знаем про Ивана Петрова?");
  const third = await host.send(conversation.conversationId, "Найди клиента в CRM и покажи карточку.");

  check("модель получила 4 запроса: 2 хода, ход с инструментом и раунд после него", () => assert.equal(bodies.length, 4));
  check("ни один запрос к модели не содержит исходных ПД", () => {
    for (const { raw } of bodies) {
      const decoded = JSON.stringify(JSON.parse(raw));
      for (const value of ORIGINALS) assert.ok(!raw.includes(value) && !decoded.includes(value), "исходное значение в запросе к модели");
    }
  });
  check("второй ход несёт тот же PERSON-тег, ответ восстановлен локально", () => {
    assert.match(textOf(bodies[1].request.input.filter((item) => item.role === "user").at(-1)), /<PII type="PERSON" id="1" \/>/);
    assert.equal(second.text, "Иван Петров обращался по ремонту подвески");
    assert.ok(first.text.includes("Иван Петров"));
  });
  check("восстановленный ответ не попал в историю следующего хода", () => {
    const history = bodies[2].request.input.map(textOf).join("\n");
    assert.ok(history.includes('<PII type="PERSON" id="1" /> обращался по ремонту подвески'));
    assert.ok(!history.includes("Иван Петров обращался"));
  });
  check("результат инструмента Host очищен до модели", () => {
    const output = bodies[3].request.input.find((item) => item.type === "function_call_output");
    assert.ok(output, "нет function_call_output");
    assert.match(textOf(output), /<PII type="PERSON" id="1" \/>.*<PII type="PHONE_NUMBER" id="1" \/>/s);
    assert.deepEqual(third.toolCalls, ["get_test_customer"]);
    assert.equal(third.text, "Карточка: Иван Петров +7 916 123-45-67");
  });
  check("у модели нет встроенных инструментов оболочки", () => {
    const names = bodies[0].request.tools.map((tool) => tool.name ?? tool.type);
    assert.ok(names.includes("get_test_customer"), names.join(","));
    for (const forbidden of ["exec_command", "shell", "shell_command", "local_shell", "write_stdin", "view_image"]) {
      assert.ok(!names.includes(forbidden), `доступен ${forbidden}: ${names.join(",")}`);
    }
    console.log(`  инструменты модели: ${names.join(", ")}`);
  });
} finally {
  host.close();
  await privacy.close();
  model.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(`Codex Host + codex app-server: ${passed} проверок пройдено.`);
