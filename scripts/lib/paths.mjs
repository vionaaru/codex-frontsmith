import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const defaultBusinessRoot = path.join(".frontsmith", "business");
export const websiteSourceRoot = "website";
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

export function businessRoot() {
  const configuredRoot = process.env.FRONTSMITH_BUSINESS_ROOT?.trim();
  const root = configuredRoot ? path.normalize(configuredRoot) : defaultBusinessRoot;
  const relative = path.relative(projectRoot, path.resolve(root));
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) &&
      relative !== ".frontsmith" && !relative.startsWith(`.frontsmith${path.sep}`)) {
    throw new Error("Рабочие данные внутри репозитория разрешены только в игнорируемом .frontsmith/. Используйте .frontsmith/business или каталог вне проекта.");
  }
  return root;
}

export function businessPath(...segments) {
  return path.join(businessRoot(), ...segments);
}

export function businessWebsiteRoot() {
  return businessPath("website");
}

export function previewWebsiteRoot({ source = false } = {}) {
  return !source && existsSync(path.join(businessWebsiteRoot(), "index.html"))
    ? businessWebsiteRoot() : websiteSourceRoot;
}
