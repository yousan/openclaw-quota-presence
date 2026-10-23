// What `agy -p /usage` printed on 2026-10-21, and an OpenClaw usage summary of the same day.
export const AGY_TSV = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-28T07:32:19Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-21T17:32:19Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-28T14:48:24Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t90%\t2026-10-21T19:48:24Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t55%\t2026-10-28T07:04:55Z",
  "",
].join("\n");

export const USAGE_SUMMARY = {
  updatedAt: 1792570000000,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      plan: "plus",
      windows: [
        { label: "5h", usedPercent: 9, resetAt: 1792596190000 },
        { label: "Week", usedPercent: 16, resetAt: 1793083688000 },
      ],
    },
    {
      provider: "anthropic",
      displayName: "Claude",
      windows: [
        { label: "5h", usedPercent: 8, resetAt: 1792596190000 },
        { label: "Week", usedPercent: 30, resetAt: 1793083688000 },
        { label: "Opus", usedPercent: 12 },
      ],
    },
    { provider: "zai", displayName: "z.ai", windows: [], error: "Timeout" },
  ],
};

export const EXAMPLE_ITEMS = [
  { label: "Argon", source: "agy:gemini-4-argon" },
  { label: "GPT", source: "usage:openai" },
  { label: "Opus", source: "usage:anthropic", window: "opus" },
];

// GET /api/oauth/usage for a Claude Code login (Max plan), 2026-10-23 14:07Z,
// trimmed to the keys this plugin reads plus a few it must ignore. On that
// plan there is no Opus-only limit: seven_day_opus is null.
export const CLAUDE_USAGE = {
  five_hour: { utilization: 35, resets_at: "2026-10-23T16:40:00.316701+00:00" },
  seven_day: { utilization: 8, resets_at: "2026-10-30T08:00:00.316727+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null, currency: "USD" },
  limits: [
    { kind: "session", group: "session", percent: 35, resets_at: "2026-10-23T16:40:00.316701+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 8, resets_at: "2026-10-30T08:00:00.316727+00:00", scope: null, is_active: false },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      resets_at: "2026-10-30T08:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};
// When it was fetched.
export const CLAUDE_USAGE_AT = Date.parse("2026-10-23T14:07:27Z");
