// quota-presence for OpenClaw: a Gateway service that turns how much quota is
// left on each AI provider into one line ("Argon 55% | GPT 84% | Opus 92%")
// and writes it to <state>/quota-presence/status.json. No model calls: the
// numbers come from `agy -p /usage` and from OpenClaw's own provider usage
// loader, called inside the Gateway process (never through the `openclaw` CLI).
// Putting the line on Discord is automation/set-presence.js's job.

import os from "node:os";
import path from "node:path";
import { createAgyFetcher } from "../src/agy.js";
import { applyFooter, footerPattern } from "../src/footer.js";
import { loadUsageFunction } from "../src/host.js";
import { normalizeUsageSummary, usageSummaryErrors } from "../src/quota.js";
import { createQuotaPresence } from "../src/service.js";
import { writeStatusFile } from "../src/statusfile.js";
import { resolvePluginConfig } from "./config.js";

export const PLUGIN_ID = "quota-presence";

export default {
  id: PLUGIN_ID,
  name: "Quota Presence",
  description:
    "Writes how much quota is left on each AI provider as one status line (status.json) for the bot's Discord custom status. Reads agy /usage and OpenClaw's provider usage; no model calls.",
  register(api) {
    if (api.registrationMode && api.registrationMode !== "full") return;
    const pc = api.pluginConfig || {};
    let running = null;

    api.registerService({
      id: PLUGIN_ID,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}`] },
      async start(ctx) {
        const log = prefixed(api.logger || console);
        const host = hostConfig(api, ctx);
        const sd = stateDir(api);
        const config = resolvePluginConfig(api.pluginConfig || {}, { stateDir: sd });
        if (host?.channels?.discord?.autoPresence?.enabled) {
          log.warn("channels.discord.autoPresence is on and will overwrite the custom status every few seconds");
        }
        running = createQuotaPresence({
          config,
          sources: createSources(api, ctx, config),
          publish: (status) => writeStatusFile(config.statusFile, status),
          log,
        });
        running.start();
      },
      async stop() {
        running?.stop();
        running = null;
      },
    });

    // agent_end is a conversation hook: non-bundled plugins also need
    // plugins.entries.quota-presence.hooks.allowConversationAccess=true.
    if (pc.refreshOnAgentEnd !== false) {
      api.on?.("agent_end", () => {
        running?.request("agent_end");
      });
    }

    // Registered only when asked for: any message_sending hook turns off
    // Discord's streamed reply preview for every message (OpenClaw 2026.10.2,
    // checked per message). Read at registration, so changing footer.enabled
    // takes `openclaw plugins reload quota-presence`.
    if (pc.footer?.enabled) {
      api.on?.("message_sending", (event, ctx) => footerHook(running, pc.footer, event, ctx));
    }
  },
};

/** message_sending: add the status as a small "-#" line under each reply, once. */
export function footerHook(running, footer = {}, event, ctx) {
  const channels = footer.channels ?? ["discord"];
  if (!running) return;
  if (channels.length && !channels.includes(ctx?.channelId)) return;
  const opts = { ...footerDisplay(footer), template: footer.template ?? "-# {items}", maxLength: footer.maxLength ?? 300 };
  // Nothing fetched yet (or all of it stale): no line of question marks.
  if (!running.renderWith({ ...opts, missingTemplate: false })) return;
  const content = applyFooter(event?.content, running.renderWith(opts), footerPattern({ ...running.config, ...opts }));
  return content === undefined ? undefined : { content };
}

// Display keys the footer can set for itself; any it leaves out come from the
// plugin's own config (the custom status), as before footer had them.
export const FOOTER_DISPLAY_KEYS = [
  "items",
  "itemTemplate",
  "missingTemplate",
  "separator",
  "windowTemplate",
  "windowSeparator",
  "windowLabels",
  "resetAtFormat",
  "resetAtTodayFormat",
  "resetPrecision",
  "timeZone",
];

function footerDisplay(footer) {
  return Object.fromEntries(FOOTER_DISPLAY_KEYS.filter((k) => footer[k] !== undefined).map((k) => [k, footer[k]]));
}

export function createSources(api, ctx, config) {
  const sources = [];
  if (config.agy.enabled) sources.push({ id: "agy", fetch: createAgyFetcher(config.agy) });
  if (config.usage.enabled) {
    let load = null;
    sources.push({
      id: "usage",
      async fetch() {
        load ??= loadUsageFunction({ module: config.usage.module }).catch((e) => {
          load = null; // try again next time
          throw e;
        });
        const loadProviderUsageSummary = await load;
        const summary = await loadProviderUsageSummary({
          config: hostConfig(api, ctx),
          timeoutMs: config.usage.timeoutMs,
          ...(config.usage.providers?.length ? { providers: config.usage.providers } : {}),
          ...(config.usage.agentDir ? { agentDir: config.usage.agentDir } : {}),
        });
        const rows = normalizeUsageSummary(summary);
        rows.errors = usageSummaryErrors(summary);
        return rows;
      },
    });
  }
  return sources;
}

function hostConfig(api, ctx) {
  try {
    return api.runtime?.config?.current?.() || ctx?.config || api.config;
  } catch {
    return ctx?.config || api.config;
  }
}

function stateDir(api) {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.();
    if (dir) return dir;
  } catch {}
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function prefixed(log) {
  return {
    info: (m) => log.info(`quota-presence: ${m}`),
    warn: (m) => log.warn(`quota-presence: ${m}`),
    debug: (m) => log.debug?.(`quota-presence: ${m}`),
  };
}
