// Реальный сквозной smoke-test: синтетические ПД → Privacy Service (pii-guard + NER)
// → Codex Host → `codex app-server` (stdio) → Codex по подписке ChatGPT → restore.
// Не входит в `npm test`: тратит лимиты подписки и требует Docker и вход ChatGPT.
//
//   npm run smoke:codex-host                 Privacy Service уже запущен
//   npm run smoke:codex-host -- --docker     поднять Privacy Service через Docker Compose
//
// Выход: 0 — PASS, 1 — FAIL, 2 — SKIPPED (нет Docker, Privacy Service или входа).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.mjs";
import { CodexHost } from "./codex-host.mjs";
import { assertOutside, codexEnv, defaultHostRoot, findCodex, prepareCodexHome } from "./codex-home.mjs";
import { PrivacyClient } from "./privacy-client.mjs";
import { getTestCustomerTool } from "./testing/test-customer-tool.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const useDocker = process.argv.includes("--docker");
const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const ORIGINALS = [PERSON, "Ивана Петрова", "Иван", "Петров", PHONE, "916 123-45-67", "123-45-67"];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const skip = (reason) => {
  console.log(`SKIPPED  ${reason}`);
  process.exit(2);
};

async function waitReady(privacy, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await privacy.readiness();
      if (last.ready) return last;
    } catch {
      last = { reasons: ["unreachable"] };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return last ?? { ready: false, reasons: ["timeout"] };
}

let baseUrl = process.env.FRONTSMITH_PRIVACY_URL ?? "http://127.0.0.1:4310";
let token = process.env.FRONTSMITH_PRIVACY_TOKEN;
if (useDocker) {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) skip("Docker daemon недоступен");
  token = randomBytes(24).toString("hex");
  const compose = ["compose", "-f", path.join(repo, "services", "privacy", "compose.yml")];
  console.log("Сборка и запуск Privacy Service (первая сборка скачивает torch и веса NER)...");
  execFileSync("docker", [...compose, "up", "-d", "--build", "--force-recreate"], { stdio: "inherit", env: { ...process.env, PRIVACY_SERVICE_TOKEN: token } });
}
if (!token) skip("не задан FRONTSMITH_PRIVACY_TOKEN (или используйте --docker)");

const privacy = new PrivacyClient({ baseUrl, token });
const readiness = await waitReady(privacy, useDocker ? 600_000 : 10_000);
if (!readiness.ready) skip(`Privacy Service не готов: ${readiness.reasons.join(",")}`);
const health = readiness.health;
console.log(`Privacy Service: pii-guard ${health.pii_guard_version} (${health.pii_guard_commit}), NER=${health.ner_enabled}, ${health.ner_model}@${health.ner_revision}`);

const codexBin = findCodex();
const home = prepareCodexHome(path.join(defaultHostRoot(), "home"), { forbiddenRoots: [repo] });
const env = codexEnv(home);
const status = spawnSync(codexBin, ["login", "status"], { env, encoding: "utf8" });
if (!/ChatGPT/i.test(`${status.stdout}${status.stderr}`)) skip(`в ${home} нет входа ChatGPT: выполните npm run codex-host:login`);
console.log(`${execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim()}; CODEX_HOME=${home}; вход: ChatGPT; API key: НЕТ`);

const workspace = mkdtempSync(path.join(os.tmpdir(), "frontsmith-codex-host-ws-"));
assertOutside(workspace, [repo, home]);
writeFileSync(path.join(workspace, "README.txt"), "Пустая рабочая область Frontsmith Codex Host. Данных клиентов здесь нет.\n");

const seen = [];
const logFile = path.join(defaultHostRoot(), "logs", `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const client = AppServerClient.spawn({ codexBin, args: ["app-server", "--strict-config"], env, cwd: workspace });
const host = new CodexHost({
  client,
  privacy,
  workspace,
  tools: [getTestCustomerTool()],
  model: process.env.FRONTSMITH_CODEX_MODEL,
  diagnostics: { logFile, captureModelVisible: (entry) => seen.push(entry) }
});
const clean = (text) => ORIGINALS.every((value) => !text.includes(value));

try {
  const server = await host.start();
  console.log(`App Server: ${server.userAgent}, transport stdio`);
  const conversation = await host.openConversation({ tenantId: "smoke-tenant" });

  const t1 = await host.send(conversation.conversationId, `Клиент ${PERSON}, телефон ${PHONE}.\nЗапомни, что он обратился по ремонту подвески.`);
  const t2 = await host.send(conversation.conversationId, "Что мы знаем про Ивана Петрова?");
  const t3 = await host.send(conversation.conversationId, "Вызови инструмент get_test_customer и перескажи карточку клиента одной строкой.");

  const inputs = seen.filter((entry) => entry.kind === "turn_input");
  const tools = seen.filter((entry) => entry.kind === "tool_output");
  check("turn/start: исходные ПД отсутствуют во всех ходах", inputs.length === 3 && inputs.every((entry) => clean(entry.text)), `ходов=${inputs.length}`);
  check("turn/start: теги PII присутствуют", inputs[0]?.pii_tags >= 2 && inputs[1]?.pii_tags >= 1, inputs.map((entry) => entry.pii_tags).join("/"));
  const personTag = inputs[0]?.text.match(/<PII type="PERSON"[^>]*\/>/)?.[0];
  check("двухходовый диалог: второй ход несёт тот же PERSON-тег", Boolean(personTag) && inputs[1]?.text.includes(personTag), personTag ?? "тег не найден");
  check("ответ модели содержит теги, а не исходные значения", clean(t2.modelText) && /<PII/.test(t2.modelText), t2.modelText.slice(0, 160));
  check("ответ восстановлен локально для адресата", t2.text.includes("Петров") && !/<PII/.test(t2.text));
  check("инструмент Host вызван моделью", t3.toolCalls.includes("get_test_customer"), t3.toolCalls.join(","));
  check("tool result очищен до модели", tools.length >= 1 && tools.every((entry) => clean(entry.text)), `результатов=${tools.length}`);
  check("финальный ответ после инструмента восстановлен", t3.text.includes("Петров") || t3.text.includes("916"), "");
  check("запросов одобрения не было или все отклонены", host.approvals.every((entry) => JSON.stringify(entry.decision).includes("decline") || JSON.stringify(entry.decision).includes("denied")));
  console.log(`Ответы модели (псевдонимизированные):\n  1: ${t1.modelText.replace(/\s+/g, " ").slice(0, 200)}\n  2: ${t2.modelText.replace(/\s+/g, " ").slice(0, 200)}\n  3: ${t3.modelText.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`Диагностический журнал (только SHA-256 и счётчики): ${logFile}`);
} catch (error) {
  check("сквозной прогон без ошибок", false, error.code ?? error.message);
} finally {
  host.close();
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? "Smoke: PASS (API key использовался: НЕТ)" : `Smoke: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
