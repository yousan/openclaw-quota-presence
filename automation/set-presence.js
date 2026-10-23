// quota-presence → Discord custom status.
//
// An OpenClaw automation *script payload* (Code Mode, headless; no model call):
//   openclaw automations create --every 15m --script <this file> --session isolated --no-deliver
// It reads the plugin's status.json with the read tool and, when the line
// differs from the one it last applied, calls the message tool's Discord
// set-presence action (gate channels.discord.actions.presence must be true).
// What it applied is kept in the job's own state (trigger.state).
//
// Before creating the job, replace __STATUS_FILE__ with the absolute path of
// status.json (<state dir>/quota-presence/status.json); see README.

const STATUS_FILE = "__STATUS_FILE__";
const STATUS = "online"; // online | idle | dnd | invisible
const MAX_LENGTH = 128; // Discord's custom status limit, in UTF-16 code units
const MAX_AGE_MS = 6 * 60 * 60_000; // older status.json = the plugin is not running: leave Discord alone
// Discord resets the presence when the bot reconnects, so the same line is
// sent again after this long. 0 = only when the line changes.
const REAPPLY_MS = 60 * 60_000;

const prev = trigger.state ?? {};
const now = Date.now();
const keep = (skipped) => ({ state: { ...prev, skipped } });

let raw;
try {
  raw = (await read({ path: STATUS_FILE }))?.content;
} catch (e) {
  // Not written yet (the plugin has not finished its first refresh).
  return keep(`no status file: ${e?.message ?? e}`);
}
if (typeof raw !== "string" || raw.trim() === "") return keep("no status file");

let status;
try {
  status = JSON.parse(raw);
} catch (e) {
  // The plugin writes atomically, so this is a real problem: fail the run.
  throw new Error(`${STATUS_FILE} is not valid JSON: ${e?.message ?? e}`);
}

const updatedAt = Date.parse(status?.updatedAt);
if (!Number.isFinite(updatedAt) || now - updatedAt > MAX_AGE_MS) return keep(`status.json is stale (${status?.updatedAt})`);

let text = typeof status?.text === "string" ? status.text.trim() : "";
// An empty line means every source is down: keep showing the last one.
if (!text) return keep("empty text");
if (text.length > MAX_LENGTH) {
  let end = MAX_LENGTH - 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  text = text.slice(0, end).trimEnd() + "…";
}

const due = REAPPLY_MS > 0 && now - (prev.appliedAt ?? 0) >= REAPPLY_MS;
if (text === prev.appliedText && !due) return keep("unchanged");

const res = await message({
  action: "set-presence",
  channel: "discord",
  status: STATUS,
  activityType: "custom",
  activityName: "Custom Status",
  activityState: text,
});
// Discord's handler answers { ok: true, ... } and throws on failure; a tool
// error can also come back as { isError, message }. Failing the run means the
// state is not saved, so the next run tries again.
if (res?.isError || res?.ok === false) throw new Error(`set-presence failed: ${res?.message ?? res?.error ?? JSON.stringify(res)}`);

return { state: { appliedText: text, appliedAt: now } };
