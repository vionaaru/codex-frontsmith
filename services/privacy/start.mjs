// Запуск Privacy Service в этом терминале до Ctrl+C. Для диагностики: обычный
// запуск AI runtime (`npm run ai:start`) поднимает сервис сам.
//
//   npm run privacy:start
import { startPrivacyService } from "./runtime.mjs";

let service;
try {
  console.log("Запуск Privacy Service (загрузка NER занимает до минуты)...");
  service = await startPrivacyService({ onLog: (chunk) => process.stderr.write(chunk) });
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
const { health } = service;
console.log(`✓ Privacy Service: ${service.url} (только 127.0.0.1)`);
console.log(`  pii-guard ${health.pii_guard_version} (${health.pii_guard_commit.slice(0, 7)}), NER=${health.ner_enabled} ${health.ner_model}@${health.ner_revision?.slice(0, 7)}`);
console.log("  Токен выдан на этот запуск и известен только процессу Host. Ctrl+C — остановка.");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  await service.stop();
  process.exit(0);
});
service.exited.then(({ code }) => {
  console.error(`Privacy Service завершился с кодом ${code}`);
  process.exit(1);
});
