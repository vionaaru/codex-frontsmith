// Isolated artificial companies; no production data, AI calls or outbound delivery.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultBrand, validateBrand, brandCss, brandAsset } from "../scripts/lib/brand.mjs";
import { createOfficeServer } from "../office/server.mjs";
import { freePort } from "../services/crm/runtime.mjs";
import { POST as contactPost } from "../api/contact.js";

const exec = promisify(execFile);
const repo = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "frontsmith-design-"));
const root = path.join(temp, "business");
const data = path.join(temp, "data");
const env = { ...process.env, FRONTSMITH_BUSINESS_ROOT: root, FRONTSMITH_DATA_ROOT: data };
const oldRoot = process.env.FRONTSMITH_BUSINESS_ROOT;
process.env.FRONTSMITH_BUSINESS_ROOT = root;
let server;
let passed = 0;
const run = (script, ...args) => exec(process.execPath, [path.join(repo, script), ...args], { cwd: repo, env });
const design = (...args) => run("scripts/design.mjs", ...args);
const status = async () => JSON.parse((await design("status")).stdout);
const put = async (relative, text) => { const file = path.join(root, "design", relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
async function check(name, action) { await action(); passed++; console.log(`✓ ${name}`); }
try {
  await check("проверка токенов и защита от инъекции/низкого контраста", async () => {
    validateBrand(defaultBrand);
    assert.match(brandCss(defaultBrand), /prefers-color-scheme:dark/);
    assert.throws(() => validateBrand({ ...defaultBrand, font: "Arial;url(https://bad.example)" }));
    assert.throws(() => validateBrand({ ...defaultBrand, light: { ...defaultBrand.light, text: defaultBrand.light.page } }));
    assert.throws(() => validateBrand({ ...defaultBrand, fontFace: { family: "unsafe';x", file: "brand.woff2" } }));
    assert.match(brandCss(validateBrand({ ...defaultBrand, fontFace: { family: "Company Sans", file: "brand.woff2" } })), /@font-face/);
  });
  await run("scripts/business-init.mjs");
  await design("init");
  await cp("tests/fixtures/brand-independent", path.join(root, "design", "inputs"), { recursive: true });
  await check("возобновление в новом процессе и зависимые этапы", async () => {
    assert.equal((await status()).next, "research");
    await put("research.md", "Искусственный исследовательский результат, не визуальная приёмка");
    await design("checkpoint", "research", "research.md");
    assert.equal((await status()).next, "brand");
    await put("brand.json", JSON.stringify(defaultBrand));
    await put("BRAND-DESIGN.md", "Искусственная спецификация механического теста");
    await design("validate");
    await design("checkpoint", "brand", "brand.json", "BRAND-DESIGN.md");
    assert.equal((await status()).next, "preview");
    await put("inputs/brief.md", "Изменённый искусственный бриф");
    assert.deepEqual((await status()).stages.slice(0, 2).map((s) => s.status), ["stale", "stale"]);
    await design("checkpoint", "research", "research.md");
    await design("checkpoint", "brand", "brand.json", "BRAND-DESIGN.md");
    await assert.rejects(design("checkpoint", "preview", "../business.json"));
  });
  await check("клиентская композиция и бренд переживают обновление сведений", async () => {
    const original = await readFile("blueprints/generic-service/website/index.html", "utf8");
    await put("site/index.html", original.replace('<main id="top">', '<main id="top" data-art-direction="garden-editorial">'));
    await put("site/site.css", ".hero-heading-row{grid-template-columns:1fr}.hero h1{font-family:Georgia,serif}");
    await run("scripts/update-website.mjs");
    const profilePath = path.join(root, "business.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.businessName = "Вереск — искусственный пример";
    await writeFile(profilePath, JSON.stringify(profile));
    await run("scripts/update-website.mjs");
    const html = await readFile(path.join(root, "website/index.html"), "utf8");
    assert.match(html, /garden-editorial/); assert.match(html, /Вереск/); assert.match(html, /brand-theme.js/); assert.match(html, /chat-widget.js/);
    assert.match(await readFile(path.join(root, "website/site.css"), "utf8"), /Georgia/);
  });
  await check("ручные CSS/JS/HTML правки блокируют генерацию до изменения сайта", async () => {
    for (const name of ["styles.css", "chat-widget.js", "index.html"]) {
      const file = path.join(root, "website", name); const original = await readFile(file, "utf8");
      const before = await readFile(path.join(root, "website/index.html"), "utf8");
      await writeFile(file, original + "\n/* owner edit */");
      await assert.rejects(run("scripts/update-website.mjs"), (e) => /изменён после последней генерации/.test(e.stderr));
      assert.equal(await readFile(file, "utf8"), original + "\n/* owner edit */");
      if (name !== "index.html") assert.equal(await readFile(path.join(root, "website/index.html"), "utf8"), before);
      await writeFile(file, original);
    }
  });
  await check("неполный клиентский HTML отклоняется без изменения результата", async () => {
    const file = path.join(root, "design/site/index.html"); const template = await readFile(file, "utf8");
    const before = await readFile(path.join(root, "website/index.html"), "utf8");
    await writeFile(file, template.replace('data-intake-form', 'data-broken-form'));
    await assert.rejects(run("scripts/update-website.mjs"), (e) => /обязательный контракт/.test(e.stderr));
    assert.equal(await readFile(path.join(root, "website/index.html"), "utf8"), before);
    await writeFile(file, template);
  });
  await check("имена полей email/phone сохраняют контракт FormData и сервера", async () => {
    const file = path.join(root, "design/site/index.html");
    const template = await readFile(file, "utf8");
    const generated = path.join(root, "website/index.html");
    const before = await readFile(generated, "utf8");
    for (const name of ["email", "phone"]) {
      for (const broken of [
        template.replace(`name="${name}"`, `name="customer_${name}"`),
        template.replace(`name="${name}"`, `disabled name="${name}"`),
        template.replace(`name="${name}"`, `form="other-form" name="${name}"`),
        template.replace(`name="${name}"`, `name="${name}" data-frontsmith-attrs="name:businessName"`),
        template.replace('</form>', `<input type="hidden" name="${name}"></form>`)
      ]) {
        await writeFile(file, broken);
        await assert.rejects(run("scripts/update-website.mjs"), (e) => e.stderr.includes(`поле data-contact-${name}`));
        assert.equal(await readFile(generated, "utf8"), before);
      }
    }
    // Attribute order, whitespace and single quotes do not change browser semantics.
    await writeFile(file, template.replace('name="email" type="email"', "type='email' name = 'email'"));
    await run("scripts/update-website.mjs");
    const html = await readFile(generated, "utf8");
    const payload = new FormData();
    for (const name of ["email", "phone"]) {
      const tag = [...html.matchAll(/<input\b[^>]*>/g)].find(([tag]) => tag.includes(`data-contact-${name}`))[0];
      const key = /\bname\s*=\s*(["'])(.*?)\1/.exec(tag)[2];
      payload.set(key, name === "email" ? "fixture@example.com" : "+79990000000");
    }
    const oldMode = process.env.CONTACT_DELIVERY_MODE;
    process.env.CONTACT_DELIVERY_MODE = "dry-run";
    try {
      const response = await contactPost(new Request("http://localhost/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(payload)) }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, "dry-run");
    } finally {
      if (oldMode === undefined) delete process.env.CONTACT_DELIVERY_MODE; else process.env.CONTACT_DELIVERY_MODE = oldMode;
    }
    await writeFile(file, template);
    await run("scripts/update-website.mjs");
  });
  await check("удалённые ресурсы убираются только по квитанции; ручные правки защищены", async () => {
    const source = path.join(root, "design/public/retired.png");
    const output = path.join(root, "website/brand-assets/retired.png");
    const receipt = path.join(root, ".website-render.json");
    await put("public/retired.png", "artificial generated bytes");
    await run("scripts/update-website.mjs");
    const unmanaged = path.join(root, "website/brand-assets/owner.png");
    await writeFile(unmanaged, "owner's unrelated resource");
    await rm(source);
    await run("scripts/update-website.mjs");
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assert.equal(await readFile(unmanaged, "utf8"), "owner's unrelated resource");
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).files["brand-assets/retired.png"], undefined);
    await put("public/retired.png", "second generated version");
    await run("scripts/update-website.mjs");
    await writeFile(output, "owner's edited image bytes");
    await rm(source);
    const beforeReceipt = await readFile(receipt, "utf8");
    const beforeHtml = await readFile(path.join(root, "website/index.html"), "utf8");
    const beforeCss = await readFile(path.join(root, "website/site.css"), "utf8");
    await put("site/site.css", beforeCss + "\n/* next generation */");
    await assert.rejects(run("scripts/update-website.mjs"), (e) => /изменён после последней генерации/.test(e.stderr));
    assert.equal(await readFile(output, "utf8"), "owner's edited image bytes");
    assert.equal(await readFile(receipt, "utf8"), beforeReceipt);
    assert.equal(await readFile(path.join(root, "website/index.html"), "utf8"), beforeHtml);
    assert.equal(await readFile(path.join(root, "website/site.css"), "utf8"), beforeCss);
    const { stdout } = await run("scripts/update-website.mjs", "--force");
    const backup = /Прежний файл сохранён: (.+)/.exec(stdout)[1].trim();
    assert.ok(path.resolve(backup).startsWith(path.resolve(data, "backups") + path.sep));
    assert.equal(await readFile(backup, "utf8"), "owner's edited image bytes");
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assert.equal(await readFile(unmanaged, "utf8"), "owner's unrelated resource");
  });
  await check("удаление управляемого ресурса не следует по подменённому каталогу", async () => {
    await put("public/junction.png", "owned resource");
    await run("scripts/update-website.mjs");
    await rm(path.join(root, "design/public/junction.png"));
    const directory = path.join(root, "website/brand-assets");
    const saved = path.join(root, "website/saved-brand-assets");
    const outside = path.join(temp, "outside-site");
    await mkdir(outside);
    await writeFile(path.join(outside, "junction.png"), "unrelated private fixture");
    await rename(directory, saved);
    let linked = false;
    try {
      await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
      linked = true;
      const before = await readFile(path.join(root, ".website-render.json"), "utf8");
      await assert.rejects(run("scripts/update-website.mjs"), (e) => /по ссылке или вне сайта/.test(e.stderr));
      assert.equal(await readFile(path.join(outside, "junction.png"), "utf8"), "unrelated private fixture");
      assert.equal(await readFile(path.join(root, ".website-render.json"), "utf8"), before);
    } finally {
      if (linked) await unlink(directory);
      await rename(saved, directory);
    }
    await run("scripts/update-website.mjs");
  });
  await check("проверка становится stale при правке готового сайта", async () => {
    await design("checkpoint", "research", "research.md"); await design("checkpoint", "brand", "brand.json", "BRAND-DESIGN.md");
    await put("review/preview.md", "Механический тест: не решение владельца"); await design("checkpoint", "preview", "review/preview.md");
    await put("review/implementation.md", "Механический тест"); await design("checkpoint", "implementation", "site/index.html", "site/site.css", "review/implementation.md");
    await put("review/verification.md", "Механический тест"); await design("checkpoint", "verification", "review/verification.md");
    assert.equal((await status()).next, null);
    const file = path.join(root, "website/site.css"); const css = await readFile(file, "utf8"); await writeFile(file, css + "\n/* changed */");
    assert.equal((await status()).next, "implementation"); await writeFile(file, css);
  });
  await check("добавление, замена, переименование и удаление public-актива инвалидируют бренд", async () => {
    const mutations = [
      () => put("public/progress.png", "artificial image one"),
      () => put("public/progress.png", "artificial image two"),
      () => rename(path.join(root, "design/public/progress.png"), path.join(root, "design/public/moved.png")),
      () => rm(path.join(root, "design/public/moved.png"))
    ];
    for (const mutate of mutations) {
      await design("checkpoint", "brand", "brand.json", "BRAND-DESIGN.md");
      await design("checkpoint", "preview", "review/preview.md");
      await design("checkpoint", "implementation", "site/index.html", "site/site.css", "review/implementation.md");
      await design("checkpoint", "verification", "review/verification.md");
      assert.equal((await status()).next, null);
      await mutate();
      const result = await status();
      assert.equal(result.next, "brand");
      assert.deepEqual(result.stages.map((s) => s.status), ["complete", "stale", "stale", "stale", "stale"]);
    }
  });
  await check("офис отдаёт токены, но не исходные материалы/состояние", async () => {
    await put("public/logo.PNG", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh9sAAAAASUVORK5CYII=", "base64"));
    await put("brand.json", JSON.stringify({ ...defaultBrand, logo: "logo.PNG" }));
    const port = await freePort(); server = createOfficeServer({ port }); await new Promise((resolve) => server.server.listen(port, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${port}`;
    const css = await fetch(base + "/brand.css"); assert.equal(css.status, 200); assert.match(await css.text(), /brand-accent/);
    const page = await fetch(base); const html = await page.text(); assert.match(html, /brand-theme.js/); assert.match(html, /brand-assets\/logo.PNG/);
    assert.equal((await fetch(base + "/brand-assets/logo.PNG")).headers.get("content-type"), "image/png");
    assert.equal((await fetch(base + "/brand-assets/progress.json")).status, 404);
    assert.equal((await fetch(base + "/design/inputs/brief.md")).status, 404);
    await assert.rejects(brandAsset("../brand.json"));
  });
  await check("навык самодостаточен и все ссылки references существуют", async () => {
    const skill = ".agents/skills/frontsmith-brand"; const main = await readFile(path.join(skill, "SKILL.md"), "utf8");
    for (const match of main.matchAll(/\]\((references\/[^)]+)\)/g)) await readFile(path.join(skill, match[1]));
    assert.doesNotMatch(main, /for feat/);
  });
} finally {
  if (server) await server.close();
  if (oldRoot === undefined) delete process.env.FRONTSMITH_BUSINESS_ROOT; else process.env.FRONTSMITH_BUSINESS_ROOT = oldRoot;
  await rm(temp, { recursive: true, force: true });
}
console.log(`Design: ${passed} проверок пройдено`);
