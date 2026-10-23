import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, createAgyFetcher } from "../src/agy.js";
import { AGY_TSV } from "./fixtures.js";

/** A spawn that prints `out` and exits with `code` after `delay` ms (never, with delay Infinity). */
function fakeSpawn({ out = AGY_TSV, err = "", code = 0, delay = 5 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = null;
    child.kill = (sig) => {
      child.killed = sig;
      setImmediate(() => child.emit("close", null, sig));
    };
    calls.push({ cmd, args, opts, child });
    if (delay !== Infinity) {
      setTimeout(() => {
        if (out) child.stdout.emit("data", Buffer.from(out));
        if (err) child.stderr.emit("data", Buffer.from(err));
        child.emit("close", code, null);
      }, delay);
    }
    return child;
  };
  return { spawn, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-agy-"));

test("runs agy -p /usage and parses the table", async () => {
  const { spawn, calls } = fakeSpawn();
  const rows = await createAgyFetcher({ spawn })();
  assert.equal(rows.length, 5);
  assert.equal(calls[0].cmd, "agy");
  assert.deepEqual(calls[0].args, ["-p", "/usage"]);
  assert.deepEqual(calls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("concurrent calls share one run", async () => {
  const { spawn, calls } = fakeSpawn({ delay: 20 });
  const fetch = createAgyFetcher({ spawn });
  const [a, b] = await Promise.all([fetch(), fetch()]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  await fetch();
  assert.equal(calls.length, 2);
});

test("a hung agy is killed at the timeout", async () => {
  const { spawn, calls } = fakeSpawn({ delay: Infinity });
  await assert.rejects(createAgyFetcher({ spawn, timeoutMs: 30 })(), /timed out after 30ms/);
  assert.equal(calls[0].child.killed, "SIGKILL");
});

test("a failing or silent agy is an error, not an empty status", async () => {
  await assert.rejects(createAgyFetcher(fakeSpawn({ out: "", err: "not logged in", code: 1 }))(), /exited with 1: not logged in/);
  await assert.rejects(createAgyFetcher(fakeSpawn({ out: "hello\n" }))(), /no usage rows/);
  const missing = createAgyFetcher({ command: path.join(tmp(), "no-such-agy") });
  await assert.rejects(missing(), /ENOENT/);
});

test("the lock file keeps a second run out and is removed afterwards", async () => {
  const lockFile = path.join(tmp(), "sub", "agy.lock");
  const release = acquireLock(lockFile, 60_000);
  const { spawn, calls } = fakeSpawn();
  await assert.rejects(createAgyFetcher({ spawn, lockFile })(), /another usage check is running/);
  assert.equal(calls.length, 0);
  release();
  await createAgyFetcher({ spawn, lockFile })();
  assert.equal(fs.existsSync(lockFile), false);
});

test("a stale lock (left by a crash) is taken over", () => {
  const lockFile = path.join(tmp(), "agy.lock");
  fs.writeFileSync(lockFile, "12345");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockFile, old, old);
  const release = acquireLock(lockFile, 60_000);
  assert.equal(fs.readFileSync(lockFile, "utf8"), String(process.pid));
  release();
});

test("works against a real executable", async () => {
  const dir = tmp();
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf 'Gemini 4 Argon\\tGemini 4 Argon Weekly Limit\\t%s\\t2026-10-28T07:04:55Z\\n' "$2" | sed 's#/usage#42%#'\n`);
  fs.chmodSync(bin, 0o755);
  const rows = await createAgyFetcher({ command: bin, lockFile: path.join(dir, "lock") })();
  assert.deepEqual(rows.map((r) => [r.group, r.remaining]), [["agy:gemini-4-argon", 42]]);
});
