// Демонстрация записи через AI-чат: отдельная учебная компания с тестовыми услугами,
// расписанием (Пн–Сб, 10:00–19:00, Москва) и разрешённым автоподтверждением записи.
//
//   npm run demo:booking
//
// Рабочие данные демонстрации — в .frontsmith/demo-booking/ (не в Git), отдельно от
// .frontsmith/business/: офисная база, сайт и записи компании не меняются. Каталог данных
// (crmkit, Privacy Service, вход Codex) общий с установкой: контакты демонстрации попадают
// во встроенный CRM с признаком учебных данных. Повторный запуск продолжает ту же демонстрацию.
// Режим «только запрос на запись»: в .frontsmith/demo-booking/business.json поставьте
// booking.autoConfirm = false и перезапустите.
import { execFileSync, fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repo, ".frontsmith", "demo-booking");
const env = { ...process.env, FRONTSMITH_BUSINESS_ROOT: root };
const node = (script, ...args) => execFileSync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, env, stdio: "inherit" });

if (!existsSync(path.join(root, "office.sqlite"))) {
  console.log(`Подготовка учебной компании: ${path.relative(repo, root)}`);
  if (!existsSync(path.join(root, "business.json"))) node("scripts/business-init.mjs", "--profile", "blueprints/generic-service/booking-demo.json");
  node("scripts/office.mjs", "init");
  node("scripts/office.mjs", "import");
}

console.log("Демонстрация записи через AI-чат: учебная компания, автоподтверждение разрешено в профиле");
const child = fork(path.join(repo, "scripts", "frontsmith.mjs"), [], { cwd: repo, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.send?.({ type: "shutdown" }));
child.on("exit", (code) => process.exit(code ?? 0));
