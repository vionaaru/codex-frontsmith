// Локальная проверка комплектности поставки перед публикацией репозитория.
// Ничего не устанавливает, не скачивает и не меняет: только читает рабочую копию и индекс Git.
//
//   npm run release:check
//
//  1. обязательные файлы             5. Bootstrap без незакреплённых внешних источников
//  2. vendor/manifest.json ↔ пины    6. лицензии и атрибуция
//  3. SHA-256 и настоящие объекты    7. запрещённые файлы, секреты и локальные пути в индексе
//     Git LFS, отпечатки исходников  8. файлы поставки отслеживаются Git и попадают в LFS
//  4. wheelhouse покрывает requirements.lock для Windows x64 / Python 3.11
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CRMKIT } from "../services/crm/runtime.mjs";
import { PINS, PYTHON_DIST, UV_DIST } from "../services/privacy/runtime.mjs";
import { describeProblem, projectRoot, readManifest, vendorPath, verifyComponent } from "./lib/vendor.mjs";

const results = [];
const pass = (area, text) => results.push({ level: "pass", area, text });
const fail = (area, text) => results.push({ level: "fail", area, text });
const warn = (area, text) => results.push({ level: "warn", area, text });
const git = (...args) => spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const exists = (relative) => existsSync(path.join(projectRoot, relative));

// ── 1. обязательные файлы ──────────────────────────────────────────
const REQUIRED = [
  "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", ".gitattributes", ".gitignore", "package.json", "package-lock.json",
  "vendor/README.md", "vendor/manifest.json", "docs/testing/external-first-run.md",
  "services/privacy/requirements.in", "services/privacy/requirements.lock",
  "scripts/bootstrap.mjs", "services/privacy/bootstrap.mjs", "services/crm/bootstrap.mjs"
];
const missing = REQUIRED.filter((file) => !exists(file));
missing.length ? fail("files", `нет обязательных файлов: ${missing.join(", ")}`) : pass("files", `обязательные файлы на месте (${REQUIRED.length})`);

// ── 2. manifest ↔ зафиксированные версии ───────────────────────────
let manifest = null;
try {
  manifest = readManifest();
} catch (error) {
  fail("manifest", error.message);
}
if (manifest) {
  const byId = Object.fromEntries(manifest.components.map((item) => [item.id, item]));
  const expect = (condition, text) => (condition ? null : text);
  const fileSha = (id, name) => byId[id]?.files?.find((file) => file.path.endsWith(name))?.sha256;
  const mismatches = [
    expect(manifest.schema === 1, "schema ≠ 1"),
    expect(manifest.platform === "win32-x64", `platform ${manifest.platform}`),
    ...["crmkit-source", "crmkit-binary", "pii-guard", "ner-model", "uv", "python", "wheelhouse"].map((id) => expect(byId[id], `нет компонента ${id}`)),
    expect(byId["crmkit-source"]?.source?.commit === CRMKIT.commit, "crmkit: commit ≠ CRMKIT.commit"),
    expect(byId["crmkit-binary"]?.version === CRMKIT.version, "crmkit: версия ≠ CRMKIT.version"),
    expect(fileSha("crmkit-binary", `crmkit-${CRMKIT.tag}-windows-amd64.tar.gz`) === CRMKIT.sha256["win32-x64"], "crmkit: SHA-256 архива ≠ CRMKIT.sha256"),
    expect(byId["pii-guard"]?.source?.commit === PINS.piiGuardCommit, "pii-guard: commit ≠ PINS.piiGuardCommit"),
    expect(byId["pii-guard"]?.version === PINS.piiGuardVersion, "pii-guard: версия ≠ PINS.piiGuardVersion"),
    expect(byId["ner-model"]?.source?.revision === PINS.nerRevision, "NER: ревизия ≠ PINS.nerRevision"),
    expect(byId["ner-model"]?.files?.some((file) => file.path.endsWith("model.safetensors") && file.lfs), "NER: нет весов model.safetensors в LFS"),
    ...["config.json", "tokenizer.json", "tokenizer_config.json"].map((name) => expect(byId["ner-model"]?.files?.some((file) => file.path.endsWith(name)), `NER: нет ${name}`)),
    expect(fileSha("uv", UV_DIST.file) === UV_DIST.sha256, "uv: SHA-256 ≠ PINS.uv"),
    expect(fileSha("python", PYTHON_DIST.file) === PYTHON_DIST.sha256, "Python: SHA-256 ≠ PYTHON_DIST")
  ].filter(Boolean);
  mismatches.length ? fail("manifest", mismatches.join("; ")) : pass("manifest", "vendor/manifest.json совпадает с зафиксированными версиями и SHA-256 в коде");

  // ── 3. SHA-256, объекты LFS, отпечатки исходников ──────────────
  const problems = [];
  for (const item of manifest.components) problems.push(...(await verifyComponent(item)));
  const lfsFiles = manifest.components.flatMap((item) => item.files ?? []).filter((file) => file.lfs);
  const lfsBytes = lfsFiles.reduce((sum, file) => sum + file.size, 0);
  if (problems.length) fail("integrity", problems.map(describeProblem).join("\n    "));
  else pass("integrity", `SHA-256 всех файлов поставки совпадают; ${lfsFiles.length} объектов LFS настоящие (${(lfsBytes / 1024 ** 2).toFixed(0)} МБ); отпечатки исходников crmkit и pii-guard совпадают`);

  // ── 4. wheelhouse ↔ requirements.lock ────────────────────────────
  const wheels = new Map(byId.wheelhouse.files.map((file) => [normalize(file.name), file.version]));
  const lock = readFileSync(path.join(projectRoot, "services", "privacy", "requirements.lock"), "utf8");
  const uncovered = [];
  const remote = [];
  let required = 0;
  for (const line of lock.split(/\r?\n/)) {
    if (!line || line.startsWith(" ") || line.startsWith("#")) continue;
    const [spec, marker] = line.split(" ; ");
    if (marker && !markerMatches(marker)) continue;
    if (/@\s*https?:/.test(spec)) remote.push(spec);
    const pinned = spec.match(/^([A-Za-z0-9._-]+)==(\S+)$/);
    if (!pinned) continue;
    required += 1;
    if (wheels.get(normalize(pinned[1])) !== pinned[2]) uncovered.push(`${pinned[1]}==${pinned[2]}`);
  }
  if (!/^pii-guard @ \.\.\/\.\.\/vendor\/pii-guard\/source$/m.test(lock)) fail("wheelhouse", "requirements.lock: pii-guard не из vendor/pii-guard/source");
  if (remote.length) fail("wheelhouse", `requirements.lock ссылается на внешние архивы: ${remote.join(", ")}`);
  uncovered.length ? fail("wheelhouse", `нет wheel для: ${uncovered.join(", ")}`) : pass("wheelhouse", `${required} закреплённых пакетов requirements.lock для Windows x64 / Python 3.11 есть в wheelhouse; pii-guard — из vendor/`);
  for (const build of ["setuptools", "wheel"]) if (!wheels.has(build)) fail("wheelhouse", `нет ${build}: сборка pii-guard из исходников без сети невозможна`);

  // ── 6. лицензии ─────────────────────────────────────────────────
  const noLicense = manifest.components.filter((item) => !item.license).map((item) => item.id);
  const missingLicenseFiles = manifest.components.flatMap((item) => item.licenseFiles ?? []).filter((file) => !existsSync(vendorPath(file)));
  const unknownWheels = byId.wheelhouse.files.filter((file) => !file.license || file.license === "UNKNOWN").map((file) => file.name);
  const notices = exists("THIRD_PARTY_NOTICES.md") ? readFileSync(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8") : "";
  const unattributed = manifest.components.filter((item) => item.kind !== "wheels" && !notices.includes(item.name)).map((item) => item.name);
  const licenseProblems = [
    noLicense.length ? `без лицензии: ${noLicense.join(", ")}` : null,
    missingLicenseFiles.length ? `нет файлов лицензий: ${missingLicenseFiles.join(", ")}` : null,
    unknownWheels.length ? `wheels без лицензии: ${unknownWheels.join(", ")}` : null,
    unattributed.length ? `нет в THIRD_PARTY_NOTICES.md: ${unattributed.join(", ")}` : null
  ].filter(Boolean);
  licenseProblems.length ? fail("licenses", licenseProblems.join("; ")) : pass("licenses", "лицензии всех компонентов и wheels указаны, LICENSE/NOTICE исходных авторов на месте, атрибуция в THIRD_PARTY_NOTICES.md");
  const proprietary = byId.wheelhouse.files.filter((file) => /proprietary/i.test(file.license)).map((file) => `${file.name} ${file.version}`);
  if (proprietary.length) warn("licenses", `несвободная лицензия, нужно решение владельца перед публикацией: ${proprietary.join(", ")} (THIRD_PARTY_NOTICES.md)`);

  // ── 8. файлы поставки в Git и LFS ───────────────────────────────
  const tracked = new Set(git("ls-files", "-z").stdout.split("\0").filter(Boolean));
  const manifestFiles = manifest.components.flatMap((item) => item.files ?? []);
  const untracked = manifestFiles.filter((file) => !tracked.has(file.path)).map((file) => file.path);
  const treeUntracked = manifest.components.filter((item) => item.tree && ![...tracked].some((file) => file.startsWith(`${item.path}/`))).map((item) => item.path);
  untracked.length || treeUntracked.length
    ? fail("git", `не добавлены в Git: ${[...treeUntracked, ...untracked.slice(0, 5)].join(", ")}${untracked.length > 5 ? ` и ещё ${untracked.length - 5}` : ""}`)
    : pass("git", `все ${manifestFiles.length} файлов поставки и деревья исходников отслеживаются Git`);
  const attrs = git("check-attr", "filter", "--", ...lfsFiles.map((file) => file.path)).stdout.split(/\r?\n/).filter(Boolean);
  const notLfs = attrs.filter((line) => !line.endsWith(": filter: lfs")).map((line) => line.split(": filter:")[0]);
  notLfs.length ? fail("lfs", `не попадают в Git LFS по .gitattributes: ${notLfs.join(", ")}`) : pass("lfs", ".gitattributes направляет все большие файлы поставки в Git LFS");
  const lfsTracked = new Set(git("lfs", "ls-files", "--name-only").stdout.split(/\r?\n/).filter(Boolean));
  const notInLfs = lfsFiles.filter((file) => tracked.has(file.path) && !lfsTracked.has(file.path)).map((file) => file.path);
  if (notInLfs.length) fail("lfs", `в индексе как обычные объекты Git, не LFS: ${notInLfs.slice(0, 5).join(", ")}`);
  if (git("lfs", "version").status !== 0) fail("lfs", "Git LFS не установлен");
}

// ── 5. Bootstrap без незакреплённых внешних источников ─────────────
const BOOTSTRAP_FILES = ["scripts/bootstrap.mjs", "services/privacy/bootstrap.mjs", "services/privacy/runtime.mjs", "services/crm/bootstrap.mjs", "services/crm/runtime.mjs"];
const FORBIDDEN = [
  [/\bfetch\(\s*(asset|url|`https?:)/, "скачивание через fetch"],
  [/snapshot_download|hf_hub_download/, "скачивание модели с Hugging Face"],
  [/\bgit\b["',\s]+clone|"clone"/, "git clone"],
  [/"python",\s*"install"/, "uv python install (скачивание Python)"],
  [/--torch-backend/, "индекс PyTorch"],
  [/"pip",\s*"(sync|install)"(?![^\n]*"--offline")/, "uv pip без --offline"]
];
const offending = [];
for (const file of BOOTSTRAP_FILES) {
  const text = readFileSync(path.join(projectRoot, file), "utf8");
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(text)) offending.push(`${file}: ${label}`);
}
offending.length ? fail("bootstrap", offending.join("; ")) : pass("bootstrap", "Bootstrap берёт crmkit, Python, wheels, pii-guard и NER только из vendor/: внешних загрузок нет");

// ── 7. запрещённые файлы, секреты и локальные пути ────────────────
const indexFiles = git("ls-files", "-z").stdout.split("\0").filter(Boolean);
const FORBIDDEN_FILES = [
  [/^\.frontsmith\//, "рабочие данные бизнеса"],
  [/\.(sqlite3?|db)(-wal|-shm|-journal)?$/i, "база данных"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "файл окружения"],
  [/(^|\/)(credential|credentials|auth)\.json$/i, "учётные данные"],
  [/(^|\/)crmkit\.yaml$/, "конфигурация crmkit с secret_key"],
  [/(^|\/)codex-host\/(home|runtime)\//, "CODEX_HOME или журналы Codex Host"],
  [/(^|\/)(privacy-models|privacy-env)\//, "распакованный runtime"],
  [/(^|\/)backups?\//i, "резервные копии"],
  [/\.(pem|key|p12|pfx)$/i, "ключи"],
  [/^node_modules\//, "node_modules"],
  [/(^|\/)(sessions|history)\.jsonl$/i, "история диалогов"]
];
const badFiles = indexFiles.flatMap((file) => FORBIDDEN_FILES.filter(([pattern]) => pattern.test(file)).map(([, label]) => `${file} (${label})`));
// Исключение: каталоги исходников сторонних проектов с их собственными тестовыми данными
const vendorSafe = badFiles.filter((entry) => !entry.startsWith("vendor/"));
vendorSafe.length ? fail("index", `запрещённые файлы в индексе Git: ${vendorSafe.join(", ")}`) : pass("index", "в индексе нет рабочих баз, резервных копий, учётных данных, runtime и истории диалогов");

const SECRET = /(sk-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{20,})/;
// Пути компьютера разработки: код и данные этой установки. Примеры E:\Frontsmith в подсказках — не они
const LOCAL_PATH = /\bD:[\\/]+(Frontsmith|codex_project)\b/i;
const RUNTIME_DIRS = /^(scripts|services|office|api|packages|blueprints|workflows)\//;
const secrets = [];
const localPaths = [];
for (const file of indexFiles) {
  if (file.startsWith("vendor/") || !existsSync(path.join(projectRoot, file))) continue;
  const full = path.join(projectRoot, file);
  if (statSync(full).size > 2 * 1024 * 1024) continue;
  const text = readFileSync(full, "utf8");
  if (SECRET.test(text)) secrets.push(file);
  // Примеры в комментариях и подсказках «--data-root E:\Frontsmith» — не пути выполнения
  const runtimeLines = text.split(/\r?\n/).filter((line) => LOCAL_PATH.test(line) && !/^\s*(\/\/|#|\*)/.test(line) && !line.includes("--data-root"));
  if (RUNTIME_DIRS.test(file) && /\.(mjs|js|py|json|toml)$/.test(file) && file !== "scripts/release-check.mjs" && runtimeLines.length) localPaths.push(file);
}
secrets.length ? fail("secrets", `похоже на секреты: ${secrets.join(", ")}`) : pass("secrets", "в отслеживаемых файлах нет токенов и приватных ключей");
localPaths.length ? fail("paths", `абсолютные локальные пути в runtime-коде: ${localPaths.join(", ")}`) : pass("paths", "в runtime-коде нет абсолютных путей D:\\Frontsmith и D:\\codex_project");

// Большие файлы вне LFS превышают лимиты GitHub (предупреждение 50 МБ, отказ 100 МБ)
const lfsAll = new Set(git("lfs", "ls-files", "--name-only").stdout.split(/\r?\n/).filter(Boolean));
const large = indexFiles.filter((file) => !lfsAll.has(file) && existsSync(path.join(projectRoot, file)) && statSync(path.join(projectRoot, file)).size > 50 * 1024 * 1024);
large.length ? fail("size", `файлы больше 50 МБ вне Git LFS: ${large.join(", ")}`) : pass("size", "файлов больше 50 МБ вне Git LFS нет");

// ── итог ──────────────────────────────────────────────────────────
const mark = { pass: "✓", warn: "!", fail: "✗" };
for (const result of results) console.log(`${mark[result.level]} [${result.area}] ${result.text}`);
const failed = results.filter((result) => result.level === "fail").length;
const warned = results.filter((result) => result.level === "warn").length;
console.log(`\nrelease:check — ${failed ? "FAIL" : "PASS"}: ошибок ${failed}, предупреждений ${warned}`);
console.log("Проверена комплектность рабочей копии. Установка из чистого клона этой командой не проверяется");
process.exitCode = failed ? 1 : 0;

function normalize(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, "-");
}

// Маркеры PEP 508 из requirements.lock для поддерживаемой установки: Windows x64, CPython 3.11
function markerMatches(marker) {
  const env = { sys_platform: "win32", platform_machine: "AMD64", platform_python_implementation: "CPython", implementation_name: "cpython", python_full_version: PINS.python, python_version: "3.11" };
  const compareVersion = (a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
    return 0;
  };
  const atom = (text) => {
    const match = text.trim().match(/^(\w+)\s*(==|!=|>=|<=|<|>)\s*'([^']*)'$/);
    if (!match) throw new Error(`маркер не разобран: ${text}`);
    const [, key, op, value] = match;
    const actual = env[key];
    if (key.includes("version")) {
      const diff = compareVersion(actual, value);
      return { "==": diff === 0, "!=": diff !== 0, ">=": diff >= 0, "<=": diff <= 0, "<": diff < 0, ">": diff > 0 }[op];
    }
    return op === "==" ? actual === value : op === "!=" ? actual !== value : false;
  };
  return marker.split(/\s+or\s+/).some((group) => group.split(/\s+and\s+/).every(atom));
}
