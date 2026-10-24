// Первичная подготовка встроенного CRM без Go и Docker.
//
//   npm run crm:bootstrap
//
// 1. Архив релиза crmkit v0.9.1 из поставки Frontsmith (vendor/crmkit/release, Windows amd64).
// 2. SHA-256 архива сверяется с vendor/manifest.json, с зафиксированным в runtime.mjs и с
//    официальным checksums.txt релиза (лежит рядом). Сеть не используется.
// 3. crmkitd распаковывается в <data>/runtime/crmkit/<версия>/ (PATH не меняется, права администратора не нужны).
// 4. <data>/crm/: конфигурация, схема базы (crmkitd migrate --execute), токен доверенного процесса.
// 5. Проверка: обычный запуск на 127.0.0.1 принимает токен, /auth/request кода не выдаёт.
// Повторный запуск пропускает готовые шаги и ничего не скачивает.
//
// Каталог данных — тот же, что у Privacy Service (`npm run privacy:bootstrap -- --data-root`).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { assertBundledPlatform, assertComponents } from "../../scripts/lib/vendor.mjs";
import { CRMKIT, crmPaths, crmkitAsset, freePort, protectDir, provisionCredential, readCredential, runMigrations, startCrmkit, writeConfig } from "./runtime.mjs";
import { CrmkitClient } from "./client.mjs";

const fail = (text) => {
  console.error(`\n✗ ${text}`);
  process.exit(1);
};

export async function installCrmkit(paths, { log = () => {} } = {}) {
  const asset = crmkitAsset();
  if (existsSync(paths.binary) && existsSync(paths.marker)) {
    const version = spawnSync(paths.binary, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    if (version === `crmkitd ${CRMKIT.tag}`) return { downloaded: false, version, asset };
  }
  mkdirSync(paths.tmp, { recursive: true });
  // Архив из поставки Frontsmith; указатель Git LFS вместо архива — понятная ошибка до распаковки
  assertBundledPlatform();
  await assertComponents(["crmkit-binary"]);
  log(`из поставки: ${path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), asset.local)}`);
  const archive = readFileSync(asset.local);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== asset.sha256) throw new Error(`SHA-256 ${asset.file} не совпадает с зафиксированным`);
  const checksums = readFileSync(asset.localChecksums, "utf8");
  const official = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find(([, name]) => name === asset.file)?.[0];
  if (official !== digest) throw new Error(`${asset.file} не совпадает с официальным checksums.txt релиза ${CRMKIT.tag}`);

  const work = mkdtempSync(path.join(paths.tmp, "crmkit-"));
  try {
    const file = path.join(work, asset.file);
    writeFileSync(file, archive);
    const unpacked = path.join(work, "unpacked");
    mkdirSync(unpacked);
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const result = spawnSync(tar, ["-xzf", file, "-C", unpacked], { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`распаковка ${asset.file} завершилась с кодом ${result.status}`);
    const name = path.basename(paths.binary);
    const found = [path.join(unpacked, name), ...listDirs(unpacked).map((dir) => path.join(dir, name))].find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`в архиве нет ${name}`);
    rmSync(paths.runtime, { recursive: true, force: true });
    mkdirSync(paths.runtime, { recursive: true });
    renameSync(found, paths.binary);
    const version = spawnSync(paths.binary, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    if (version !== `crmkitd ${CRMKIT.tag}`) throw new Error(`распакованный crmkitd сообщает «${version}»`);
    writeFileSync(paths.marker, `${JSON.stringify({ version: CRMKIT.version, tag: CRMKIT.tag, commit: CRMKIT.commit, asset: asset.file, sha256: digest, installedAt: new Date().toISOString() }, null, 2)}\n`);
    return { downloaded: true, version, asset, sha256: digest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function listDirs(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

// Обычный запуск принимает токен Frontsmith и не выдаёт код входа никому другому.
export async function verifyClosedMode(paths) {
  const server = await startCrmkit({ paths, port: await freePort() });
  try {
    const credential = readCredential(paths);
    const whoami = await new CrmkitClient({ baseUrl: server.url, token: credential.token }).request("GET", "/whoami");
    const anonymous = new CrmkitClient({ baseUrl: server.url });
    const leak = await anonymous.request("POST", "/auth/request", { email: credential.email }).then((body) => body.local_code ?? "no_code", (error) => error.code);
    return { workspaceId: whoami.workspace_id, tokenAccepted: whoami.workspace_id === credential.workspaceId, authRequest: leak };
  } finally {
    await server.stop();
  }
}

export async function bootstrapCrm(paths = crmPaths(), { log = console.log } = {}) {
  log(`\n▸ crmkit ${CRMKIT.tag} (${crmkitAsset().file})`);
  const install = await installCrmkit(paths, { log: (text) => log(`  ${text}`) });
  log(install.downloaded ? `  ${install.version}, распакован из поставки; SHA-256 проверен (manifest, зафиксированный, checksums.txt)` : `  уже установлен: ${install.version}`);

  log("\n▸ хранилище CRM");
  protectDir(paths.dataDir);
  log(writeConfig(paths) ? `  конфигурация создана: ${paths.config}` : "  конфигурация уже есть");
  for (const line of runMigrations(paths).filter((text) => /^(current|latest)/.test(text))) log(`  ${line}`);

  log("\n▸ учётные данные доверенного процесса Frontsmith");
  const provisioned = await provisionCredential(paths);
  log(provisioned.created ? "  токен получен штатным входом crmkit (local mode, случайный порт)" : "  токен уже есть");

  log("\n▸ проверка обычного режима");
  const check = await verifyClosedMode(paths);
  if (!check.tokenAccepted) throw new Error("crmkit не принял токен Frontsmith");
  if (check.authRequest !== "email_failed") throw new Error(`обычный режим выдал ответ на /auth/request: ${check.authRequest}`);
  log("  токен принят, новый код входа не выдаётся (почта закрыта)");
  return { install, provisioned: provisioned.created, check };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const paths = crmPaths();
  console.log(`Каталог данных Frontsmith: ${paths.root}`);
  try {
    await bootstrapCrm(paths);
  } catch (error) {
    fail(error.message);
  }
  console.log(`\n✓ CRM готов\n  crmkitd: ${paths.binary}\n  база:    ${paths.db}`);
}
