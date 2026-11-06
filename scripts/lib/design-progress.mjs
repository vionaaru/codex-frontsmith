// Small file-based checkpoints, independently verifiable after a new Codex session.
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rename, realpath } from "node:fs/promises";
import path from "node:path";
import { businessPath } from "./paths.mjs";

export const stages = ["research", "brand", "preview", "implementation", "verification"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(root, prefix = "") {
  let entries;
  try { entries = await readdir(path.join(root, prefix), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error("Ссылки в материалах дизайна не поддерживаются");
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, relative));
    else if (entry.isFile()) result.push([relative, hash(await readFile(path.join(root, relative)))]);
  }
  return result;
}
async function inputs() {
  const material = await files(businessPath("design", "inputs"));
  const publicAssets = await files(businessPath("design", "public"));
  let profile = null;
  try { profile = hash(await readFile(businessPath("business.json"))); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { material, profile, publicAssets: hash(JSON.stringify(publicAssets)), digest: hash(JSON.stringify({ material, profile })) };
}
async function state() {
  try { return JSON.parse(await readFile(businessPath("design", "progress.json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { version: 1, stages: {} }; throw e; }
}
async function outputDigest() {
  const outputs = await files(businessPath("website"));
  const code = [];
  for (const file of ["scripts/lib/brand.mjs", "scripts/lib/render-website.mjs", "scripts/lib/website-contract.mjs", "scripts/lib/website-paths.mjs", "website/brand-base.css", "website/brand-theme.js", "website/chat-widget.js", "office/public/styles.css", "office/public/app.js", "office/public/index.html", "office/server.mjs"]) code.push([file, hash(await readFile(file))]);
  return hash(JSON.stringify({ outputs, code }));
}
async function safeArtifact(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Артефакт должен находиться внутри design/");
  const root = await realpath(businessPath("design"));
  const file = await realpath(path.join(root, relative));
  if (!file.startsWith(root + path.sep) || relative.replaceAll("\\", "/") === "progress.json" || relative.replaceAll("\\", "/").startsWith("inputs/")) throw new Error("Недопустимый артефакт");
  return hash(await readFile(file));
}
export async function designStatus() {
  const current = await inputs();
  const saved = await state();
  let previous = current.digest;
  let stale = false;
  const results = [];
  for (const stage of stages) {
    const item = saved.stages[stage];
    let valid = !stale && item?.input === previous && Object.keys(item?.artifacts ?? {}).length > 0;
    if (valid && stage === "brand" && item.publicAssets !== current.publicAssets) valid = false;
    if (valid) for (const [file, expected] of Object.entries(item.artifacts)) {
      try { if (await safeArtifact(file) !== expected) valid = false; } catch { valid = false; }
    }
    if (valid && item.output && item.output !== await outputDigest()) valid = false;
    results.push({ stage, status: valid ? "complete" : item ? "stale" : "pending", artifacts: Object.keys(item?.artifacts ?? {}) });
    stale ||= !valid;
    previous = valid ? hash(JSON.stringify(item)) : null;
  }
  return { version: 1, materialCount: current.material.length, profilePresent: current.profile !== null, stages: results, next: results.find((s) => s.status !== "complete")?.stage ?? null, input: current.digest };
}
export async function checkpoint(stage, artifacts) {
  const index = stages.indexOf(stage);
  if (index < 0 || !artifacts.length) throw new Error("Укажите этап и хотя бы один проверяемый артефакт");
  const status = await designStatus();
  if (!status.materialCount || !status.profilePresent) throw new Error("Нужны business.json и материалы в design/inputs/");
  if (status.stages.slice(0, index).some((s) => s.status !== "complete")) throw new Error("Сначала завершите предыдущие этапы");
  const saved = await state();
  const fingerprints = {};
  for (const file of artifacts) fingerprints[file] = await safeArtifact(file);
  saved.stages[stage] = { input: index === 0 ? status.input : hash(JSON.stringify(saved.stages[stages[index - 1]])), artifacts: fingerprints, recordedAt: new Date().toISOString() };
  if (stage === "brand") saved.stages[stage].publicAssets = (await inputs()).publicAssets;
  if (stage === "implementation" || stage === "verification") saved.stages[stage].output = await outputDigest();
  for (const following of stages.slice(index + 1)) delete saved.stages[following];
  const target = businessPath("design", "progress.json");
  const temporary = target + ".tmp";
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify(saved, null, 2) + "\n");
  await rename(temporary, target);
  return designStatus();
}
