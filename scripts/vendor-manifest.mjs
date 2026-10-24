// Пересборка vendor/manifest.json после обновления поставки. Для сопровождающих:
// установка и Bootstrap этот скрипт не вызывают.
//
//   npm run vendor:manifest            пересчитать SHA-256, размеры и отпечатки деревьев
//
// Версии берутся из зафиксированных значений (CRMKIT, PINS); для wheels — имя, версия и
// лицензия из METADATA самого wheel. Как обновлять сами артефакты — vendor/README.md.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CRMKIT } from "../services/crm/runtime.mjs";
import { PINS, PYTHON_DIST, UV_DIST } from "../services/privacy/runtime.mjs";
import { BUNDLED_PLATFORM, MANIFEST_FILE, isLfsPointer, projectRoot, sha256File, treeDigest, vendorPath } from "./lib/vendor.mjs";

const rel = (file) => path.relative(projectRoot, file).split(path.sep).join("/");

async function fileEntry(relative, { lfs = false } = {}) {
  const file = vendorPath(relative);
  if (lfs && isLfsPointer(file)) throw new Error(`${relative}: указатель Git LFS, нужен настоящий файл (git lfs pull)`);
  return { path: relative, size: statSync(file).size, sha256: await sha256File(file), ...(lfs ? { lfs: true } : {}) };
}

async function tree(relative) {
  return treeDigest(vendorPath(relative));
}

// Имя, версия и лицензия из METADATA wheel (tar.exe Windows и bsdtar читают zip)
function wheelMetadata(file) {
  const base = path.basename(file);
  const [name, version] = base.split("-");
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";
  const result = spawnSync(tar, ["-xOf", file, `${name}-${version}.dist-info/METADATA`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${base}: не удалось прочитать METADATA`);
  const headers = result.stdout.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
  const field = (key) => headers.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2).trim();
  const classifiers = headers.filter((line) => line.startsWith("Classifier: License ::")).map((line) => line.split("::").pop().trim());
  const license = field("License-Expression") || (field("License") && field("License").length < 80 ? field("License") : "") || classifiers.join("; ") || "UNKNOWN";
  return { name: field("Name"), version: field("Version"), license };
}

const wheelsDir = "vendor/runtime-assets/wheels";
const wheels = [];
for (const name of readdirSync(vendorPath(wheelsDir)).filter((file) => file.endsWith(".whl")).sort()) {
  const relative = `${wheelsDir}/${name}`;
  wheels.push({ ...(await fileEntry(relative, { lfs: true })), ...wheelMetadata(vendorPath(relative)) });
}

const nerDir = "vendor/ner-model/rubert-base-pii-ner";
const nerFiles = [];
for (const name of readdirSync(vendorPath(nerDir)).sort()) nerFiles.push(await fileEntry(`${nerDir}/${name}`, { lfs: name.endsWith(".safetensors") }));

const crmkitArchive = `vendor/crmkit/release/crmkit-${CRMKIT.tag}-windows-amd64.tar.gz`;

const manifest = {
  schema: 1,
  product: "Frontsmith",
  platform: BUNDLED_PLATFORM,
  note: "Сторонние компоненты в поставке Frontsmith. Bootstrap проверяет SHA-256 перед установкой и не скачивает их повторно. Обновление: vendor/README.md",
  components: [
    {
      id: "crmkit-source",
      name: "crmkit",
      version: CRMKIT.version,
      kind: "source",
      source: { repository: "https://github.com/crmkit/crmkit", tag: CRMKIT.tag, commit: CRMKIT.commit, gitTree: "31652c59d378d7b996f3f35ccf38280813f911f0" },
      license: "MIT",
      licenseFiles: ["vendor/crmkit/source/LICENSE"],
      path: "vendor/crmkit/source",
      tree: await tree("vendor/crmkit/source"),
      bootstrap: "не используется: исходники зафиксированной версии для аудита и сборки (сборка требует Go)",
      offline: true
    },
    {
      id: "crmkit-binary",
      name: "crmkitd (Windows amd64)",
      version: CRMKIT.version,
      kind: "binary",
      source: { url: `https://github.com/crmkit/crmkit/releases/download/${CRMKIT.tag}/crmkit-${CRMKIT.tag}-windows-amd64.tar.gz`, checksums: `https://github.com/crmkit/crmkit/releases/download/${CRMKIT.tag}/checksums.txt` },
      license: "MIT",
      licenseFiles: ["vendor/crmkit/source/LICENSE"],
      path: "vendor/crmkit/release",
      files: [await fileEntry(crmkitArchive, { lfs: true }), await fileEntry("vendor/crmkit/release/checksums.txt")],
      bootstrap: "распаковывается в <data>/runtime/crmkit; SHA-256 сверяется с зафиксированным и с официальным checksums.txt",
      offline: true
    },
    {
      id: "pii-guard",
      name: "pii-guard",
      version: PINS.piiGuardVersion,
      kind: "source",
      source: { repository: "https://github.com/redmadrobot-rnd/pii-guard", commit: PINS.piiGuardCommit, gitTree: "2cc7c2a1be58ddea4904da07af3fb1d05e8e1d13" },
      license: "Apache-2.0",
      licenseFiles: ["vendor/pii-guard/source/LICENSE", "vendor/pii-guard/source/NOTICE"],
      path: "vendor/pii-guard/source",
      tree: await tree("vendor/pii-guard/source"),
      bootstrap: "собирается из локальной копии (setuptools и wheel из wheelhouse) и ставится в venv Privacy Service",
      offline: true
    },
    {
      id: "ner-model",
      name: PINS.nerModel,
      version: PINS.nerRevision,
      kind: "model",
      source: { repository: `https://huggingface.co/${PINS.nerModel}`, revision: PINS.nerRevision, baseModel: "https://huggingface.co/ai-forever/ruBert-base (Apache-2.0)" },
      license: "Apache-2.0",
      licenseFiles: [`${nerDir}/LICENSE`],
      path: nerDir,
      files: nerFiles,
      bootstrap: "загружается Privacy Service из этого каталога (local_files_only, HF_HUB_OFFLINE=1)",
      offline: true
    },
    {
      id: "uv",
      name: "uv",
      version: PINS.uv.version,
      kind: "binary",
      source: { url: `https://github.com/astral-sh/uv/releases/download/${PINS.uv.version}/${UV_DIST.file}` },
      license: "MIT OR Apache-2.0",
      licenseFiles: [],
      path: "vendor/runtime-assets/uv",
      files: [await fileEntry(`vendor/runtime-assets/uv/${UV_DIST.file}`, { lfs: true })],
      bootstrap: "распаковывается в <data>/runtime/uv; создаёт venv и ставит wheels без сети",
      offline: true
    },
    {
      id: "python",
      name: "CPython (python-build-standalone)",
      version: `${PINS.python}+${PYTHON_DIST.build}`,
      kind: "binary",
      source: { url: PYTHON_DIST.url, checksums: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_DIST.build}/SHA256SUMS` },
      license: "PSF-2.0 (вместе с лицензиями включённых библиотек: архив содержит LICENSE.txt)",
      licenseFiles: [],
      path: "vendor/runtime-assets/python",
      files: [await fileEntry(`vendor/runtime-assets/python/${PYTHON_DIST.file}`, { lfs: true })],
      bootstrap: "распаковывается в <data>/runtime/python без установки в систему и без записи в реестр",
      offline: true
    },
    {
      id: "wheelhouse",
      name: "Python wheels Privacy Service (cp311, win_amd64)",
      version: "services/privacy/requirements.lock",
      kind: "wheels",
      source: { index: "https://pypi.org/simple", extraIndex: "https://download.pytorch.org/whl/cpu", spacyModel: "https://github.com/explosion/spacy-models/releases/tag/ru_core_news_sm-3.8.0" },
      license: "по пакетам: поле license у каждого файла",
      licenseFiles: [],
      path: wheelsDir,
      files: wheels,
      bootstrap: "uv pip sync --offline --no-index --find-links по requirements.lock",
      offline: true
    }
  ]
};

writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
const lfsFiles = manifest.components.flatMap((item) => item.files ?? []).filter((file) => file.lfs);
const bytes = lfsFiles.reduce((sum, file) => sum + file.size, 0);
console.log(`${rel(MANIFEST_FILE)}: компонентов ${manifest.components.length}, файлов Git LFS ${lfsFiles.length}, ${(bytes / 1024 ** 2).toFixed(0)} МБ`);
