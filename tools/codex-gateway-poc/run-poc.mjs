// ИССЛЕДОВАТЕЛЬСКИЙ PoC, не production gateway.
// Воспроизводит три теста маршрута codex exec → локальный gateway на синтетических
// данных в отдельном временном CODEX_HOME. Пользовательский CODEX_HOME не читается.
//
//   node tools/codex-gateway-poc/run-poc.mjs
//   CODEX_BIN=<путь к codex.exe> node tools/codex-gateway-poc/run-poc.mjs
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_TOKEN, SIMPLE_ANSWER, startGateway } from "./gateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes("--keep");

function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const root = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, process.platform === "win32" ? "codex.exe" : "codex");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

// Снимает TCP-соединения процесса codex и его прямых потомков через netstat, пока
// не появится stop-файл. Только Windows. Соединения короче интервала снимков
// не видны, поэтому отсутствие посторонних адресов — косвенное свидетельство.
function startNetSampler(rootPid, stopFile, outFile) {
  if (process.platform !== "win32") return null;
  const script = `
$ids = @(${rootPid}); $seen = @{}; $i = 0
while (-not (Test-Path -LiteralPath '${stopFile}')) {
  if ($i % 5 -eq 0) { Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid}" -Property ProcessId -ErrorAction SilentlyContinue | ForEach-Object { if ($ids -notcontains $_.ProcessId) { $ids += [int]$_.ProcessId } } }
  foreach ($line in (netstat -ano -p TCP)) {
    $f = -split $line
    if ($f.Count -ge 5 -and $f[0] -eq 'TCP' -and $ids -contains [int]$f[4] -and $f[2] -notmatch ':0$') { $seen[$f[2]] = 1 }
  }
  $i++; Start-Sleep -Milliseconds 50
}
($seen.Keys | Sort-Object) -join [Environment]::NewLine | Set-Content -Encoding utf8 -LiteralPath '${outFile}'
`;
  return spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

function runCodex({ codex, home, work, prompt, port }) {
  return new Promise((resolveRun) => {
    const child = spawn(
      codex,
      ["exec", "--strict-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", work, "--json", prompt],
      {
        cwd: work,
        env: { ...process.env, CODEX_HOME: home, FRONTSMITH_POC_KEY: "poc-dummy-not-a-secret", OPENAI_API_KEY: "", OPENAI_BASE_URL: "" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stopFile = join(home, `stop-${port}-${child.pid}`);
    const netFile = join(home, `net-${port}-${child.pid}.txt`);
    const sampler = startNetSampler(child.pid, stopFile, netFile);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const finish = () => {
        const remotes = existsSync(netFile) ? readFileSync(netFile, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean) : null;
        const events = stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
        resolveRun({ code, events, stderr, remotes });
      };
      if (!sampler) return finish();
      writeFileSync(stopFile, "");
      sampler.on("close", finish);
    });
  });
}

function lastMessage(events) {
  return events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item.text ?? null;
}

// Монитор считается рабочим, только если сам увидел соединение с gateway.
function netCheck(label, remotes, port, expectGateway) {
  if (remotes === null) return console.log(`SKIP  ${label}: сетевой мониторинг доступен только в Windows`);
  const gateway = `127.0.0.1:${port}`;
  const foreign = remotes.filter((remote) => remote !== gateway);
  if (expectGateway) check(`${label}: монитор увидел соединение с gateway`, remotes.includes(gateway), remotes.join(",") || "ничего");
  check(`${label}: посторонних TCP-соединений не замечено`, foreign.length === 0, foreign.join(","));
}

const codex = findCodex();
const version = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "frontsmith-codex-gateway-poc-"));
const home = join(root, "home");
const work = join(root, "work");
const logFile = join(root, "gateway.jsonl");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  for (const dir of [home, work]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(here, "fixture.txt"), join(work, "fixture.txt"));

  // holdMs держит поток открытым, чтобы netstat успел увидеть соединение с gateway.
  const gateway = await startGateway({ port: 0, logFile, holdMs: 1500 });
  const port = gateway.port;
  const template = readFileSync(join(here, "codex-home.config.example.toml"), "utf8");
  writeFileSync(join(home, "config.toml"), template.replace("{{PORT}}", String(port)));
  console.log(`${version}; CODEX_HOME=${home}; gateway http://127.0.0.1:${port}/v1`);

  const homeBefore = readdirSync(home);
  check("CODEX_HOME содержит только config.toml", homeBefore.length === 1 && homeBefore[0] === "config.toml", homeBefore.join(","));

  const t1 = await runCodex({ codex, home, work, prompt: `Ответь одним словом: ${SIMPLE_ANSWER}`, port });
  const after1 = gateway.state.count;
  check("Тест 1: codex exec завершился ответом gateway", t1.code === 0 && lastMessage(t1.events) === SIMPLE_ANSWER, `ответ=${lastMessage(t1.events)}`);
  check("Тест 1: gateway получил ровно 1 запрос", after1 === 1, `запросов=${after1}`);
  netCheck("Тест 1", t1.remotes, port, true);

  const t2 = await runCodex({ codex, home, work, prompt: "Прочитай fixture.txt и верни его содержимое.", port });
  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const round = entries.slice(after1);
  const commands = t2.events.filter((e) => e.type === "item.completed" && e.item?.type === "command_execution");
  check("Тест 2: gateway получил 2 модельных раунда", round.length === 2, `запросов=${round.length}`);
  check("Тест 2: раунд 1 — ответ с tool call", round[0]?.reply === "tool_call");
  check("Тест 2: Codex выполнил команду локально", commands.length === 1 && commands[0].item.exit_code === 0);
  check("Тест 2: раунд 2 несёт function_call_output с fixture", round[1]?.input_item_types.includes("function_call_output") && round[1]?.function_call_output_has_fixture === true);
  check("Тест 2: финальный ответ — содержимое fixture", t2.code === 0 && lastMessage(t2.events) === FIXTURE_TOKEN, `ответ=${lastMessage(t2.events)}`);
  netCheck("Тест 2", t2.remotes, port, true);

  await new Promise((done) => gateway.server.close(done));
  const t3 = await runCodex({ codex, home, work, prompt: `Ответь одним словом: ${SIMPLE_ANSWER}`, port });
  const failed = t3.events.some((e) => e.type === "turn.failed");
  check("Тест 3: без gateway codex exec завершается ошибкой", t3.code !== 0 && failed && lastMessage(t3.events) === null, `код=${t3.code}`);
  netCheck("Тест 3", t3.remotes, port, false);

  const homeAfter = readdirSync(home).filter((name) => !name.startsWith("net-") && !name.startsWith("stop-"));
  console.log(`CODEX_HOME после запусков: ${homeAfter.join(", ")}`);
  console.log(`Журнал gateway: ${logFile}`);
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}

const failedChecks = results.filter((r) => !r.ok).length;
console.log(failedChecks === 0 ? "PoC: PASS" : `PoC: FAIL (${failedChecks})`);
process.exitCode = failedChecks === 0 ? 0 : 1;
