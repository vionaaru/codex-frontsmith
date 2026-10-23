// Встроенный CRM Frontsmith: готовый бинарный релиз crmkit, без Go и Docker.
// Всё лежит в каталоге данных Frontsmith вне Git, вне `.frontsmith/business/` и
// вне рабочей области Codex:
//
//   <data>/runtime/crmkit/<версия>/   crmkitd зафиксированной версии
//   <data>/crm/crmkit.db              база контактов (персональные данные)
//   <data>/crm/crmkit.yaml            конфигурация (secret_key, лимиты, закрытая почта)
//   <data>/crm/credential.json        bearer-токен доверенного процесса Frontsmith
//
// Авторизация штатная: crmkit выдаёт токен по одноразовому коду. Код получает только
// подготовка (`provisionCredential`): короткий запуск в local mode на случайном порту.
// Обычный запуск — без local mode и с недоставляемой почтой, поэтому новый код не
// получит никто, а ранее выданный токен продолжает работать.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { dataRoot } from "../privacy/runtime.mjs";
import { CrmkitClient } from "./client.mjs";

export const CRMKIT = {
  version: "0.9.1",
  tag: "v0.9.1",
  commit: "59f21852597bd2de5090293f10f0330151291d05",
  // SHA-256 архивов релиза v0.9.1 (совпадают с официальным checksums.txt релиза)
  sha256: {
    "win32-x64": "529e3d153062945287da2a292eb36d325af9b79f5558607d3b6f660820e76dbc",
    "linux-x64": "d5d4c93e4bed3e6e97794fb9ba2280498d7e491425d18251da2ce6cdcca87008",
    "linux-arm64": "f3fa85944834217c1e175b9d55808238be80b5ba1397405621b562a5515ee5fd",
    "darwin-x64": "343f4b2eb35addaacb49328feba03e3afc9f9cee5d98ce417360e152f566160c",
    "darwin-arm64": "dfd607a6ba0fe50848506ef3d54480d6f236ccc87818a8764061f233dc20baa2"
  }
};

const TARGETS = {
  "win32-x64": "windows-amd64",
  "linux-x64": "linux-amd64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-amd64",
  "darwin-arm64": "darwin-arm64"
};

export const DEFAULT_CRM_PORT = 4320;
// Учётная запись доверенного процесса в crmkit. Это пользователь CRM, а не клиент:
// адрес нигде не принимает почту и в контакты не попадает.
export const OPERATOR_EMAIL = "frontsmith-host@frontsmith.invalid";

export function crmkitAsset(key = `${process.platform}-${process.arch}`) {
  const target = TARGETS[key];
  if (!target) throw new Error(`платформа ${key} не поддерживается релизом crmkit ${CRMKIT.tag}`);
  const file = `crmkit-${CRMKIT.tag}-${target}.tar.gz`;
  const base = `https://github.com/crmkit/crmkit/releases/download/${CRMKIT.tag}`;
  return { key, file, sha256: CRMKIT.sha256[key], url: `${base}/${file}`, checksumsUrl: `${base}/checksums.txt` };
}

export function crmPaths(root = dataRoot()) {
  const runtime = path.join(root, "runtime", "crmkit", CRMKIT.version);
  const dataDir = path.join(root, "crm");
  return {
    root,
    runtime,
    binary: path.join(runtime, process.platform === "win32" ? "crmkitd.exe" : "crmkitd"),
    marker: path.join(runtime, "crmkit-runtime.json"),
    tmp: path.join(root, "runtime", "tmp"),
    dataDir,
    db: path.join(dataDir, "crmkit.db"),
    config: path.join(dataDir, "crmkit.yaml"),
    credential: path.join(dataDir, "credential.json"),
    backups: path.join(dataDir, "backups")
  };
}

export function crmStatus(paths = crmPaths()) {
  if (!existsSync(paths.binary) || !existsSync(paths.marker)) return { ready: false, reason: "crm_runtime_missing", paths };
  let marker;
  try {
    marker = JSON.parse(readFileSync(paths.marker, "utf8"));
  } catch {
    return { ready: false, reason: "crm_runtime_incomplete", paths };
  }
  if (marker.version !== CRMKIT.version || marker.sha256 !== crmkitAsset().sha256) return { ready: false, reason: "crm_runtime_outdated", paths };
  if (!existsSync(paths.config) || !existsSync(paths.db)) return { ready: false, reason: "crm_storage_missing", paths };
  if (!readCredential(paths)) return { ready: false, reason: "crm_credential_missing", paths };
  return { ready: true, paths, marker };
}

// Каталог CRM: доступ только текущему пользователю (и SYSTEM на Windows), как у privacy/.
export function protectDir(dir) {
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME}`;
    spawnSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "ignore" });
  } else {
    chmodSync(dir, 0o700);
  }
}

// Конфигурация создаётся один раз: secret_key стабилен между запусками.
// Почта указывает на закрытый порт 9: в обычном режиме код входа не уходит никому.
export function writeConfig(paths, { port = DEFAULT_CRM_PORT } = {}) {
  if (existsSync(paths.config)) return false;
  protectDir(paths.dataDir);
  const limits = ["max_workspaces: 1", "max_members: 1", "max_contacts: 100000", "max_companies: 100000", "max_deals: 100000",
    "max_tickets: 100000", "max_tasks: 100000", "max_activities: 1000000", "audit_retention_days: -1"];
  const yaml = [
    "# Сгенерировано Frontsmith (npm run crm:bootstrap). Не помещать в Git и в рабочую область Codex",
    "server:",
    `  listen_addr: '127.0.0.1:${port}'`,
    `  base_url: 'http://127.0.0.1:${port}'`,
    `  db_path: '${paths.db.replace(/'/g, "''")}'`,
    `  secret_key: '${randomBytes(32).toString("hex")}'`,
    "  token_idle_ttl_seconds: 315360000",
    "  log_format: 'json'",
    "  local: false",
    "email:",
    "  provider: smtp",
    "  from: 'crmkit@frontsmith.invalid'",
    "  smtp_host: '127.0.0.1'",
    "  smtp_port: 9",
    "plans:",
    "  default: basic",
    "  catalogue:",
    "    basic:",
    ...limits.map((line) => `      ${line}`),
    ""
  ].join("\n");
  writeFileSync(paths.config, yaml, { mode: 0o600 });
  return true;
}

export function readCredential(paths = crmPaths()) {
  if (!existsSync(paths.credential)) return null;
  try {
    const value = JSON.parse(readFileSync(paths.credential, "utf8"));
    return value?.token && value?.workspaceId ? value : null;
  } catch {
    return null;
  }
}

// Окружение crmkitd по белому списку: CRMKIT_* родителя и секреты не наследуются.
function crmkitEnv(paths, extra = {}) {
  const env = { TEMP: paths.tmp, TMP: paths.tmp, TMPDIR: paths.tmp, HOME: paths.dataDir, USERPROFILE: paths.dataDir };
  for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function ready(url) {
  try {
    const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

export function runMigrations(paths) {
  const result = spawnSync(paths.binary, ["migrate", "--execute", "--config", paths.config, "--db", paths.db], {
    env: crmkitEnv(paths), cwd: paths.dataDir, encoding: "utf8", windowsHide: true
  });
  if (result.status !== 0) throw new Error(`crmkitd migrate завершился с кодом ${result.status}`);
  return result.stdout.split(/\r?\n/).filter((line) => /^(current|latest|applied|pending)/.test(line));
}

// Запускает crmkitd на 127.0.0.1 и ждёт /readyz. Журнал crmkit не пишется на диск:
// в local mode он содержит коды входа. onLog получает строки без кодов.
export async function startCrmkit({ paths = crmPaths(), port = DEFAULT_CRM_PORT, local = false, timeoutMs = 30_000, onLog } = {}) {
  if (!existsSync(paths.binary)) throw Object.assign(new Error("crmkit не установлен: выполните npm run crm:bootstrap"), { code: "crm_runtime_missing" });
  mkdirSync(paths.tmp, { recursive: true });
  const url = `http://127.0.0.1:${port}`;
  if (await ready(url)) throw Object.assign(new Error(`порт ${port} уже занят`), { code: "crm_port_busy" });
  const child = spawn(
    paths.binary,
    ["--config", paths.config, "--db", paths.db, "--listen", `127.0.0.1:${port}`, "--base-url", url, ...(local ? ["--local"] : [])],
    { cwd: paths.dataDir, env: crmkitEnv(paths, local ? { CRMKIT_EMAIL_PROVIDER: "log" } : {}), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let exited = null;
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve((exited = { code }))));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (!onLog || local) return;
      for (const line of chunk.split(/\r?\n/)) if (line && !/code/i.test(line)) onLog(line);
    });
  }
  const stop = async () => {
    if (exited) return;
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exit;
    clearTimeout(timer);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited) {
    if (await ready(url)) return { url, port, process: child, stop, exited: exit, local };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw Object.assign(new Error(exited ? `crmkitd завершился с кодом ${exited.code}` : "crmkitd не ответил /readyz"), { code: "crm_not_ready" });
}

// Штатный вход crmkit: /auth/request → код (local mode отдаёт его вызывающему) →
// /auth/verify → токен. Выполняется на случайном порту, сразу после — остановка.
export async function provisionCredential(paths = crmPaths()) {
  const existing = readCredential(paths);
  if (existing) return { created: false, credential: existing };
  const port = await freePort();
  const server = await startCrmkit({ paths, port, local: true });
  try {
    const anonymous = new CrmkitClient({ baseUrl: server.url });
    const requested = await anonymous.request("POST", "/auth/request", { email: OPERATOR_EMAIL });
    if (!requested.local_code) throw new Error("crmkit не вернул код входа в local mode");
    const verified = await anonymous.request("POST", "/auth/verify", { email: OPERATOR_EMAIL, code: requested.local_code, token_name: "frontsmith-host" });
    const client = new CrmkitClient({ baseUrl: server.url, token: verified.token });
    const whoami = await client.request("GET", "/whoami");
    const credential = {
      version: 1,
      crmkit: CRMKIT.version,
      email: OPERATOR_EMAIL,
      token: verified.token,
      workspaceId: whoami.workspace_id ?? verified.workspace_id,
      createdAt: new Date().toISOString()
    };
    protectDir(paths.dataDir);
    writeFileSync(paths.credential, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    return { created: true, credential };
  } finally {
    await server.stop();
  }
}

// Обеспечить работающий crmkit для доверенного процесса. Если на порту уже отвечает
// crmkit и наш токен к нему подходит — используется он (панель и AI runtime делят
// один экземпляр). Иначе запускается дочерний процесс, которым владеет вызывающий.
export async function ensureCrm({ paths = crmPaths(), port = Number(process.env.FRONTSMITH_CRM_PORT ?? DEFAULT_CRM_PORT), onLog } = {}) {
  const status = crmStatus(paths);
  if (!status.ready) throw Object.assign(new Error(`CRM не подготовлен (${status.reason}): выполните npm run crm:bootstrap`), { code: status.reason });
  const credential = readCredential(paths);
  const url = `http://127.0.0.1:${port}`;
  if (await ready(url)) {
    const client = new CrmkitClient({ baseUrl: url, token: credential.token });
    const whoami = await client.request("GET", "/whoami").catch(() => null);
    if (whoami?.workspace_id !== credential.workspaceId) {
      throw Object.assign(new Error(`порт ${port} занят другим процессом`), { code: "crm_port_busy" });
    }
    return { url, client, workspaceId: credential.workspaceId, owned: false, stop: async () => {}, exited: new Promise(() => {}) };
  }
  const server = await startCrmkit({ paths, port, onLog });
  const client = new CrmkitClient({ baseUrl: server.url, token: credential.token });
  try {
    const whoami = await client.request("GET", "/whoami");
    if (whoami.workspace_id !== credential.workspaceId) throw new Error("рабочая область crmkit не совпадает с сохранённой");
  } catch (error) {
    await server.stop();
    throw Object.assign(new Error(`crmkit не принял токен Frontsmith: ${error.code ?? error.message}`), { code: "crm_auth_failed" });
  }
  return { url: server.url, client, workspaceId: credential.workspaceId, owned: true, stop: server.stop, exited: server.exited, process: server.process };
}
