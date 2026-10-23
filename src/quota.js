// Quota rows from every source share one shape:
//   { group, groupLabel, window, windowLabel, remaining, resetAt? }
// group  — "agy:<slug>" or "usage:<provider id>", what an item points at
// window — "5h", "week", "day", … or a slug of the source's own label

/** "Gemini 4 Argon" → "gemini-4-argon". */
export function slug(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A source's window label → a short, stable window id. */
export function windowOf(label) {
  const s = String(label ?? "").trim();
  if (/five[\s-]*hours?/i.test(s)) return "5h";
  const hours = /^(\d+)\s*h(?:ours?)?$/i.exec(s);
  if (hours) return `${Number(hours[1])}h`;
  if (/week/i.test(s)) return "week";
  if (/\bday\b|daily/i.test(s)) return "day";
  if (/month/i.test(s)) return "month";
  return slug(s);
}

export function clampPercent(n) {
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, n));
}

/**
 * Parse `agy -p /usage`: one row per limit,
 * `<group>\t<limit name>\t<remaining>%\t<reset ISO time>`.
 */
export function parseAgyUsage(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 3 || !cols[0]) continue;
    const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(cols[2]);
    if (!m) continue;
    const resetAt = cols[3] ? Date.parse(cols[3]) : NaN;
    rows.push({
      group: `agy:${slug(cols[0])}`,
      groupLabel: cols[0],
      window: windowOf(cols[1]),
      windowLabel: cols[1],
      remaining: clampPercent(Number(m[1])),
      ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    });
  }
  return rows;
}

/**
 * OpenClaw's provider usage summary ({ providers: [{ provider, displayName,
 * windows: [{ label, usedPercent, resetAt }], error }] }) → quota rows.
 * Providers that only carry an error contribute nothing.
 */
export function normalizeUsageSummary(summary) {
  const rows = [];
  for (const p of summary?.providers ?? []) {
    if (!p?.provider) continue;
    for (const w of p.windows ?? []) {
      const remaining = clampPercent(100 - Number(w?.usedPercent));
      if (remaining === undefined) continue;
      rows.push({
        group: `usage:${p.provider}`,
        groupLabel: p.displayName || p.provider,
        window: windowOf(w.label),
        windowLabel: w.label,
        remaining,
        ...(Number.isFinite(w.resetAt) ? { resetAt: w.resetAt } : {}),
      });
    }
  }
  return rows;
}

/** Provider errors in a usage summary, for logging ("openai: Timeout"). */
export function usageSummaryErrors(summary) {
  return (summary?.providers ?? [])
    .filter((p) => p?.error && !(p.windows?.length > 0))
    .map((p) => `${p.provider}: ${p.error}`);
}
