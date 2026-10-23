import test from "node:test";
import assert from "node:assert/strict";
import { resolvePluginConfig } from "../openclaw/config.js";
import { CLAUDE_GROUP, CLAUDE_USAGE_URL, createClaudeFetcher, defaultCredentialsFile, parseClaudeUsage, readClaudeToken } from "../src/claude.js";
import { renderStatus } from "../src/format.js";
import { footerPattern } from "../src/footer.js";
import { createQuotaPresence } from "../src/service.js";
import { CLAUDE_USAGE, CLAUDE_USAGE_AT } from "./fixtures.js";

const TOKEN = "sk-ant-oat01-test-token-not-real";
const HOUR = 60 * 60_000;
const quiet = { info() {}, warn() {}, debug() {} };

function credentials({ token = TOKEN, expiresAt = CLAUDE_USAGE_AT + 6 * HOUR } = {}) {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r-not-real", expiresAt, scopes: ["user:profile"] } });
}

/** A fetch that answers like the usage endpoint and records what it was asked. */
function fakeFetch(answer = () => ({ status: 200, body: CLAUDE_USAGE })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = await answer(calls.length);
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("not JSON");
        return a.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

function fetcher({ file = credentials(), fetch = fakeFetch(), now = () => CLAUDE_USAGE_AT } = {}) {
  const reads = [];
  const readFile = (p) => {
    reads.push(p);
    if (file instanceof Error) throw file;
    return file;
  };
  return { fetch: createClaudeFetcher({ credentialsFile: "/home/u/.claude/.credentials.json", fetch, now, readFile }), reads, http: fetch };
}

test("parseClaudeUsage: 5h, week and model-scoped weeks with the resets the API gave", () => {
  const rows = parseClaudeUsage(CLAUDE_USAGE);
  assert.deepEqual(
    rows.map((r) => [r.group, r.window, r.remaining, new Date(r.resetAt).toISOString(), r.scope]),
    [
      [CLAUDE_GROUP, "5h", 65, "2026-10-23T16:40:00.000Z", undefined],
      [CLAUDE_GROUP, "week", 92, "2026-10-30T08:00:00.000Z", undefined],
      [CLAUDE_GROUP, "fable", 100, "2026-10-30T08:00:00.000Z", "model"],
    ],
  );
  assert.ok(!rows.some((r) => r.window === "opus"), "no Opus window when the plan has no Opus limit");
});

test("parseClaudeUsage: no reset time is made up; null and missing windows are left out", () => {
  const rows = parseClaudeUsage({ five_hour: { utilization: 50, resets_at: null }, seven_day: null, seven_day_opus: { utilization: 20 } });
  assert.deepEqual(rows.map((r) => [r.window, r.remaining, "resetAt" in r]), [["5h", 50, false], ["opus", 80, false]]);
  assert.deepEqual(parseClaudeUsage({ five_hour: { utilization: null } }), []);
  assert.deepEqual(parseClaudeUsage(null), []);
  // a reset a hair before the full minute shows as that minute
  assert.equal(new Date(parseClaudeUsage({ five_hour: { utilization: 1, resets_at: "2026-10-23T16:39:59.516+00:00" } })[0].resetAt).toISOString(), "2026-10-23T16:40:00.000Z");
  // utilization above 100 (over the limit) is 0% left, not negative
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 104 } })[0].remaining, 0);
});

test("readClaudeToken: missing file, no OAuth login, expired login are auth errors that clear the group", () => {
  const read = (content) => () => {
    if (content instanceof Error) throw content;
    return content;
  };
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  for (const [content, re] of [
    [enoent, /not logged in/],
    ["{", /not JSON/],
    [JSON.stringify({}), /no OAuth token/],
    [credentials({ expiresAt: CLAUDE_USAGE_AT - 1 }), /expired at/],
    [credentials({ expiresAt: CLAUDE_USAGE_AT + 30_000 }), /expired at/],
  ]) {
    assert.throws(
      () => readClaudeToken("/c.json", { now: CLAUDE_USAGE_AT, readFile: read(content) }),
      (e) => e.name === "ClaudeAuthError" && re.test(e.message) && e.clear?.includes(CLAUDE_GROUP) && !e.message.includes(TOKEN),
    );
  }
  assert.equal(readClaudeToken("/c.json", { now: CLAUDE_USAGE_AT, readFile: read(credentials()) }).token, TOKEN);
});

test("defaultCredentialsFile: $CLAUDE_CONFIG_DIR, else ~/.claude", () => {
  assert.equal(defaultCredentialsFile({}, "/home/u"), "/home/u/.claude/.credentials.json");
  assert.equal(defaultCredentialsFile({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), "/cfg/.credentials.json");
});

test("fetcher: one GET to the usage endpoint with the login's token; no model call, no body", async () => {
  const { fetch, http } = fetcher();
  const rows = await fetch();
  assert.equal(rows.length, 3);
  assert.equal(http.calls.length, 1);
  const { url, init } = http.calls[0];
  assert.equal(url, CLAUDE_USAGE_URL);
  assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(init.method, undefined, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, "error", "the token never follows a redirect");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(init.signal instanceof AbortSignal, "has a timeout");
});

test("fetcher: concurrent calls share one request", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { fetch, http } = fetcher({ fetch: fakeFetch(async () => (await gate, { status: 200, body: CLAUDE_USAGE })) });
  const a = fetch();
  const b = fetch();
  release();
  assert.equal(await a, await b);
  assert.equal(http.calls.length, 1);
  await fetch();
  assert.equal(http.calls.length, 2, "a later call asks again");
});

test("fetcher: expired or missing login fails before any request", async () => {
  for (const file of [credentials({ expiresAt: CLAUDE_USAGE_AT - HOUR }), Object.assign(new Error("x"), { code: "ENOENT" })]) {
    const { fetch, http } = fetcher({ file });
    await assert.rejects(fetch(), (e) => e.name === "ClaudeAuthError" && e.clear.includes(CLAUDE_GROUP));
    assert.equal(http.calls.length, 0);
  }
});

test("fetcher: 401/403 clear the group; 429, 5xx, timeouts and junk keep it (transient)", async () => {
  for (const status of [401, 403]) {
    const { fetch } = fetcher({ fetch: fakeFetch(() => ({ status, body: { error: { message: "OAuth token has expired" } } })) });
    await assert.rejects(fetch(), (e) => e.clear?.includes(CLAUDE_GROUP) && e.message.includes(`HTTP ${status}`) && !e.message.includes(TOKEN));
  }
  const transient = [
    fakeFetch(() => ({ status: 429, body: { error: { message: "rate limited" } } })),
    fakeFetch(() => ({ status: 503 })),
    fakeFetch(() => ({ status: 200 })), // not JSON
    fakeFetch(() => ({ status: 200, body: { five_hour: null } })), // no windows
    fakeFetch(() => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }),
  ];
  for (const http of transient) {
    const { fetch } = fetcher({ fetch: http });
    await assert.rejects(fetch(), (e) => !e.clear && !e.message.includes(TOKEN));
  }
});

// The service with the claude-code source and a hand-driven clock.
function service({ answers, file = () => credentials(), configOverrides = {} }) {
  let t = CLAUDE_USAGE_AT;
  const http = fakeFetch((n) => answers[Math.min(n, answers.length) - 1]);
  const readFile = () => {
    const f = file(t);
    if (f instanceof Error) throw f;
    return f;
  };
  const config = resolvePluginConfig(
    {
      items: [{ label: "Claude", source: "claude-code", windows: ["5h", "week"] }],
      itemTemplate: "{label} {windows}",
      windowTemplate: "{window} {remaining}%{stale} ↻{resetAt}",
      windowLabels: { week: "1w" },
      resetAtTodayFormat: "HH:mm",
      ...configOverrides,
    },
    { stateDir: "/s" },
  );
  const published = [];
  const warns = [];
  const svc = createQuotaPresence({
    config,
    sources: [{ id: "claude-code", fetch: createClaudeFetcher({ credentialsFile: "/c.json", fetch: http, now: () => t, readFile }) }],
    publish: (s) => published.push(s),
    log: { ...quiet, warn: (m) => warns.push(m) },
    now: () => t,
  });
  return { svc, http, published, warns, config, at: () => t, advance: (ms) => (t += ms) };
}

const later = {
  ...CLAUDE_USAGE,
  five_hour: { utilization: 41, resets_at: "2026-10-23T16:40:00Z" },
  seven_day: { utilization: 9, resets_at: "2026-10-30T08:00:00Z" },
};

test("service: 5h/week with their resets, updated on the next refresh", async () => {
  const { svc, published } = service({ answers: [{ status: 200, body: CLAUDE_USAGE }, { status: 200, body: later }] });
  assert.equal((await svc.refresh()).text, "Claude 5h 65% ↻10/24 01:40・1w 92% ↻10/30 17:00");
  const item = published[0].items[0];
  assert.deepEqual([item.source, item.window, item.remaining, item.resetAt], ["claude-code", "5h", 65, "2026-10-23T16:40:00.000Z"]);
  assert.equal(item.fetchedAt, new Date(CLAUDE_USAGE_AT).toISOString());
  assert.equal((await svc.refresh()).text, "Claude 5h 59% ↻10/24 01:40・1w 91% ↻10/30 17:00");
});

test("service: min is the shared limit, not a model-scoped one", async () => {
  const exhaustedFable = { ...CLAUDE_USAGE, limits: CLAUDE_USAGE.limits.map((l) => (l.scope ? { ...l, percent: 100 } : l)) };
  const { svc } = service({ answers: [{ status: 200, body: exhaustedFable }], configOverrides: { items: [{ label: "Claude", source: "claude-code" }], itemTemplate: "{label} {remaining}% {window}" } });
  assert.equal((await svc.refresh()).text, "Claude 65% 5h");
  assert.equal(svc.renderWith({ items: [{ label: "Fable", source: "claude-code", window: "fable" }] }), "Fable 0% fable");
});

test("service: a transient failure keeps the last numbers, marked old after markStaleAfterMs", async () => {
  const { svc, advance, warns, config } = service({ answers: [{ status: 200, body: CLAUDE_USAGE }, { status: 503 }] });
  assert.equal(config.markStaleAfterMs, 35 * 60_000);
  await svc.refresh();
  advance(15 * 60_000);
  assert.equal((await svc.refresh()).text, "Claude 5h 65% ↻10/24 01:40・1w 92% ↻10/30 17:00", "one miss: not marked yet");
  advance(25 * 60_000);
  assert.equal((await svc.refresh()).text, "Claude 5h 65%* ↻10/24 01:40・1w 92%* ↻10/30 17:00");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /claude-code: usage request: HTTP 503/);
});

test("service: an old number is dropped once its window resets; no reset time is invented", async () => {
  const { svc, advance } = service({ answers: [{ status: 200, body: CLAUDE_USAGE }, { status: 503 }] });
  await svc.refresh();
  advance(2 * HOUR + 40 * 60_000); // past 16:40Z, the 5h reset
  assert.equal((await svc.refresh()).text, "Claude 1w 92%* ↻10/30 17:00");
});

test("service: an expired login or a 401 makes the item unknown at once, without a request", async () => {
  const expiresAt = CLAUDE_USAGE_AT + 20 * 60_000;
  const { svc, advance, http } = service({ answers: [{ status: 200, body: CLAUDE_USAGE }], file: () => credentials({ expiresAt }) });
  await svc.refresh();
  advance(30 * 60_000);
  assert.equal((await svc.refresh()).text, "Claude ?");
  assert.equal(http.calls.length, 1, "no request with an expired token");

  const revoked = service({ answers: [{ status: 200, body: CLAUDE_USAGE }, { status: 401, body: { error: { message: "invalid token" } } }] });
  await revoked.svc.refresh();
  assert.equal((await revoked.svc.refresh()).text, "Claude ?");
  assert.equal(revoked.published.at(-1).items[0].remaining, null);
});

test("service: recovers when the login is back", async () => {
  let loggedIn = false;
  const enoent = Object.assign(new Error("x"), { code: "ENOENT" });
  const { svc } = service({ answers: [{ status: 200, body: CLAUDE_USAGE }], file: () => (loggedIn ? credentials() : enoent) });
  assert.equal((await svc.refresh()).text, "Claude ?");
  loggedIn = true;
  assert.equal((await svc.refresh()).text, "Claude 5h 65% ↻10/24 01:40・1w 92% ↻10/30 17:00");
});

test("{stale} in the footer pattern: a marked footer is still recognised and replaced", () => {
  const opts = {
    template: "-# {items}",
    items: [{ label: "Claude", source: "claude-code", windows: ["5h", "week"] }],
    itemTemplate: "{label} {windows}",
    windowTemplate: "{window} {remaining}%{stale} ↻{resetAt}",
    windowLabels: { week: "1w" },
    resetAtTodayFormat: "HH:mm",
  };
  const re = footerPattern(opts);
  assert.ok(re.test("-# Claude 5h 65%* ↻10/24 01:40・1w 92%* ↻10/30 17:00"));
  assert.ok(re.test("-# Claude 5h 65% ↻10/24 01:40・1w 92% ↻10/30 17:00"));
  assert.ok(re.test("-# Claude ?"));
  const rows = parseClaudeUsage(CLAUDE_USAGE).map((r) => ({ ...r, fetchedAt: CLAUDE_USAGE_AT }));
  assert.ok(re.test(renderStatus(rows, { ...opts, markStaleAfterMs: 1 }, CLAUDE_USAGE_AT + 2)));
});
