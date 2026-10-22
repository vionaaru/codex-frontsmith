// Тесты Privacy Service в контейнере: pytest (логика + настоящий pii-guard с NER)
// и проверка fail closed на образе с отключённым NER.
//
//   npm run test:privacy
//
// Docker не запускается автоматически: если демон выключен, тесты помечаются SKIPPED.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compose = ["compose", "-f", path.join(dir, "compose.yml")];
const env = { ...process.env, PRIVACY_SERVICE_TOKEN: "test-token-not-a-secret", PRIVACY_SERVICE_PORT: "4311" };

if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIPPED  Privacy Service: Docker daemon недоступен");
  process.exit(0);
}

const run = (args) => execFileSync("docker", args, { stdio: "inherit", env });
run([...compose, "build"]);
run([...compose, "run", "--rm", "--no-deps", "privacy-service", "python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"]);

// Настоящий pii-guard без NER: сервис обязан объявить себя not_ready.
const name = `frontsmith-privacy-ner-off-${process.pid}`;
run(["run", "-d", "--rm", "--name", name, "-e", "PII_GUARD_NER_DISABLED=1", "-e", "PRIVACY_SERVICE_TOKEN=x", "-p", "127.0.0.1:4312:8080", "frontsmith-privacy:poc"]);
try {
  let health = null;
  for (let attempt = 0; attempt < 60 && !health; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const response = await fetch("http://127.0.0.1:4312/health");
      health = { status: response.status, body: await response.json() };
    } catch {
      health = null;
    }
  }
  const ok = health?.status === 503 && health.body.reasons.includes("ner_disabled") && health.body.reasons.includes("entity_unavailable:PHONE_NUMBER");
  console.log(`${ok ? "PASS" : "FAIL"}  NER отключён: /health ${health?.status} ${health?.body?.reasons?.join(",")}`);
  const blocked = await fetch("http://127.0.0.1:4312/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x" },
    body: JSON.stringify({ tenant_id: "t" })
  });
  console.log(`${blocked.status === 503 ? "PASS" : "FAIL"}  NER отключён: POST /sessions ${blocked.status}`);
  process.exitCode = ok && blocked.status === 503 ? 0 : 1;
} finally {
  spawnSync("docker", ["stop", name], { stdio: "ignore" });
}
