// Безопасный диагностический отчёт для сообщения об ошибке установки или запуска.
//
//   npm run diagnostics
//
// Печатает версии, состояние компонентов и количества. Не печатает и не читает контакты
// клиентов, токены CRM и Privacy Service, вход ChatGPT, содержимое псевдонимизации и
// бизнес-записи. Путь профиля пользователя заменяется на %USERPROFILE%. Ничего не меняет.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAuthStatus } from "../services/codex-host/ai-runtime.mjs";
import { crmPaths } from "../services/crm/runtime.mjs";
import { DATA_ROOT_POINTER, PINS, nerModelStatus, runtimePaths } from "../services/privacy/runtime.mjs";
import { inspectInstallation, projectRoot } from "./lib/installation.mjs";
import { BUNDLED_PLATFORM, isLfsPointer, readManifest, vendorPath } from "./lib/vendor.mjs";

const home = os.homedir();
const mask = (value) => String(value ?? "").split(home).join("%USERPROFILE%");
const out = (label, value) => console.log(`${label.padEnd(22)} ${mask(value)}`);
const version = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "не найден";
};
const safe = (fn) => {
  try {
    return fn();
  } catch (error) {
    return `ошибка: ${error.code ?? error.message}`;
  }
};

console.log("=== Frontsmith diagnostics (без персональных данных и токенов) ===\n");
out("Платформа", `${process.platform}-${process.arch} (${os.release()}); поставка для ${BUNDLED_PLATFORM}`);
out("Node.js", process.version);
// При запуске через npm run версия npm — из npm_config_user_agent, без вызова оболочки
out("npm", process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ?? "запустите через npm run diagnostics");
out("Git", version("git", ["--version"]));
out("Git LFS", version("git", ["lfs", "version"]));
out("Frontsmith commit", safe(() => spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim() || "нет Git"));
const dirty = safe(() => spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim().split(/\r?\n/).filter(Boolean).length);
out("Изменённых файлов", dirty);

console.log("\n-- Поставка vendor/");
out("Git LFS объекты", safe(() => {
  const files = readManifest().components.flatMap((item) => item.files ?? []).filter((file) => file.lfs);
  const missing = files.filter((file) => !existsSync(vendorPath(file.path))).length;
  const pointers = files.filter((file) => existsSync(vendorPath(file.path)) && isLfsPointer(vendorPath(file.path))).length;
  return `${files.length - missing - pointers} из ${files.length} настоящие; указателей ${pointers}; отсутствует ${missing}`;
}));
out("Модель NER", safe(() => nerModelStatus().ready ? "на месте" : nerModelStatus().reason));

console.log("\n-- Каталог данных");
const install = safe(() => inspectInstallation());
out("Каталог данных", install.dataRoot ?? install);
out("Выбор сохранён", existsSync(DATA_ROOT_POINTER) ? "да" : "нет (по умолчанию)");
out("Свободно", safe(() => {
  const { bavail, bsize } = statfsSync(existsSync(install.dataRoot) ? install.dataRoot : path.parse(install.dataRoot).root);
  return `${((bavail * bsize) / 1024 ** 3).toFixed(1)} ГБ`;
}));
out("Privacy runtime", install.privacy ? (install.privacy.ready ? `готов (Python ${PINS.python}, pii-guard ${PINS.piiGuardCommit.slice(0, 7)})` : install.privacy.reason) : "—");
out("crmkit", install.crm ? (install.crm.ready ? `готов (${install.crm.marker?.version})` : install.crm.reason) : "—");
out("Маркер runtime", safe(() => {
  const marker = runtimePaths().marker;
  return existsSync(marker) ? `assets=${JSON.parse(readFileSync(marker, "utf8")).assets ?? "download (прежняя установка)"}` : "нет";
}));
out("Хранилище CRM", safe(() => (existsSync(crmPaths().db) ? "есть" : "нет")));

console.log("\n-- Офис");
const business = install.business ?? {};
out("Профиль бизнеса", install.profile ? safe(() => JSON.parse(readFileSync(path.join(install.businessRoot, "business.json"), "utf8")).blueprint ?? "без поля blueprint") : "нет");
out("Офисная база", business.exists ? `${business.kind}, схема ${business.schema}/${business.latest}` : "нет (новая установка)");
out("Клиентов (client_id)", business.exists ? `${business.customers ?? 0}; связей CRM ${business.links ?? 0}; прежних контактов ${business.legacyContacts ?? 0}` : "—");

console.log("\n-- Codex");
const codex = safe(() => codexAuthStatus());
out("Codex CLI", typeof codex === "string" ? codex : codex.state === "cli_missing" ? "не найден" : codex.version);
out("Вход ChatGPT", typeof codex === "string" ? "—" : { ready: "есть", login_required: "нужен: npm run codex-host:login", cli_missing: "—" }[codex.state] ?? codex.state);

console.log("\nСкопируйте этот вывод целиком в сообщение об ошибке вместе с текстом ошибки команды.");
