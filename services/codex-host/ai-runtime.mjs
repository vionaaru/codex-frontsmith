// AI runtime Frontsmith: crmkit, Privacy Service и Codex App Server как дочерние процессы Host.
//
//   0. обеспечить встроенный CRM (npm run crm:bootstrap): запустить crmkit или подключиться
//      к уже работающему экземпляру панели; токен crmkit остаётся в этом процессе
//   1. проверить подготовленный Privacy runtime (npm run privacy:bootstrap)
//   2. запустить Privacy Service на 127.0.0.1 и дождаться /health ready
//   3. проверить вход ChatGPT в отдельном CODEX_HOME (npm run codex-host:login)
//   4. запустить `codex app-server` на stdio и выполнить initialize
//   5. вернуть CodexHost для операций Frontsmith
//
// stop(): App Server, Privacy Service, затем crmkit (если его запускал этот процесс).
// Токены Privacy Service и crmkit, пути к их базам известны только этому процессу:
// в окружение и рабочую область Codex они не передаются, crmkit MCP не подключается.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths, runtimeStatus, startPrivacyService } from "../privacy/runtime.mjs";
import { crmPaths, ensureCrm } from "../crm/runtime.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { CodexHost } from "./codex-host.mjs";
import { assertOutside, codexEnv, defaultHostRoot, findCodex, prepareCodexHome } from "./codex-home.mjs";
import { PrivacyClient } from "./privacy-client.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class AiRuntimeUnavailable extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function codexLoginStatus(codexBin, env) {
  const result = spawnSync(codexBin, ["login", "status"], { env, encoding: "utf8" });
  return /ChatGPT/i.test(`${result.stdout}${result.stderr}`);
}

// tools — массив инструментов Host или функция ({ crm }) → массив (инструментам CRM нужен клиент crmkit).
// crm: false — не запускать встроенный CRM (тесты со своим экземпляром crmkit)
export async function startAiRuntime({ tools = [], model, diagnostics = {}, onPrivacyLog, privacyPort, crm: withCrm = true } = {}) {
  const paths = runtimePaths();
  const status = runtimeStatus(paths);
  if (!status.ready) throw new AiRuntimeUnavailable(status.reason, "Privacy runtime не подготовлен: выполните npm run privacy:bootstrap");

  const codexBin = findCodex();
  const crmData = crmPaths();
  const home = prepareCodexHome(path.join(defaultHostRoot(), "home"), { forbiddenRoots: [repo, paths.runtime, paths.stateDir, crmData.dataDir, crmData.runtime] });
  const env = codexEnv(home);
  if (!codexLoginStatus(codexBin, env)) throw new AiRuntimeUnavailable("codex_login_required", `в ${home} нет входа ChatGPT: выполните npm run codex-host:login`);

  let crm = null;
  if (withCrm) {
    try {
      crm = await ensureCrm();
    } catch (error) {
      throw new AiRuntimeUnavailable(error.code ?? "crm_unavailable", error.message);
    }
  }
  let service;
  let client;
  let workspace;
  const stop = async () => {
    client?.close();
    if (client?.process && client.process.exitCode === null) {
      await new Promise((resolve) => client.process.once("exit", resolve));
    }
    await service?.stop();
    await crm?.stop();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  };
  try {
    service = await startPrivacyService({ paths, port: privacyPort, onLog: onPrivacyLog });
  } catch (error) {
    await stop();
    throw error;
  }
  try {
    // Пустая рабочая область агента: вне репозитория, CODEX_HOME и данных Privacy Service.
    workspace = mkdtempSync(path.join(os.tmpdir(), "frontsmith-codex-host-ws-"));
    assertOutside(workspace, [repo, home, paths.runtime, paths.stateDir, crmData.dataDir, crmData.runtime]);
    writeFileSync(path.join(workspace, "README.txt"), "Пустая рабочая область Frontsmith Codex Host. Данных клиентов здесь нет.\n");

    const privacy = new PrivacyClient({ baseUrl: service.url, token: service.token });
    client = AppServerClient.spawn({ codexBin, args: ["app-server", "--strict-config"], env, cwd: workspace });
    const host = new CodexHost({ client, privacy, workspace, tools: typeof tools === "function" ? tools({ crm }) : tools, model, diagnostics });
    const server = await host.start();
    return {
      host,
      client,
      privacy,
      privacyHealth: service.health,
      privacyService: service,
      crm,
      server,
      codexVersion: execFileSync(codexBin, ["--version"], { env, encoding: "utf8" }).trim(),
      codexHome: home,
      workspace,
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
