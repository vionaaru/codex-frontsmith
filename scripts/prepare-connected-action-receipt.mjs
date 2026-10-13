import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { businessPath, businessRoot } from "./lib/paths.mjs";

const root = businessRoot();
const business = await readBusinessProfile();
const actionType = readArg("--action-type") ?? "email";
const title = readArg("--title") ?? "Отправить сообщение после консультации";
const target = readArg("--target") ?? "Повторный контакт с клиентом";
const evidence = readArg("--evidence") ?? "Заметки о клиенте от владельца";
const outputDir = businessPath("connected-actions");
const slug = slugify(`${actionType}-${title}`);
const markdownFile = path.join(outputDir, `${slug}-receipt.md`);
const jsonFile = path.join(outputDir, `${slug}-receipt.json`);
const record = connectedActionRecord({ actionType, title, target, evidence });

await mkdir(outputDir, { recursive: true });
await writeFile(jsonFile, `${JSON.stringify(record, null, 2)}\n`);
await writeFile(markdownFile, renderReceipt({ record, markdownFile, jsonFile }));

console.log(`Подготовлена запись подключаемого действия: ${markdownFile}`);
console.log("Режим: только пробный запуск");
console.log("Выполнение заблокировано до согласования владельцем и предварительной проверки подключённого режима");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function readBusinessProfile() {
  const profilePath = businessPath("business.json");
  try {
    return JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Рабочие данные бизнеса не найдены: ${profilePath}. Сначала выполните npm run bootstrap.`);
    }
    throw error;
  }
}

function connectedActionRecord({ actionType, title, target, evidence }) {
  const normalizedActionType = slugify(actionType);
  const normalizedTitle = slugify(title);
  const refBase = `${normalizedActionType}-${normalizedTitle}`;

  return {
    schema: "frontsmith.connected_action_receipt.v0.1",
    mode: "dry_run",
    business: {
      name: business.businessName,
      workspace: ".frontsmith/business"
    },
    proposed_action: {
      action_ref: `frontsmith-action-${refBase}`,
      type: actionType,
      title,
      target,
      evidence,
      requested_by: "owner_or_operator",
      execution_default: "blocked"
    },
    authority_refs: {
      neura_registry_ref: `registry-ref-pending-${refBase}`,
      neura_relay_action_card_ref: `relay-action-card-pending-${refBase}`,
      neura_relay_decision_receipt_ref: "pending_until_connected_mode_preflight",
      trace_ref: `frontsmith-trace-${refBase}`
    },
    approval_gate: {
      owner_approval_required: true,
      approval_status: "not_approved",
      required_before_execution: [
        "согласие владельца на конкретное действие",
        "подтверждённые цель и содержимое",
        "подтверждённые коннектор и учётная запись",
        "предварительная проверка Neura Relay в подключённом режиме",
        "проверка записи до запуска адаптера"
      ]
    },
    adapter_boundary: {
      live_adapter_enabled: false,
      blocked_adapters: ["email", "publish", "file", "calendar", "provider_setup"],
      reason: "Frontsmith записывает предлагаемое действие локально до разрешения внешних действий сервиса."
    },
    created_at: new Date().toISOString()
  };
}

function renderReceipt({ record, markdownFile, jsonFile }) {
  return `# Запись подключаемого действия

Бизнес: ${record.business.name}
Статус: пробный запуск, нужна проверка владельцем, не выполнено
Создано: ${record.created_at}

## Краткая сводка

Frontsmith создал локальную запись предлагаемого внешнего действия. Адаптеры не запускались: письма не отправлены, сайт не опубликован, файлы не загружены, встречи не созданы, сервисы не настроены.

## Предлагаемое действие

- Ссылка действия: \`${record.proposed_action.action_ref}\`
- Тип: ${record.proposed_action.type}
- Название: ${record.proposed_action.title}
- Цель: ${record.proposed_action.target}
- Основание: ${record.proposed_action.evidence}
- Выполнение по умолчанию: заблокировано (${record.proposed_action.execution_default})

## Ссылки Neura

- Ссылка Registry: \`${record.authority_refs.neura_registry_ref}\`
- Ссылка Relay Action Card: \`${record.authority_refs.neura_relay_action_card_ref}\`
- Ссылка Relay Decision Receipt: \`${record.authority_refs.neura_relay_decision_receipt_ref}\`
- Ссылка трассировки: \`${record.authority_refs.trace_ref}\`

Эти ссылки — локальные заготовки до согласования подключённого режима и настоящей предварительной проверки Neura Relay.

## Условия согласования

- Нужно согласие владельца: ${record.approval_gate.owner_approval_required ? "да" : "нет"}
- Статус согласования: не согласовано (${record.approval_gate.approval_status})

Требуется до выполнения:

${record.approval_gate.required_before_execution.map((item) => `- ${item}`).join("\n")}

## Границы адаптера

- Рабочий адаптер включён: ${record.adapter_boundary.live_adapter_enabled ? "да" : "нет"}
- Заблокированные адаптеры: ${record.adapter_boundary.blocked_adapters.join(", ")}
- Причина: ${record.adapter_boundary.reason}

## Материалы

- Запись Markdown: \`${displayPath(markdownFile)}\`
- Запись JSON: \`${displayPath(jsonFile)}\`
- Профиль бизнеса: \`${displayPath(businessPath("business.json"))}\`

## Границы безопасности

Эта запись хранится локально. Она не отправляет письма, не публикует сайт, не меняет DNS, не создаёт встречи, не загружает файлы, не экспортирует данные, не настраивает сервисы и не выполняет внешние действия.
`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function displayPath(targetFile) {
  const normalizedFile = path.normalize(targetFile);
  const normalizedRoot = path.normalize(root);
  const relativeToBusiness = path.relative(normalizedRoot, normalizedFile);

  if (relativeToBusiness && !relativeToBusiness.startsWith("..") && !path.isAbsolute(relativeToBusiness)) {
    return toPosix(path.join(".frontsmith", "business", relativeToBusiness));
  }

  const relativeToProject = path.relative(process.cwd(), normalizedFile) || normalizedFile;
  return toPosix(relativeToProject);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
