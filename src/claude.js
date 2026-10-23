// Claude Code's own plan usage: the numbers `/usage` shows for the account
// Claude Code is logged in with (and so for an agent on the claude-cli runtime).
//
// Claude Code 2.1 reads them from GET https://api.anthropic.com/api/oauth/usage
// with the login's OAuth access token. We do the same, read-only: the token is
// read from Claude Code's credentials file, never refreshed (refreshing rotates
// the refresh token Claude Code holds), never logged, and only ever sent to
// that one URL. No model call, nothing from any conversation.
//
// `claude -p /usage` gives the same numbers without a model call, but takes
// about 90 s of CPU (it also analyses local transcripts) and prints prose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampPercent, slug } from "./quota.js";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_GROUP = "claude-code";
const GROUP_LABEL = "Claude (Claude Code login)";
// A token this close to its expiry is treated as expired: Claude Code refreshes
// it on its next run, we never do.
const EXPIRY_MARGIN_MS = 60_000;

/** An error that means "no usable login": the group should go unknown, not keep old numbers. */
export class ClaudeAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeAuthError";
    this.clear = [CLAUDE_GROUP];
  }
}

/** Where Claude Code keeps its login on Linux/WSL ($CLAUDE_CONFIG_DIR, else ~/.claude). */
export function defaultCredentialsFile(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), ".credentials.json");
}

/**
 * The access token from Claude Code's credentials file, or a ClaudeAuthError.
 * @returns {{token: string, expiresAt?: number}}
 */
export function readClaudeToken(file, { now = Date.now(), readFile = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch (e) {
    throw new ClaudeAuthError(e?.code === "ENOENT" ? `not logged in (no ${file})` : `cannot read ${file}: ${e?.code ?? "error"}`);
  }
  let oauth;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    throw new ClaudeAuthError(`${file} is not JSON`);
  }
  const token = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!token) throw new ClaudeAuthError(`not logged in with a Claude subscription (no OAuth token in ${file})`);
  const expiresAt = Number(oauth.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_MARGIN_MS <= now) {
    throw new ClaudeAuthError(`login expired at ${new Date(expiresAt).toISOString()} (Claude Code refreshes it on its next run)`);
  }
  return { token, ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) };
}

/**
 * The /api/oauth/usage answer → quota rows of group "claude-code":
 *   5h    five_hour  (the shared session limit)
 *   week  seven_day  (all models)
 *   <model slug>     model-scoped weekly limits (limits[].scope.model, seven_day_opus/sonnet), scope "model"
 * A window without a usable resets_at has no resetAt.
 */
export function parseClaudeUsage(data) {
  const rows = [];
  const seen = new Set();
  const add = (window, windowLabel, utilization, resetsAt, extra = {}) => {
    const remaining = clampPercent(100 - Number(utilization));
    if (utilization === null || utilization === undefined || remaining === undefined || seen.has(window)) return;
    seen.add(window);
    // The API answers e.g. 16:39:59.516 for a 16:40 reset; to the second, as Claude Code shows it.
    const resetAt = typeof resetsAt === "string" ? Math.round(Date.parse(resetsAt) / 1000) * 1000 : NaN;
    rows.push({
      group: CLAUDE_GROUP,
      groupLabel: GROUP_LABEL,
      window,
      windowLabel,
      remaining,
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      ...extra,
    });
  };
  const usage = data && typeof data === "object" ? data : {};
  add("5h", "Current session", usage.five_hour?.utilization, usage.five_hour?.resets_at);
  add("week", "Current week (all models)", usage.seven_day?.utilization, usage.seven_day?.resets_at);
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    const model = limit?.scope?.model;
    const name = model?.display_name || model?.id;
    if (!name) continue;
    add(slug(name), `Current week (${name})`, limit.percent, limit.resets_at, { scope: "model" });
  }
  for (const [key, name] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ]) {
    add(slug(name), `Current week (${name})`, usage[key]?.utilization, usage[key]?.resets_at, { scope: "model" });
  }
  return rows;
}

/**
 * @param {{credentialsFile?: string, timeoutMs?: number, fetch?: Function, now?: () => number,
 *          readFile?: Function, userAgent?: string}} opts
 * @returns {() => Promise<object[]>} quota rows; concurrent calls share the request in flight
 */
export function createClaudeFetcher(opts = {}) {
  const {
    credentialsFile = defaultCredentialsFile(),
    timeoutMs = 10_000,
    fetch: fetchFn = globalThis.fetch,
    now = Date.now,
    readFile,
    userAgent = "openclaw-quota-presence",
  } = opts;
  let inflight = null;
  return function fetchClaude() {
    inflight ??= (async () => {
      const { token } = readClaudeToken(credentialsFile, { now: now(), ...(readFile ? { readFile } : {}) });
      let res;
      try {
        res = await fetchFn(CLAUDE_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": userAgent,
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
        throw new Error(timedOut ? `usage request timed out after ${timeoutMs} ms` : `usage request failed: ${e?.cause?.code ?? e?.message ?? e}`);
      }
      if (!res.ok) {
        const why = await errorMessage(res);
        const msg = `usage request: HTTP ${res.status}${why ? ` (${why})` : ""}`;
        if (res.status === 401 || res.status === 403) throw new ClaudeAuthError(msg);
        throw new Error(msg);
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("usage request: the answer is not JSON");
      }
      const rows = parseClaudeUsage(data);
      if (rows.length === 0) throw new Error("usage request: no usage windows in the answer");
      return rows;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** The API's own error message, short; never the request. */
async function errorMessage(res) {
  try {
    const msg = (await res.json())?.error?.message;
    return typeof msg === "string" ? msg.trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}
