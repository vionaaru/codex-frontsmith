// Обычный запуск AI runtime Frontsmith: Privacy Service + Codex App Server.
// Первичная подготовка выполняется один раз: npm run privacy:bootstrap и
// npm run codex-host:login.
//
//   npm run ai:start
import { startAiRuntime } from "./ai-runtime.mjs";

let runtime;
try {
  console.log("Запуск Privacy Service и Codex App Server...");
  runtime = await startAiRuntime();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
const { privacyHealth: health } = runtime;
console.log(`✓ Privacy Service: ${runtime.privacyService.url}, pii-guard ${health.pii_guard_version} (${health.pii_guard_commit.slice(0, 7)}), NER=${health.ner_enabled}`);
console.log(`✓ Codex App Server: ${runtime.codexVersion}, stdio, вход ChatGPT`);
console.log("AI-операции Frontsmith разрешены. Ctrl+C — остановка App Server и Privacy Service.");

let stopping = false;
const shutdown = async (code) => {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
  console.log("AI runtime остановлен.");
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));
runtime.privacyService.exited.then(({ code }) => {
  console.error(`Privacy Service завершился с кодом ${code}: AI-операции остановлены.`);
  shutdown(1);
});
