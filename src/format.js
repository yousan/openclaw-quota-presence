// Quota rows → the status line ("Argon 55% | GPT 84% | Opus 92%").

export const DISCORD_CUSTOM_STATUS_MAX = 128;
export const DEFAULT_RESET_TIME_ZONE = "Asia/Tokyo";

/**
 * Resolve the configured items against the rows.
 * items: "auto" (every group, in the order the sources listed them) or
 * [{ label, source, window, windows }], where source is a group
 * ("agy:gemini-4-argon", "usage:openai"), window is "min" (the tightest limit;
 * default) or a window id ("5h", "week"), and windows a list of window ids
 * shown together through {windows}. "min" leaves out model-scoped windows
 * (scope "model", e.g. claude-code's "fable") when the group has others: a
 * limit on one model is not the limit of the whole group.
 * @returns {{label: string, row?: object, rows: object[]}[]}  row: the tightest of rows
 */
export function resolveItems(items, rows) {
  const list = items === "auto" || items === undefined ? autoItems(rows) : items;
  return list.map((item) => {
    const label = item.label ?? item.source;
    if (Array.isArray(item.windows) && item.windows.length) {
      const found = item.windows.map((w) => pick(rows, item.source, w)).filter(Boolean);
      return { label, row: tightest(found), rows: found };
    }
    const row = pick(rows, item.source, item.window);
    return { label, row, rows: row ? [row] : [] };
  });
}

/** The resolved items as plain data, for status.json. */
export function describeItems(items, rows) {
  return resolveItems(items, rows).map(({ label, row, rows: found }) =>
    row
      ? {
          label,
          source: row.group,
          window: row.window,
          remaining: Math.round(row.remaining),
          ...(row.resetAt ? { resetAt: new Date(row.resetAt).toISOString() } : {}),
          ...(row.fetchedAt ? { fetchedAt: new Date(row.fetchedAt).toISOString() } : {}),
          ...(found.length > 1
            ? { windows: found.map((r) => ({ window: r.window, remaining: Math.round(r.remaining), ...(r.resetAt ? { resetAt: new Date(r.resetAt).toISOString() } : {}) })) }
            : {}),
        }
      : { label, remaining: null },
  );
}

function autoItems(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.group)) seen.set(r.group, { label: r.groupLabel, source: r.group });
  return [...seen.values()];
}

function pick(rows, source, window = "min") {
  const mine = rows.filter((r) => r.group === source);
  if (window !== "min") return mine.find((r) => r.window === window);
  const whole = mine.filter((r) => r.scope !== "model");
  return tightest(whole.length ? whole : mine);
}

function tightest(rows) {
  let best;
  for (const r of rows) if (!best || r.remaining < best.remaining) best = r;
  return best;
}

/**
 * @param {object[]} rows
 * @param {object} opts  items, template, itemTemplate, missingTemplate (false hides), separator,
 *   windowTemplate, windowSeparator, windowLabels, resetAtFormat, resetAtTodayFormat, resetPrecision,
 *   staleMark, markStaleAfterMs, maxLength, timeZone
 */
export function renderStatus(rows, opts = {}, now = Date.now()) {
  const {
    template = "{items}",
    itemTemplate = "{label} {remaining}%",
    missingTemplate = "{label} ?",
    separator = " | ",
    windowTemplate = "{window} {remaining}%",
    windowSeparator = "・",
    maxLength = DISCORD_CUSTOM_STATUS_MAX,
    timeZone,
  } = opts;
  const parts = [];
  for (const { label, row, rows: found } of resolveItems(opts.items, rows)) {
    if (row) {
      const windows = found.map((r) => fill(windowTemplate, itemVars(label, r, now, opts))).join(windowSeparator);
      parts.push(fill(itemTemplate, { ...itemVars(label, row, now, opts), windows }));
    } else if (missingTemplate !== false) parts.push(fill(missingTemplate, { label }));
  }
  if (parts.length === 0) return "";
  const text = fill(template, { items: parts.join(separator), time: clock(now, timeZone) }).trim();
  return truncate(text, maxLength);
}

function itemVars(label, row, now, opts) {
  return {
    label,
    remaining: Math.round(row.remaining),
    used: Math.round(100 - row.remaining),
    window: opts.windowLabels?.[row.window] ?? row.window,
    reset: row.resetAt ? untilText(row.resetAt - now, opts.resetPrecision) : "",
    resetAt: row.resetAt ? resetAtText(row.resetAt, now, opts) : "",
    stale: isStale(row, now, opts) ? (opts.staleMark ?? DEFAULT_STALE_MARK) : "",
  };
}

export const DEFAULT_STALE_MARK = "*";

/** Fetched longer than markStaleAfterMs ago (a source that keeps failing shows its last numbers). */
export function isStale(row, now, { markStaleAfterMs } = {}) {
  return markStaleAfterMs > 0 && Number.isFinite(row.fetchedAt) && now - row.fetchedAt > markStaleAfterMs;
}

/** Replace {name} with vars[name]; unknown names stay as they are. */
export function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const UNITS = [
  ["d", 1440],
  ["h", 60],
  ["m", 1],
];

/** 45m / 3h / 2d; with precision 2: 45m / 3h20m / 1d6h (the last unit rounded, zero units left out). */
export function untilText(ms, precision = 1) {
  if (!(ms > 0)) return "0m";
  const m = Math.ceil(ms / 60_000);
  if (!(precision > 1)) {
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }
  const first = UNITS.findIndex(([, size]) => m >= size);
  const last = Math.min(first + Math.floor(precision) - 1, UNITS.length - 1);
  const step = UNITS[last][1];
  let rest = Math.max(step, Math.round(m / step) * step);
  let out = "";
  for (const [unit, size] of UNITS.slice(0, last + 1)) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) out += `${n}${unit}`;
  }
  return out;
}

const DATE_TOKENS = /YYYY|MM|M|DD|D|HH|H|mm/g;

/**
 * The reset time as a date: format tokens YYYY, M, MM, D, DD, H, HH, mm (everything
 * else is literal), in timeZone (default Asia/Tokyo). resetAtTodayFormat, when set,
 * is used instead if the reset falls on the same day as now (e.g. "HH:mm").
 */
export function resetAtText(resetAt, now, { resetAtFormat = "M/D HH:mm", resetAtTodayFormat, timeZone = DEFAULT_RESET_TIME_ZONE } = {}) {
  const at = dateParts(resetAt, timeZone);
  if (!at) return "";
  const today = resetAtTodayFormat ? dateParts(now, timeZone) : undefined;
  const sameDay = today && today.YYYY === at.YYYY && today.M === at.M && today.D === at.D;
  return String(sameDay ? resetAtTodayFormat : resetAtFormat).replace(DATE_TOKENS, (t) => at[t]);
}

function dateParts(ms, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(ms);
  } catch {
    return undefined;
  }
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const pad = (v) => String(Number(v)).padStart(2, "0");
  return {
    YYYY: p.year,
    M: String(Number(p.month)),
    MM: pad(p.month),
    D: String(Number(p.day)),
    DD: pad(p.day),
    H: String(Number(p.hour)),
    HH: pad(p.hour),
    mm: pad(p.minute),
  };
}

function clock(now, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(now);
  } catch {
    return "";
  }
}

/** Cut to max UTF-16 code units (how Discord counts), ending with "…" when cut; never splits a surrogate pair. */
export function truncate(text, max = DISCORD_CUSTOM_STATUS_MAX) {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end).trimEnd() + "…";
}
