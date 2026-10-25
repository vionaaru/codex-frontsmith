// Единый запуск цифрового офиса Frontsmith: один процесс, один терминал.
//
//   npm run frontsmith
//
//   проверка подготовки (npm run bootstrap)
//     → crmkit на 127.0.0.1, ожидание /readyz
//     → Privacy Service на 127.0.0.1, ожидание /health ready
//     → проверка входа ChatGPT → Codex App Server (stdio)
//     → сервер офиса http://127.0.0.1:4180
//     → сайт компании с AI-чатом http://127.0.0.1:4173
//     → READY
//
// crmkit, Privacy Service и Codex App Server — дочерние процессы, сервер офиса работает
// в этом процессе. Ctrl+C завершает их в обратном порядке: офис, App Server, Privacy
// Service, crmkit. Обязательные компоненты — офисная база, crmkit и Privacy Service: без
// любого из них запуск прерывается с кодом причины. Без входа ChatGPT офис работает, а
// AI-операции недоступны (CODEX_NOT_AUTHENTICATED). Токены CRM и Privacy Service остаются
// в этом процессе и в вывод не попадают.
//
// Сайт компании обслуживается отдельным сервером на своём порту (только 127.0.0.1): статика
// сайта и веб-канал AI-чата, без маршрутов офиса. Чат использует тот же CodexHost, что и офис,
// второй AI runtime не запускается; публичные диалоги открываются без инструментов Host.
import { createServer } from "node:net";
import path from "node:path";
import { defaultOfficePort, createOfficeServer } from "../office/server.mjs";
import { openOfficeDb } from "../office/lib/db.mjs";
import { registerFunctions } from "../office/lib/repositories.mjs";
import { assertCustomerProvider } from "../office/customers/contract.mjs";
import { CrmkitProvider } from "../office/customers/crmkit-provider.mjs";
import { crmPaths, ensureCrm, freePort } from "../services/crm/runtime.mjs";
import { runtimePaths, startPrivacyService } from "../services/privacy/runtime.mjs";
import { codexAuthStatus, startAiRuntime } from "../services/codex-host/ai-runtime.mjs";
import { getCustomerContextTool } from "../services/codex-host/tools/customer-context.mjs";
import { ConversationCore } from "../services/conversation/core.mjs";
import { ConversationStore } from "../services/conversation/store.mjs";
import { loadPublicBusinessContext } from "../services/conversation/business-context.mjs";
import { createWebChannel } from "../services/conversation/web-channel.mjs";
import { foreignCrmLinks, inspectInstallation } from "./lib/installation.mjs";
import { previewWebsiteRoot } from "./lib/paths.mjs";
import { createWebsiteServer } from "./lib/website-server.mjs";

const host = "127.0.0.1";
const verbose = process.env.FRONTSMITH_VERBOSE === "1";
const status = { office: "not_ready", crm: "not_ready", privacy: "not_ready", codex: "not_ready", customers: "not_ready", site: "not_ready" };
const components = { office: null, ai: null, aiDb: null, privacy: null, crm: null, site: null, conversations: null };
let stopping = false;

class StartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown(0));
// Управление из тестов и других процессов Frontsmith: сообщение shutdown по IPC
process.on("message", (message) => { if (message?.type === "shutdown") shutdown(0); });
process.on("disconnect", () => shutdown(0));

try {
  await start();
} catch (error) {
  const code = error instanceof StartError ? error.code : "FRONTSMITH_START_FAILED";
  console.error(`\n✗ ${code}: ${error.message}`);
  process.send?.({ type: "failed", code });
  await shutdown(1);
}

async function start() {
  console.log("Запуск Frontsmith...");

  // ── проверка подготовки ─────────────────────────────────────────
  const install = inspectInstallation();
  const { business } = install;
  if (!install.crm.ready) throw new StartError("CRM_NOT_READY", `CRM не подготовлен (${install.crm.reason}): выполните npm run bootstrap`);
  if (!install.privacy.ready) throw new StartError("PRIVACY_NOT_READY", `Privacy runtime не подготовлен (${install.privacy.reason}): выполните npm run bootstrap`);
  if (!business.exists || business.kind === "fresh" || business.kind === "foreign") throw new StartError("BUSINESS_DB_NOT_READY", `офисная база не создана (${business.file}): выполните npm run bootstrap`);
  if (business.schema < business.latest || !business.business) throw new StartError("BUSINESS_DB_NOT_READY", "схема офисной базы устарела: выполните npm run bootstrap");
  if (foreignCrmLinks(business, install.crmWorkspace).length) throw new StartError("CRM_MISMATCH", "офисная база связана с другой рабочей областью crmkit");
  const officePort = Number(process.env.FRONTSMITH_OFFICE_PORT ?? defaultOfficePort);
  if (!(await portFree(officePort))) throw new StartError("OFFICE_PORT_BUSY", `порт офиса ${officePort} занят: остановите другой экземпляр или задайте FRONTSMITH_OFFICE_PORT`);

  // ── crmkit ──────────────────────────────────────────────────────
  try {
    components.crm = await startCrm();
  } catch (error) {
    throw new StartError("CRM_NOT_READY", `${error.code ?? ""} ${error.message}`.trim());
  }
  const crm = components.crm;
  status.crm = "ready";
  console.log(`✓ CRM: crmkit ${crm.owned ? "запущен" : "уже работал"}, 127.0.0.1:${new URL(crm.url).port}`);
  crm.exited.then(({ code }) => fatal("CRM_NOT_READY", `crmkit завершился с кодом ${code}`));

  // ── Privacy Service ────────────────────────────────────────────
  console.log("… Privacy Service: загрузка pii-guard и NER, на слабом компьютере до нескольких минут");
  try {
    const wanted = Number(process.env.FRONTSMITH_PRIVACY_PORT ?? 4310);
    components.privacy = await startPrivacyService({
      paths: runtimePaths(install.dataRoot),
      port: (await portFree(wanted)) ? wanted : await freePort(),
      onLog: verbose ? (chunk) => process.stderr.write(chunk) : undefined
    });
  } catch (error) {
    throw new StartError("PRIVACY_NOT_READY", error.reason ?? error.message);
  }
  const privacy = components.privacy;
  status.privacy = "ready";
  console.log(`✓ Privacy: pii-guard ${privacy.health.pii_guard_version} (${privacy.health.pii_guard_commit.slice(0, 7)}), NER=${privacy.health.ner_enabled}, 127.0.0.1:${privacy.port}`);
  privacy.exited.then(({ code }) => fatal("PRIVACY_NOT_READY", `Privacy Service завершился с кодом ${code}`));

  // ── Codex App Server ───────────────────────────────────────────
  const paths = runtimePaths(install.dataRoot);
  const crmData = crmPaths(install.dataRoot);
  const auth = codexAuthStatus({ forbiddenRoots: [paths.runtime, paths.stateDir, crmData.dataDir, crmData.runtime] });
  if (auth.state === "ready") {
    try {
      // Доверенный инструмент клиента: CustomerProvider → Privacy Service → Codex
      components.aiDb = registerFunctions(openOfficeDb());
      const provider = assertCustomerProvider(new CrmkitProvider({ db: components.aiDb, client: crm.client, workspaceId: crm.workspaceId }));
      components.ai = await startAiRuntime({ crm, privacyService: privacy, tools: [getCustomerContextTool(provider)] });
      status.codex = "ready";
      console.log(`✓ Codex: ${components.ai.codexVersion}, App Server на stdio, вход ChatGPT`);
      components.ai.client.process?.once("exit", () => {
        if (stopping) return;
        status.codex = "stopped";
        console.error("! Codex App Server завершился: AI-операции недоступны, офис продолжает работать");
      });
    } catch (error) {
      status.codex = "error";
      console.error(`! Codex App Server не запущен (${error.code ?? "error"}): ${error.message}. Офис работает без AI`);
    }
  } else {
    status.codex = auth.state;
    console.log(auth.state === "login_required"
      ? "! CODEX_NOT_AUTHENTICATED: Codex authentication required. Run: npm run codex-host:login"
      : "! CODEX_NOT_INSTALLED: Codex CLI не найден, офис работает без AI");
  }

  // ── сервер офиса ───────────────────────────────────────────────
  const office = createOfficeServer({
    port: officePort,
    connectProvider: (conn) => ({
      provider: assertCustomerProvider(new CrmkitProvider({ db: conn, client: crm.client, workspaceId: crm.workspaceId })),
      crm: { exited: crm.exited },
      stop: async () => {}
    })
  });
  await new Promise((resolve, reject) => {
    office.server.once("error", (error) => reject(new StartError(error.code === "EADDRINUSE" ? "OFFICE_PORT_BUSY" : "OFFICE_NOT_READY", error.message)));
    office.server.listen(officePort, host, resolve);
  });
  components.office = office;
  const url = `http://${host}:${officePort}`;

  // Офис готов, когда отвечает API, а раздел «Клиенты» получает контакты через CustomerProvider
  const health = await fetchJson(`${url}/api/health`);
  if (health.status !== 200 || health.body?.data?.database !== "present") throw new StartError("BUSINESS_DB_NOT_READY", "сервер офиса не видит офисную базу");
  status.office = "ready";
  const customers = await fetchJson(`${url}/api/customers`);
  if (customers.status !== 200) throw new StartError("CRM_NOT_READY", `раздел «Клиенты» недоступен: ${customers.body?.error?.code ?? customers.status}`);
  const pending = customers.body.data.filter((row) => row.contactStatus !== "ok").length;
  status.customers = pending ? "legacy" : "ready";

  // ── сайт компании и AI-чат ─────────────────────────────────────
  let siteUrl = null;
  try {
    const wanted = Number(process.env.FRONTSMITH_SITE_PORT ?? 4173);
    const sitePort = (await portFree(wanted)) ? wanted : await freePort();
    components.conversations = new ConversationStore();
    const core = new ConversationCore({
      store: components.conversations,
      host: () => (status.codex === "ready" ? components.ai.host : null),
      context: loadPublicBusinessContext,
      log: verbose ? (entry) => console.log(`chat: ${JSON.stringify(entry)}`) : undefined
    });
    const chat = createWebChannel({ core, allowedHosts: new Set([`${host}:${sitePort}`, `localhost:${sitePort}`]) });
    const site = createWebsiteServer({ root: () => path.resolve(previewWebsiteRoot()), port: sitePort, chat });
    await new Promise((resolve, reject) => {
      site.once("error", reject);
      site.listen(sitePort, host, resolve);
    });
    components.site = site;
    siteUrl = `http://${host}:${sitePort}`;
    status.site = "ready";
  } catch (error) {
    status.site = "error";
    console.error(`! Сайт компании не запущен (${error.code ?? "error"}): ${error.message}. Офис работает без сайта`);
  }

  const label = (value) => ({ ready: "ready", login_required: "sign-in required", cli_missing: "CLI not found", error: "error", legacy: `ready, ${pending} клиентов без контакта в CRM` }[value] ?? value);
  const aiReady = status.codex === "ready";
  console.log(`\nFrontsmith ready\n`);
  console.log(`Office:         ${url}`);
  console.log(`Site:           ${siteUrl ?? "not started"}${siteUrl ? ` (AI-чат: ${aiReady ? "ready" : "unavailable"})` : ""}`);
  console.log(`CRM:            ${label(status.crm)}`);
  console.log(`Privacy:        ${label(status.privacy)}`);
  console.log(`Codex:          ${label(status.codex)}`);
  console.log(`CustomerModule: ${label(status.customers)}`);
  console.log(`\nOffice ready: yes · AI ready: ${aiReady ? "yes" : `no (${status.codex === "login_required" ? "CODEX_NOT_AUTHENTICATED" : status.codex === "cli_missing" ? "CODEX_NOT_INSTALLED" : "CODEX_NOT_READY"})`}`);
  if (pending) console.log("Legacy customer storage detected.\nRun:\nnpm run crm:migrate-customers -- --dry-run");
  console.log("Ctrl+C — остановка сайта, офиса, Codex App Server, Privacy Service и crmkit");

  process.send?.({
    type: "ready",
    office: url,
    status: { ...status },
    site: siteUrl,
    officeReady: true,
    aiReady,
    ports: { office: officePort, site: siteUrl ? Number(new URL(siteUrl).port) : null, crm: Number(new URL(crm.url).port), privacy: privacy.port },
    pids: { crm: crm.process?.pid ?? null, privacy: privacy.process.pid, codex: components.ai?.client.process?.pid ?? null }
  });
}

// Штатный порт, если он свободен или на нём crmkit этой установки; иначе свободный
async function startCrm() {
  const wanted = Number(process.env.FRONTSMITH_CRM_PORT ?? 4320);
  try {
    return await ensureCrm({ port: wanted, onLog: verbose ? (line) => console.log(`crmkit: ${line}`) : undefined });
  } catch (error) {
    if (error.code !== "crm_port_busy") throw error;
    return ensureCrm({ port: await freePort() });
  }
}

function fatal(code, message) {
  if (stopping) return;
  console.error(`\n✗ ${code}: ${message}. Офис остановлен, чтобы не работать без обязательного компонента`);
  shutdown(1);
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (status.office === "ready" || components.crm) console.log("\nОстановка Frontsmith...");
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      console.error(`! ${name}: ${error.message}`);
    }
  };
  await step("сайт", async () => {
    if (!components.site) return;
    const closed = new Promise((resolve) => components.site.close(resolve));
    components.site.closeAllConnections?.();
    await closed;
  });
  await step("офис", async () => {
    if (!components.office) return;
    const closed = components.office.close();
    components.office.server.closeAllConnections?.();
    await closed;
  });
  await step("Codex App Server", async () => components.ai?.stop());
  await step("база AI", async () => components.aiDb?.close());
  await step("диалоги", async () => components.conversations?.close());
  await step("Privacy Service", async () => components.privacy?.stop());
  await step("crmkit", async () => components.crm?.stop());
  if (components.crm) console.log("Frontsmith остановлен: сайт, офис, Codex App Server, Privacy Service, crmkit");
  process.send?.({ type: "stopped", code });
  process.exit(code);
}

async function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
