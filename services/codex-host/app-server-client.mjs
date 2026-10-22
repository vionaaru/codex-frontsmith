// JSON-RPC клиент Codex App Server. Основной транспорт — stdio дочернего процесса
// `codex app-server`, отладочный — WebSocket (`codex app-server --listen ws://...`).
// Сообщения — по одному JSON-объекту на строку, поле "jsonrpc" не передаётся.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class AppServerError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "app-server error"}`);
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AppServerClient extends EventEmitter {
  #send;
  #close;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor({ send, close }) {
    super();
    this.#send = send;
    this.#close = close;
  }

  // Запускает долгоживущий `codex app-server` (args по умолчанию) на stdio. env передаётся целиком:
  // вызывающий решает, какие переменные видит процесс Codex.
  static spawn({ codexBin, args = ["app-server"], env, cwd, onStderr }) {
    const child = spawn(codexBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const client = new AppServerClient({
      send: (line) => child.stdin.write(`${line}\n`),
      close: () => {
        child.stdin.end();
        setTimeout(() => child.kill(), 2000).unref();
      }
    });
    client.process = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) client.receive(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => onStderr?.(chunk));
    child.on("error", (error) => client.fail(error));
    child.on("exit", (code) => client.fail(new Error(`codex app-server exited with code ${code}`)));
    return client;
  }

  // Отладочный режим для уже запущенного `codex app-server --listen ws://127.0.0.1:<port>`.
  static async connectWebSocket(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    const client = new AppServerClient({ send: (line) => socket.send(line), close: () => socket.close() });
    socket.addEventListener("message", (event) => client.receive(String(event.data)));
    socket.addEventListener("close", () => client.fail(new Error("app-server websocket closed")));
    return client;
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("non-JSON line from app-server"));
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new AppServerError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) this.emit("request", message);
    else this.emit("notification", message);
  }

  fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.emit("closed", error);
  }

  request(method, params) {
    if (this.#closed) return Promise.reject(new Error("app-server connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method, params) {
    this.#send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id, result) {
    this.#send(JSON.stringify({ id, result }));
  }

  respondError(id, code, message) {
    this.#send(JSON.stringify({ id, error: { code, message } }));
  }

  close() {
    this.fail(new Error("app-server connection closed by host"));
    this.#close();
  }
}
