// Клиент Privacy Service для доверенного Codex Host.
// Умеет только проверить готовность, открыть сессию, подготовить текст для модели
// и восстановить итоговый ответ для адресата. Методов получения mapping, исходных
// значений или дампа сессии нет: сервис их не предоставляет, и Host их не просит.

export const REQUIRED_ENTITIES = ["PERSON", "PHONE_NUMBER"];

export class PrivacyProcessingError extends Error {
  constructor(reason) {
    super("privacy_processing_failed");
    this.code = "privacy_processing_failed";
    this.reason = reason;
  }
}

export class PrivacyClient {
  constructor({ baseUrl, token, timeoutMs = 60_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #call(method, path, body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new PrivacyProcessingError("privacy_service_unavailable");
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  }

  // Готовность для клиентских диалогов: NER, обязательные типы и хранилище.
  async readiness() {
    const { status, payload } = await this.#call("GET", "/health");
    const reasons = [];
    if (!payload) reasons.push(`health_http_${status}`);
    else {
      if (!payload.ready) reasons.push(...(payload.reasons ?? ["not_ready"]));
      if (!payload.ner_enabled) reasons.push("ner_disabled");
      if (!payload.state_store_ready) reasons.push("state_store_unavailable");
      for (const entity of REQUIRED_ENTITIES) {
        if (!payload.available_entity_types?.includes(entity)) reasons.push(`entity_unavailable:${entity}`);
      }
    }
    return { ready: reasons.length === 0, reasons: [...new Set(reasons)], health: payload };
  }

  async assertReady() {
    const { ready, reasons, health } = await this.readiness();
    if (!ready) throw new PrivacyProcessingError(reasons.join(","));
    return health;
  }

  async createSession(tenantId) {
    const { status, payload } = await this.#call("POST", "/sessions", { tenant_id: tenantId });
    if (status !== 200 || typeof payload?.privacy_session_id !== "string") {
      throw new PrivacyProcessingError(payload?.error ?? `sessions_http_${status}`);
    }
    return { privacySessionId: payload.privacy_session_id, modelInstructions: payload.model_instructions ?? "" };
  }

  // Возвращает только псевдонимизированный текст. Любое другое поле ответа отбрасывается.
  async prepare({ tenantId, privacySessionId, text, source }) {
    const { status, payload } = await this.#call("POST", `/sessions/${encodeURIComponent(privacySessionId)}/prepare`, {
      tenant_id: tenantId,
      text,
      source
    });
    if (status !== 200 || typeof payload?.text !== "string") {
      throw new PrivacyProcessingError(payload?.error ?? `prepare_http_${status}`);
    }
    return { text: payload.text, replacements: payload.replacements ?? 0 };
  }

  async restoreFinalForRecipient({ tenantId, privacySessionId, text, recipient }) {
    const { status, payload } = await this.#call("POST", `/sessions/${encodeURIComponent(privacySessionId)}/restore`, {
      tenant_id: tenantId,
      text,
      recipient
    });
    if (status !== 200 || typeof payload?.text !== "string") {
      throw new PrivacyProcessingError(payload?.error ?? `restore_http_${status}`);
    }
    return payload.text;
  }
}
