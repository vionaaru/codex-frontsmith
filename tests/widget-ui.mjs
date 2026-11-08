// Prepared GenUI catalog → scoped model tool → authenticated visitor state.
// No real model, customer contacts, credentials, packages or network services.
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultBrand, validateBrand } from "../scripts/lib/brand.mjs";
import { publicWidgetConfig, validateWidget } from "../scripts/lib/widget.mjs";
import "../website/widget-shell.js";
import { ConversationCore, ConversationError } from "../services/conversation/core.mjs";
import { ConversationStore } from "../services/conversation/store.mjs";
import { WIDGET_UI_TOOL } from "../services/conversation/widget-ui.mjs";
import { createWebChannel } from "../services/conversation/web-channel.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "frontsmith-widget-"));
const business = path.join(temp, "business");
const env = { ...process.env, FRONTSMITH_BUSINESS_ROOT: business, FRONTSMITH_DATA_ROOT: path.join(temp, "data") };
const run = (file, ...args) => promisify(execFile)(process.execPath, [file, ...args], { env, windowsHide: true });
const widget = { question: "Чем помочь?", surface: "layered", components: [
  { id: "services", type: "services", title: "Выберите услугу" },
  { id: "details", type: "choices", title: "Уточните задачу", options: [{ label: "Не знаю", message: "Помогите разобраться" }] }
] };
let store, site;
try {
  assert.equal(validateBrand({ ...defaultBrand, widget }).widget.surface, "layered");
  for (const broken of [{ ...widget, object: "https://remote.invalid/logo.png" }, { ...widget, start: "unknown" }, { ...widget, components: [{ type: "choices", title: "bad", options: [] }] }, { ...widget, components: [{ id: "bad", type: "html", title: "bad" }] }]) assert.throws(() => validateWidget(broken));
  const config = publicWidgetConfig({ ...defaultBrand, widget, logo: "logo.png" }, { services: [{ id: "consult", name: "Консультация" }] });
  assert.equal(config.object, "/brand-assets/logo.png");
  assert.equal(config.tones.length, 5);
  assert.equal(config.tones[0].color, defaultBrand.light.accent);
  for (const tone of config.tones) for (const mode of ["light", "dark"]) {
    const { contrast } = await import("../scripts/lib/brand.mjs");
    assert.ok(contrast(tone[mode].accent, tone[mode].onAccent) >= 4.5, "text remains readable in every tone/theme");
    assert.ok(contrast(tone[mode].accent, defaultBrand[mode].surface) >= 3, "controls remain visible");
  }
  const customTones = { brand: "#ffddcc", darker: "#dabbaa", lighter: "#fff3ef", warmer: "#ffddbb", cooler: "#eedddd" };
  const pale = publicWidgetConfig({ ...defaultBrand, widget: { ...widget, tones: customTones } }, {});
  assert.equal(pale.tones[0].color, "#ffddcc", "exact source retained even when too pale for controls");
  assert.equal(pale.tones[0].light.accent, defaultBrand.light.accent);
  for (const broken of [{ geometry: "html" }, { tones: { brand: "#000000" } }, { tones: { ...customTones, darker: "#ffffff" } }, { tones: { ...customTones, warmer: "url(bad)" } }, { components: [{ ...widget.components[0], shell: "form" }] }]) assert.throws(() => validateWidget({ ...widget, ...broken }));
  let painted = [];
  const controller = globalThis.FrontsmithWidgetShell(config, (state, tone) => painted.push([state, tone.id]), () => 0);
  for (const state of ["object", "question", "conversation", "form", "result"]) controller.enter(state);
  assert.deepEqual(painted.map(item => item[1]), Array(5).fill("brand"), "first entry of every shell uses the brand");
  controller.enter("conversation"); assert.equal(painted.at(-1)[1], "darker");
  const before = painted.length; controller.enter("conversation"); controller.enter("untrusted");
  assert.equal(painted.length, before, "ordinary messages and invalid states cannot recolor the shell");
  controller.refresh(); assert.equal(painted.at(-1)[1], "darker", "theme refresh keeps the selected tone");
  controller.enter("object"); controller.enter("conversation"); assert.equal(painted.at(-1)[1], "brand", "repeat excludes the previous tone");
  assert.equal(publicWidgetConfig({ ...defaultBrand, widget: { ...widget, object: "white-logo.png", objectBackground: "#222222" } }, {}).objectBackground, "#222222");
  assert.throws(() => validateWidget({ ...widget, objectBackground: "url(bad)" }));
  assert.equal(config.components[0].options[0].label, "Консультация");
  assert.equal(publicWidgetConfig(defaultBrand, {}), null);
  await mkdir(path.join(business, "design/public"), { recursive: true });
  await writeFile(path.join(business, "design/public/logo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh9sAAAAASUVORK5CYII=", "base64"));
  const profile = { ...JSON.parse(await readFile("blueprints/generic-service/business.example.json", "utf8")), businessName: "Synthetic", services: [{ id: "consult", name: "Консультация" }] };
  const profileFile = path.join(temp, "profile.json");
  await writeFile(profileFile, JSON.stringify(profile));
  await run("scripts/business-init.mjs", "--profile", profileFile, "--skip-website");
  const brand = { ...defaultBrand, logo: "logo.png", widget: { ...widget, question: "Вопрос </script><script>bad()</script>" } };
  await writeFile(path.join(business, "design/brand.json"), JSON.stringify(brand));
  await run("scripts/update-website.mjs");
  const html = await readFile(path.join(business, "website/index.html"), "utf8");
  const embedded = /<script type="application\/json" id="frontsmith-widget-config">(.*?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(embedded, /<script/);
  assert.equal(JSON.parse(embedded).question, brand.widget.question);
  await run("scripts/update-website.mjs");
  assert.equal(await readFile(path.join(business, "website/index.html"), "utf8"), html);
  await writeFile(path.join(business, "design/brand.json"), JSON.stringify({ ...brand, widget: { ...widget, object: "missing.png" } }));
  await assert.rejects(run("scripts/update-website.mjs"));
  assert.equal(await readFile(path.join(business, "website/index.html"), "utf8"), html, "missing widget asset does not overwrite site");

  store = new ConversationStore({ file: path.join(temp, "conversations.sqlite") });
  let tool, lastContext, rejectTurn = false, takeover = false;
  const host = {
    async openConversation({ context }) { lastContext = context; const id = randomUUID(); return { conversationId: id, threadId: id, privacySessionId: "synthetic" }; },
    async resumeConversation({ threadId }) { return { conversationId: threadId, threadId }; },
    async send(threadId, text) {
      const componentId = text.match(/\b(details|services|bad)$/)?.[1];
      assert.equal(await tool.handler({ componentId }, { threadId }), componentId === "bad" ? "widget_unknown_component" : "widget_selected: компонент будет показан после успешного ответа. Не утверждай, что действие уже выполнено");
      const row = store.byThread(threadId);
      assert.equal((await core.visitorUi(row.id)).component, null, "no UI before successful completion");
      if (takeover) core.handoff(row.id, "test", { by: "visitor" });
      if (rejectTurn) throw new ConversationError("privacy_unavailable");
      return { text: "Уточните задачу", toolCalls: [WIDGET_UI_TOOL] };
    }
  };
  let currentConfig = config;
  const core = new ConversationCore({ store, host: () => host, context: async () => "Synthetic public facts", widget: async () => currentConfig, tools: [WIDGET_UI_TOOL] });
  tool = core.widgetTool();
  assert.equal(await tool.handler({ componentId: "details" }, { threadId: "foreign" }), "widget_unavailable");
  const visitor = core.start({ channel: "web" });
  await core.reply(visitor.id, "details");
  assert.match(lastContext, /details: Уточните задачу/);
  assert.equal((await core.visitorUi(visitor.id)).component.id, "details");
  const restarted = new ConversationCore({ store, host: () => host, context: async () => "Synthetic public facts", widget: async () => config, tools: [WIDGET_UI_TOOL] });
  assert.equal((await restarted.visitorUi(visitor.id)).component, null, "restart does not resurrect obsolete UI");
  // The choice follows the model tool call, not keywords in the assistant's text.
  await core.reply(visitor.id, "services");
  assert.equal((await core.visitorUi(visitor.id)).component.id, "services");
  await core.reply(visitor.id, "bad");
  assert.equal((await core.visitorUi(visitor.id)).component, null);
  rejectTurn = true;
  await assert.rejects(core.reply(visitor.id, "details"), error => error.code === "privacy_unavailable");
  assert.equal((await core.visitorUi(visitor.id)).component, null);
  rejectTurn = false;
  await core.reply(visitor.id, "details");
  currentConfig = { ...config, components: [] };
  assert.equal((await core.visitorUi(visitor.id)).component, null, "removed components are not replayed");
  currentConfig = config;
  takeover = true;
  await core.reply(visitor.id, "details");
  assert.equal((await core.visitorUi(visitor.id)).component, null, "handoff discards model UI");
  let secured;
  site = createServer((req, res) => secured.handle(req, res, new URL(req.url, "http://local").pathname));
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = site.address().port;
  secured = createWebChannel({ core, allowedHosts: new Set([`127.0.0.1:${port}`]) });
  const request = token => fetch(`http://127.0.0.1:${port}/api/chat/ui`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ conversationId: visitor.id }) });
  assert.equal((await request("foreign")).status, 401);
  const other = core.start({ channel: "web" });
  assert.equal((await request(other.token)).status, 401, "another valid visitor token cannot read this UI");
  const authorized = await request(visitor.token); assert.equal(authorized.status, 200); assert.equal((await authorized.json()).component, null);
  console.log("Widget UI PASS: config/assets/escaping/update, model-selected components, failure/hand-off isolation, authenticated state");
} finally {
  if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
  store?.close();
  await rm(temp, { recursive: true, force: true });
}
