import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsageSummary, parseAgyUsage, slug, usageSummaryErrors, windowOf } from "../src/quota.js";
import { AGY_TSV, USAGE_SUMMARY } from "./fixtures.js";

test("agy /usage TSV → one row per limit", () => {
  const rows = parseAgyUsage(AGY_TSV);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[4], {
    group: "agy:gemini-4-argon",
    groupLabel: "Gemini 4 Argon",
    window: "week",
    windowLabel: "Gemini 4 Argon Weekly Limit",
    remaining: 55,
    resetAt: Date.parse("2026-10-28T07:04:55Z"),
  });
  assert.deepEqual(
    rows.map((r) => [r.group, r.window, r.remaining]),
    [
      ["agy:gemini-models", "week", 100],
      ["agy:gemini-models", "5h", 100],
      ["agy:claude-and-gpt-models", "week", 100],
      ["agy:claude-and-gpt-models", "5h", 90],
      ["agy:gemini-4-argon", "week", 55],
    ],
  );
});

test("agy output that is not a usage table yields nothing", () => {
  assert.deepEqual(parseAgyUsage("Error: not logged in\n"), []);
  assert.deepEqual(parseAgyUsage(""), []);
  assert.deepEqual(parseAgyUsage("a\tb\tnot-a-percent\tx"), []);
  assert.deepEqual(parseAgyUsage("a\tb\t150%")[0].remaining, 100);
  assert.equal(parseAgyUsage("a\tb\t12%\tgarbage")[0].resetAt, undefined);
});

test("OpenClaw usage summary → remaining % per window; error-only providers drop out", () => {
  const rows = normalizeUsageSummary(USAGE_SUMMARY);
  assert.deepEqual(
    rows.map((r) => [r.group, r.groupLabel, r.window, r.remaining]),
    [
      ["usage:openai", "OpenAI", "5h", 91],
      ["usage:openai", "OpenAI", "week", 84],
      ["usage:anthropic", "Claude", "5h", 92],
      ["usage:anthropic", "Claude", "week", 70],
      ["usage:anthropic", "Claude", "opus", 88],
    ],
  );
  assert.equal(rows[0].resetAt, 1792596190000);
  assert.deepEqual(usageSummaryErrors(USAGE_SUMMARY), ["zai: Timeout"]);
  assert.deepEqual(normalizeUsageSummary(undefined), []);
});

test("window and group ids", () => {
  assert.equal(windowOf("Five Hour Limit Remaining"), "5h");
  assert.equal(windowOf("5h"), "5h");
  assert.equal(windowOf("3h"), "3h");
  assert.equal(windowOf("Week"), "week");
  assert.equal(windowOf("Weekly Limit Remaining"), "week");
  assert.equal(windowOf("Day"), "day");
  assert.equal(windowOf("Extra usage"), "extra-usage");
  assert.equal(slug("Claude and GPT models"), "claude-and-gpt-models");
});
