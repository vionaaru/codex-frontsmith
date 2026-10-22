// ТЕСТОВЫЙ ДВОЙНИК Privacy Service для `npm run test:codex-host`.
// Повторяет HTTP-контракт services/privacy, но вместо pii-guard заменяет два
// синтетических значения регулярными выражениями. Нужен только для проверки
// Codex Host без Docker; настоящая псевдонимизация проверяется в services/privacy.
// Ответ prepare намеренно содержит лишние поля (mapping, normalized_text), чтобы
// тест доказал, что Host их отбрасывает.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PATTERNS = [
  ["PERSON", /Иван(?:а|у|ом|е)? Петров(?:а|у|ым|е)?/g, "Иван Петров"],
  ["PERSON", /Мари(?:я|и|ю|ей) Сидоров(?:а|ой|у)/g, "Мария Сидорова"],
  ["PHONE_NUMBER", /\+7 \d{3} \d{3}-\d{2}-\d{2}/g, null]
];

export async function startFakePrivacyService({ token = "fake-token" } = {}) {
  const sessions = new Map();
  const mode = { ner: true, store: true, prepareFails: false, failSource: null };
  const calls = [];

  function pseudonymize(session, text) {
    let out = text;
    for (const [type, pattern, canonical] of PATTERNS) {
      out = out.replace(pattern, (value) => {
        const key = `${type}:${canonical ?? value}`;
        if (!session.tags.has(key)) {
          session.counters[type] = (session.counters[type] ?? 0) + 1;
          const tag = `<PII type="${type}" id="${session.counters[type]}" />`;
          session.tags.set(key, tag);
          session.mapping.set(tag, canonical ?? value);
        }
        return session.tags.get(key);
      });
    }
    return out;
  }

  const health = () => {
    const reasons = [...(mode.ner ? [] : ["ner_disabled", "entity_unavailable:PERSON", "entity_unavailable:PHONE_NUMBER"]), ...(mode.store ? [] : ["state_store_unavailable"])];
    return {
      status: reasons.length ? "not_ready" : "ready",
      ready: reasons.length === 0,
      reasons,
      pii_guard_version: "fake",
      ner_enabled: mode.ner,
      available_entity_types: mode.ner ? ["PERSON", "PHONE_NUMBER", "INN"] : ["INN"],
      required_entity_types: ["PERSON", "PHONE_NUMBER"],
      state_store_ready: mode.store
    };
  };

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    calls.push(`${req.method} ${req.url.replace(/ps_[^/]+/, ":id")}`);
    if (req.url === "/health") return reply(health().ready ? 200 : 503, health());
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
    if (!health().ready) return reply(503, { error: "privacy_not_ready", reasons: health().reasons });
    if (req.method === "POST" && req.url === "/sessions") {
      const id = `ps_${randomUUID()}`;
      sessions.set(id, { tenant: json.tenant_id, counters: {}, tags: new Map(), mapping: new Map() });
      return reply(200, { privacy_session_id: id, tenant_id: json.tenant_id, model_instructions: "Сохраняй теги <PII .../>." });
    }
    const match = req.url.match(/^\/sessions\/([^/]+)\/(prepare|restore)$/);
    const session = match && sessions.get(decodeURIComponent(match[1]));
    if (!session || session.tenant !== json.tenant_id) return reply(404, { error: "privacy_session_not_found" });
    if (match[2] === "prepare") {
      if (mode.prepareFails || mode.failSource === json.source) return reply(503, { error: "anonymizer_failed" });
      const text = pseudonymize(session, json.text);
      return reply(200, { text, replacements: (text.match(/<PII/g) ?? []).length, mapping: Object.fromEntries(session.mapping), normalized_text: json.text });
    }
    if (json.recipient !== "operator") return reply(403, { error: "recipient_not_allowed" });
    const restored = json.text.replace(/<PII\b[^>]*\/>/g, (tag) => session.mapping.get(tag) ?? "****");
    return reply(200, { text: restored });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    mode,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
