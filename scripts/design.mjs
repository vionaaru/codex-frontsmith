import { mkdir } from "node:fs/promises";
import { businessPath } from "./lib/paths.mjs";
import { checkpoint, designStatus } from "./lib/design-progress.mjs";
import { loadBrand } from "./lib/brand.mjs";

try {
  const [command = "status", stage, ...artifacts] = process.argv.slice(2);
  if (command === "init") {
    for (const dir of ["inputs", "public", "site", "review"]) await mkdir(businessPath("design", dir), { recursive: true });
    console.log("Материалы компании: design/inputs/ в приватной рабочей области бизнеса");
  } else if (command === "status") console.log(JSON.stringify(await designStatus(), null, 2));
  else if (command === "checkpoint") console.log(JSON.stringify(await checkpoint(stage, artifacts), null, 2));
  else if (command === "validate") {
    const brand = await loadBrand();
    if (!brand) throw new Error("design/brand.json отсутствует");
    console.log("brand.json: структура и основные текстовые контрасты проверены; визуальная проверка нужна отдельно");
  } else throw new Error("Использование: npm run design -- init|status|validate|checkpoint ЭТАП АРТЕФАКТ...");
} catch (error) { console.error(error.message); process.exitCode = 1; }
