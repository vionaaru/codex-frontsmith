// Перенос контактов клиентов из офисной базы в CRM Frontsmith (crmkit).
//
//   npm run crm:migrate-customers -- --dry-run            сводка без изменений
//   npm run crm:migrate-customers -- --confirm            перенос
//   ... --db путь                                         другая база (копия, fixture)
//
// Автоматически не запускается. Перед переносом делается копия базы в каталог CRM вне
// рабочей области Codex: она содержит прежние контакты клиентов. Вывод не содержит
// имён, телефонов и email — только количества и client_id.
import path from "node:path";
import { backupOfficeDb, migrate, officeDbExists, officeDbPath, openOfficeDb, schemaVersion } from "../office/lib/db.mjs";
import { connectCustomers } from "../office/customers/index.mjs";
import { migrateLegacyCustomers, planLegacyMigration } from "../office/customers/migrate-legacy.mjs";
import { crmPaths, protectDir } from "../services/crm/runtime.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIndex = args.indexOf("--db");
const file = dbIndex === -1 ? officeDbPath() : path.resolve(args[dbIndex + 1]);

function printPlan(plan) {
  console.log(`Клиентов с контактами в офисной базе: ${plan.customers}`);
  console.log(`  уже связаны с CRM:                ${plan.linked}`);
  console.log(`  уже есть в CRM (повтор переноса): ${plan.alreadyInCrm}`);
  console.log(`  будет создано контактов в CRM:    ${plan.toCreate}`);
  console.log(`Переносимые данные: имя ${plan.pii.name}, телефон ${plan.pii.phone}, email ${plan.pii.email}, заметка ${plan.pii.note}`);
  if (plan.unparsed.phone || plan.unparsed.email) console.log(`  нераспознанные телефоны ${plan.unparsed.phone}, email ${plan.unparsed.email}: уйдут в заметку контакта CRM`);
  if (plan.sharedPhones) console.log(`  номеров у нескольких клиентов: ${plan.sharedPhones} (клиенты не объединяются)`);
  if (plan.crm !== "available") console.log("  CRM не проверялся: связи и конфликты с CRM не учтены");
  if (!plan.conflicts.length) console.log("Конфликты: нет");
  for (const conflict of plan.conflicts) {
    const label = { duplicate_email: "один email у нескольких клиентов", email_in_crm: "email уже есть у контакта CRM" }[conflict.kind] ?? conflict.kind;
    console.log(`Конфликт: ${label} — ${conflict.clientIds.join(", ")}`);
  }
}

// Без process.exit: на Windows выход при закрывающихся сокетах fetch роняет Node
if (!officeDbExists(file)) {
  console.error(`База не найдена: ${file}`);
  process.exitCode = 1;
} else if (dryRun) {
  await dryRunPlan();
} else if (!args.includes("--confirm")) {
  console.error("Перенос изменит базу офиса. Сначала посмотрите --dry-run, затем повторите с --confirm");
  process.exitCode = 1;
} else {
  await migrateConfirmed();
}

async function dryRunPlan() {
  const db = openOfficeDb({ file, readonly: true });
  let connection = null;
  try {
    if (schemaVersion(db) >= 4) {
      try {
        connection = await connectCustomers({ db });
      } catch (error) {
        console.log(`CRM недоступен (${error.code ?? error.message}): сводка без проверки CRM`);
      }
    }
    console.log(`База: ${file} (схема ${schemaVersion(db)})`);
    printPlan(await planLegacyMigration(db, connection?.provider ?? null));
    console.log("\nИзменений нет (--dry-run). Перенос: npm run crm:migrate-customers -- --confirm");
  } finally {
    await connection?.stop();
    db.close();
  }
}

async function migrateConfirmed() {
  const paths = crmPaths();
  protectDir(paths.backups);
  const backup = await backupOfficeDb({ file, destination: path.join(paths.backups, `office-before-crm-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sqlite`) });
  console.log(`Копия до переноса (содержит прежние контакты, вне рабочей области Codex): ${backup}`);

  const db = openOfficeDb({ file });
  let connection;
  try {
    const applied = migrate(db).applied;
    if (applied.length) console.log(`Схема обновлена: ${applied.join(", ")}`);
    connection = await connectCustomers({ db });
    const plan = await planLegacyMigration(db, connection.provider);
    printPlan(plan);
    const result = await migrateLegacyCustomers(db, connection.provider, {
      onProgress: ({ clientId, status }) => console.log(`  ${clientId}  ${status}`)
    });
    console.log(`\nПеренесено: ${result.migrated} (восстановлено после сбоя ${result.recovered}), уже было связано: ${result.alreadyLinked}`);
    console.log(`Записей журнала очищено от копий контактов: ${result.eventsScrubbed}`);
    for (const entry of [...result.conflicts, ...result.failed]) console.log(`Не перенесён ${entry.clientId}: ${entry.code}${entry.candidates ? ` (${entry.candidates.map((id) => id ?? "контакт вне Frontsmith").join(", ")})` : ""}`);
    console.log(result.remaining ? `Осталось в офисной базе: ${result.remaining}. Устраните конфликты и повторите` : "Контактов клиентов в офисной базе не осталось");
    process.exitCode = result.remaining ? 2 : 0;
  } finally {
    await connection?.stop();
    db.close();
  }
}
