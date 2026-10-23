// Запуск встроенного CRM отдельно от панели (обычно не нужен: панель и AI runtime
// запускают crmkit сами). Только 127.0.0.1, Ctrl+C — остановка.
//
//   npm run crm:start
import { ensureCrm } from "./runtime.mjs";

let crm;
try {
  crm = await ensureCrm({ onLog: (line) => console.log(`crmkit: ${line}`) });
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
if (!crm.owned) {
  console.log(`crmkit уже работает: ${crm.url}`);
  process.exit(0);
}
console.log(`✓ crmkit: ${crm.url} (только 127.0.0.1). Ctrl+C — остановка`);
const shutdown = async (code) => {
  await crm.stop();
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));
crm.exited.then(({ code }) => {
  console.error(`crmkit завершился с кодом ${code}`);
  process.exit(1);
});
