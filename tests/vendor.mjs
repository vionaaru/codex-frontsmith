// Поставка сторонних компонентов (vendor/): обнаружение указателей Git LFS, сверка SHA-256
// и размеров, отпечатки деревьев исходников, проверка настоящих файлов поставки.
// Без установки runtime и без сети
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRMKIT, crmkitAsset } from "../services/crm/runtime.mjs";
import { PINS, VENDOR, nerModelStatus } from "../services/privacy/runtime.mjs";
import { assertBundledPlatform, assertComponents, component, isLfsPointer, projectRoot, readManifest, treeDigest, verifyComponent, verifyFile } from "../scripts/lib/vendor.mjs";

const temp = mkdtempSync(path.join(os.tmpdir(), "frontsmith-vendor-"));
const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:2b9510cd99101c05800c3b4bcaeaebb26d285aa3152e49bea09dc5c2a38d4b16\nsize 711022548\n";
const rel = (file) => path.relative(projectRoot, file).split(path.sep).join("/");
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

try {
  const manifest = readManifest();

  await check("manifest: версии совпадают с зафиксированными в коде", async () => {
    assert.equal(component(manifest, "crmkit-binary").version, CRMKIT.version);
    assert.equal(component(manifest, "crmkit-source").source.commit, CRMKIT.commit);
    assert.equal(component(manifest, "pii-guard").source.commit, PINS.piiGuardCommit);
    assert.equal(component(manifest, "ner-model").source.revision, PINS.nerRevision);
    assert.equal(component(manifest, "crmkit-binary").files[0].sha256, crmkitAsset("win32-x64").sha256);
  });

  await check("указатель Git LFS распознаётся, настоящий файл — нет", async () => {
    const pointer = path.join(temp, "pointer.safetensors");
    writeFileSync(pointer, POINTER);
    assert.equal(isLfsPointer(pointer), true);
    const small = path.join(temp, "small.json");
    writeFileSync(small, "{}");
    assert.equal(isLfsPointer(small), false);
    assert.equal(isLfsPointer(path.join(VENDOR.nerModel, "config.json")), false);
  });

  await check("сверка файла: отсутствует, указатель LFS, размер, SHA-256", async () => {
    const file = path.join(temp, "artifact.bin");
    writeFileSync(file, "frontsmith");
    const sha256 = "58c7e1e4d8f69e1df8e2d5a27a92cb4dcf0b1a2dc4e5c4a9d56a7e4e1d0ad4b5";
    assert.equal((await verifyFile({ path: rel(path.join(temp, "missing.bin")), sha256 })).reason, "missing");
    assert.equal((await verifyFile({ path: rel(file), size: 3, sha256 })).reason, "size_mismatch");
    assert.equal((await verifyFile({ path: rel(file), size: 10, sha256 })).reason, "sha256_mismatch");
    writeFileSync(file, POINTER);
    assert.equal((await verifyFile({ path: rel(file), lfs: true, sha256 })).reason, "lfs_pointer");
  });

  await check("указатели LFS вместо весов — понятная ошибка до установки", async () => {
    const dir = path.join(temp, "ner");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "model.safetensors"), POINTER);
    assert.equal(nerModelStatus(dir).reason, "ner_model_lfs_pointer");
    assert.equal(nerModelStatus(path.join(temp, "none")).reason, "ner_model_missing");
    const fake = { components: [{ id: "ner-model", files: [{ path: rel(path.join(dir, "model.safetensors")), lfs: true, size: 711022548, sha256: "0" }] }] };
    await assert.rejects(assertComponents(["ner-model"], fake), (error) => error.code === "LFS_OBJECTS_MISSING" && /git lfs pull/.test(error.message));
  });

  await check("отпечаток дерева исходников зависит от содержимого и путей", async () => {
    const dir = path.join(temp, "tree");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.py"), "a = 1\n");
    const first = await treeDigest(dir);
    assert.deepEqual(await treeDigest(dir), first);
    writeFileSync(path.join(dir, "src", "a.py"), "a = 1\r\n");
    assert.notEqual((await treeDigest(dir)).digest, first.digest, "смена концов строк заметна");
  });

  await check("настоящая поставка: crmkit, pii-guard, uv и Python совпадают с manifest", async () => {
    for (const id of ["crmkit-binary", "crmkit-source", "pii-guard", "uv", "python"]) {
      assert.deepEqual(await verifyComponent(component(manifest, id)), [], id);
    }
    assert.equal(nerModelStatus().ready, true, "веса NER — настоящий файл");
  });

  await check("поддерживаемая платформа поставки — только Windows x64", async () => {
    assert.doesNotThrow(() => assertBundledPlatform("win32-x64"));
    assert.throws(() => assertBundledPlatform("linux-x64"), (error) => error.code === "PLATFORM_NOT_BUNDLED");
    assert.throws(() => assertBundledPlatform("darwin-arm64"), (error) => error.code === "PLATFORM_NOT_BUNDLED");
  });

  console.log(`Vendor: ${passed} проверок пройдено`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
