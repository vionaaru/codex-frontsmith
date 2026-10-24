// Бизнес-профили (blueprints): стартовый профиль, шаблон сайта и отраслевые модули офиса.
// Ядро (клиенты через CustomerProvider, Privacy, AI) от профиля не зависит: профиль только
// включает отраслевые разделы панели и выбирает стартовые данные новой установки.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// Универсальные модули есть в любом профиле; отраслевые включает blueprint.json → officeModules
export const CORE_OFFICE_MODULES = ["customers", "inquiries", "tasks", "services", "schedule"];
export const INDUSTRY_OFFICE_MODULES = ["vehicles", "work-orders", "work-results"];

// Профили, созданные до появления поля blueprint, — учебный автосервис: отраслевые разделы
// остаются включёнными, существующая установка не перенастраивается
export const LEGACY_BLUEPRINT = "auto-service";

export function defaultBlueprintId() {
  const config = JSON.parse(readFileSync(path.join(projectRoot, "frontsmith.config.json"), "utf8"));
  return config.defaultBlueprint;
}

export function blueprintDir(id) {
  if (!/^[a-z0-9-]+$/.test(String(id ?? ""))) throw new Error(`Неверный идентификатор профиля: ${id}`);
  return path.join(projectRoot, "blueprints", id);
}

export function loadBlueprint(id) {
  const file = path.join(blueprintDir(id), "blueprint.json");
  if (!existsSync(file)) throw new Error(`Профиль ${id} не найден: ${path.relative(projectRoot, file)}`);
  const blueprint = JSON.parse(readFileSync(file, "utf8"));
  if (blueprint.id !== id) throw new Error(`${path.relative(projectRoot, file)}: id «${blueprint.id}» не совпадает с каталогом`);
  return blueprint;
}

// Файл стартового профиля blueprint, относительно корня проекта
export function exampleProfileFile(id) {
  const blueprint = loadBlueprint(id);
  if (!blueprint.exampleProfile) throw new Error(`У профиля ${id} нет стартового business.example.json`);
  return blueprint.exampleProfile;
}

// Шаблон сайта blueprint; без поля — общий website/index.html
export function websiteTemplateFile(profile) {
  const blueprint = profileBlueprint(profile);
  return blueprint?.websiteTemplate ?? path.join("website", "index.html");
}

export function profileBlueprint(profile) {
  const id = profile?.blueprint ?? LEGACY_BLUEPRINT;
  try {
    return loadBlueprint(id);
  } catch {
    return null;
  }
}

// Включённые разделы офиса. Неизвестный профиль — все разделы: лучше лишний пустой раздел,
// чем скрытые данные существующей установки
export function officeModules(profile) {
  const blueprint = profileBlueprint(profile);
  if (!blueprint || !Array.isArray(blueprint.officeModules)) return [...CORE_OFFICE_MODULES, ...INDUSTRY_OFFICE_MODULES];
  return [...new Set([...CORE_OFFICE_MODULES, ...blueprint.officeModules.filter((module) => INDUSTRY_OFFICE_MODULES.includes(module))])];
}
