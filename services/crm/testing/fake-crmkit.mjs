// Тестовый двойник HTTP API crmkit v0.9.1 в памяти: только то, чем пользуется
// CrmkitProvider. Повторяет проверенное на настоящем crmkitd поведение: upsert по email
// без учёта регистра, фильтры custom.* (eq и like, без in), поиск ?search= с учётом
// регистра кириллицы, версии и 412, bearer-токен. Для `npm test` без бинарника.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

// Двойник + каталог данных Frontsmith с учётными данными для него. Доверенные процессы
// (CLI, панель) находят его через FRONTSMITH_DATA_ROOT и FRONTSMITH_CRM_URL
export async function useFakeCrm(dataRoot) {
  const fake = await startFakeCrmkit();
  mkdirSync(path.join(dataRoot, "crm"), { recursive: true });
  writeFileSync(path.join(dataRoot, "crm", "credential.json"), JSON.stringify({ version: 1, token: fake.token, workspaceId: fake.workspaceId }));
  process.env.FRONTSMITH_DATA_ROOT = dataRoot;
  process.env.FRONTSMITH_CRM_URL = fake.url;
  return fake;
}

export async function startFakeCrmkit({ token = `ck_test_${randomBytes(8).toString("hex")}`, workspaceId = "ws_test" } = {}) {
  const contacts = [];
  const requests = [];
  const faults = { failNext: 0, dropResponseAfterCreate: false };
  let seq = 0;

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const find = (ref) => contacts.find((contact) => contact.id === ref || contact.handle === ref || `contact_${contact.handle}` === ref);
  const read = async (req) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : {};
  };
  const visible = (contact) => structuredClone(contact);
  const likeOrEq = (value, rule) => (rule.startsWith("like:") ? String(value ?? "").includes(rule.slice(5)) : rule.startsWith("in:") ? false : String(value ?? "") === rule);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null });
    if (url.pathname === "/readyz" || url.pathname === "/healthz") return send(res, 200, { status: "ok" });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "auth_required", hint: "login" });
    if (faults.failNext > 0) {
      faults.failNext -= 1;
      return send(res, 503, { error: "server_error" });
    }
    if (url.pathname === "/whoami") return send(res, 200, { workspace_id: workspaceId, email: "frontsmith-host@frontsmith.invalid" });
    if (url.pathname === "/contacts" && req.method === "GET") {
      let list = [...contacts];
      for (const [key, rule] of url.searchParams) {
        if (key.startsWith("custom.")) list = list.filter((contact) => likeOrEq(contact.custom?.[key.slice(7)], rule));
        else if (key === "phone" || key === "email" || key === "name") list = list.filter((contact) => likeOrEq(contact[key], rule));
        else if (key === "search") list = list.filter((contact) => ["name", "email", "phone"].some((field) => String(contact[field] ?? "").includes(rule)));
      }
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = list.slice(offset, offset + limit);
      return send(res, 200, { items: page.map(visible), next_cursor: offset + limit < list.length ? String(offset + limit) : "", total: list.length });
    }
    if (url.pathname === "/contacts" && req.method === "POST") {
      const body = await read(req);
      if (!String(body.name ?? "").trim()) return send(res, 400, { error: "missing_field" });
      const existing = body.email ? contacts.filter((contact) => contact.email?.toLowerCase() === body.email.toLowerCase()) : [];
      if (existing.length > 1) return send(res, 409, { error: "ambiguous_match" });
      if (existing.length === 1) {
        Object.assign(existing[0], body, { version: existing[0].version + 1, updated_at: new Date().toISOString() });
        return send(res, 200, visible(existing[0]));
      }
      seq += 1;
      const now = new Date().toISOString();
      const contact = { id: `c_fake${String(seq).padStart(6, "0")}`, handle: `h${seq}`, version: 1, name: body.name, email: body.email || undefined, phone: body.phone || undefined,
        tags: body.tags ?? [], notes: body.notes || undefined, custom: body.custom ?? {}, created_at: now, updated_at: now };
      contacts.push(contact);
      if (faults.dropResponseAfterCreate) {
        faults.dropResponseAfterCreate = false;
        req.socket.destroy();
        return undefined;
      }
      return send(res, 201, visible(contact));
    }
    const match = /^\/contacts\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const contact = find(decodeURIComponent(match[1]));
      if (!contact) return send(res, 404, { error: "not_found" });
      if (req.method === "GET") return send(res, 200, visible(contact));
      if (req.method === "PATCH") {
        const body = await read(req);
        const expected = body.version ?? (req.headers["if-match"] ? Number(req.headers["if-match"]) : 0);
        if (expected > 0 && expected !== contact.version) return send(res, 412, { error: "version_conflict" });
        delete body.version;
        for (const [key, value] of Object.entries(body)) {
          if (value === "") delete contact[key];
          else contact[key] = value;
        }
        contact.version += 1;
        contact.updated_at = new Date().toISOString();
        return send(res, 200, visible(contact));
      }
    }
    return send(res, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, workspaceId, contacts, requests, faults, close: () => new Promise((resolve) => server.close(resolve)) };
}
