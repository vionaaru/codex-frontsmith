// ТЕСТОВЫЙ ДВОЙНИК Codex App Server для `npm run test:codex-host`.
// Говорит тем же JSON-RPC по stdio, но вместо модели отвечает по простым правилам.
// Всё, что ему пришло (turn/start и результаты инструментов), пишется в журнал
// FAKE_APP_SERVER_LOG — по нему тест проверяет, что дошло до App Server.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_APP_SERVER_LOG;
const record = (entry) => log && appendFileSync(log, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threads = new Map();
const waiting = new Map();
let nextId = 1000;
let turnSeq = 0;

function serverRequest(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const tags = (text) => text.match(/<PII\b[^>]*\/>/g) ?? [];

async function runTurn(threadId, turnId, text) {
  const thread = threads.get(threadId);
  thread.history.push(text);
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
  let answer;
  if (text.includes("клиента из CRM")) {
    const result = await serverRequest("item/tool/call", { threadId, turnId, callId: `call-${turnId}`, namespace: null, tool: "get_test_customer", arguments: {} });
    const output = result.contentItems.map((item) => item.text).join("\n");
    record({ kind: "tool_output", threadId, text: output, success: result.success });
    thread.history.push(output);
    answer = result.success ? `Карточка: ${tags(output).join(" ")}` : "Инструмент недоступен";
  } else if (text.includes("выполни команду")) {
    const decision = await serverRequest("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId: "cmd-1", startedAtMs: Date.now(), environmentId: null, command: "type secret.txt" });
    record({ kind: "approval", threadId, decision });
    answer = `Команда: ${decision.decision}`;
  } else {
    // «Память» модели: теги PERSON из всей истории thread.
    const person = thread.history.flatMap(tags).find((tag) => tag.includes('type="PERSON"'));
    answer = person ? `${person} обращался по ремонту подвески` : "Нет данных";
  }
  thread.history.push(answer);
  const item = { type: "agentMessage", id: `msg-${turnId}`, text: answer, phase: null, memoryCitation: null, delivery: null, questions: null };
  send({ method: "item/completed", params: { item, threadId, turnId, completedAtMs: Date.now() } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status: "completed", error: null } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method === "initialized") return;
  record({ kind: "request", method, params: method === "turn/start" ? undefined : params });
  if (method === "initialize") return send({ id, result: { userAgent: "fake-app-server", codexHome: "", platformFamily: "test", platformOs: "test" } });
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = params.threadId ?? `thread-${threads.size + 1}`;
    if (!threads.has(threadId)) threads.set(threadId, { history: [] });
    return send({ id, result: { thread: { id: threadId }, model: "fake", modelProvider: "fake" } });
  }
  if (method === "turn/start") {
    const text = params.input.map((part) => part.text).join("\n");
    record({ kind: "turn_start", threadId: params.threadId, text });
    const turnId = `turn-${++turnSeq}`;
    send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    runTurn(params.threadId, turnId, text);
    return;
  }
  send({ id, error: { code: -32601, message: `fake: ${method}` } });
});
