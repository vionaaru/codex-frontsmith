import { access, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  ".env.example",
  "vercel.json",
  "frontsmith.config.json",
  "api/contact.js",
  "blueprints/local-service/blueprint.json",
  "demo/index.html",
  "demo/styles.css",
  "demo/script.js",
  "workflows/owner-brief.md",
  "workflows/bootstrap-business.md",
  "workflows/update-website.md",
  "workflows/prepare-customer-reply.md",
  "workflows/prepare-estimate-draft.md",
  "workflows/prepare-extension-plan.md",
  "workflows/deploy-website.md",
  "workflows/launch-plan.md",
  "scripts/bootstrap.mjs",
  "scripts/prepare-owner-brief.mjs",
  "scripts/update-website.mjs",
  "scripts/prepare-customer-reply.mjs",
  "scripts/prepare-estimate-draft.mjs",
  "scripts/prepare-extension-plan.mjs",
  "scripts/launch-status.mjs",
  "scripts/build-demo.mjs",
  "scripts/deploy-check.mjs",
  "scripts/preview-demo.mjs",
  "scripts/preview-website.mjs",
  "scripts/lib/paths.mjs",
  "scripts/lib/render-website.mjs",
  "tests/regression.mjs",
  "tests/launch-readiness.mjs",
  "tests/office.mjs",
  "scripts/office.mjs",
  "office/README.md",
  "office/server.mjs",
  "office/db/migrations/001_initial.sql",
  "office/lib/db.mjs",
  "office/lib/domain.mjs",
  "office/lib/repositories.mjs",
  "office/lib/operations.mjs",
  "office/lib/import.mjs",
  "office/lib/catalog.mjs",
  "office/public/index.html",
  "office/public/styles.css",
  "office/public/app.js",
  "package-lock.json",
  "website/index.html",
  "website/styles.css",
  "website/script.js",
  "website/apple-touch-icon.png",
  "website/favicon.png",
  "website/favicon.svg",
  "website/frontsmith-mark.svg",
  "docs/operator/start-here.md",
  "docs/developer/extension-guide.md",
  "docs/product/launch-scenarios.md",
  "docs/product/package-spec.md",
  "docs/product/architecture.md",
  "DEVELOPERS.md"
];

const oldInstancesDir = ["inst", "ances"].join("");
const oldInstanceFlag = ["--", "inst", "ance"].join("");
const oldBusinessSlugToken = ["business", "-slug"].join("");
const oldBusinessInstancePhrase = ["business", "instance"].join(" ");
const oldLocalInstancePhrase = ["local", "instance"].join(" ");
const oldFrontsmithInstancesPath = [".frontsmith/", oldInstancesDir].join("");
const oldTemplatesDir = ["templ", "ates"].join("");
const oldGeneratedWebsiteApp = ["apps/generated", "-website"].join("");
const oldBusinessWebsitePath = [".frontsmith/business/", "website"].join("");
const oldGeneratedWebsitePhrase = ["generated", "website"].join(" ");
const oldStarterWebsitePhrase = ["starter", "website"].join(" ");
const oldWebsiteOutputPhrase = ["website", "output"].join(" ");
const oldGenerateWebsiteCommand = ["generate", ":website"].join("");
const oldTemplatesWebsitePath = [oldTemplatesDir, "/website"].join("");

const forbiddenPaths = [
  "next.config.ts",
  "src/app",
  oldInstancesDir,
  oldTemplatesDir,
  oldGeneratedWebsiteApp
];

const forbiddenTrackedPaths = [
  ".vercel/project.json"
];

const jsonFiles = [
  "package.json",
  "vercel.json",
  "frontsmith.config.json",
  "blueprints/local-service/blueprint.json",
  "blueprints/auto-service/blueprint.json",
  "blueprints/auto-service/business.example.json"
];

const removedConcept = ["de", "mo"].join("");
const oldReferenceName = [
  String.fromCharCode(79, 97, 107),
  " & ",
  String.fromCharCode(70, 114, 97, 109, 101)
].join("");
const oldReferenceSlug = ["oak", "-frame"].join("");
const oldTemplatePath = ["remodeling", "-", String.fromCharCode(99, 111, 110, 116, 114, 97, 99, 116, 111, 114)].join("");
const starterDataWord = ["sam", "ple"].join("");

const forbiddenText = [
  ["setup", removedConcept].join(":"),
  oldReferenceName,
  oldReferenceSlug,
  oldTemplatePath,
  ["reference", "instance"].join(" "),
  oldInstanceFlag,
  oldBusinessSlugToken,
  oldBusinessInstancePhrase,
  oldLocalInstancePhrase,
  oldFrontsmithInstancesPath,
  oldGeneratedWebsitePhrase,
  oldStarterWebsitePhrase,
  oldWebsiteOutputPhrase,
  oldGenerateWebsiteCommand,
  oldTemplatesWebsitePath,
  [starterDataWord, "business"].join(" "),
  [removedConcept, "business"].join(" ")
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

for (const file of requiredFiles) {
  if (!(await exists(file))) {
    throw new Error(`Отсутствует обязательный файл: ${file}`);
  }
}

for (const file of forbiddenPaths) {
  if (await exists(file)) {
    throw new Error(`В репозитории продукта остался запрещённый путь: ${file}`);
  }
}

for (const file of forbiddenTrackedPaths) {
  if (await isTracked(file)) {
    throw new Error(`Git всё ещё отслеживает запрещённый путь репозитория продукта: ${file}`);
  }
}

for (const file of jsonFiles) {
  JSON.parse(await readFile(file, "utf8"));
}

for (const file of ["website/index.html"]) {
  const content = await readFile(file, "utf8");
  if (!content.includes("data-frontsmith-")) {
    throw new Error(`Отсутствуют маркеры обновления сайта Frontsmith: ${file}`);
  }
  if (/\{\{[a-zA-Z0-9]+\}\}/.test(content)) {
    throw new Error(`В ${file} найден устаревший маркер сайта`);
  }
  if (/\bhref=["'][^"']+\.html(?:[#?][^"']*)?["']/.test(content)) {
    throw new Error(`Навигация сайта не должна ссылаться на маршруты .html: ${file}`);
  }
  if (!content.includes('rel="icon"') || !content.includes('href="/favicon.svg"')) {
    throw new Error(`Сайт должен объявлять значок Frontsmith в формате SVG: ${file}`);
  }
  if (!content.includes('href="/favicon.png"') || !content.includes('href="/apple-touch-icon.png"')) {
    throw new Error(`Сайт должен объявлять резервные значки PNG: ${file}`);
  }
  for (const requiredHeadToken of [
    'rel="canonical"',
    'property="og:title"',
    'property="og:description"',
    'property="og:image"',
    'property="og:image:alt"',
    'name="twitter:card"',
    'name="twitter:image"',
    'name="twitter:image:alt"'
  ]) {
    if (!content.includes(requiredHeadToken)) {
      throw new Error(`В метаданных head сайта отсутствует ${requiredHeadToken}: ${file}`);
    }
  }
}

const trackedFiles = await listTrackedFiles();
const { stdout: committedPaths } = await execFileAsync("git", ["ls-files", "--cached"]);
for (const file of committedPaths.split("\n").filter(Boolean)) {
  if (file.startsWith(".frontsmith/") || /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(file)) {
    throw new Error(`Рабочие данные не должны отслеживаться Git: ${file}`);
  }
}
for (const file of trackedFiles) {
  if (!shouldScan(file)) continue;
  if (!(await exists(file))) continue;
  const content = await readFile(file, "utf8");
  for (const text of forbiddenText) {
    if (content.includes(text)) {
      throw new Error(`В ${file} найден запрещённый текст "${text}"`);
    }
  }
}

console.log("Проверка набора Frontsmith v1.0 пройдена.");

async function listTrackedFiles() {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return await listProjectFiles(".");
  }
}

async function isTracked(file) {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", file]);
    return true;
  } catch {
    return false;
  }
}

function shouldScan(file) {
  return !file.startsWith(".frontsmith/") && !file.startsWith(".git/");
}

async function listProjectFiles(dir) {
  const ignoredDirs = new Set([".git", ".frontsmith", ".vercel", "dist", "node_modules", "coverage"]);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const file = dir === "." ? entry.name : `${dir}/${entry.name}`;

    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      files.push(...(await listProjectFiles(file)));
      continue;
    }

    if (entry.isFile()) {
      files.push(file);
    }
  }

  return files;
}
