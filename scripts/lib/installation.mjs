// Состояние установки Frontsmith для npm run bootstrap и npm run frontsmith.
// Отдельной базы установщика нет: состояние выводится из уже существующих маркеров —
// маркеров runtime (privacy-runtime.json, crmkit-runtime.json), учётных данных CRM,
// schema_migrations офисной базы и карантина прежних контактов (legacy_customer_contacts).
//
//   fresh    офисной базы нет: новая установка, клиенты сразу через CustomerProvider
//   current  схема актуальна, контактов клиентов в офисной базе нет
//   outdated есть неприменённые миграции, контактов прежней модели нет
//   legacy   контакты клиентов ещё в офисной базе: перенос только явной командой
//            npm run crm:migrate-customers -- --dry-run, затем --confirm
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMigrations, officeDbExists, officeDbPath, openOfficeDb, schemaVersion } from "../../office/lib/db.mjs";
import { crmPaths, crmStatus, readCredential } from "../../services/crm/runtime.mjs";
import { dataRoot, runtimePaths, runtimeStatus } from "../../services/privacy/runtime.mjs";
import { businessPath, businessRoot } from "./paths.mjs";

export const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function latestSchema() {
  return Math.max(...listMigrations().map((migration) => migration.version));
}

// Каталог данных вне репозитория: там токен CRM, состояние псевдонимизации и runtime
export function assertDataRootOutsideRepo(root = dataRoot()) {
  const relative = path.relative(projectRoot, path.resolve(root));
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw Object.assign(new Error(`каталог данных Frontsmith не может находиться в репозитории: ${root}`), { code: "DATA_ROOT_INVALID" });
  }
  return root;
}

// Сводка офисной базы без значений: количества, версии и экземпляры CRM в связях
export function inspectBusinessDb(file = officeDbPath()) {
  if (!officeDbExists(file)) return { exists: false, file, kind: "fresh" };
  const db = openOfficeDb({ file, readonly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    // Пустой файл остаётся после прерванной первой подготовки
    if (!tables.size) return { exists: true, file, kind: "fresh" };
    if (!tables.has("schema_migrations")) return { exists: true, file, kind: "foreign", schema: 0, latest: latestSchema() };
    const schema = schemaVersion(db);
    const count = (sql) => db.prepare(sql).get().n;
    const customerColumns = tables.has("customers") ? db.prepare("PRAGMA table_info(customers)").all().map((column) => column.name) : [];
    const customers = tables.has("customers") ? count("SELECT count(*) AS n FROM customers") : 0;
    // До миграции 004 контакты лежат в самой таблице customers
    const legacyContacts = tables.has("legacy_customer_contacts")
      ? count("SELECT count(*) AS n FROM legacy_customer_contacts")
      : customerColumns.includes("full_name") ? customers : 0;
    const links = tables.has("customer_provider_links") ? count("SELECT count(*) AS n FROM customer_provider_links") : 0;
    const instances = tables.has("customer_provider_links")
      ? db.prepare("SELECT DISTINCT provider, provider_instance FROM customer_provider_links").all()
      : [];
    const business = tables.has("business") && Boolean(db.prepare("SELECT 1 FROM business WHERE singleton = 1").get());
    const latest = latestSchema();
    const kind = legacyContacts > 0 ? "legacy" : schema < latest ? "outdated" : "current";
    return { exists: true, file, kind, schema, latest, customers, legacyContacts, links, instances, business, piiColumns: customerColumns.includes("full_name") };
  } finally {
    db.close();
  }
}

export function inspectInstallation() {
  const root = dataRoot();
  const crm = crmStatus(crmPaths(root));
  const privacy = runtimeStatus(runtimePaths(root));
  const credential = crm.ready ? readCredential(crm.paths) : null;
  return {
    dataRoot: root,
    businessRoot: path.resolve(businessRoot()),
    profile: existsSync(businessPath("business.json")),
    business: inspectBusinessDb(),
    crm,
    crmWorkspace: credential?.workspaceId ?? null,
    privacy
  };
}

// Связи client_id из другого экземпляра CRM означают, что офисная база и каталог
// данных не принадлежат одной установке
export function foreignCrmLinks(business, workspaceId) {
  if (!business.exists || !workspaceId) return [];
  return (business.instances ?? []).filter((row) => row.provider === "crmkit" && row.provider_instance !== workspaceId);
}

export const LEGACY_HINT = "Legacy customer storage detected.\nRun:\nnpm run crm:migrate-customers -- --dry-run";
