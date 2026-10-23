import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { businessPath } from "../../scripts/lib/paths.mjs";

const migrationsDir = fileURLToPath(new URL("../db/migrations/", import.meta.url));

export function officeDbPath() {
  return businessPath("office.sqlite");
}

export function officeBackupDir() {
  return businessPath("backups");
}

export function officeDbExists(file = officeDbPath()) {
  return existsSync(file);
}

export function openOfficeDb({ file = officeDbPath(), readonly = false } = {}) {
  if (readonly && !existsSync(file)) {
    throw new OfficeDbMissingError(file);
  }
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  return db;
}

export class OfficeDbMissingError extends Error {
  constructor(file) {
    super(`База офиса не найдена: ${file}. Сначала выполните npm run office:init`);
    this.code = "OFFICE_DB_MISSING";
  }
}

export function listMigrations() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const raw = readFileSync(path.join(migrationsDir, name), "utf8");
      // Контрольная сумма не зависит от переводов строк: Git на Windows меняет LF на CRLF при checkout
      const sql = raw.replace(/\r\n/g, "\n");
      const checksum = sha256(sql);
      const rawChecksum = sha256(raw);
      return {
        version: Number(name.slice(0, 3)),
        name,
        sql,
        checksum,
        // Базы, созданные до нормализации из CRLF-копии файла, хранят сумму исходного текста
        acceptedChecksums: rawChecksum === checksum ? [checksum] : [checksum, rawChecksum]
      };
    });
}

// upTo — только для тестов совместимости: собрать базу старой версии схемы
export function migrate(db, { upTo = Infinity } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = new Map(db.prepare("SELECT version, name, checksum FROM schema_migrations").all().map((row) => [row.version, row]));
  const result = { applied: [], current: [] };

  for (const migration of listMigrations().filter((item) => item.version <= upTo)) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (!migration.acceptedChecksums.includes(existing.checksum)) {
        throw new Error(`Миграция ${migration.name} изменена после применения. Добавьте новую миграцию вместо правки старой`);
      }
      result.current.push(migration.name);
      continue;
    }
    // Пересборка таблицы-родителя требует выключенных FK; PRAGMA внутри транзакции не действует.
    // Целостность проверяется foreign_key_check до фиксации
    const rebuild = /^-- frontsmith: foreign_keys=off$/m.test(migration.sql);
    if (rebuild) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        if (rebuild) {
          const problems = db.pragma("foreign_key_check");
          if (problems.length) throw new Error(`Миграция ${migration.name} нарушает внешние ключи: ${JSON.stringify(problems.slice(0, 5))}`);
        }
        db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
          .run(migration.version, migration.name, migration.checksum, nowIso());
      })();
    } finally {
      if (rebuild) db.pragma("foreign_keys = ON");
    }
    result.applied.push(migration.name);
  }

  const known = new Set(listMigrations().map((migration) => migration.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) {
      throw new Error(`База содержит неизвестную миграцию ${version}: код старее базы`);
    }
  }

  return result;
}

export function schemaVersion(db) {
  return db.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version ?? 0;
}

export function assertHealthy(db) {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Проверка целостности SQLite не пройдена: ${integrity}`);
  const fkProblems = db.pragma("foreign_key_check");
  if (fkProblems.length) throw new Error(`Нарушены внешние ключи: ${JSON.stringify(fkProblems.slice(0, 5))}`);
}

export async function backupOfficeDb({ file = officeDbPath(), destination } = {}) {
  if (!existsSync(file)) throw new OfficeDbMissingError(file);
  const target = destination ?? path.join(officeBackupDir(), `office-${stamp()}.sqlite`);
  await mkdir(path.dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`Файл копии уже существует: ${target}`);

  const db = openOfficeDb({ file, readonly: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  verifyBackup(target);
  return target;
}

export function verifyBackup(file) {
  if (!existsSync(file)) throw new Error(`Файл копии не найден: ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assertHealthy(db);
    const version = db.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version;
    if (!version) throw new Error("В копии нет таблицы миграций Frontsmith");
    return { version };
  } finally {
    db.close();
  }
}

export async function restoreOfficeDb({ source, file = officeDbPath() }) {
  const resolvedSource = path.resolve(source);
  if (resolvedSource === path.resolve(file)) throw new Error("Нельзя восстановить базу из неё самой");
  verifyBackup(resolvedSource);

  const safetyCopy = existsSync(file)
    ? await backupOfficeDb({ file, destination: path.join(officeBackupDir(), `office-before-restore-${stamp()}.sqlite`) })
    : null;

  const temporary = `${file}.restore-${process.pid}`;
  await rm(temporary, { force: true });
  const sourceDb = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(temporary);
  } finally {
    sourceDb.close();
  }
  verifyBackup(temporary);

  await mkdir(path.dirname(file), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) await rm(`${file}${suffix}`, { force: true });
  await rename(temporary, file);

  const restored = openOfficeDb({ file });
  try {
    migrate(restored);
    assertHealthy(restored);
  } finally {
    restored.close();
  }
  return { file, safetyCopy };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}
