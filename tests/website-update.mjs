// npm run update:website: бренд компании из профиля в любом шаблоне (в том числе в учебном
// шаблоне автосервиса) и защита рабочего index.html, изменённого после последней генерации.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = await mkdtemp(path.join(os.tmpdir(), "frontsmith-website-update-"));
const data = path.join(testRoot, "data");
let passed = 0;

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function node(root, script, ...args) {
  const env = { ...process.env, FRONTSMITH_BUSINESS_ROOT: root, FRONTSMITH_DATA_ROOT: data };
  return execFileAsync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, env });
}

try {
  const auto = path.join(testRoot, "auto");
  await check("auto-service: update:website подставляет бренд компании, а не «АвтоРитм»", async () => {
    await node(auto, "scripts/business-init.mjs", "--blueprint", "auto-service");
    const file = path.join(auto, "business.json");
    const profile = JSON.parse(await readFile(file, "utf8"));
    profile.businessName = "Тест Сервис";
    profile.media = { ...profile.media, logoImage: "/test-mark.svg" };
    await writeFile(file, JSON.stringify(profile, null, 2));
    await node(auto, "scripts/update-website.mjs");
    const site = await readFile(path.join(auto, "website", "index.html"), "utf8");
    assert.doesNotMatch(site, /АвтоРитм|avtoritm-mark/);
    assert.match(site, /aria-label="Тест Сервис — в начало страницы"/);
    assert.equal(site.match(/src="\/test-mark\.svg"/g)?.length, 2, "логотип в шапке и подвале");
  });

  await check("повторная генерация без ручных правок проходит", async () => {
    await node(auto, "scripts/update-website.mjs");
  });

  await check("изменённый после генерации index.html не перезаписывается молча", async () => {
    const index = path.join(auto, "website", "index.html");
    const edited = `${await readFile(index, "utf8")}<!-- правка владельца -->\n`;
    await writeFile(index, edited);
    await assert.rejects(node(auto, "scripts/update-website.mjs"), (error) => /изменён после последней генерации/.test(error.stderr));
    assert.equal(await readFile(index, "utf8"), edited, "страница не изменена");
  });

  await check("--force заменяет страницу шаблоном и сохраняет прежнюю в каталоге данных", async () => {
    const index = path.join(auto, "website", "index.html");
    const edited = await readFile(index, "utf8");
    const { stdout } = await node(auto, "scripts/update-website.mjs", "--force");
    assert.match(stdout, /Прежний index\.html сохранён/);
    const backups = readdirSync(path.join(data, "backups", "website"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(data, "backups", "website", backups[0]), "utf8"), edited);
    assert.doesNotMatch(await readFile(index, "utf8"), /правка владельца/);
    assert.ok(!existsSync(path.join(auto, "website", ".website-render.json")), "отпечаток генерации не публикуется на сайте");
  });

  await check("generic-service: генерация и повторное обновление без «АвтоРитм»", async () => {
    const generic = path.join(testRoot, "generic");
    await node(generic, "scripts/business-init.mjs");
    await node(generic, "scripts/update-website.mjs");
    const site = await readFile(path.join(generic, "website", "index.html"), "utf8");
    assert.doesNotMatch(site, /АвтоРитм|avtoritm/);
    assert.match(site, /Новая компания/);
  });
} finally {
  await rm(testRoot, { recursive: true, force: true }).catch(() => {});
}
console.log(`Website update: ${passed} проверок пройдено`);
