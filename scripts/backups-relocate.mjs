// Перенос старых копий из рабочей области Codex в каталог данных Frontsmith.
//
//   npm run backups:relocate              план: что лежит в <каталог бизнеса>/backups и куда будет скопировано
//   npm run backups:relocate -- --confirm копирование с проверкой SHA-256 каждого файла
//
// Содержимое копий не читается и не выводится: только имена, тип по заголовку файла, размер и SHA-256.
// SQLite копируется вместе с -wal и -shm байт в байт, без открытия базы (открытие могло бы выполнить
// checkpoint и изменить файлы). Исходные файлы не меняются и не удаляются: удаление из рабочей
// области — отдельное решение владельца после проверки копии.
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { protectDir } from "../services/crm/runtime.mjs";
import { dataRoot } from "../services/privacy/runtime.mjs";
import { assertDataRootOutsideRepo } from "./lib/installation.mjs";
import { businessPath } from "./lib/paths.mjs";

const confirm = process.argv.includes("--confirm");
const source = path.resolve(businessPath("backups"));
const target = path.join(assertDataRootOutsideRepo(dataRoot()), "backups", "workspace-legacy");

if (!existsSync(source)) {
  console.log(`Старых копий нет: ${source} не существует`);
  process.exit(0);
}

const units = collectUnits(source);
console.log(`Копии в рабочей области: ${source}`);
console.log(`Назначение вне рабочей области: ${target}\n`);
if (!units.length) console.log("Каталог пуст");
for (const unit of units) {
  console.log(`- ${unit.name}: ${unit.kind}; файлов ${unit.files.length}, ${formatSize(unit.bytes)}; ${unit.risk}`);
}

if (!confirm) {
  console.log("\nЭто план, ничего не скопировано. Копирование с проверкой SHA-256: npm run backups:relocate -- --confirm");
  console.log("Исходные файлы не удаляются ни в одном режиме");
  process.exit(0);
}

protectDir(target);
const manifest = { createdAt: new Date().toISOString(), source, target, units: [] };
for (const unit of units) {
  const files = [];
  for (const relative of unit.files) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    const hash = sha256(from);
    if (existsSync(to)) {
      if (sha256(to) !== hash) throw new Error(`${to} уже существует и отличается от исходного файла: проверьте вручную, ничего не перезаписано`);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      if (sha256(to) !== hash) throw new Error(`SHA-256 копии ${to} не совпадает с исходным файлом`);
    }
    files.push({ path: relative.split(path.sep).join("/"), bytes: statSync(from).size, sha256: hash });
  }
  manifest.units.push({ name: unit.name, kind: unit.kind, risk: unit.risk, files });
  console.log(`✓ ${unit.name}: ${files.length} файлов скопировано, SHA-256 совпадает`);
}
const manifestFile = path.join(target, `manifest-${manifest.createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nМанифест (имена, размеры, SHA-256 без содержимого): ${manifestFile}`);
console.log(`Исходные файлы в ${source} не изменены и не удалены. После проверки копии владелец решает, удалять ли их`);

// Единица переноса: SQLite с -wal/-shm, каталог целиком или отдельный файл
function collectUnits(dir) {
  const names = readdirSync(dir).sort();
  const companions = new Set(names.filter((name) => /-(wal|shm|journal)$/.test(name) && names.includes(name.replace(/-(wal|shm|journal)$/, ""))));
  return names.filter((name) => !companions.has(name)).map((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const files = walk(full).map((file) => path.relative(dir, file));
      const base = files.map((file) => path.basename(file));
      const hasDb = base.some((file) => /\.(sqlite|sqlite3|db)$/.test(file));
      const hasProfile = base.includes("business.json");
      const kind = hasDb || hasProfile ? `каталог: ${[hasProfile && "профиль business.json", hasDb && "база SQLite"].filter(Boolean).join(", ")}` : base.includes("index.html") ? "каталог сайта" : "каталог";
      return unit(name, kind, files, hasDb ? "возможны ПД клиентов: требуется решение владельца" : hasProfile ? "контакты компании, возможны ПД в заметках" : "контакты компании на страницах сайта");
    }
    const group = [name, ...["-wal", "-shm", "-journal"].map((suffix) => `${name}${suffix}`).filter((file) => companions.has(file))];
    const sqlite = isSqlite(full);
    const kind = sqlite ? `SQLite${group.length > 1 ? ` + ${group.slice(1).map((file) => file.slice(name.length + 1)).join(", ")}` : ""}` : "файл";
    return unit(name, kind, group, sqlite ? "возможны ПД клиентов (контакты до схемы 004, свободные тексты): требуется решение владельца" : "тип не определён: требуется решение владельца");
  });
}

function unit(name, kind, files, risk) {
  return { name, kind, files, risk, bytes: files.reduce((sum, file) => sum + statSync(path.join(source, file)).size, 0) };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function isSqlite(file) {
  const header = Buffer.alloc(16);
  const fd = openSync(file, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return header.toString("latin1") === "SQLite format 3\0";
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
}
