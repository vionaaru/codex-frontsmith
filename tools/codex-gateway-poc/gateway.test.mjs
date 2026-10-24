// Синтетический тест PoC gateway без Codex и без внешних запросов.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_TOKEN, SIMPLE_ANSWER, decide, startGateway } from "./gateway.mjs";

const execTool = { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

assert.equal(decide({ input: [user("Ответь одним словом")] }).text, SIMPLE_ANSWER);
const call = decide({ input: [user("Прочитай fixture.txt")], tools: [execTool] });
assert.equal(call.kind, "tool_call");
assert.equal(call.call.name, "exec_command");
assert.match(call.call.args.cmd, /fixture\.txt/);
const final = decide({ input: [user("Прочитай fixture.txt"), { type: "function_call_output", call_id: "c", output: `${FIXTURE_TOKEN}\n` }] });
assert.deepEqual([final.kind, final.text, final.outputHasFixture], ["final_after_tool", FIXTURE_TOKEN, true]);

const dir = mkdtempSync(join(tmpdir(), "frontsmith-gateway-test-"));
const logFile = join(dir, "gateway.jsonl");
const { server, port } = await startGateway({ logFile });
try {
  const secret = "sk-synthetic-must-not-be-logged";
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-custom": secret, "content-type": "application/json" },
    body: JSON.stringify({ model: "poc-model", stream: true, input: [user("Ответь одним словом")], tools: [execTool] })
  });
  const sse = await response.text();
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  for (const event of ["response.created", "response.output_item.done", "response.completed"]) assert.ok(sse.includes(`event: ${event}`), event);
  assert.ok(sse.includes(SIMPLE_ANSWER));

  const log = readFileSync(logFile, "utf8");
  assert.ok(!log.includes(secret), "журнал не содержит Authorization и заголовков");
  const entry = JSON.parse(log.trim());
  assert.equal(entry.has_authorization, true);
  assert.deepEqual(entry.tool_names, ["exec_command"]);
  assert.equal(entry.path, "/v1/responses");
  assert.match(entry.body_sha256, /^[0-9a-f]{64}$/);
} finally {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
}
console.log("codex-gateway-poc: синтетический тест gateway пройден");
