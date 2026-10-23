import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin, { createSources, footerHook } from "../openclaw/index.js";
import { resolvePluginConfig } from "../openclaw/config.js";
import { USAGE_SUMMARY } from "./fixtures.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-plugin-"));

/** A fake agy and a fake usage chunk, on disk. */
function world() {
  const dir = tmp();
  const agy = path.join(dir, "agy");
  fs.writeFileSync(agy, `#!/bin/sh\nprintf 'Gemini 4 Argon\\tGemini 4 Argon Weekly Limit\\t55%%\\t2026-10-28T07:04:55Z\\n'\n`);
  fs.chmodSync(agy, 0o755);
  const usage = path.join(dir, "usage.mjs");
  fs.writeFileSync(
    usage,
    `export async function loadProviderUsageSummary(opts) { globalThis.__qpUsageOpts = opts; return ${JSON.stringify(USAGE_SUMMARY)}; }\n`,
  );
  return { dir, agy, usage };
}

function fakeApi(pluginConfig, stateDir) {
  const services = [];
  const hooks = {};
  const logs = [];
  const api = {
    registrationMode: "full",
    pluginConfig,
    config: {},
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), debug() {} },
    registerService: (s) => services.push(s),
    on: (name, fn) => (hooks[name] = fn),
    runtime: {
      config: { current: () => ({ marker: "live" }) },
      state: { resolveStateDir: () => stateDir },
    },
  };
  return { api, services, hooks, logs };
}

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("the service writes agy + OpenClaw usage to status.json", async () => {
  const w = world();
  const { api, services, hooks, logs } = fakeApi(
    {
      items: [
        { label: "Argon", source: "agy:gemini-4-argon" },
        { label: "GPT", source: "usage:openai" },
        { label: "Opus", source: "usage:anthropic", window: "opus" },
      ],
      agy: { command: w.agy },
      usage: { module: w.usage, providers: ["openai", "anthropic"] },
      startDelayMs: 0,
    },
    w.dir,
  );
  plugin.register(api);
  assert.equal(services.length, 1);
  assert.equal(typeof hooks.agent_end, "function");
  assert.equal(hooks.message_sending, undefined, "footer is off by default, so no message_sending hook");
  const t0 = Date.now();
  await services[0].start({});
  assert.ok(Date.now() - t0 < 50, "start() does no work itself");
  const file = path.join(w.dir, "quota-presence", "status.json");
  await waitFor(() => fs.existsSync(file));
  await services[0].stop();
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(status.text, "Argon 55% | GPT 84% | Opus 88%");
  assert.deepEqual(status.items.map((i) => i.label), ["Argon", "GPT", "Opus"]);
  assert.ok(Date.parse(status.updatedAt) >= t0);
  assert.equal(globalThis.__qpUsageOpts.config.marker, "live");
  assert.deepEqual(globalThis.__qpUsageOpts.providers, ["openai", "anthropic"]);
  assert.ok(logs.some((l) => l.includes("status (startup)")));
  assert.equal(fs.existsSync(path.join(w.dir, "quota-presence", "agy.lock")), false);
});

test("hooks are registered only as configured; nothing outside full registration", () => {
  const off = fakeApi({ refreshOnAgentEnd: false }, "/x");
  plugin.register(off.api);
  assert.deepEqual(Object.keys(off.hooks), []);
  const on = fakeApi({ footer: { enabled: true } }, "/x");
  plugin.register(on.api);
  assert.deepEqual(Object.keys(on.hooks).sort(), ["agent_end", "message_sending"]);
  const disc = fakeApi({}, "/x");
  disc.api.registrationMode = "tool-discovery";
  plugin.register(disc.api);
  assert.equal(disc.services.length, 0);
});

test("footer: a -# line under Discord replies, once", () => {
  const running = { renderWith: (o) => (o.template === "-# {items}" ? "-# Argon 55%" : "?") };
  assert.deepEqual(footerHook(running, {}, { to: "channel:1", content: "hello" }, { channelId: "discord" }), {
    content: "hello\n-# Argon 55%",
  });
  assert.equal(footerHook(running, {}, { content: "hello\n-# Argon 55%" }, { channelId: "discord" }), undefined);
  assert.equal(footerHook(running, {}, { content: "hello" }, { channelId: "line" }), undefined);
  assert.equal(footerHook(running, {}, { content: "  " }, { channelId: "discord" }), undefined);
  assert.equal(footerHook(null, {}, { content: "hello" }, { channelId: "discord" }), undefined);
  assert.equal(footerHook({ renderWith: () => "" }, {}, { content: "hello" }, { channelId: "discord" }), undefined);
  assert.deepEqual(footerHook(running, { channels: [] }, { content: "hi" }, { channelId: "line" }), { content: "hi\n-# Argon 55%" });
});

test("config defaults", () => {
  const c = resolvePluginConfig({}, { stateDir: "/s" });
  assert.equal(c.intervalMs, 900_000);
  assert.equal(c.minUpdateIntervalMs, 120_000);
  assert.equal(c.items, "auto");
  assert.equal(c.footer.enabled, false);
  assert.equal(c.statusFile, "/s/quota-presence/status.json");
  assert.equal(resolvePluginConfig({ statusFile: "/elsewhere/s.json" }, { stateDir: "/s" }).statusFile, "/elsewhere/s.json");
  assert.equal(c.agy.lockFile, "/s/quota-presence/agy.lock");
  assert.deepEqual(c.agy.args, ["-p", "/usage"]);
  assert.equal(resolvePluginConfig({ intervalMs: 1000, maxLength: 999 }, { stateDir: "/s" }).intervalMs, 60_000);
  assert.equal(resolvePluginConfig({ maxLength: 999 }, { stateDir: "/s" }).maxLength, 128);
  assert.equal(c.claudeCode.enabled, false, "reading Claude Code's login is opt-in");
  assert.equal(c.markStaleAfterMs, 35 * 60_000);
  assert.equal(resolvePluginConfig({ intervalMs: 600_000 }, { stateDir: "/s" }).markStaleAfterMs, 25 * 60_000);
  assert.equal(resolvePluginConfig({ markStaleAfterMs: 0 }, { stateDir: "/s" }).markStaleAfterMs, 0);
  assert.equal(c.staleMark, "*");
});

test("sources: claude-code only when enabled", () => {
  const ids = (pc) => createSources({}, {}, resolvePluginConfig(pc, { stateDir: "/s" })).map((s) => s.id);
  assert.deepEqual(ids({}), ["agy", "usage"]);
  assert.deepEqual(ids({ claudeCode: { enabled: true }, agy: { enabled: false }, usage: { enabled: false } }), ["claude-code"]);
  const c = resolvePluginConfig({ claudeCode: { enabled: true, credentialsFile: "~/x/.credentials.json" } }, { stateDir: "/s" });
  assert.equal(c.claudeCode.credentialsFile, path.join(os.homedir(), "x/.credentials.json"));
});

test("the manifest's configSchema covers every config key", async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  const { DEFAULTS } = await import("../openclaw/config.js");
  const props = manifest.configSchema.properties;
  for (const k of Object.keys(DEFAULTS)) assert.ok(k in props, `configSchema lacks ${k}`);
  for (const k of ["statusFile", "timeZone"]) assert.ok(k in props);
  for (const k of ["status", "accountId", "discordRuntimeModule", "reapplyCheckMs"]) assert.ok(!(k in props), `${k} is gone`);
  for (const k of Object.keys(DEFAULTS.agy)) assert.ok(k in props.agy.properties, `agy.${k}`);
  for (const k of Object.keys(DEFAULTS.usage)) assert.ok(k in props.usage.properties, `usage.${k}`);
  for (const k of Object.keys(DEFAULTS.footer)) assert.ok(k in props.footer.properties, `footer.${k}`);
  for (const k of [...Object.keys(DEFAULTS.claudeCode), "credentialsFile"]) assert.ok(k in props.claudeCode.properties, `claudeCode.${k}`);
  assert.ok("markStaleAfterMs" in props);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.id, plugin.id);
});
