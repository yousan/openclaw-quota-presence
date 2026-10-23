// The reply footer: the status line as a small "-#" line under a reply.
// Applied to one outgoing message (message_sending runs once per payload,
// before the channel splits long text), so the line lands once, at the end.

import { fill } from "./format.js";

const SILENT = /^\s*(NO_REPLY|HEARTBEAT_OK)\s*$/;
const REASONING = /^\s*>\s*🧠/; // Discord's reasoning quote ("> 🧠 …")
const FENCE = /^\s*(```|~~~)/;

/**
 * A pattern for a whole footer line as `opts` renders it, with any numbers:
 * used to find footers already in the text (an older one, or one the model
 * copied from the chat history) so there is only ever one.
 * @param {object} opts  template, itemTemplate, missingTemplate, separator, items,
 *   windowTemplate, windowSeparator, windowLabels, resetAtFormat, resetAtTodayFormat
 */
export function footerPattern(opts = {}) {
  const {
    template = "-# {items}",
    itemTemplate = "{label} {remaining}%",
    missingTemplate = "{label} ?",
    separator = " | ",
    windowTemplate = "{window} {remaining}%",
    windowSeparator = "・",
    resetAtFormat = "M/D HH:mm",
    resetAtTodayFormat,
  } = opts;
  const labels = Array.isArray(opts.items) ? opts.items.map((i) => i.label ?? i.source).filter(Boolean) : [];
  const label = labels.length ? `(?:${labels.map(escape).join("|")})` : ".+?";
  const names = Object.values(opts.windowLabels ?? {}).filter(Boolean).map(escape);
  const resetAt = [resetAtFormat, resetAtTodayFormat].filter((f) => f !== undefined).map(dateRegex);
  const vars = {
    label,
    remaining: "\\d{1,3}",
    used: "\\d{1,3}",
    window: `(?:${[...names, "\\S*"].join("|")})`,
    reset: "\\S*",
    resetAt: `(?:${resetAt.join("|")})?`,
  };
  const win = toRegex(windowTemplate, vars, false);
  vars.windows = `(?:${win}(?:${escape(windowSeparator)}${win})*)`;
  const alts = [toRegex(itemTemplate, vars)];
  if (missingTemplate !== false) alts.push(toRegex(missingTemplate, { label }));
  const item = `(?:${alts.join("|")})`;
  const items = `${item}(?:${escape(separator)}${item})*`;
  return new RegExp(`^${toRegex(template, { items, time: "(?:\\d{2}:\\d{2})?" })}$`);
}

/** A resetAt format as a regex: date tokens → digits, the rest literal. */
function dateRegex(format) {
  return String(format)
    .split(/(YYYY|MM|M|DD|D|HH|H|mm)/)
    .map((part, i) => (i % 2 ? "\\d{1,4}" : escape(part)))
    .join("");
}

/**
 * `content` with `line` at the end, or undefined to leave the message alone:
 * nothing to add to (empty, media only, NO_REPLY, a reasoning quote, only a
 * footer), or an unclosed code fence the line would land inside.
 * Footer lines already at the end are replaced, so applying it twice changes nothing.
 */
export function applyFooter(content, line, pattern) {
  if (!line || typeof content !== "string" || !content.trim()) return;
  if (SILENT.test(content) || REASONING.test(content)) return;
  const lines = content.replace(/\s+$/, "").split("\n");
  while (lines.length && (!lines.at(-1).trim() || pattern?.test(lines.at(-1).trim()))) lines.pop();
  if (!lines.length) return;
  if (lines.filter((l) => FENCE.test(l)).length % 2) return;
  const next = `${lines.join("\n")}\n${line}`;
  return next === content ? undefined : next;
}

/** A template as a regex: literal text escaped, {name} replaced by vars[name] (unknown names stay literal, as fill() leaves them). */
function toRegex(template, vars, trim = true) {
  const keys = Object.keys(vars);
  const marked = fill(template, Object.fromEntries(keys.map((k, i) => [k, `\u0000${i}\u0000`])));
  return escape(trim ? marked.trim() : marked).replace(/\u0000(\d+)\u0000/g, (_, i) => vars[keys[i]]);
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
