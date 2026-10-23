import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FOOTER_DISPLAY_KEYS, footerHook } from "../openclaw/index.js";
import { resolvePluginConfig } from "../openclaw/config.js";
import { describeItems, renderStatus, resetAtText, untilText } from "../src/format.js";
import { applyFooter, footerPattern } from "../src/footer.js";
import { createQuotaPresence } from "../src/service.js";
import { normalizeUsageSummary, parseAgyUsage } from "../src/quota.js";
import { AGY_TSV, EXAMPLE_ITEMS, USAGE_SUMMARY } from "./fixtures.js";

const rows = [...parseAgyUsage(AGY_TSV), ...normalizeUsageSummary(USAGE_SUMMARY)];
const NOW = Date.parse("2026-10-21T15:00:00Z"); // 2026-10-22 00:00 in Tokyo
const discord = { channelId: "discord" };

// usage:openai — 5h: 91% left, resets 2026-10-21T15:23:10Z (10/22 00:23 in Tokyo, 24 min after NOW);
// week: 84% left, resets 2026-10-27T06:48:08Z (10/27 15:48 in Tokyo).
const GPT_BOTH = { label: "GPT", source: "usage:openai", windows: ["5h", "week"] };

test("windows: several windows of one item through {windows}", () => {
  const items = [GPT_BOTH];
  assert.equal(renderStatus(rows, { items, itemTemplate: "{label} {windows}" }, NOW), "GPT 5h 91%・week 84%");
  assert.equal(
    renderStatus(rows, { items, itemTemplate: "{label} {windows}", windowTemplate: "{window}:{remaining}", windowSeparator: "/" }, NOW),
    "GPT 5h:91/week:84",
  );
  assert.equal(renderStatus(rows, { items }, NOW), "GPT 84%", "{remaining} is the tightest of the windows");
  assert.equal(
    renderStatus(rows, { items: [{ ...GPT_BOTH, windows: ["5h", "day", "week"] }], itemTemplate: "{label} {windows}" }, NOW),
    "GPT 5h 91%・week 84%",
    "a window the source does not have is left out",
  );
  assert.equal(
    renderStatus(rows, { items: [{ label: "GPT", source: "usage:openai", windows: ["day"] }], itemTemplate: "{label} {windows}" }, NOW),
    "GPT ?",
    "none of them: the missing template",
  );
  assert.equal(
    renderStatus(rows, { items: [{ label: "GPT", source: "usage:openai", window: "5h" }], itemTemplate: "{label} {windows}" }, NOW),
    "GPT 5h 91%",
    "{windows} of a one-window item",
  );
  const [d] = describeItems(items, rows);
  assert.deepEqual(
    d.windows.map((w) => [w.window, w.remaining]),
    [
      ["5h", 91],
      ["week", 84],
    ],
  );
  assert.equal(d.remaining, 84);
});

test("window and the old window/min selection keep working", () => {
  assert.equal(renderStatus(rows, { items: EXAMPLE_ITEMS }, NOW), "Argon 55% | GPT 84% | Opus 88%");
  assert.equal(renderStatus(rows, { items: [{ label: "G", source: "usage:openai", window: "5h" }], itemTemplate: "{label} {window} {remaining}%" }, NOW), "G 5h 91%");
});

test("windowLabels rename {window}; unlisted windows keep their id", () => {
  const windowLabels = { week: "1w" };
  assert.equal(renderStatus(rows, { items: [GPT_BOTH], itemTemplate: "{label} {windows}", windowLabels }, NOW), "GPT 5h 91%・1w 84%");
  assert.equal(
    renderStatus(rows, { items: [{ label: "Argon", source: "agy:gemini-4-argon" }], itemTemplate: "{label} {window} {remaining}%", windowLabels: { week: "週" } }, NOW),
    "Argon 週 55%",
  );
});

test("{resetAt}: format, time zone, today without the date", () => {
  const item = [{ label: "GPT", source: "usage:openai", window: "week" }];
  const t = (o) => renderStatus(rows, { items: item, itemTemplate: "{resetAt}", ...o }, NOW);
  assert.equal(t({}), "10/27 15:48", "default M/D HH:mm in Asia/Tokyo");
  assert.equal(t({ timeZone: "UTC" }), "10/27 06:48");
  assert.equal(t({ resetAtFormat: "YYYY-MM-DD H:mm" }), "2026-10-27 15:48");
  assert.equal(t({ resetAtFormat: "MM/DD(HH時)" }), "10/27(15時)", "the rest is literal");
  const five = [{ label: "GPT", source: "usage:openai", window: "5h" }];
  assert.equal(renderStatus(rows, { items: five, itemTemplate: "{resetAt}" }, NOW), "10/22 00:23", "today, no today format");
  assert.equal(renderStatus(rows, { items: five, itemTemplate: "{resetAt}", resetAtTodayFormat: "HH:mm" }, NOW), "00:23", "today: the date is left out");
  assert.equal(t({ resetAtTodayFormat: "HH:mm" }), "10/27 15:48", "another day keeps the date");
  // "today" is the time zone's day: NOW is the 22nd in Tokyo but still the 21st in UTC.
  const lastNight = Date.parse("2026-10-21T14:30:00Z");
  assert.equal(resetAtText(lastNight, NOW, { resetAtTodayFormat: "HH:mm" }), "10/21 23:30");
  assert.equal(resetAtText(lastNight, NOW, { resetAtTodayFormat: "HH:mm", timeZone: "UTC" }), "14:30");
  assert.equal(resetAtText(Date.parse("2026-01-02T03:04:00Z"), NOW, { timeZone: "UTC", resetAtFormat: "M/D H:mm|MM/DD HH:mm" }), "1/2 3:04|01/02 03:04");
  assert.equal(resetAtText(NOW, NOW, { timeZone: "No/Such_Zone" }), "", "a bad time zone gives nothing, not an exception");
  const opus = [{ label: "Opus", source: "usage:anthropic", window: "opus" }];
  assert.equal(renderStatus(rows, { items: opus, itemTemplate: "{label} {resetAt}|{reset}" }, NOW), "Opus |", "no reset time: empty");
});

test("{reset} with resetPrecision 2", () => {
  const h = 3600_000;
  assert.equal(untilText(30 * h, 2), "1d6h");
  assert.equal(untilText(30 * h + 20 * 60_000, 2), "1d6h", "the last unit is rounded");
  assert.equal(untilText(3 * h + 20 * 60_000, 2), "3h20m");
  assert.equal(untilText(3 * h, 2), "3h", "zero units are left out");
  assert.equal(untilText(48 * h, 2), "2d");
  assert.equal(untilText(45 * 60_000, 2), "45m");
  assert.equal(untilText(23 * h + 59.5 * 60_000, 2), "1d", "rounding carries");
  assert.equal(untilText(-1, 2), "0m");
  assert.equal(untilText(30 * h), "30h", "precision 1 is unchanged");
  assert.equal(untilText(30 * h, 3), "1d6h");
  assert.equal(
    renderStatus(rows, { items: [GPT_BOTH], itemTemplate: "{label} {windows}", windowTemplate: "{window} {remaining}% {reset}", resetPrecision: 2 }, NOW),
    "GPT 5h 91% 24m・week 84% 5d16h",
  );
});

/** A real service with fetched rows. */
async function service(config) {
  const running = createQuotaPresence({
    config: { ...resolvePluginConfig(config, { stateDir: "/s" }), staleAfterMs: 0 },
    sources: [
      { id: "agy", fetch: async () => parseAgyUsage(AGY_TSV) },
      { id: "usage", fetch: async () => normalizeUsageSummary(USAGE_SUMMARY) },
    ],
    log: { info() {}, warn() {}, debug() {} },
  });
  await running.refresh("test");
  return running;
}

test("footer: its own items/itemTemplate/separator/missingTemplate; the status keeps the main ones", async () => {
  const footer = {
    items: [{ label: "Argon", source: "agy:gemini-4-argon" }, GPT_BOTH, { label: "Grok", source: "usage:xai" }],
    itemTemplate: "{label} {windows}",
    separator: " / ",
    missingTemplate: "{label} -",
    windowLabels: { week: "1w" },
  };
  const running = await service({ items: EXAMPLE_ITEMS, footer });
  assert.equal(running.text, "Argon 55% | GPT 84% | Opus 88%", "status.json is unchanged");
  const r = footerHook(running, footer, { content: "hi" }, discord);
  const line = "-# Argon 1w 55% / GPT 5h 91%・1w 84% / Grok -";
  assert.deepEqual(r, { content: `hi\n${line}` });
  assert.equal(footerHook(running, footer, { content: r.content }, discord), undefined, "its own line is recognised: no second one");
  assert.deepEqual(
    footerHook(running, footer, { content: "hi\n-# Argon 1w 0% / GPT 5h 100%・1w 99% / Grok -" }, discord),
    { content: `hi\n${line}` },
    "an older footer with other numbers is replaced",
  );
});

test("footer: keys it leaves out come from the main config (as in 0.3.0)", async () => {
  const running = await service({ items: EXAMPLE_ITEMS, itemTemplate: "{label}={remaining}", separator: ", " });
  assert.deepEqual(footerHook(running, {}, { content: "hi" }, discord), { content: "hi\n-# Argon=55, GPT=84, Opus=88" });
  assert.deepEqual(
    footerHook(running, { separator: " · " }, { content: "hi" }, discord),
    { content: "hi\n-# Argon=55 · GPT=84 · Opus=88" },
    "only the separator overridden",
  );
});

test("footer pattern: {windows}, window names and {resetAt}", () => {
  const opts = {
    template: "-# {items}",
    items: [GPT_BOTH],
    itemTemplate: "{label} {windows}",
    windowTemplate: "{window} {remaining}% ↻{resetAt}",
    windowLabels: { week: "1 week" },
    resetAtTodayFormat: "HH:mm",
  };
  const line = renderStatus(rows, opts, NOW);
  assert.equal(line, "-# GPT 5h 91% ↻00:23・1 week 84% ↻10/27 15:48");
  const P = footerPattern(opts);
  assert.ok(P.test(line));
  assert.ok(P.test("-# GPT 5h 0% ↻12/31 23:59・1 week 7% ↻"), "other dates; no reset time");
  assert.ok(!P.test("-# GPT 5h 0% ↻soon"));
  assert.equal(applyFooter(`hi\n${line}`, line, P), undefined);
});

test("truncation: status 128, footer 300 (or footer.maxLength), with the new placeholders", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `P${i}`, source: "usage:openai", windows: ["5h", "week"] }));
  const opts = { items: many, itemTemplate: "{label} {windows}", windowTemplate: "{window} {remaining}% ↻{resetAt}" };
  const status = renderStatus(rows, opts, NOW);
  assert.equal(status.length, 128);
  assert.ok(status.endsWith("…"));
  const running = await service({ items: EXAMPLE_ITEMS, footer: opts });
  const line = footerHook(running, opts, { content: "hi" }, discord).content.split("\n").at(-1);
  assert.equal(line.length, 300);
  assert.ok(line.endsWith("…"));
  const short = footerHook(running, { ...opts, maxLength: 60 }, { content: "hi" }, discord).content.split("\n").at(-1);
  assert.equal(short.length, 60);
});

test("defaults still fit Discord's custom status", () => {
  const c = resolvePluginConfig({ items: EXAMPLE_ITEMS }, { stateDir: "/s" });
  assert.equal(c.windowTemplate, "{window} {remaining}%");
  assert.equal(c.windowSeparator, "・");
  assert.equal(c.resetAtFormat, "M/D HH:mm");
  assert.ok(renderStatus(rows, c, NOW).length <= 128);
});

test("the manifest's configSchema has every footer display key and items[].windows", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  const props = manifest.configSchema.properties;
  for (const k of FOOTER_DISPLAY_KEYS) {
    assert.ok(k in props, `configSchema lacks ${k}`);
    assert.ok(k in props.footer.properties, `configSchema lacks footer.${k}`);
  }
  assert.ok("windows" in props.items.anyOf[1].items.properties);
  assert.ok("windows" in props.footer.properties.items.anyOf[1].items.properties);
});
