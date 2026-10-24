// Поставка сторонних компонентов внутри репозитория Frontsmith (vendor/).
// Bootstrap берёт crmkit, pii-guard, модель NER, uv, Python и Python wheels отсюда,
// а не из исходных репозиториев: опубликованная версия Frontsmith остаётся
// устанавливаемой, даже если исходный проект удалят или закроют.
//
// vendor/manifest.json фиксирует для каждого компонента версию, источник, лицензию,
// расположение и SHA-256 каждого файла. Большие файлы хранятся в Git LFS: без
// `git lfs pull` вместо них лежат текстовые указатели, и проверка сообщает об этом
// до установки, а не падает на середине.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const VENDOR_ROOT = path.join(projectRoot, "vendor");
export const MANIFEST_FILE = path.join(VENDOR_ROOT, "manifest.json");
export const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

// Платформа, для которой в поставку включены установочные артефакты
export const BUNDLED_PLATFORM = "win32-x64";

export class VendorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

export function readManifest(file = MANIFEST_FILE) {
  if (!existsSync(file)) throw new VendorError("VENDOR_MANIFEST_MISSING", `нет ${path.relative(projectRoot, file)}: репозиторий неполный`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function component(manifest, id) {
  const entry = manifest.components.find((item) => item.id === id);
  if (!entry) throw new VendorError("VENDOR_COMPONENT_MISSING", `в vendor/manifest.json нет компонента ${id}`);
  return entry;
}

// Пути в manifest — относительно корня репозитория, через «/»; абсолютный путь — как есть (тесты)
export function vendorPath(relative) {
  return path.isAbsolute(relative) ? relative : path.join(projectRoot, ...relative.split("/"));
}

export function bundledPlatformSupported(key = `${process.platform}-${process.arch}`) {
  return key === BUNDLED_PLATFORM;
}

export function assertBundledPlatform(key = `${process.platform}-${process.arch}`) {
  if (!bundledPlatformSupported(key)) {
    throw new VendorError("PLATFORM_NOT_BUNDLED", `установочные артефакты Frontsmith включены только для ${BUNDLED_PLATFORM}; платформа ${key} в этом релизе не поддерживается`);
  }
}

// Указатель Git LFS: маленький текстовый файл вместо настоящего объекта
export function isLfsPointer(file) {
  const size = statSync(file).size;
  if (size > 1024) return false;
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(LFS_POINTER_PREFIX.length);
    readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8") === LFS_POINTER_PREFIX;
  } finally {
    closeSync(fd);
  }
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

// Отпечаток дерева исходников: SHA-256 строк «sha256  путь» в порядке путей.
// Не зависит от Git и проверяется так же в чистом клоне
export async function treeDigest(dir) {
  const files = walk(dir).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${await sha256File(path.join(dir, file))}  ${file}\n`);
  return { digest: hash.digest("hex"), files: files.length };
}

// Проверка одного файла поставки: есть, не указатель LFS, размер и SHA-256 совпадают
export async function verifyFile(entry) {
  const file = vendorPath(entry.path);
  if (!existsSync(file)) return { ok: false, path: entry.path, reason: "missing" };
  if (entry.lfs && isLfsPointer(file)) return { ok: false, path: entry.path, reason: "lfs_pointer" };
  if (entry.size !== undefined && statSync(file).size !== entry.size) return { ok: false, path: entry.path, reason: "size_mismatch" };
  if ((await sha256File(file)) !== entry.sha256) return { ok: false, path: entry.path, reason: "sha256_mismatch" };
  return { ok: true, path: entry.path };
}

// Все файлы компонента: архивы, файлы модели, wheels; для деревьев исходников — отпечаток
export async function verifyComponent(entry) {
  const problems = [];
  for (const file of entry.files ?? []) {
    const result = await verifyFile(file);
    if (!result.ok) problems.push(result);
  }
  if (entry.tree) {
    const dir = vendorPath(entry.path);
    if (!existsSync(dir)) problems.push({ ok: false, path: entry.path, reason: "missing" });
    else {
      const actual = await treeDigest(dir);
      if (actual.digest !== entry.tree.digest || actual.files !== entry.tree.files) problems.push({ ok: false, path: entry.path, reason: "tree_mismatch" });
    }
  }
  return problems;
}

export function describeProblem(problem) {
  const reason = {
    missing: "файл отсутствует",
    lfs_pointer: "вместо файла лежит указатель Git LFS — выполните git lfs install и git lfs pull",
    size_mismatch: "размер не совпадает с vendor/manifest.json",
    sha256_mismatch: "SHA-256 не совпадает с vendor/manifest.json",
    tree_mismatch: "исходники отличаются от зафиксированной версии"
  }[problem.reason] ?? problem.reason;
  return `${problem.path}: ${reason}`;
}

// Проверка перед установкой. Указатели LFS — отдельная понятная ошибка
export async function assertComponents(ids, manifest = readManifest()) {
  const problems = [];
  for (const id of ids) problems.push(...(await verifyComponent(component(manifest, id))));
  if (!problems.length) return manifest;
  const pointers = problems.filter((problem) => problem.reason === "lfs_pointer");
  if (pointers.length) {
    throw new VendorError("LFS_OBJECTS_MISSING",
      `большие файлы поставки не получены из Git LFS (${pointers.length}):\n  ${pointers.map((problem) => problem.path).join("\n  ")}\n` +
      "  Выполните в каталоге Frontsmith:\n    git lfs install\n    git lfs pull\n  и повторите npm run bootstrap", { problems });
  }
  throw new VendorError("VENDOR_INTEGRITY_FAILED", `поставка Frontsmith повреждена:\n  ${problems.map(describeProblem).join("\n  ")}`, { problems });
}
