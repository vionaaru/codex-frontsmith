import path from "node:path";
import { previewWebsiteRoot } from "./lib/paths.mjs";
import { createWebsiteServer } from "./lib/website-server.mjs";

const port = Number(readArg("--port") ?? 4173);
const source = process.argv.includes("--source");
const root = () => path.resolve(previewWebsiteRoot({ source }));

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

// Предпросмотр без AI runtime: чат на сайте отвечает «AI-помощник не запущен».
// Живой чат — в npm run frontsmith
const server = createWebsiteServer({ root, port });

server.listen(port, "127.0.0.1", () => {
  console.log(`Предпросмотр сайта Frontsmith: http://localhost:${port}`);
  console.log(`Каталог сайта: ${root()}`);
});
