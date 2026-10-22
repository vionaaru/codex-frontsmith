// ИССЛЕДОВАТЕЛЬСКИЙ PoC, не production gateway.
// Локальный Responses-совместимый endpoint, который отвечает синтетическими
// ответами и ведёт журнал без секретов. Внешних запросов не делает.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIXTURE_TOKEN = "GATEWAY_POC_FIXTURE_42";
export const SIMPLE_ANSWER = "POC_OK";

const here = dirname(fileURLToPath(import.meta.url));

// Только эти поля попадают в журнал. Заголовки, включая Authorization,
// не сохраняются: фиксируется лишь факт наличия Authorization.
function safeEntry(state, req, body, parsed, decision) {
  const input = Array.isArray(parsed?.input) ? parsed.input : [];
  return {
    timestamp: new Date().toISOString(),
    request_number: state.count,
    method: req.method,
    path: req.url.split("?")[0],
    model: typeof parsed?.model === "string" ? parsed.model : null,
    stream: parsed?.stream === true,
    has_authorization: Boolean(req.headers.authorization),
    input_item_types: input.map((item) => item?.type ?? (item?.role ? `role:${item.role}` : "unknown")),
    tool_names: Array.isArray(parsed?.tools) ? parsed.tools.map(toolName) : [],
    has_previous_response_id: Boolean(parsed?.previous_response_id),
    function_call_output_has_fixture: decision.outputHasFixture ?? null,
    body_bytes: body.length,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    reply: decision.kind
  };
}

function toolName(tool) {
  return tool?.name ?? tool?.function?.name ?? tool?.type ?? "unknown";
}

function textOf(item) {
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) return item.content.map((part) => part?.text ?? "").join("\n");
  return "";
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => part?.text ?? "").join("\n");
  if (output && typeof output === "object") return JSON.stringify(output);
  return "";
}

// Подбирает вызов инструмента под фактическую схему, которую прислал Codex.
function shellCall(tools) {
  const functions = (tools ?? []).filter((tool) => tool?.type === "function" || tool?.parameters);
  const props = (tool) => Object.keys(tool?.parameters?.properties ?? tool?.function?.parameters?.properties ?? {});
  const command = "Get-Content -LiteralPath fixture.txt";
  for (const tool of functions) {
    const name = toolName(tool);
    const keys = props(tool);
    if (keys.includes("cmd")) return { name, args: { cmd: command } };
    if (keys.includes("command")) {
      const type = (tool.parameters ?? tool.function?.parameters).properties.command.type;
      return { name, args: { command: type === "array" ? ["powershell", "-NoProfile", "-Command", command] : command } };
    }
  }
  return null;
}

export function decide(parsed) {
  const input = Array.isArray(parsed?.input) ? parsed.input : [];
  const outputs = input.filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output");
  if (outputs.length > 0) {
    const text = outputText(outputs.at(-1).output);
    const outputHasFixture = text.includes(FIXTURE_TOKEN);
    return { kind: "final_after_tool", outputHasFixture, text: outputHasFixture ? FIXTURE_TOKEN : "FIXTURE_NOT_FOUND" };
  }
  const userText = input.filter((item) => item?.role === "user").map(textOf).join("\n");
  if (userText.includes("fixture.txt")) {
    const call = shellCall(parsed?.tools);
    if (call) return { kind: "tool_call", call };
    return { kind: "no_shell_tool", text: "NO_SHELL_TOOL" };
  }
  return { kind: "simple", text: SIMPLE_ANSWER };
}

function outputItem(decision) {
  if (decision.kind === "tool_call") {
    return {
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: `call_${randomUUID()}`,
      name: decision.call.name,
      arguments: JSON.stringify(decision.call.args),
      status: "completed"
    };
  }
  return {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: decision.text, annotations: [] }]
  };
}

function responseObject(id, model, items, status) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: items,
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
  };
}

function sendSse(res, model, item, holdMs) {
  const id = `resp_${randomUUID()}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("response.created", { response: responseObject(id, model, [], "in_progress") });
  event("response.output_item.added", { output_index: 0, item });
  if (item.type === "message") {
    event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
  }
  event("response.output_item.done", { output_index: 0, item });
  setTimeout(() => {
    event("response.completed", { response: responseObject(id, model, [item], "completed") });
    res.end();
  }, holdMs);
}

export function startGateway({ port = 0, logFile, holdMs = 0 } = {}) {
  const state = { count: 0 };
  const log = (entry) => {
    if (!logFile) return;
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.count += 1;
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = body.length ? JSON.parse(body.toString("utf8")) : null;
      } catch {
        parsed = null;
      }
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path.endsWith("/responses") && parsed) {
        const decision = decide(parsed);
        log(safeEntry(state, req, body, parsed, decision));
        const item = outputItem(decision);
        const model = parsed.model ?? "poc-model";
        if (parsed.stream === false) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(responseObject(`resp_${randomUUID()}`, model, [item], "completed")));
        } else {
          sendSse(res, model, item, holdMs);
        }
        return;
      }
      if (req.method === "GET" && path.endsWith("/models")) {
        log(safeEntry(state, req, body, parsed, { kind: "models" }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [], models: [] }));
        return;
      }
      log(safeEntry(state, req, body, parsed, { kind: "not_found" }));
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found in PoC gateway" } }));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => resolveStart({ server, state, port: server.address().port }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.POC_GATEWAY_PORT ?? 4199);
  const logFile = resolve(process.env.POC_GATEWAY_LOG ?? resolve(here, "runtime", "gateway.jsonl"));
  const { port: actual } = await startGateway({ port, logFile });
  console.log(`PoC gateway: http://127.0.0.1:${actual}/v1 (журнал: ${logFile})`);
}
