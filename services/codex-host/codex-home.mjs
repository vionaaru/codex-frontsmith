// Отдельный CODEX_HOME для Frontsmith-controlled App Server.
// Не совпадает с CODEX_HOME Codex Desktop: здесь нет пользовательских плагинов, MCP,
// памяти и истории. Каталог лежит вне репозитория, вне `.frontsmith/business/` и вне
// рабочей области агента. Вход — штатный ChatGPT (`npm run codex-host:login`).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultHostRoot() {
  if (process.env.FRONTSMITH_CODEX_HOST_ROOT) return path.resolve(process.env.FRONTSMITH_CODEX_HOST_ROOT);
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA ?? os.homedir() : path.join(os.homedir(), ".local", "share");
  return path.join(base, "Frontsmith", "codex-host");
}

export function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const root = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const candidate = path.join(root, dir, process.platform === "win32" ? "codex.exe" : "codex");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

// Встроенные инструменты оболочки, правки файлов, браузер, приложения и плагины
// выключены: модель получает только инструменты, которые объявил Host.
export const HOST_CONFIG_TOML = `# Управляется Frontsmith Codex Host. Перезаписывается при запуске.
forced_login_method = "chatgpt"
sandbox_mode = "read-only"
check_for_update_on_startup = false
web_search = "disabled"
project_doc_max_bytes = 0

[windows]
sandbox = "unelevated"

[history]
persistence = "none"

[analytics]
enabled = false

[features]
apps = false
plugins = false
remote_plugin = false
memories = false
browser_use = false
browser_use_external = false
in_app_browser = false
computer_use = false
image_generation = false
multi_agent = false
tool_suggest = false
skill_mcp_dependency_install = false
realtime_conversation = false
daemon_auto_start = false
in_app_updates = false
shell_tool = false
unified_exec = false
shell_snapshot = false
view_image = false
hooks = false
goals = false
sleep_tool = false
skill_search = false
workspace_dependencies = false
`;

// Каталоги, которые никогда не должны оказаться внутри CODEX_HOME или workspace агента.
export function assertOutside(target, forbiddenRoots) {
  const resolved = path.resolve(target).toLowerCase();
  for (const root of forbiddenRoots) {
    const forbidden = path.resolve(root).toLowerCase();
    if (resolved === forbidden || resolved.startsWith(forbidden + path.sep) || forbidden.startsWith(resolved + path.sep)) {
      throw new Error(`refusing to use ${target}: overlaps ${root}`);
    }
  }
}

export function prepareCodexHome(home, { forbiddenRoots = [] } = {}) {
  assertOutside(home, forbiddenRoots);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.toml"), HOST_CONFIG_TOML);
  return home;
}

// Переменные окружения дочернего процесса — по белому списку. OPENAI_API_KEY,
// CODEX_API_KEY, OPENAI_BASE_URL и прочие секреты родителя не наследуются.
const ENV_ALLOWLIST = [
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "PATH", "Path", "TEMP", "TMP", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "HOME", "LANG", "LC_ALL", "USERNAME", "USER"
];

export function codexEnv(home, source = process.env) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  env.CODEX_HOME = home;
  return env;
}
