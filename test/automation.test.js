import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeStatusFile } from "../src/statusfile.js";

const SCRIPT = fs.readFileSync(new URL("../automation/set-presence.js", import.meta.url), "utf8");
const AsyncFunction = (async () => {}).constructor;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-auto-"));

/**
 * Run the script the way the automation runner does: a body with top-level
 * await/return and the read / message tools and trigger as globals.
 */
async function run({ file, state, now = Date.parse("2026-10-22T08:00:00Z"), presence = () => ({ ok: true }) }) {
  const sent = [];
  const read = async ({ path: p }) => {
    // Like the read tool: a missing file is a tool error.
    if (!fs.existsSync(p)) throw new Error(`ENOENT: ${p}`);
    return { kind: "complete", content: fs.readFileSync(p, "utf8") };
  };
  const message = async (args) => (sent.push(args), presence(args));
  const RealDate = Date;
  const FakeDate = class extends RealDate {
    static now() {
      return now;
    }
  };
  const body = SCRIPT.replaceAll("__STATUS_FILE__", file);
  const fn = new AsyncFunction("read", "message", "trigger", "Date", body);
  const result = await fn(read, message, Object.freeze({ state }), FakeDate);
  return { result, sent };
}

const NOW = Date.parse("2026-10-22T08:00:00Z");
const status = (text, at = NOW - 60_000) => ({ text, items: [], updatedAt: new Date(at).toISOString() });

test("status.json is written atomically: whole JSON, no temp file left", () => {
  const file = path.join(tmp(), "nested", "status.json");
  writeStatusFile(file, status("Argon 55% | GPT 84%"));
  writeStatusFile(file, status("Argon 54% | GPT 84%"));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).text, "Argon 54% | GPT 84%");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["status.json"]);
});

test("a write that fails leaves the previous file intact and cleans up", () => {
  const dir = tmp();
  const file = path.join(dir, "status.json");
  writeStatusFile(file, status("old"));
  const bad = { toJSON() { throw new Error("boom"); } };
  assert.throws(() => writeStatusFile(file, bad), /boom/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).text, "old");
  assert.deepEqual(fs.readdirSync(dir), ["status.json"]);
});

test("applies a new line as a custom status and remembers it", async () => {
  const file = path.join(tmp(), "status.json");
  writeStatusFile(file, status("Argon 55% | GPT 84% | Opus 92%"));
  const { result, sent } = await run({ file });
  assert.deepEqual(sent, [
    {
      action: "set-presence",
      channel: "discord",
      status: "online",
      activityType: "custom",
      activityName: "Custom Status",
      activityState: "Argon 55% | GPT 84% | Opus 92%",
    },
  ]);
  assert.deepEqual(result, { state: { appliedText: "Argon 55% | GPT 84% | Opus 92%", appliedAt: NOW } });
});

test("the same line is not sent again; a changed one is", async () => {
  const file = path.join(tmp(), "status.json");
  writeStatusFile(file, status("Argon 55%"));
  const state = { appliedText: "Argon 55%", appliedAt: NOW - 15 * 60_000 };
  const same = await run({ file, state });
  assert.equal(same.sent.length, 0);
  assert.deepEqual(same.result.state, { ...state, skipped: "unchanged" }, "the applied line is kept in state");
  writeStatusFile(file, status("Argon 54%"));
  const changed = await run({ file, state });
  assert.equal(changed.sent[0].activityState, "Argon 54%");
  assert.equal(changed.result.state.appliedText, "Argon 54%");
});

test("the same line is sent again after an hour (a reconnect resets Discord's presence)", async () => {
  const file = path.join(tmp(), "status.json");
  writeStatusFile(file, status("Argon 55%"));
  const { sent } = await run({ file, state: { appliedText: "Argon 55%", appliedAt: NOW - 60 * 60_000 } });
  assert.equal(sent.length, 1);
});

test("cut to 128 UTF-16 code units, never splitting a surrogate pair", async () => {
  const file = path.join(tmp(), "status.json");
  writeStatusFile(file, status("x".repeat(126) + "🔋🔋"));
  const a = (await run({ file })).sent[0].activityState;
  assert.equal(a, "x".repeat(126) + "…");
  writeStatusFile(file, status("x".repeat(200)));
  const b = (await run({ file })).sent[0].activityState;
  assert.equal(b.length, 128);
  assert.ok(b.endsWith("…"));
  writeStatusFile(file, status("x".repeat(128)));
  assert.equal((await run({ file })).sent[0].activityState, "x".repeat(128), "exactly 128 is not cut");
});

test("missing status.json: nothing sent, the last applied line stays in state", async () => {
  const state = { appliedText: "Argon 55%", appliedAt: NOW - 60_000 };
  const { result, sent } = await run({ file: path.join(tmp(), "none.json"), state });
  assert.equal(sent.length, 0);
  assert.equal(result.state.appliedText, "Argon 55%");
  assert.match(result.state.skipped, /no status file/);
  const first = await run({ file: path.join(tmp(), "none.json") });
  assert.deepEqual(first.sent, []);
});

test("broken status.json fails the run (state not saved), nothing sent", async () => {
  const file = path.join(tmp(), "status.json");
  fs.writeFileSync(file, '{"text": "Argon 5');
  await assert.rejects(run({ file, state: { appliedText: "Argon 55%" } }), /not valid JSON/);
});

test("a source outage keeps the old status: empty text or a stale file sends nothing", async () => {
  const file = path.join(tmp(), "status.json");
  const state = { appliedText: "Argon 55%", appliedAt: NOW - 2 * 60 * 60_000 };
  writeStatusFile(file, status(""));
  const empty = await run({ file, state });
  assert.deepEqual([empty.sent.length, empty.result.state.appliedText, empty.result.state.skipped], [0, "Argon 55%", "empty text"]);
  writeStatusFile(file, status("Argon 10%", NOW - 7 * 60 * 60_000));
  const stale = await run({ file, state });
  assert.equal(stale.sent.length, 0);
  assert.match(stale.result.state.skipped, /stale/);
  fs.writeFileSync(file, JSON.stringify({ text: "Argon 10%" }));
  assert.equal((await run({ file, state })).sent.length, 0, "no updatedAt counts as stale");
});

test("a failed set-presence fails the run so the next one retries", async () => {
  const file = path.join(tmp(), "status.json");
  writeStatusFile(file, status("Argon 55%"));
  await assert.rejects(
    run({ file, presence: () => ({ isError: true, message: "Discord presence changes are disabled." }) }),
    /set-presence failed: Discord presence changes are disabled/,
  );
  await assert.rejects(
    run({ file, presence: () => { throw new Error('Discord gateway is not connected for account "default".'); } }),
    /not connected/,
  );
});

test("the script is the plugin's status file, end to end", async () => {
  const { resolvePluginConfig } = await import("../openclaw/config.js");
  const dir = tmp();
  const c = resolvePluginConfig({}, { stateDir: dir });
  assert.equal(c.statusFile, path.join(dir, "quota-presence", "status.json"));
  writeStatusFile(c.statusFile, status("GPT 84%"));
  assert.equal((await run({ file: c.statusFile })).sent[0].activityState, "GPT 84%");
});
