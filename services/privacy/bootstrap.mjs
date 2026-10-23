// Первичная подготовка Privacy Service без Docker и без системного Python.
//
//   npm run privacy:bootstrap
//   npm run privacy:bootstrap -- --data-root D:\Frontsmith   данные на другом диске (запоминается)
//
// 1. uv зафиксированной версии: скачивается с GitHub, SHA-256 сверяется с PINS.
// 2. Python PINS.python ставится uv в каталог runtime (не в систему, без прав администратора).
// 3. venv Privacy Service по requirements.lock (pii-guard, spaCy-модель, torch CPU).
// 4. Веса NER зафиксированной ревизии — в Hugging Face cache каталога runtime.
// 5. Проверка готовности: сервис запускается и отвечает /health ready.
// Повторный запуск пропускает готовые шаги.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PINS, SERVICE_DIR, dataRoot, rememberDataRoot, runtimeEnv, runtimePaths, startPrivacyService, uvAsset } from "./runtime.mjs";

const MIN_FREE_BYTES = 4 * 1024 ** 3;
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

const requested = flag("--data-root");
if (requested) {
  const root = path.resolve(requested);
  const repo = path.resolve(SERVICE_DIR, "..", "..");
  if (root.toLowerCase().startsWith(repo.toLowerCase())) fail("каталог данных не может находиться внутри репозитория");
  rememberDataRoot(root);
}
const paths = runtimePaths(dataRoot());
for (const dir of [paths.runtime, paths.cache, paths.tmp, paths.stateDir]) mkdirSync(dir, { recursive: true });
const env = runtimeEnv(paths);
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

// ── 0. место на диске ────────────────────────────────────────────
if (!existsSync(paths.python)) {
  const { bavail, bsize } = statfsSync(paths.runtime);
  const free = bavail * bsize;
  if (free < MIN_FREE_BYTES) {
    fail(
      `в ${paths.root} свободно ${(free / 1024 ** 3).toFixed(1)} ГБ, нужно не меньше 4 ГБ (torch, веса NER).\n` +
        "  Укажите каталог на другом диске: npm run privacy:bootstrap -- --data-root D:\\Frontsmith"
    );
  }
}

// ── 1. uv ────────────────────────────────────────────────────────
step(`uv ${PINS.uv.version}`);
if (output(paths.uv, ["--version"]).startsWith(`uv ${PINS.uv.version}`)) {
  console.log("  уже установлен");
} else {
  const asset = uvAsset();
  const response = await fetch(asset.url);
  if (!response.ok) fail(`не удалось скачать ${asset.url}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== asset.sha256) fail(`SHA-256 ${asset.file} не совпадает с зафиксированным`);
  const file = path.join(paths.tmp, asset.file);
  writeFileSync(file, archive);
  rmSync(paths.uvDir, { recursive: true, force: true });
  mkdirSync(paths.uvDir, { recursive: true });
  // tar есть в Windows 10+ и умеет zip; в архивах Linux/macOS бинарники лежат в подкаталоге.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-xf", file, "-C", paths.uvDir, ...(asset.file.endsWith(".tar.gz") ? ["--strip-components=1"] : [])]);
  rmSync(file, { force: true });
  console.log(`  ${output(paths.uv, ["--version"])}, SHA-256 проверен`);
}

// ── 2. Python ────────────────────────────────────────────────────
step(`Python ${PINS.python}`);
// --no-bin: без ярлыков python3.x в ~/.local/bin, PATH и профиль пользователя не меняются.
run(paths.uv, ["python", "install", "--no-bin", PINS.python]);

// ── 3. venv и зависимости ───────────────────────────────────────
step("venv Privacy Service");
const venvVersion = output(paths.python, ["-c", "import platform; print(platform.python_version())"]);
if (venvVersion !== PINS.python) {
  rmSync(paths.env, { recursive: true, force: true });
  run(paths.uv, ["venv", "--python", PINS.python, paths.env]);
}
run(paths.uv, [
  "pip", "sync", "--python", paths.python, "--torch-backend", "cpu",
  path.join(SERVICE_DIR, "requirements.lock")
]);

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
run(paths.python, [
  "-c",
  "import sys; from huggingface_hub import snapshot_download as d; print(d(sys.argv[1], revision=sys.argv[2]))",
  PINS.nerModel,
  PINS.nerRevision
]);

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
