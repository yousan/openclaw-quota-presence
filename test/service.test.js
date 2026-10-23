import test from "node:test";
import assert from "node:assert/strict";
import { resolvePluginConfig } from "../openclaw/config.js";
import { createQuotaPresence } from "../src/service.js";
import { normalizeUsageSummary, parseAgyUsage } from "../src/quota.js";
import { AGY_TSV, EXAMPLE_ITEMS, USAGE_SUMMARY } from "./fixtures.js";

/** Manual clock + timers. */
function clock(start = 1_000_000) {
  let t = start;
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => (timers.set(++id, { fn, at: t + ms }), id),
      clearTimeout: (h) => timers.delete(h),
      setInterval: (fn, ms) => (timers.set(++id, { fn, at: t + ms, every: ms }), id),
      clearInterval: (h) => timers.delete(h),
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [h, v] = next;
        t = v.at;
        if (v.every) v.at += v.every;
        else timers.delete(h);
        v.fn();
        await settle();
      }
      t = end;
    },
  };
}
const settle = () => new Promise((r) => setImmediate(r));

/** Collects what the service publishes. */
function fakeSink() {
  const out = [];
  const publish = (status) => out.push(status);
  publish.out = out;
  publish.texts = () => out.map((s) => s.text);
  return publish;
}

const quiet = { info() {}, warn() {}, debug() {} };

function setup({ agy, usage, configOverrides = {} } = {}) {
  const c = clock();
  const calls = { agy: 0, usage: 0 };
  const sources = [
    { id: "agy", fetch: async () => (calls.agy++, agy ? agy() : parseAgyUsage(AGY_TSV)) },
    { id: "usage", fetch: async () => (calls.usage++, usage ? usage() : normalizeUsageSummary(USAGE_SUMMARY)) },
  ];
  const config = resolvePluginConfig({ items: EXAMPLE_ITEMS, ...configOverrides }, { stateDir: "/s" });
  const publish = fakeSink();
  const warns = [];
  const infos = [];
  const svc = createQuotaPresence({
    config,
    sources,
    publish,
    log: { ...quiet, info: (m) => infos.push(m), warn: (m) => warns.push(m) },
    now: c.now,
    timers: c.timers,
  });
  return { c, calls, svc, publish, warns, infos, config };
}

test("refresh renders every source into one status and publishes text, items and updatedAt", async () => {
  const { svc, publish, c } = setup();
  const r = await svc.refresh();
  assert.equal(r.text, "Argon 55% | GPT 84% | Opus 88%");
  assert.equal(r.written, true);
  assert.equal(publish.out.length, 1);
  const s = publish.out[0];
  assert.equal(s.text, "Argon 55% | GPT 84% | Opus 88%");
  assert.equal(s.updatedAt, new Date(c.now()).toISOString());
  assert.deepEqual(
    s.items.map((i) => [i.label, i.source, i.remaining]),
    [["Argon", "agy:gemini-4-argon", 55], ["GPT", "usage:openai", 84], ["Opus", "usage:anthropic", 88]],
  );
});

test("start returns at once, fetches after startDelayMs, then every intervalMs; stop clears the timers", async () => {
  const { c, calls, svc } = setup();
  svc.start();
  await settle();
  assert.equal(calls.agy, 0, "nothing runs inside start()");
  await c.advance(10_000);
  assert.equal(calls.agy, 1);
  await c.advance(15 * 60_000 - 10_001);
  assert.equal(calls.agy, 1);
  await c.advance(1);
  assert.equal(calls.agy, 2);
  svc.stop();
  assert.equal(c.pending(), 0);
});

test("agent_end refreshes at most once per minUpdateIntervalMs, then once at the end of the gap", async () => {
  const { c, calls, svc } = setup();
  await svc.refresh();
  assert.equal(svc.request("agent_end"), "scheduled");
  assert.equal(svc.request("agent_end"), "coalesced");
  assert.equal(svc.request("agent_end"), "coalesced");
  await c.advance(2 * 60_000 - 1);
  assert.equal(calls.agy, 1);
  await c.advance(1);
  assert.equal(calls.agy, 2);
  await c.advance(2 * 60_000);
  assert.equal(svc.request("agent_end"), "now");
  await settle();
  assert.equal(calls.agy, 3);
});

test("the file is rewritten every refresh (fresh updatedAt); the log line only when the text changes", async () => {
  const { svc, publish, infos, c } = setup();
  await svc.refresh();
  await c.advance(60_000);
  await svc.refresh();
  assert.equal(publish.out.length, 2);
  assert.notEqual(publish.out[0].updatedAt, publish.out[1].updatedAt);
  assert.equal(infos.filter((m) => m.startsWith("status (")).length, 1);
});

test("a failed write is logged and reported, and the next refresh tries again", async () => {
  const c = clock();
  let fail = true;
  const warns = [];
  const svc = createQuotaPresence({
    config: resolvePluginConfig({ items: EXAMPLE_ITEMS }, { stateDir: "/s" }),
    sources: [{ id: "agy", fetch: async () => parseAgyUsage(AGY_TSV) }],
    publish: () => {
      if (fail) throw new Error("EACCES");
    },
    log: { ...quiet, warn: (m) => warns.push(m) },
    now: c.now,
    timers: c.timers,
  });
  assert.deepEqual([(await svc.refresh()).written, warns], [false, ["could not write the status: EACCES"]]);
  fail = false;
  assert.equal((await svc.refresh()).written, true);
});

test("a failing source keeps its last numbers (until stale) and logs once", async () => {
  let fail = false;
  const { c, svc, warns, publish } = setup({
    agy: () => {
      if (fail) throw new Error("agy timed out after 15000ms");
      return parseAgyUsage(AGY_TSV);
    },
    configOverrides: { staleAfterMs: 60 * 60_000 },
  });
  await svc.refresh();
  fail = true;
  await c.advance(30 * 60_000);
  assert.equal((await svc.refresh()).text, "Argon 55% | GPT 84% | Opus 88%");
  await svc.refresh();
  assert.deepEqual(warns, ["agy: agy timed out after 15000ms"]);
  await c.advance(31 * 60_000);
  assert.equal((await svc.refresh()).text, "Argon ? | GPT 84% | Opus 88%");
  assert.deepEqual(new Set(publish.texts()), new Set(["Argon 55% | GPT 84% | Opus 88%", "Argon ? | GPT 84% | Opus 88%"]));
});

test("a provider missing from one usage reply keeps its last numbers", async () => {
  let summary = USAGE_SUMMARY;
  const { svc } = setup({ usage: () => normalizeUsageSummary(summary) });
  await svc.refresh();
  summary = { providers: [{ provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" }, USAGE_SUMMARY.providers[0]] };
  assert.equal((await svc.refresh()).text, "Argon 55% | GPT 84% | Opus 88%");
});

test("all sources down from the start: items show as unknown; nothing at all with auto", async () => {
  const down = () => {
    throw new Error("down");
  };
  const a = setup({ agy: down, usage: down });
  assert.equal((await a.svc.refresh()).text, "Argon ? | GPT ? | Opus ?");
  const b = setup({ agy: down, usage: down, configOverrides: { items: "auto" } });
  const r = await b.svc.refresh();
  assert.equal(r.text, "");
  assert.deepEqual(b.publish.out.map((s) => [s.text, s.items]), [["", []]], "an empty line is still written; the reader keeps its last status");
});

test("renderWith gives the footer its own template", async () => {
  const { svc } = setup();
  await svc.refresh();
  assert.equal(svc.renderWith({ template: "-# {items}" }), "-# Argon 55% | GPT 84% | Opus 88%");
});
