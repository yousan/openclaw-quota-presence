// Finding OpenClaw's provider usage loader from inside the Gateway process.
//
// loadProviderUsageSummary is not on the public plugin SDK (OpenClaw 2026.10.2):
// it lives in a hashed dist chunk (dist/provider-usage-<hash>.mjs), not in
// openclaw/plugin-sdk/provider-usage. We load it with require() (the Gateway
// uses require(esm); import() of a module it already required can hit a Node
// internal assertion) and never start the `openclaw` CLI (≈500 MB per run).
// Nothing here touches @openclaw/discord.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Loaded module paths (require.cache keys). */
export function loadedModulePaths(cache = require.cache) {
  return Object.keys(cache ?? {});
}

/** Candidate OpenClaw dist dirs: the Gateway entry script, then anything loaded from an openclaw/dist. */
export function openclawDistDirs({ argv1 = process.argv[1], loaded = loadedModulePaths() } = {}) {
  const dirs = [];
  const add = (d) => d && !dirs.includes(d) && dirs.push(d);
  if (argv1) {
    try {
      add(path.dirname(fs.realpathSync(argv1)));
    } catch {}
  }
  for (const p of loaded) {
    const m = /^(.*[\\/]openclaw[\\/]dist)[\\/]/.exec(p);
    if (m) add(m[1]);
  }
  return dirs;
}

/** dist/provider-usage-<hash>.mjs files that export loadProviderUsageSummary by name. */
export function findUsageModules(distDirs) {
  const found = [];
  for (const dir of distDirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^provider-usage-[\w-]+\.mjs$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (/export\s*\{[^}]*\bloadProviderUsageSummary\b/.test(fs.readFileSync(file, "utf8"))) found.push(file);
      } catch {}
    }
  }
  return found;
}

/** @returns {Promise<Function>} OpenClaw's loadProviderUsageSummary */
export async function loadUsageFunction({ module: override, distDirs = openclawDistDirs(), loader = loadModule } = {}) {
  const files = override ? [override] : findUsageModules(distDirs);
  const errors = [];
  for (const file of files) {
    try {
      const mod = await loader(file);
      if (typeof mod?.loadProviderUsageSummary === "function") return mod.loadProviderUsageSummary;
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  throw new Error(
    `loadProviderUsageSummary not found (${errors.length ? errors.join("; ") : `looked in ${override || distDirs.join(", ") || "no OpenClaw dist"}`}); set usage.module`,
  );
}

/** Loaded exports if the Gateway already has the file, else require() it (import() as a last resort). */
export async function loadModule(file) {
  const cached = require.cache[file]?.exports;
  if (cached) return cached;
  try {
    return require(file);
  } catch (e) {
    if (e?.code !== "ERR_REQUIRE_ASYNC_MODULE" && e?.code !== "ERR_REQUIRE_ESM") throw e;
    return import(pathToFileURL(file).href);
  }
}
