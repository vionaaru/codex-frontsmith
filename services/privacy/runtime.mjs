// Управляемый runtime Privacy Service: локальный uv → локальный Python → venv с
// pii-guard. Установочные артефакты (uv, Python, wheels, исходники pii-guard, модель
// NER) поставляются в vendor/ репозитория; распакованный runtime лежит в каталоге
// данных Frontsmith вне Git, вне `.frontsmith/business/` и вне рабочей области Codex.
// Docker не используется.
//
//   <data>/runtime/uv/            uv зафиксированной версии
//   <data>/runtime/python/        Python из vendor/runtime-assets/python
//   <data>/runtime/privacy-env/   venv Privacy Service
//   <data>/privacy/privacy.sqlite состояние псевдонимизации
//   vendor/ner-model/…            веса NER: сервис читает их на месте, без Hugging Face
//
// <data> выбирается при первом `npm run bootstrap` (по умолчанию `%LOCALAPPDATA%\Frontsmith`)
// и запоминается в `%LOCALAPPDATA%\Frontsmith\data-root.txt`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PINS = {
  uv: {
    version: "0.12.24",
    sha256: {
      "win32-x64": "7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019",
      "win32-arm64": "4b783bda5cc44bbae0651a837223873a7acee31152381aef5fc86ef6bef25997",
      "linux-x64": "b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6",
      "linux-arm64": "5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21",
      "darwin-x64": "4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6",
      "darwin-arm64": "0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732"
    }
  },
  python: "3.11.14",
  piiGuardCommit: "24230abb72949a9f85499244dd4f15a0ad0cdd9e",
  piiGuardVersion: "0.1.0",
  nerModel: "redmadrobot-rnd/rubert-base-pii-ner",
  nerRevision: "c802e8cd26f85d1cf920973ea6f83965a0618d63",
  spacyModel: "ru_core_news_sm"
};

// Артефакты в поставке (только Windows x64). Источник указан для аудита: Bootstrap
// по этим адресам не обращается
export const UV_DIST = {
  file: "uv-x86_64-pc-windows-msvc.zip",
  sha256: PINS.uv.sha256["win32-x64"]
};

export const PYTHON_DIST = {
  build: "20260211",
  file: `cpython-${PINS.python}+20260211-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
  url: `https://github.com/astral-sh/python-build-standalone/releases/download/20260211/cpython-${PINS.python}%2B20260211-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
  // Совпадает с SHA256SUMS релиза python-build-standalone 20260211
  sha256: "db4a7b6389961f194ef5c1cb21a46c023dbc13703ac51f7bd7eaa1088740ca72"
};

const REPO_ROOT = path.resolve(SERVICE_DIR, "..", "..");
export const VENDOR = {
  uv: path.join(REPO_ROOT, "vendor", "runtime-assets", "uv", UV_DIST.file),
  python: path.join(REPO_ROOT, "vendor", "runtime-assets", "python", PYTHON_DIST.file),
  wheels: path.join(REPO_ROOT, "vendor", "runtime-assets", "wheels"),
  piiGuard: path.join(REPO_ROOT, "vendor", "pii-guard", "source"),
  // Модель NER читается прямо из поставки: каталог и есть зафиксированная версия
  nerModel: path.join(REPO_ROOT, "vendor", "ner-model", "rubert-base-pii-ner")
};

function localAppData() {
  return process.platform === "win32" ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share");
}

// Указатель на выбранный каталог данных. Сам указатель маленький и всегда в
// `%LOCALAPPDATA%\Frontsmith`, даже если данные лежат на другом диске.
export const DATA_ROOT_POINTER = path.join(localAppData(), "Frontsmith", "data-root.txt");

// Запомнить выбранный каталог данных (--data-root первичной подготовки)
export function rememberDataRoot(root) {
  mkdirSync(path.dirname(DATA_ROOT_POINTER), { recursive: true });
  writeFileSync(DATA_ROOT_POINTER, `${path.resolve(root)}\n`);
}

// Каталог данных по умолчанию, если пользователь не выбрал другой
export function defaultDataRoot() {
  return path.join(localAppData(), "Frontsmith");
}

export function dataRoot() {
  if (process.env.FRONTSMITH_DATA_ROOT) return path.resolve(process.env.FRONTSMITH_DATA_ROOT);
  if (existsSync(DATA_ROOT_POINTER)) {
    const saved = readFileSync(DATA_ROOT_POINTER, "utf8").trim();
    if (saved) return path.resolve(saved);
  }
  return defaultDataRoot();
}

export function runtimePaths(root = dataRoot()) {
  const runtime = path.join(root, "runtime");
  const env = path.join(runtime, "privacy-env");
  const exe = process.platform === "win32";
  return {
    root,
    runtime,
    uvDir: path.join(runtime, "uv"),
    uv: path.join(runtime, "uv", exe ? "uv.exe" : "uv"),
    pythonDir: path.join(runtime, "python"),
    // Интерпретатор из поставки: распаковывается сюда, в систему и реестр не ставится
    basePythonDir: path.join(runtime, "python", `cpython-${PINS.python}-bundled`),
    basePython: exe ? path.join(runtime, "python", `cpython-${PINS.python}-bundled`, "python.exe") : path.join(runtime, "python", `cpython-${PINS.python}-bundled`, "bin", "python3"),
    env,
    python: exe ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python"),
    models: path.join(runtime, "privacy-models"),
    cache: path.join(runtime, "cache"),
    tmp: path.join(runtime, "tmp"),
    marker: path.join(runtime, "privacy-runtime.json"),
    stateDir: path.join(root, "privacy"),
    stateDb: path.join(root, "privacy", "privacy.sqlite"),
    logs: path.join(root, "privacy", "logs")
  };
}

// Окружение uv и Python: кэши и временные файлы — в каталоге runtime, не в профиле
// пользователя и не на системном диске, если данные вынесены на другой.
export function runtimeEnv(paths, extra = {}) {
  return {
    ...process.env,
    UV_CACHE_DIR: paths.cache,
    UV_PYTHON_INSTALL_DIR: paths.pythonDir,
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PYTHON_BIN_DIR: path.join(paths.runtime, "bin"),
    UV_NO_CONFIG: "1",
    UV_LINK_MODE: "copy",
    HF_HOME: paths.models,
    HF_HUB_DISABLE_TELEMETRY: "1",
    TMP: paths.tmp,
    TEMP: paths.tmp,
    TMPDIR: paths.tmp,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    ...extra
  };
}

// Веса NER в поставке: настоящий файл, а не указатель Git LFS (быстрая проверка без SHA-256;
// полная сверка — при установке и в npm run release:check)
export function nerModelStatus(dir = VENDOR.nerModel) {
  const weights = path.join(dir, "model.safetensors");
  if (!existsSync(weights)) return { ready: false, reason: "ner_model_missing" };
  if (statSync(weights).size < 1024 && readFileSync(weights, "utf8").startsWith("version https://git-lfs")) return { ready: false, reason: "ner_model_lfs_pointer" };
  return { ready: true };
}

// Подготовленный runtime: маркер bootstrap совпадает с зафиксированными версиями.
export function runtimeStatus(paths = runtimePaths()) {
  if (!existsSync(paths.python)) return { ready: false, reason: "privacy_runtime_missing", paths };
  const ner = nerModelStatus();
  if (!ner.ready) return { ready: false, reason: ner.reason, paths };
  if (!existsSync(paths.marker)) return { ready: false, reason: "privacy_runtime_incomplete", paths };
  let marker;
  try {
    marker = JSON.parse(readFileSync(paths.marker, "utf8"));
  } catch {
    return { ready: false, reason: "privacy_runtime_incomplete", paths };
  }
  const stale = marker.piiGuardCommit !== PINS.piiGuardCommit || marker.nerRevision !== PINS.nerRevision || marker.python !== PINS.python;
  return stale ? { ready: false, reason: "privacy_runtime_outdated", paths, marker } : { ready: true, paths, marker };
}

export function serviceEnv(paths, { token, dbPath = paths.stateDb, extra = {} } = {}) {
  return runtimeEnv(paths, {
    PRIVACY_SERVICE_TOKEN: token,
    PRIVACY_DB_PATH: dbPath,
    // visitor — посетитель публичного веб-канала: restore возвращает ему только значения его же privacy-session
    PRIVACY_RESTORE_RECIPIENTS: "operator,visitor",
    PII_GUARD_COMMIT: PINS.piiGuardCommit,
    // Локальный каталог модели: Hugging Face Hub не нужен, ревизия — сам каталог поставки.
    // Пустая PII_GUARD_NER_REVISION — «без ревизии Hub» для локального пути
    PII_GUARD_NER_MODEL: VENDOR.nerModel,
    PII_GUARD_NER_REVISION: "",
    FRONTSMITH_NER_MODEL_ID: PINS.nerModel,
    FRONTSMITH_NER_REVISION: PINS.nerRevision,
    PII_GUARD_SPACY_MODEL: PINS.spacyModel,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    ...extra
  });
}

async function health(url) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  }
}

// Запускает Privacy Service как дочерний процесс на 127.0.0.1 и ждёт /health.
// Токен генерируется на запуск и известен только вызывающему Host.
// `requireReady: false` возвращает процесс и при not_ready (для проверок fail closed).
export async function startPrivacyService({
  port = Number(process.env.FRONTSMITH_PRIVACY_PORT ?? 4310),
  token = randomBytes(24).toString("hex"),
  dbPath,
  extraEnv = {},
  paths = runtimePaths(),
  requireReady = true,
  // Первый запуск после установки на слабом компьютере (6 ГБ RAM) загружает torch и NER ~6,5 минуты
  timeoutMs = 900_000,
  onLog
} = {}) {
  const status = runtimeStatus(paths);
  if (!status.ready) throw Object.assign(new Error(`${status.reason}: выполните npm run privacy:bootstrap`), { code: status.reason });
  const url = `http://127.0.0.1:${port}`;
  if (await health(url)) throw Object.assign(new Error(`порт ${port} уже занят`), { code: "privacy_port_busy" });

  const child = spawn(
    paths.python,
    ["-m", "uvicorn", "frontsmith_privacy.app:app", "--host", "127.0.0.1", "--port", String(port), "--no-access-log"],
    { cwd: SERVICE_DIR, env: serviceEnv(paths, { token, dbPath, extra: extraEnv }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let exited = null;
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve((exited = { code }))));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => onLog?.(chunk));
  }

  const stop = async () => {
    if (exited) return;
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exit;
    clearTimeout(timer);
    // python.exe venv на Windows — лаунчер: интерпретатор завершается чуть позже.
    // Остановка считается завершённой, когда порт закрыт и файлы SQLite отпущены.
    for (let attempt = 0; attempt < 40 && (await health(url)); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline && !exited) {
    last = await health(url);
    if (last && (last.body?.ready || !requireReady)) break;
    if (last && !last.body?.ready && last.body?.reasons?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (exited || !last || (requireReady && !last.body?.ready)) {
    // Причина — до остановки: после stop() процесс уже завершён нами
    const reason = exited ? `privacy_process_exited:${exited.code}` : !last ? "privacy_start_timeout" : (last.body?.reasons ?? []).join(",") || "privacy_not_ready";
    await stop();
    throw Object.assign(new Error(`Privacy Service не готов: ${reason}`), { code: "privacy_not_ready", reason });
  }
  return { url, token, port, process: child, health: last.body, stop, exited: exit };
}
