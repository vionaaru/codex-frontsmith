// Выбор каталога данных при первом bootstrap без установки runtime: проверки пути,
// план выбора (первая установка / сохранённый / существующая установка), интерактивный
// ввод и отказ bootstrap менять каталог существующей установки.
// %LOCALAPPDATA% подменяется временным каталогом: настоящий data-root.txt не читается и не меняется
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "frontsmith-data-root-"));
const local = path.join(temp, "LocalAppData");
mkdirSync(local, { recursive: true });
process.env.LOCALAPPDATA = local;
delete process.env.FRONTSMITH_DATA_ROOT;
delete process.env.FRONTSMITH_CODEX_HOST_ROOT;
const { DATA_ROOT_POINTER, dataRootPlan, looksInstalled, promptDataRoot, validateDataRoot } = await import("../scripts/lib/data-root.mjs");
const { defaultDataRoot } = await import("../services/privacy/runtime.mjs");
const { defaultHostRoot } = await import("../services/codex-host/codex-home.mjs");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function freeDriveLetter() {
  for (const letter of "QWXYZRSTUV") if (!existsSync(`${letter}:\\`)) return `${letter}:\\Frontsmith`;
  return null;
}

async function answer(lines, suggested, validate) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => (printed += chunk));
  const result = promptDataRoot({ suggested, validate, input, output });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  return { result: await result.catch((error) => error), printed };
}

try {
  await check("путь по умолчанию — %LOCALAPPDATA%\\Frontsmith, указатель выбора тоже там", async () => {
    assert.equal(defaultDataRoot(), path.join(local, "Frontsmith"));
    assert.equal(DATA_ROOT_POINTER, path.join(local, "Frontsmith", "data-root.txt"));
  });

  await check("проверки пути: относительный, внутри репозитория, несуществующий диск — отказ", async () => {
    assert.match(validateDataRoot("Frontsmith", { projectRoot: repo }).problems[0], /полный путь/);
    const insideRepo = validateDataRoot(path.join(repo, "data"), { projectRoot: repo });
    assert.equal(insideRepo.ok, false);
    assert.match(insideRepo.problems[0], /внутри репозитория/);
    assert.equal(existsSync(path.join(repo, "data")), false, "каталог в репозитории не создаётся");
    assert.equal(validateDataRoot(repo, { projectRoot: repo }).ok, false, "сам репозиторий");
    const missing = freeDriveLetter();
    if (missing) assert.match(validateDataRoot(missing, { projectRoot: repo }).problems[0], /недоступен/);
  });

  await check("проверки пути: запись, временный каталог и свободное место", async () => {
    const target = path.join(temp, "E", "FrontsmithData");
    const ok = validateDataRoot(target, { projectRoot: repo, minFreeBytes: 1 });
    assert.equal(ok.ok, true, ok.problems?.join(", "));
    assert.ok(ok.free > 0);
    assert.ok(existsSync(path.join(target, "runtime", "tmp")), "временный каталог установки — на выбранном диске");
    const fresh = path.join(temp, "no-space");
    const small = validateDataRoot(fresh, { projectRoot: repo, minFreeBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(small.ok, false);
    assert.match(small.problems.join(" "), /нужно не меньше/);
    assert.equal(existsSync(fresh), false, "созданный для проверки каталог удалён после отказа");
    assert.equal(validateDataRoot(fresh, { projectRoot: repo, minFreeBytes: Number.MAX_SAFE_INTEGER, installed: true }).ok, true, "готовой установке место под распаковку не нужно");
  });

  await check("план первой установки: интерактивно — вопрос, неинтерактивно — путь по умолчанию, --data-root — без вопроса", async () => {
    assert.deepEqual(dataRootPlan({ interactive: true }), { source: "prompt", root: defaultDataRoot(), remember: true });
    assert.deepEqual(dataRootPlan({ interactive: false }), { source: "default", root: defaultDataRoot(), remember: true });
    const chosen = path.join(temp, "E", "Frontsmith");
    assert.deepEqual(dataRootPlan({ requested: chosen, interactive: true }), { source: "flag", root: chosen, remember: true });
  });

  await check("интерактивный выбор: Enter — предложенный путь, неверный путь — повтор, закрытый ввод — ошибка", async () => {
    const validate = (candidate) => validateDataRoot(candidate, { projectRoot: repo, minFreeBytes: 1 });
    const suggested = path.join(temp, "suggested");
    const enter = await answer([""], suggested, validate);
    assert.equal(enter.result.root, suggested);
    assert.match(enter.printed, /Первоначальная настройка Frontsmith/);
    assert.match(enter.printed, /CRM и контакты/);
    const other = path.join(temp, "E", "Business", "FrontsmithData");
    const retry = await answer([path.join(repo, "inside"), `"${other}"`], suggested, validate);
    assert.equal(retry.result.root, other);
    assert.match(retry.printed, /внутри репозитория/);
    const closed = await answer([], suggested, validate);
    assert.equal(closed.result.code, "DATA_ROOT_NOT_CHOSEN");
  });

  await check("повторный запуск: сохранённый каталог не спрашивается и не меняется", async () => {
    const saved = path.join(temp, "D", "Frontsmith");
    mkdirSync(path.dirname(DATA_ROOT_POINTER), { recursive: true });
    writeFileSync(DATA_ROOT_POINTER, `${saved}\n`);
    assert.deepEqual(dataRootPlan({ interactive: true }), { source: "saved", root: saved, remember: false });
    assert.equal(dataRootPlan({ requested: saved.toUpperCase() }).source, "saved", "тот же путь в другом регистре");
    assert.throws(() => dataRootPlan({ requested: path.join(temp, "E", "Frontsmith") }), (error) => error.code === "DATA_ROOT_ALREADY_SET");
    rmSync(DATA_ROOT_POINTER);
  });

  await check("установка до появления выбора в каталоге по умолчанию остаётся на месте", async () => {
    mkdirSync(path.join(defaultDataRoot(), "crm"), { recursive: true });
    writeFileSync(path.join(defaultDataRoot(), "crm", "credential.json"), "{}");
    assert.equal(looksInstalled(defaultDataRoot()), true);
    assert.equal(dataRootPlan({ interactive: true }).source, "existing");
    assert.throws(() => dataRootPlan({ requested: path.join(temp, "E", "Frontsmith") }), (error) => error.code === "DATA_ROOT_ALREADY_SET");
    rmSync(path.join(defaultDataRoot(), "crm"), { recursive: true });
  });

  await check("FRONTSMITH_DATA_ROOT имеет приоритет и не запоминается", async () => {
    process.env.FRONTSMITH_DATA_ROOT = path.join(temp, "env-root");
    assert.deepEqual(dataRootPlan({ interactive: true }), { source: "env", root: path.join(temp, "env-root"), remember: false });
    delete process.env.FRONTSMITH_DATA_ROOT;
  });

  await check("вход Codex Host: новая установка — в каталоге данных, прежний %LOCALAPPDATA%\\Frontsmith\\codex-host сохраняется", async () => {
    const saved = path.join(temp, "D", "Frontsmith");
    writeFileSync(DATA_ROOT_POINTER, `${saved}\n`);
    assert.equal(defaultHostRoot(), path.join(saved, "codex-host"));
    mkdirSync(path.join(local, "Frontsmith", "codex-host"), { recursive: true });
    assert.equal(defaultHostRoot(), path.join(local, "Frontsmith", "codex-host"));
    rmSync(path.join(local, "Frontsmith", "codex-host"), { recursive: true });
    rmSync(DATA_ROOT_POINTER);
  });

  await check("npm run bootstrap: каталог в репозитории и смена каталога существующей установки — отказ до установки", async () => {
    const env = { ...process.env, LOCALAPPDATA: local };
    delete env.FRONTSMITH_DATA_ROOT;
    const run = (...flags) => spawnSync(process.execPath, [path.join(repo, "scripts", "bootstrap.mjs"), ...flags], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
    const inside = run("--data-root", path.join(repo, "frontsmith-data"));
    assert.equal(inside.status, 1, inside.stdout + inside.stderr);
    assert.match(inside.stderr, /DATA_ROOT_INVALID/);
    assert.equal(existsSync(DATA_ROOT_POINTER), false, "отклонённый путь не запоминается");
    assert.equal(existsSync(path.join(repo, "frontsmith-data")), false);
    const saved = path.join(temp, "D", "Frontsmith");
    writeFileSync(DATA_ROOT_POINTER, `${saved}\n`);
    const moved = run("--data-root", path.join(temp, "E", "Frontsmith"));
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, /DATA_ROOT_ALREADY_SET/);
    assert.equal(readFileSync(DATA_ROOT_POINTER, "utf8").trim(), saved, "выбор существующей установки не изменён");
  });

  console.log(`Data root: ${passed} проверок пройдено`);
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
