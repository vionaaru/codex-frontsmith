// Explicit browser check, no new packages, real account, AI or outbound delivery.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { contactFormCases } from "./fixtures/contact-form-cases.mjs";
import { assertIntakeFormContract } from "../scripts/lib/website-contract.mjs";

const browser = [process.env.FRONTSMITH_TEST_BROWSER, ...[process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).flatMap((base) => [path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(base, "Google", "Chrome", "Application", "chrome.exe")])].find((file) => file && existsSync(file));
if (!browser) throw new Error("Для проверки настоящего FormData нужен установленный Edge/Chrome или FRONTSMITH_TEST_BROWSER; ничего не скачивается");
for (const item of contactFormCases) {
  if (item.accepted) assert.doesNotThrow(() => assertIntakeFormContract(item.html), item.name);
  else assert.throws(() => assertIntakeFormContract(item.html), /Клиентский шаблон/, item.name);
}
const root = await mkdtemp(path.join(os.tmpdir(), "frontsmith-formdata-"));
try {
  const html = `<!doctype html><meta charset="utf-8"><title>Artificial FormData regression</title><pre id="result"></pre><script>
  const cases=${JSON.stringify(contactFormCases).replaceAll("<", "\\u003c")};
  const failures=[];
  const canonical=(value)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
  for(const item of cases){
    const fixture=document.createElement('div');fixture.innerHTML=item.html;document.body.appendChild(fixture);
    const actual=Object.fromEntries(new FormData(fixture.querySelector('[data-intake-form]')));
    if(canonical(actual)!==canonical(item.payload))failures.push({name:item.name,actual,expected:item.payload});
    fixture.remove();
  }
  const result=document.getElementById('result');result.dataset.result=failures.length?'fail':'pass';result.textContent=JSON.stringify({cases:cases.length,failures});
  </script>`;
  const file = path.join(root, "formdata.html");
  await writeFile(file, html);
  const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", `--user-data-dir=${path.join(root, "browser-profile")}`, "--dump-dom", pathToFileURL(file).href], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /<pre id="result" data-result="pass">/, stdout);
  console.log(`Browser FormData: ${contactFormCases.length} проверок пройдено; контракт и настоящая сериализация проверены отдельно`);
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error("Отказ очистки вне временного каталога");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
