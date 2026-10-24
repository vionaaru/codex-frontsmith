// Выбор каталога данных Frontsmith при первом npm run bootstrap.
//
// Каталог данных хранит CRM и контакты, состояние Privacy Service, распакованный runtime,
// вход Codex Host и резервные копии. Он всегда вне репозитория: репозиторий — рабочая
// область Codex. Выбор запоминается в %LOCALAPPDATA%\Frontsmith\data-root.txt; повторный
// bootstrap его не спрашивает и не меняет. Перенос существующей установки не поддерживается.
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DATA_ROOT_POINTER, dataRoot, defaultDataRoot } from "../../services/privacy/runtime.mjs";

// Распакованный Python и venv с torch (~1,7 ГБ), crmkit, временные файлы установки — с запасом
export const MIN_FREE_BYTES = 4 * 1024 ** 3;

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

function inside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExisting(dir) {
  let current = path.resolve(dir);
  while (!existsSync(current)) {
    const up = path.dirname(current);
    if (up === current) return null;
    current = up;
  }
  return current;
}

// Признаки уже подготовленной установки в каталоге: её нельзя «выбрать заново»
export function looksInstalled(root) {
  return ["crm/credential.json", "crm/crmkit.yaml", "runtime/privacy-runtime.json", "privacy/privacy.sqlite"].some((file) => existsSync(path.join(root, ...file.split("/"))));
}

// Проверки до установки. Ничего не создаётся, кроме самого каталога и пробного файла
// записи, которые при неудаче удаляются, если каталога не было
export function validateDataRoot(input, { projectRoot, workspaces = [], minFreeBytes = MIN_FREE_BYTES, installed = false } = {}) {
  const problems = [];
  const text = String(input ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!text) return { ok: false, problems: ["путь не указан"] };
  if (!path.isAbsolute(text)) return { ok: false, problems: [`нужен полный путь, например E:\\Frontsmith; получено «${text}»`] };
  const root = path.resolve(text);
  const drive = path.parse(root).root;
  if (!existsSync(drive)) return { ok: false, root, problems: [`диск ${drive} недоступен`] };
  for (const area of [projectRoot, ...workspaces].filter(Boolean)) {
    if (inside(root, area)) problems.push(`каталог внутри репозитория или рабочей области Codex (${area}): CRM и состояние Privacy туда помещать нельзя`);
  }
  if (problems.length) return { ok: false, root, problems };

  const existed = existsSync(root);
  try {
    mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.frontsmith-write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (error) {
    if (!existed) rmSync(root, { recursive: true, force: true });
    return { ok: false, root, problems: [`нет права на запись: ${error.code ?? error.message}`] };
  }
  // Временные файлы установки и кэши — в <каталог>/runtime/tmp, на том же диске
  const tmp = path.join(root, "runtime", "tmp");
  try {
    mkdirSync(tmp, { recursive: true });
    const probe = path.join(tmp, `.write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  } catch (error) {
    problems.push(`временный каталог ${tmp} недоступен: ${error.code ?? error.message}`);
  }
  let free = null;
  try {
    const { bavail, bsize } = statfsSync(nearestExisting(root));
    free = bavail * bsize;
  } catch {
    problems.push("не удалось определить свободное место");
  }
  // Готовой установке место под распаковку уже не нужно
  if (free !== null && !installed && free < minFreeBytes) {
    problems.push(`свободно ${gib(free)}, нужно не меньше ${gib(minFreeBytes)} (runtime, временные файлы установки)`);
  }
  if (problems.length && !existed) rmSync(root, { recursive: true, force: true });
  return { ok: problems.length === 0, root, free, problems };
}

export function savedDataRoot() {
  if (!existsSync(DATA_ROOT_POINTER)) return null;
  const saved = readFileSync(DATA_ROOT_POINTER, "utf8").trim();
  return saved ? path.resolve(saved) : null;
}

// Откуда берётся каталог данных на этом запуске:
//   env       FRONTSMITH_DATA_ROOT (тесты, особые установки) — не запоминается
//   saved     уже выбран при первой установке — не спрашивается, не меняется
//   existing  каталог по умолчанию уже содержит установку (до появления выбора)
//   flag      --data-root первой установки
//   prompt    интерактивный выбор первой установки
//   default   неинтерактивный терминал без --data-root: документированный путь по умолчанию
export function dataRootPlan({ requested = null, interactive = false } = {}) {
  if (process.env.FRONTSMITH_DATA_ROOT) {
    return { source: "env", root: path.resolve(process.env.FRONTSMITH_DATA_ROOT), remember: false };
  }
  const saved = savedDataRoot();
  if (saved) {
    if (requested && path.resolve(requested).toLowerCase() !== saved.toLowerCase()) {
      throw Object.assign(new Error(`каталог данных уже выбран: ${saved}. Перенос существующей установки не поддерживается; --data-root ${requested} не применён`), { code: "DATA_ROOT_ALREADY_SET" });
    }
    return { source: "saved", root: saved, remember: false };
  }
  const fallback = defaultDataRoot();
  if (looksInstalled(fallback)) {
    if (requested && path.resolve(requested).toLowerCase() !== fallback.toLowerCase()) {
      throw Object.assign(new Error(`установка Frontsmith уже есть в ${fallback}. Перенос не поддерживается; --data-root ${requested} не применён`), { code: "DATA_ROOT_ALREADY_SET" });
    }
    return { source: "existing", root: fallback, remember: true };
  }
  if (requested) return { source: "flag", root: path.resolve(requested), remember: true };
  if (interactive) return { source: "prompt", root: fallback, remember: true };
  return { source: "default", root: fallback, remember: true };
}

export const PROMPT_TEXT = (suggested) => [
  "",
  "Первоначальная настройка Frontsmith",
  "",
  "Выберите каталог для хранения данных:",
  "",
  `[ ${suggested} ]`,
  "",
  "Здесь будут находиться:",
  "- CRM и контакты",
  "- состояние Privacy Service",
  "- локальные модели и runtime",
  "- служебные файлы",
  "- резервные копии",
  "",
  `Нужно около ${gib(MIN_FREE_BYTES)} свободного места. Каталог должен быть вне папки Frontsmith.`,
  "Нажмите Enter, чтобы использовать предложенный путь,",
  "или укажите другой каталог:"
].join("\n");

// Интерактивный выбор: повторять, пока путь не пройдёт проверки. Пустой ввод — предложенный путь.
// input/output подменяются в тестах
export async function promptDataRoot({ suggested, validate, input = process.stdin, output = process.stdout, maxAttempts = 10 }) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  try {
    output.write(`${PROMPT_TEXT(suggested)}\n`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      output.write("> ");
      const next = await lines.next();
      if (next.done) throw Object.assign(new Error("ввод закрыт до выбора каталога данных"), { code: "DATA_ROOT_NOT_CHOSEN" });
      const candidate = next.value.trim().replace(/^"(.*)"$/, "$1") || suggested;
      const result = validate(candidate);
      if (result.ok) return result;
      output.write(`\n✗ ${candidate}:\n  ${result.problems.join("\n  ")}\nУкажите другой каталог:\n`);
    }
    throw Object.assign(new Error("каталог данных не выбран"), { code: "DATA_ROOT_NOT_CHOSEN" });
  } finally {
    rl.close();
  }
}

export { DATA_ROOT_POINTER, dataRoot };
