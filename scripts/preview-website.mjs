import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { OPTIONS as contactOptions, POST as contactPost } from "../api/contact.js";
import { previewWebsiteRoot } from "./lib/paths.mjs";

const port = Number(readArg("--port") ?? 4173);
const source = process.argv.includes("--source");
const root = () => path.resolve(previewWebsiteRoot({ source }));

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

  if (pathname === "/api/contact") {
    await handleContactApi(req, res);
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const activeRoot = root();
  const filePath = path.join(activeRoot, requested);

  if (!filePath.startsWith(`${activeRoot}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Это не файл");
    res.writeHead(200, { "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Не найдено");
  }
});

async function handleContactApi(req, res) {
  const handler = req.method === "OPTIONS" ? contactOptions : req.method === "POST" ? contactPost : null;

  if (!handler) {
    res.writeHead(405, {
      "allow": "POST, OPTIONS",
      "content-type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify({ ok: false, error: "Метод не разрешён" }));
    return;
  }

  try {
    const request = new Request(`http://localhost:${port}${req.url ?? "/api/contact"}`, {
      method: req.method,
      headers: requestHeaders(req),
      body: req.method === "OPTIONS" ? undefined : req,
      duplex: req.method === "OPTIONS" ? undefined : "half"
    });
    const response = await handler(request);
    const headers = Object.fromEntries(response.headers.entries());
    const body = Buffer.from(await response.arrayBuffer());

    res.writeHead(response.status, headers);
    res.end(body);
  } catch (error) {
    console.error("Ошибка предпросмотра формы Frontsmith", error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Ошибка предпросмотра формы" }));
  }
}

function requestHeaders(req) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return headers;
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Предпросмотр сайта Frontsmith: http://localhost:${port}`);
  console.log(`Каталог сайта: ${root()}`);
});
