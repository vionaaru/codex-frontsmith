// Первичная подготовка Privacy Service без Docker, без системного Python и без сети.
//
//   npm run privacy:bootstrap
//   npm run privacy:bootstrap -- --data-root E:\Frontsmith   данные на другом диске (запоминается)
//
// Все установочные артефакты — в vendor/ репозитория (Windows x64):
// 0. проверка поставки: SHA-256 по vendor/manifest.json, указатели Git LFS — понятная ошибка.
// 1. uv зафиксированной версии распаковывается из vendor/runtime-assets/uv.
// 2. Python PINS.python распаковывается из vendor/runtime-assets/python (не в систему, без реестра).
// 3. venv Privacy Service по requirements.lock: wheels из vendor/runtime-assets/wheels,
//    pii-guard собирается из vendor/pii-guard/source; uv работает с --offline --no-index.
// 4. Веса NER не скачиваются: сервис читает vendor/ner-model/ на месте.
// 5. Проверка готовности: сервис запускается и отвечает /health ready.
// Повторный запуск пропускает готовые шаги. Перехода к скачиванию из интернета нет.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PINS, SERVICE_DIR, VENDOR, dataRoot, rememberDataRoot, runtimeEnv, runtimePaths, startPrivacyService } from "./runtime.mjs";
import { assertBundledPlatform, assertComponents } from "../../scripts/lib/vendor.mjs";

// Распакованный Python ~0,1 ГБ, venv с torch ~1,5 ГБ, сборка и кэш uv — с запасом
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};

const step = (text) => console.log(`\n▸ ${text}`);
const fail = (text) => {
  console.error(`\n✗ ${text}`);
  process.exit(1);
};

try {
  assertBundledPlatform();
} catch (error) {
  fail(`${error.message}.\n  Поддерживаемая установка этого релиза — Windows x64`);
}

const requested = flag("--data-root");
if (requested) {
  const root = path.resolve(requested);
  const repo = path.resolve(SERVICE_DIR, "..", "..");
  if (root.toLowerCase().startsWith(repo.toLowerCase())) fail("каталог данных не может находиться внутри репозитория");
  rememberDataRoot(root);
}
const paths = runtimePaths(dataRoot());
for (const dir of [paths.runtime, paths.cache, paths.tmp, paths.stateDir]) mkdirSync(dir, { recursive: true });
const env = { ...runtimeEnv(paths), UV_PYTHON_DOWNLOADS: "never", UV_OFFLINE: "1" };
// Каталог состояния псевдонимизации: доступ только текущему пользователю (и SYSTEM на Windows).
if (process.platform === "win32") {
  const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`;
  spawnSync("icacls", [paths.stateDir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "ignore" });
} else {
  chmodSync(paths.stateDir, 0o700);
}
console.log(`Каталог данных Frontsmith: ${paths.root}`);

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { env, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${path.basename(command)} ${commandArgs.slice(0, 3).join(" ")} завершился с кодом ${result.status}`);
};
const output = (command, commandArgs) => {
  try {
    return execFileSync(command, commandArgs, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
// tar.exe есть в Windows 10+ и умеет zip и tar.gz
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

// ── 0. место на диске и поставка ─────────────────────────────────
if (!existsSync(paths.python)) {
  const { bavail, bsize } = statfsSync(paths.runtime);
  const free = bavail * bsize;
  if (free < MIN_FREE_BYTES) {
    fail(
      `в ${paths.root} свободно ${(free / 1024 ** 3).toFixed(1)} ГБ, нужно не меньше 3 ГБ (Python, torch, временные файлы).\n` +
        "  Укажите каталог на другом диске: npm run bootstrap -- --data-root E:\\Frontsmith"
    );
  }
}

step("проверка поставки Frontsmith (vendor/manifest.json)");
try {
  await assertComponents(["uv", "python", "wheelhouse", "pii-guard", "ner-model"]);
} catch (error) {
  fail(`${error.code}: ${error.message}`);
}
console.log("  uv, Python, wheels, pii-guard и модель NER на месте, SHA-256 совпадают");

// ── 1. uv ────────────────────────────────────────────────────────
step(`uv ${PINS.uv.version}`);
if (output(paths.uv, ["--version"]).startsWith(`uv ${PINS.uv.version}`)) {
  console.log("  уже установлен");
} else {
  rmSync(paths.uvDir, { recursive: true, force: true });
  mkdirSync(paths.uvDir, { recursive: true });
  run(tar, ["-xf", VENDOR.uv, "-C", paths.uvDir]);
  console.log(`  ${output(paths.uv, ["--version"])}, из vendor/runtime-assets/uv`);
}

// ── 2. Python ────────────────────────────────────────────────────
step(`Python ${PINS.python}`);
const pythonVersion = (python) => output(python, ["-c", "import platform; print(platform.python_version())"]);
const venvVersion = pythonVersion(paths.python);
if (venvVersion === PINS.python) {
  console.log("  venv уже на этой версии");
} else if (pythonVersion(paths.basePython) === PINS.python) {
  console.log("  уже распакован");
} else {
  const work = mkdtempSync(path.join(paths.tmp, "python-"));
  try {
    run(tar, ["-xzf", VENDOR.python, "-C", work]);
    rmSync(paths.basePythonDir, { recursive: true, force: true });
    mkdirSync(path.dirname(paths.basePythonDir), { recursive: true });
    renameSync(path.join(work, "python"), paths.basePythonDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (pythonVersion(paths.basePython) !== PINS.python) fail(`распакованный Python не отвечает версией ${PINS.python}`);
  console.log(`  распакован из vendor/runtime-assets/python в ${paths.basePythonDir}`);
}

// ── 3. venv и зависимости ───────────────────────────────────────
step("venv Privacy Service (wheels из поставки, без сети)");
if (venvVersion !== PINS.python) {
  rmSync(paths.env, { recursive: true, force: true });
  run(paths.uv, ["venv", "--python", paths.basePython, paths.env]);
}
// pii-guard собирается из копии vendor/pii-guard/source: сборка пишет egg-info и build/,
// репозиторий при этом не меняется
const build = mkdtempSync(path.join(paths.tmp, "pii-guard-"));
try {
  const source = path.join(build, "pii-guard");
  cpSync(VENDOR.piiGuard, source, { recursive: true });
  const lock = readFileSync(path.join(SERVICE_DIR, "requirements.lock"), "utf8");
  const local = lock.replace(/^pii-guard @ .*$/m, `pii-guard @ ${pathToFileURL(source).href}`);
  if (local === lock) fail("requirements.lock: нет строки pii-guard @ …");
  const requirements = path.join(build, "requirements.local.txt");
  writeFileSync(requirements, local);
  // --no-cache: распакованные wheels не остаются вторым экземпляром в кэше uv (~1,5 ГБ)
  run(paths.uv, ["pip", "sync", "--python", paths.python, "--offline", "--no-index", "--no-cache", "--find-links", VENDOR.wheels, requirements]);
} finally {
  rmSync(build, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

// DLL MSVC runtime из пакета msvc-runtime: принимаются только подписанные Microsoft.
if (process.platform === "win32") {
  const check = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-ChildItem -LiteralPath $env:FS_VENV -Filter *.dll | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_.FullName; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { $_.Name } }"
  ], { env: { ...process.env, FS_VENV: paths.env }, encoding: "utf8" });
  const unsigned = check.stdout.trim();
  if (check.status !== 0 || unsigned) fail(`DLL в ${paths.env} без действительной подписи Microsoft: ${unsigned || check.stderr.trim()}`);
  console.log("  MSVC runtime: подпись Microsoft проверена");
}

// ── 4. веса NER ─────────────────────────────────────────────────
step(`NER ${PINS.nerModel}@${PINS.nerRevision.slice(0, 7)}`);
console.log(`  из поставки: ${path.relative(path.resolve(SERVICE_DIR, "..", ".."), VENDOR.nerModel)} (Hugging Face не используется)`);

// ── 5. проверка готовности ──────────────────────────────────────
step("проверка готовности pii-guard + NER");
const marker = {
  python: PINS.python,
  uv: PINS.uv.version,
  piiGuardCommit: PINS.piiGuardCommit,
  piiGuardVersion: PINS.piiGuardVersion,
  nerModel: PINS.nerModel,
  nerRevision: PINS.nerRevision,
  spacyModel: PINS.spacyModel,
  assets: "vendor",
  lockSha256: createHash("sha256").update(readFileSync(path.join(SERVICE_DIR, "requirements.lock"))).digest("hex"),
  preparedAt: new Date().toISOString()
};
writeFileSync(paths.marker, `${JSON.stringify(marker, null, 2)}\n`);
const probeDir = mkdtempSync(path.join(paths.tmp, "bootstrap-"));
const probeDb = path.join(probeDir, "probe.sqlite");
try {
  const service = await startPrivacyService({ port: 4319, dbPath: probeDb, paths });
  const health = service.health;
  await service.stop();
  console.log(`  pii-guard ${health.pii_guard_version} (${health.pii_guard_commit.slice(0, 7)}), NER=${health.ner_enabled}, типы: ${health.available_entity_types.join(",")}`);
} catch (error) {
  rmSync(paths.marker, { force: true });
  fail(`Privacy Service не прошёл проверку: ${error.reason ?? error.message}`);
} finally {
  rmSync(probeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(`\n✓ Privacy runtime готов: ${paths.runtime}\n  Состояние сессий: ${paths.stateDb}`);
