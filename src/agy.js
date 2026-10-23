// Antigravity CLI quota: run `agy -p /usage` (no model call) and parse its TSV.
// One run at a time: concurrent calls share the run in flight, and a lock file
// keeps a second Gateway (or a slow previous run) from starting another.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseAgyUsage } from "./quota.js";

const MAX_OUTPUT = 64 * 1024;

/**
 * @param {{command?: string, args?: string[], timeoutMs?: number, lockFile?: string,
 *          staleLockMs?: number, env?: object, spawn?: Function}} opts
 * @returns {() => Promise<object[]>} quota rows
 */
export function createAgyFetcher(opts = {}) {
  const {
    command = "agy",
    args = ["-p", "/usage"],
    timeoutMs = 15_000,
    lockFile,
    staleLockMs = timeoutMs * 2 + 5_000,
    env = process.env,
    spawn = nodeSpawn,
  } = opts;
  let inflight = null;
  return function fetchAgy() {
    inflight ??= (async () => {
      const release = lockFile ? acquireLock(lockFile, staleLockMs) : () => {};
      try {
        const out = await run(spawn, command, args, { timeoutMs, env });
        const rows = parseAgyUsage(out);
        if (rows.length === 0) throw new Error(`${command} printed no usage rows`);
        return rows;
      } finally {
        release();
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

function run(spawn, command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (err) {
      reject(err);
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (out.length < MAX_OUTPUT) out += d;
    });
    child.stderr?.on("data", (d) => {
      if (err.length < MAX_OUTPUT) err += d;
    });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code, signal) => {
      if (code === 0) finish(resolve, out);
      else finish(reject, new Error(`${command} exited with ${signal ?? code}: ${err.trim().slice(0, 200)}`));
    });
  });
}

/** Create the lock file or throw; a lock older than staleMs is taken over. */
export function acquireLock(file, staleMs, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = now() - fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (age < staleMs) throw new Error(`another usage check is running (lock ${file})`);
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  throw new Error(`could not take lock ${file}`);
}
