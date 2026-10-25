// Очистка данных диалогов сайта (Conversation Module) в каталоге данных:
// привязки, переписка и предложения записи.
//
//   npm run conversations:purge                 старше срока хранения (business.json → conversations.retentionDays, по умолчанию 90 дней)
//   npm run conversations:purge -- --days 30    старше 30 дней
//   npm run conversations:purge -- --all        все диалоги
//
// npm run frontsmith удаляет диалоги старше срока хранения при каждом запуске.
// Контакты клиентов в CRM, записи и обращения офиса эта команда не трогает; thread Codex
// на диске App Server (только псевдонимизированный текст) остаются до очистки CODEX_HOME.
import { loadBusinessProfile } from "../services/conversation/business-context.mjs";
import { ConversationStore } from "../services/conversation/store.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const all = process.argv.includes("--all");
const profile = await loadBusinessProfile().catch(() => ({}));
const days = Number(readArg("--days") ?? profile?.conversations?.retentionDays ?? 90);
if (!all && (!Number.isFinite(days) || days <= 0)) {
  console.error("--days: положительное число дней");
  process.exit(1);
}
const store = new ConversationStore();
try {
  const { conversations } = store.purge({ days, all });
  console.log(`Удалено диалогов сайта: ${conversations} (${all ? "все" : `без активности дольше ${days} дн.`}). Хранилище: ${store.file}`);
} finally {
  store.close();
}
