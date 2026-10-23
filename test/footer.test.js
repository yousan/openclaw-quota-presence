import test from "node:test";
import assert from "node:assert/strict";
import { footerHook } from "../openclaw/index.js";
import { resolvePluginConfig } from "../openclaw/config.js";
import { applyFooter, footerPattern } from "../src/footer.js";
import { createQuotaPresence } from "../src/service.js";
import { normalizeUsageSummary, parseAgyUsage } from "../src/quota.js";
import { AGY_TSV, EXAMPLE_ITEMS, USAGE_SUMMARY } from "./fixtures.js";

const LINE = "-# Argon 55% | GPT 84% | Opus 88%";
const P = footerPattern({ items: EXAMPLE_ITEMS });
const discord = { channelId: "discord", accountId: "default", conversationId: "channel:1" };

/** A real service with fetched rows; counts fetches. */
async function service(items = EXAMPLE_ITEMS) {
  const fetches = { n: 0 };
  const config = { ...resolvePluginConfig({ items }, { stateDir: "/s" }), staleAfterMs: 0 };
  const running = createQuotaPresence({
    config,
    sources: [
      { id: "agy", fetch: async () => (fetches.n++, parseAgyUsage(AGY_TSV)) },
      { id: "usage", fetch: async () => (fetches.n++, normalizeUsageSummary(USAGE_SUMMARY)) },
    ],
    log: { info() {}, warn() {}, debug() {} },
  });
  await running.refresh("test");
  return { running, fetches };
}

test("the pattern matches footers with any numbers, and nothing else", () => {
  assert.ok(P.test(LINE));
  assert.ok(P.test("-# Argon 0% | GPT 100% | Opus ?"));
  assert.ok(P.test("-# Opus 3%"), "a subset of the items");
  assert.ok(!P.test("-# 注: 進捗 50%"), "the model's own small text stays");
  assert.ok(!P.test("Argon 55% | GPT 84%"), "not without the -# prefix");
  assert.ok(!P.test("-# Argon 55% | GPT 84% | Opus 88% and more"));
  const auto = footerPattern({ items: "auto" });
  assert.ok(auto.test("-# Gemini 4 Argon 51% | OpenAI 69%"));
  const timed = footerPattern({ template: "-# {items} ({time})", items: EXAMPLE_ITEMS });
  assert.ok(timed.test("-# Argon 55% | GPT 84% (23:05)"));
  assert.ok(footerPattern({ template: "-# [x] {items}", items: EXAMPLE_ITEMS }).test("-# [x] Argon 1%"), "literal regex characters");
});

test("applyFooter: one line, at the end", () => {
  assert.equal(applyFooter("hello", LINE, P), `hello\n${LINE}`);
  assert.equal(applyFooter("hello\n\n", LINE, P), `hello\n${LINE}`, "trailing blank lines");
  assert.equal(applyFooter("a\nb", LINE, P), `a\nb\n${LINE}`);
  assert.equal(applyFooter("```js\nx()\n```", LINE, P), "```js\nx()\n```\n" + LINE, "after a closed code block");
});

test("applyFooter: never twice (resend, re-edit, a footer the model copied)", () => {
  assert.equal(applyFooter(`hello\n${LINE}`, LINE, P), undefined, "already there: no change");
  const once = applyFooter("hello", LINE, P);
  assert.equal(applyFooter(once, LINE, P), undefined, "idempotent");
  assert.equal(applyFooter("hello\n-# Argon 60% | GPT 90% | Opus 100%", LINE, P), `hello\n${LINE}`, "an older footer is replaced");
  assert.equal(applyFooter(`hello\n${LINE}\n${LINE}\n`, LINE, P), `hello\n${LINE}`, "stacked footers collapse");
  assert.equal(applyFooter("hello\n-# 注: 進捗 50%", LINE, P), `hello\n-# 注: 進捗 50%\n${LINE}`, "the model's own -# line stays");
  assert.equal(applyFooter(`${LINE}\nhello`, LINE, P), `${LINE}\nhello\n${LINE}`, "only a trailing footer counts");
});

test("applyFooter: messages that get no footer", () => {
  for (const c of [undefined, null, "", "  \n ", "NO_REPLY", " NO_REPLY\n", "HEARTBEAT_OK"]) {
    assert.equal(applyFooter(c, LINE, P), undefined, JSON.stringify(c));
  }
  assert.equal(applyFooter("> 🧠 thinking\n> more", LINE, P), undefined, "reasoning quote");
  assert.equal(applyFooter(LINE, LINE, P), undefined, "only a footer");
  assert.equal(applyFooter("```\nunclosed", LINE, P), undefined, "the line would land inside a code block");
  assert.equal(applyFooter("hello", "", P), undefined, "no line");
  assert.equal(applyFooter("NO_REPLY is a token", LINE, P), `NO_REPLY is a token\n${LINE}`, "only an exact token is silent");
});

test("footerHook: Discord only, from the cached rows, no fetch per message", async () => {
  const { running, fetches } = await service();
  const before = fetches.n;
  const r = footerHook(running, {}, { to: "channel:1", content: "hello", metadata: { mediaUrls: [] } }, discord);
  assert.deepEqual(r, { content: `hello\n${LINE}` });
  for (let i = 0; i < 20; i++) footerHook(running, {}, { content: `m${i}` }, discord);
  assert.equal(fetches.n, before, "sending never fetches");
  assert.equal(footerHook(running, {}, { content: "hello" }, { channelId: "line" }), undefined);
  assert.equal(footerHook(running, {}, { content: r.content }, discord), undefined, "a resend of the same text");
  assert.deepEqual(
    footerHook(running, {}, { content: "see attached", metadata: { mediaUrls: ["/tmp/a.png"] } }, discord),
    { content: `see attached\n${LINE}` },
    "text with an attachment: the line goes under the text",
  );
  assert.equal(footerHook(running, {}, { content: "", metadata: { mediaUrls: ["/tmp/a.png"] } }, discord), undefined, "attachment only");
  assert.deepEqual(footerHook(running, { channels: [] }, { content: "hi" }, { channelId: "line" }), { content: `hi\n${LINE}` }, "channels: [] = every channel");
  assert.deepEqual(
    footerHook(running, { template: "-# 残り {items}" }, { content: "hi\n-# 残り Argon 1% | GPT 2%" }, discord),
    { content: `hi\n-# 残り Argon 55% | GPT 84% | Opus 88%` },
    "a custom template is recognised too",
  );
});

test("footerHook: a long reply gets one line at the end (the channel splits after the hook)", async () => {
  const { running } = await service();
  const long = "x".repeat(1990) + "\n" + "y".repeat(500);
  const r = footerHook(running, {}, { content: long }, discord);
  assert.equal(r.content.split(LINE).length - 1, 1);
  assert.ok(r.content.endsWith(`\n${LINE}`));
});

test("footerHook: nothing before the first fetch, or when every source is stale", async () => {
  const config = resolvePluginConfig({ items: EXAMPLE_ITEMS }, { stateDir: "/s" });
  const fresh = createQuotaPresence({ config, sources: [], log: {} });
  assert.equal(footerHook(fresh, {}, { content: "hello" }, discord), undefined, "not '-# Argon ? | GPT ? | Opus ?'");
  assert.equal(footerHook(null, {}, { content: "hello" }, discord), undefined, "service not running (between reload stop/start)");
  const { running } = await service([...EXAMPLE_ITEMS, { label: "Nope", source: "usage:none" }]);
  assert.deepEqual(footerHook(running, {}, { content: "hi" }, discord), { content: `hi\n${LINE} | Nope ?` }, "some data: missing items show as ?");
});
