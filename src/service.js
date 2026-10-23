// The updater: fetch every source, render the line, publish it (status.json).
// Runs every intervalMs; request() (after a turn) refreshes too, but never
// more often than minUpdateIntervalMs — a call inside that window schedules
// one refresh at its end. Rows are kept per group, so a source that fails or
// leaves a provider out keeps showing its last value until staleAfterMs.

import { describeItems, renderStatus } from "./format.js";

/**
 * @param {{config: object, sources: {id: string, fetch: () => Promise<object[]>}[],
 *          publish?: (status: {text: string, items: object[], updatedAt: string}) => void, log?: object,
 *          now?: () => number, timers?: {setTimeout, clearTimeout, setInterval, clearInterval}}} opts
 */
export function createQuotaPresence({ config, sources, publish, log = console, now = Date.now, timers = globalThis }) {
  const groups = new Map(); // group → { rows, at }
  const lastError = new Map(); // source id → message (log each new error once)
  let lastRefreshAt = -Infinity;
  let inflight = null;
  let pending = null;
  let text = "";
  let published = null;
  const handles = [];
  let stopped = false;

  async function fetchAll() {
    await Promise.all(
      sources.map(async (s) => {
        try {
          const rows = await s.fetch();
          const at = now();
          const byGroup = new Map();
          for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
          for (const [g, rs] of byGroup) groups.set(g, { rows: rs, at });
          if (lastError.has(s.id)) log.info?.(`${s.id}: recovered`);
          lastError.delete(s.id);
          for (const e of rows.errors ?? []) log.debug?.(`${s.id}: ${e}`);
        } catch (e) {
          const msg = e?.message ?? String(e);
          if (lastError.get(s.id) !== msg) log.warn?.(`${s.id}: ${msg}`);
          lastError.set(s.id, msg);
        }
      }),
    );
  }

  /** Current rows, dropping groups not refreshed within staleAfterMs. */
  function rows() {
    const t = now();
    const out = [];
    for (const [g, v] of groups) {
      if (config.staleAfterMs > 0 && t - v.at > config.staleAfterMs) groups.delete(g);
      else out.push(...v.rows);
    }
    return out;
  }


  function refresh(reason = "manual") {
    inflight ??= (async () => {
      lastRefreshAt = now();
      await fetchAll();
      if (stopped) return { text, written: false, reason: "stopped" };
      const current = rows();
      text = renderStatus(current, config, now());
      // Written every time, so updatedAt shows the plugin is alive. An empty
      // text (every source stale) is written too; the reader keeps what it has.
      try {
        publish?.({ text, items: describeItems(config.items, current), updatedAt: new Date(now()).toISOString() });
      } catch (e) {
        log.warn?.(`could not write the status: ${e?.message ?? e}`);
        return { text, written: false, reason: "error" };
      }
      if (text !== published) log.info?.(`status (${reason}): ${text || "(empty)"}`);
      published = text;
      return { text, written: true };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    refresh,
    /** A refresh request from an event (agent_end), throttled to minUpdateIntervalMs. */
    request(reason = "event") {
      if (pending || inflight) return "coalesced";
      const wait = lastRefreshAt + config.minUpdateIntervalMs - now();
      if (wait <= 0) {
        refresh(reason).catch(() => {});
        return "now";
      }
      pending = timers.setTimeout(() => {
        pending = null;
        refresh(reason).catch(() => {});
      }, wait);
      pending?.unref?.();
      return "scheduled";
    },
    // Returns at once: the first fetch waits startDelayMs, so the Gateway's
    // service startup (5 s budget on a hot reload) never waits for us.
    start() {
      stopped = false;
      const first = timers.setTimeout(() => refresh("startup").catch(() => {}), config.startDelayMs ?? 0);
      first?.unref?.();
      handles.push(first);
      const every = (ms, fn) => {
        const h = timers.setInterval(fn, ms);
        h?.unref?.();
        handles.push(h);
      };
      every(config.intervalMs, () => refresh("interval").catch(() => {}));
    },
    stop() {
      stopped = true;
      for (const h of handles.splice(0)) {
        timers.clearInterval(h);
        timers.clearTimeout(h);
      }
      if (pending) timers.clearTimeout(pending);
      pending = null;
    },
    /** The latest line, rendered with another template (the reply footer). */
    renderWith(overrides) {
      return renderStatus(rows(), { ...config, ...overrides }, now());
    },
    get text() {
      return text;
    },
    get config() {
      return config;
    },
  };
}
