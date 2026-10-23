// Plugin config (plugins.entries.quota-presence.config) → resolved config.

import path from "node:path";
import os from "node:os";

export const DEFAULTS = {
  intervalMs: 15 * 60_000,
  minUpdateIntervalMs: 2 * 60_000,
  startDelayMs: 10_000,
  staleAfterMs: 3 * 60 * 60_000,
  staleMark: "*",
  refreshOnAgentEnd: true,
  items: "auto",
  template: "{items}",
  itemTemplate: "{label} {remaining}%",
  missingTemplate: "{label} ?",
  separator: " | ",
  windowTemplate: "{window} {remaining}%",
  windowSeparator: "・",
  windowLabels: {},
  resetAtFormat: "M/D HH:mm",
  resetPrecision: 1,
  maxLength: 128,
  agy: { enabled: true, command: "agy", args: ["-p", "/usage"], timeoutMs: 30_000 },
  usage: { enabled: true, timeoutMs: 10_000 },
  // Off unless asked for: it reads Claude Code's login (see src/claude.js).
  claudeCode: { enabled: false, timeoutMs: 10_000 },
  footer: { enabled: false, template: "-# {items}", channels: ["discord"] },
};

/**
 * @param {object} pc  the plugin's config object
 * @param {{stateDir: string}} host
 */
export function resolvePluginConfig(pc = {}, { stateDir } = {}) {
  const c = {
    ...DEFAULTS,
    ...pc,
    agy: { ...DEFAULTS.agy, ...(pc.agy || {}) },
    usage: { ...DEFAULTS.usage, ...(pc.usage || {}) },
    claudeCode: { ...DEFAULTS.claudeCode, ...(pc.claudeCode || {}) },
    footer: { ...DEFAULTS.footer, ...(pc.footer || {}) },
  };
  c.intervalMs = Math.max(60_000, c.intervalMs);
  c.minUpdateIntervalMs = Math.max(0, c.minUpdateIntervalMs);
  // {stale}: numbers that missed two refreshes in a row.
  c.markStaleAfterMs ??= 2 * c.intervalMs + 5 * 60_000;
  c.maxLength = Math.min(128, Math.max(1, c.maxLength));
  c.agy.command = expand(c.agy.command);
  c.agy.lockFile = expand(c.agy.lockFile) || path.join(stateDir, "quota-presence", "agy.lock");
  if (c.usage.module) c.usage.module = expand(c.usage.module);
  if (c.claudeCode.credentialsFile) c.claudeCode.credentialsFile = expand(c.claudeCode.credentialsFile);
  c.statusFile = expand(c.statusFile) || path.join(stateDir, "quota-presence", "status.json");
  return c;
}

function expand(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
