// Вход ChatGPT для отдельного CODEX_HOME Frontsmith Codex Host.
//
//   npm run codex-host:login                 вход через браузер
//   npm run codex-host:login -- --device-auth вход по коду устройства
//   npm run codex-host:login -- status       проверить вход
//
// API key не поддерживается намеренно: модельный контур Frontsmith работает только
// через подписку ChatGPT.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexEnv, defaultHostRoot, findCodex, prepareCodexHome } from "./codex-home.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg.includes("api-key") || arg.includes("access-token"))) {
  console.error("Frontsmith Codex Host использует только вход через ChatGPT.");
  process.exit(2);
}
const home = prepareCodexHome(path.join(defaultHostRoot(), "home"), { forbiddenRoots: [repo] });
console.log(`CODEX_HOME Frontsmith Codex Host: ${home}`);
const result = spawnSync(findCodex(), ["login", ...args], { env: codexEnv(home), stdio: "inherit" });
process.exit(result.status ?? 1);
