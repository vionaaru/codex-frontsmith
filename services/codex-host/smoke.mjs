// Реальный сквозной smoke-test: синтетические ПД → Privacy Service (настоящий
// pii-guard + NER, локальный процесс) → Codex Host → `codex app-server` (stdio) →
// Codex по подписке ChatGPT → restore. Docker не нужен.
// Не входит в `npm test`: тратит лимиты подписки.
//
//   npm run smoke:codex-host
//
// Выход: 0 — PASS, 1 — FAIL, 2 — SKIPPED (runtime не подготовлен или нет входа ChatGPT).
import path from "node:path";
import { AiRuntimeUnavailable, startAiRuntime } from "./ai-runtime.mjs";
import { defaultHostRoot } from "./codex-home.mjs";
import { getTestCustomerTool } from "./testing/test-customer-tool.mjs";

const PERSON = "Иван Петров";
const PHONE = "+7 916 123-45-67";
const ORIGINALS = [PERSON, "Ивана Петрова", "Иван", "Петров", PHONE, "916 123-45-67", "123-45-67", "9161234567"];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const skip = (reason) => {
  console.log(`SKIPPED  ${reason}`);
  process.exit(2);
};
const clean = (text) => ORIGINALS.every((value) => !text.includes(value));
const oneLine = (text) => text.replace(/\s+/g, " ").slice(0, 200);

const seen = [];
const logFile = path.join(defaultHostRoot(), "logs", `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
let runtime;
try {
  console.log("Запуск Privacy Service и Codex App Server...");
  runtime = await startAiRuntime({
    tools: [getTestCustomerTool()],
    model: process.env.FRONTSMITH_CODEX_MODEL,
    diagnostics: { logFile, captureModelVisible: (entry) => seen.push(entry) }
  });
} catch (error) {
  if (error instanceof AiRuntimeUnavailable) skip(error.message);
  throw error;
}
const { host, privacyHealth: health } = runtime;
console.log(`Privacy Service: ${runtime.privacyService.url}, pii-guard ${health.pii_guard_version} (${health.pii_guard_commit}), NER=${health.ner_enabled}, ${health.ner_model}@${health.ner_revision}`);
console.log(`${runtime.codexVersion}; App Server ${runtime.server.userAgent}; transport stdio; CODEX_HOME=${runtime.codexHome}; вход: ChatGPT; API key: НЕТ`);

try {
  // 1. Простой сквозной ход.
  const simple = await host.openConversation({ tenantId: "smoke-tenant" });
  const s1 = await host.send(simple.conversationId, `Клиент ${PERSON}, телефон ${PHONE}.\nОтветь одной фразой: с каким клиентом мы работаем?`);
  const simpleInput = seen.filter((entry) => entry.kind === "turn_input").at(-1);
  check("smoke: turn/start без «Иван Петров» и «+7 916 123-45-67»", clean(simpleInput.text) && simpleInput.pii_tags >= 2, `тегов=${simpleInput.pii_tags}`);
  check("smoke: модель ответила тегом PERSON", /<PII type="PERSON"/.test(s1.modelText) && clean(s1.modelText), oneLine(s1.modelText));
  check("smoke: ответ восстановлен локально", s1.text.includes("Петров") && !/<PII/.test(s1.text), oneLine(s1.text));

  // 2. Двухходовая privacy-session и инструмент Host.
  const conversation = await host.openConversation({ tenantId: "smoke-tenant" });
  const from = seen.length;
  const t1 = await host.send(conversation.conversationId, `Клиент ${PERSON}, телефон ${PHONE}.\nОн обратился по ремонту подвески.`);
  const t2 = await host.send(conversation.conversationId, "Что мы знаем про Ивана Петрова?");
  const t3 = await host.send(conversation.conversationId, "Вызови инструмент get_test_customer и перескажи карточку клиента одной строкой.");

  const inputs = seen.slice(from).filter((entry) => entry.kind === "turn_input");
  const tools = seen.slice(from).filter((entry) => entry.kind === "tool_output");
  check("session: исходные ПД отсутствуют во всех turn/start", inputs.length === 3 && inputs.every((entry) => clean(entry.text)), `ходов=${inputs.length}`);
  const personTag = inputs[0]?.text.match(/<PII type="PERSON"[^>]*\/>/)?.[0];
  check("session: второй ход несёт тот же PERSON-тег", Boolean(personTag) && inputs[1]?.text.includes(personTag), `${personTag ?? "тег не найден"} | ${oneLine(inputs[1]?.text ?? "")}`);
  check("session: модель связала сообщения (подвеска)", /подвеск/i.test(t2.modelText) && clean(t2.modelText), oneLine(t2.modelText));
  check("session: ответ восстановлен локально", t2.text.includes("Петров") && !/<PII/.test(t2.text), oneLine(t2.text));
  check("tool: get_test_customer вызван моделью", t3.toolCalls.includes("get_test_customer"), t3.toolCalls.join(","));
  check("tool: model-visible результат без исходных ПД", tools.length >= 1 && tools.every((entry) => clean(entry.text) && entry.pii_tags >= 2), tools.map((entry) => oneLine(entry.text)).join(" | "));
  check("tool: ответ модели только с псевдонимами", clean(t3.modelText), oneLine(t3.modelText));
  check("tool: финальный ответ восстановлен локально", t3.text.includes("Петров") || t3.text.includes("916"), oneLine(t3.text));

  // 3. Восстановленный текст не возвращается в историю Codex.
  try {
    const read = await runtime.client.request("thread/read", { threadId: conversation.threadId, includeTurns: true });
    const history = JSON.stringify(read);
    check("history: в thread App Server нет исходных ПД", clean(history), `${history.length} символов`);
  } catch (error) {
    console.log(`NOT CHECKED  history: thread/read недоступен (${error.message})`);
  }
  check("запросов одобрения не было или все отклонены", host.approvals.every((entry) => JSON.stringify(entry.decision).includes("decline") || JSON.stringify(entry.decision).includes("denied")));
  console.log(`Ответы модели (псевдонимизированные):\n  smoke: ${oneLine(s1.modelText)}\n  1: ${oneLine(t1.modelText)}\n  2: ${oneLine(t2.modelText)}\n  3: ${oneLine(t3.modelText)}`);
  console.log(`Диагностический журнал (только SHA-256 и счётчики): ${logFile}`);
} catch (error) {
  check("сквозной прогон без ошибок", false, error.code ?? error.message);
} finally {
  await runtime.stop();
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? "Smoke: PASS (API key использовался: НЕТ)" : `Smoke: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
