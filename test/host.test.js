import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUsageModules, loadModule, loadUsageFunction, openclawDistDirs } from "../src/host.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-host-"));
const put = (file, text) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, text), file);

test("finds the hashed dist chunk that exports loadProviderUsageSummary by name", async () => {
  const dist = path.join(tmp(), "node_modules", "openclaw", "dist");
  put(path.join(dist, "provider-usage-AAAA.mjs"), "export {};\n");
  put(path.join(dist, "provider-usage.load-BBBB.mjs"), "async function loadProviderUsageSummary(){}\nexport { loadProviderUsageSummary as t };\n");
  const good = put(
    path.join(dist, "provider-usage-CCCC.mjs"),
    "const loadProviderUsageSummary = async (o) => ({ providers: [], o });\nexport { loadProviderUsageSummary };\n",
  );
  assert.deepEqual(findUsageModules([dist, "/nonexistent"]), [good]);
  const fn = await loadUsageFunction({ distDirs: [dist] });
  assert.deepEqual(await fn({ a: 1 }), { providers: [], o: { a: 1 } });
  await assert.rejects(loadUsageFunction({ distDirs: [] }), /loadProviderUsageSummary not found/);
});

test("OpenClaw dist dirs: the entry script's dir, then loaded openclaw/dist modules", () => {
  const dist = path.join(tmp(), "openclaw", "dist");
  const entry = put(path.join(dist, "index.js"), "");
  const dirs = openclawDistDirs({ argv1: entry, loaded: ["/x/node_modules/openclaw/dist/chunk.mjs", path.join(dist, "a.mjs")] });
  assert.deepEqual(dirs, [fs.realpathSync(dist), "/x/node_modules/openclaw/dist"]);
});

test("loadModule: cached exports first, then require(esm)", async () => {
  const dir = tmp();
  put(path.join(dir, "package.json"), '{"type":"module"}');
  const f = put(path.join(dir, "m.js"), "export const x = 42;\n");
  const a = await loadModule(f);
  assert.equal(a.x, 42);
  assert.equal(await loadModule(f), a);
  const b = await import(f);
  assert.equal(b.x, 42);
});
