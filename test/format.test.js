import test from "node:test";
import assert from "node:assert/strict";
import { fill, renderStatus, truncate, untilText } from "../src/format.js";
import { normalizeUsageSummary, parseAgyUsage } from "../src/quota.js";
import { AGY_TSV, EXAMPLE_ITEMS, USAGE_SUMMARY } from "./fixtures.js";

const rows = [...parseAgyUsage(AGY_TSV), ...normalizeUsageSummary(USAGE_SUMMARY)];
const NOW = Date.parse("2026-10-21T15:00:00Z");

test("configured items: the tightest window by default, or the one named", () => {
  assert.equal(renderStatus(rows, { items: EXAMPLE_ITEMS }, NOW), "Argon 55% | GPT 84% | Opus 88%");
  assert.equal(
    renderStatus(rows, { items: [{ label: "GPT 5h", source: "usage:openai", window: "5h" }] }, NOW),
    "GPT 5h 91%",
  );
});

test("auto lists every group in source order, tightest window each", () => {
  assert.equal(
    renderStatus(rows, { items: "auto" }, NOW),
    "Gemini Models 100% | Claude and GPT models 90% | Gemini 4 Argon 55% | OpenAI 84% | Claude 70%",
  );
  assert.equal(renderStatus([], {}, NOW), "");
});

test("an item without data shows the missing template, or is hidden", () => {
  const items = [...EXAMPLE_ITEMS, { label: "Grok", source: "usage:xai" }];
  assert.equal(renderStatus(rows, { items }, NOW), "Argon 55% | GPT 84% | Opus 88% | Grok ?");
  assert.equal(renderStatus(rows, { items, missingTemplate: false }, NOW), "Argon 55% | GPT 84% | Opus 88%");
  assert.equal(renderStatus([], { items: [{ label: "Grok", source: "usage:xai" }], missingTemplate: false }, NOW), "");
});

test("templates: item placeholders, {items}, {time}, unknown names left alone", () => {
  const text = renderStatus(
    rows,
    {
      items: [{ label: "Argon", source: "agy:gemini-4-argon" }],
      itemTemplate: "{label} {remaining}% (used {used}%, {window}, resets in {reset})",
      template: "🔋 {items} @{time} {nope}",
      timeZone: "Asia/Tokyo",
    },
    NOW,
  );
  assert.equal(text, "🔋 Argon 55% (used 45%, week, resets in 7d) @00:00 {nope}");
  assert.equal(fill("{a}-{b}", { a: 1 }), "1-{b}");
});

test("never longer than Discord's 128 characters, cut on code points", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `Provider${i}`, source: "agy:gemini-4-argon" }));
  const text = renderStatus(rows, { items: many }, NOW);
  assert.equal(Array.from(text).length, 128);
  assert.ok(text.endsWith("…"));
  assert.equal(truncate("🔋".repeat(200), 10), "🔋".repeat(4) + "…", "10 code units: 4 pairs + …, the 5th pair is not split");
  assert.equal(truncate("a" + "🔋".repeat(200), 10), "a" + "🔋".repeat(4) + "…");
  assert.equal(truncate("x".repeat(300)).length, 128);
  assert.equal(truncate("short", 128), "short");
});

test("time until reset", () => {
  assert.equal(untilText(-5), "0m");
  assert.equal(untilText(30 * 60_000), "30m");
  assert.equal(untilText(3 * 3600_000), "3h");
  assert.equal(untilText(5 * 86400_000), "5d");
});
