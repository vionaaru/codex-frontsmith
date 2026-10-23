// Точка подключения Customer Module для доверенных процессов Frontsmith (панель, CLI,
// AI runtime). Провайдер по умолчанию — встроенный crmkit; токен crmkit остаётся
// внутри этого процесса и не передаётся браузеру, Privacy Service и Codex.
import { CrmkitClient } from "../../services/crm/client.mjs";
import { crmPaths, ensureCrm, readCredential } from "../../services/crm/runtime.mjs";
import { assertCustomerProvider } from "./contract.mjs";
import { CrmkitProvider } from "./crmkit-provider.mjs";

export { CustomerError, normalizePhone, formatPhone } from "./contract.mjs";

// FRONTSMITH_CRM_URL — уже запущенный crmkit (разработка и тесты); иначе crmkitd
// запускается дочерним процессом или переиспользуется на штатном порту.
export async function connectCustomers({ db, paths = crmPaths(), onLog } = {}) {
  let crm;
  if (process.env.FRONTSMITH_CRM_URL) {
    const credential = readCredential(paths);
    if (!credential) throw Object.assign(new Error("Нет учётных данных CRM: выполните npm run crm:bootstrap"), { code: "crm_credential_missing" });
    crm = { url: process.env.FRONTSMITH_CRM_URL, client: new CrmkitClient({ baseUrl: process.env.FRONTSMITH_CRM_URL, token: credential.token }), workspaceId: credential.workspaceId, owned: false, stop: async () => {} };
  } else {
    crm = await ensureCrm({ paths, onLog });
  }
  const provider = assertCustomerProvider(new CrmkitProvider({ db, client: crm.client, workspaceId: crm.workspaceId }));
  return { provider, crm, stop: () => crm.stop() };
}

// Подписи клиентов для бизнес-записей: по полю customer_id (= client_id) доверенный
// сервер добавляет customer_name и customer_phone. В базе их нет, SQL join на ПД нет.
// При недоступном CRM подпись — безопасный короткий идентификатор и признак недоступности
export async function enrichCustomerRefs(data, provider) {
  const ids = new Set();
  walk(data, (node) => { if (typeof node.customer_id === "string") ids.add(node.customer_id); });
  if (!ids.size) return data;
  let labels;
  try {
    labels = await provider.resolveDisplayData([...ids]);
  } catch {
    labels = new Map();
  }
  walk(data, (node) => {
    if (typeof node.customer_id !== "string") return;
    const label = labels.get(node.customer_id);
    node.customer_name = label?.displayName ?? `Клиент ${node.customer_id.slice(0, 8)}`;
    node.customer_phone = label?.phone ?? null;
    node.customer_contact = label && !label.unavailable ? "ok" : "unavailable";
  });
  return data;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value && typeof value === "object") {
    visit(value);
    for (const item of Object.values(value)) if (item && typeof item === "object") walk(item, visit);
  }
}
