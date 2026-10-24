// HTTP-клиент crmkit для доверенных процессов Frontsmith. Всегда JSON.
// Тексты ошибок crmkit (hint) могут повторять email или имя из запроса, поэтому
// наружу уходят только HTTP-статус и код ошибки.
export class CrmError extends Error {
  constructor(code, status = 0) {
    super(`crmkit: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.code = code;
    this.status = status;
  }
}

export class CrmkitClient {
  #token;

  constructor({ baseUrl, token = null, timeoutMs = 10_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, body, { version } = {}) {
    const headers = { accept: "application/json" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (version !== undefined && version !== null) headers["if-match"] = String(version);
    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new CrmError("crm_unavailable");
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* тело не JSON */
    }
    if (!response.ok) throw new CrmError(typeof payload?.error === "string" ? payload.error : "crm_error", response.status);
    return { ...payload, __status: response.status };
  }

  // Безопасный признак для журналов: сам токен в строковое представление не попадает.
  toJSON() {
    return { baseUrl: this.baseUrl, authenticated: Boolean(this.#token) };
  }
}
