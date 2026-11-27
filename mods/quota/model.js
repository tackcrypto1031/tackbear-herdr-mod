// What each subscription's login file and usage reply mean. No UI and no I/O, so tests can run it.
// To add a subscription: add an entry to PROVIDERS. `login` returns null when the file holds no
// subscription login, and `parse` returns no windows when the account has no quota to show.
// `parse` also gets what `login` returned, for plans that change which windows count.
// A pay-as-you-go API has no quota, only a balance: its entry names a `helper` script that asks
// for it (the key lives where the mod can't read it), and its windows carry `amount`, not `percent`.
// A service whose own CLI keeps the login names that CLI as `command`, and `commandOutcome` turns
// what it printed into `{ status, body }`, so the mod never sees the token.

import { t } from "./i18n.js";

const WEEK = 604800;
const FIVE_HOURS = 18000;

/** Some services send nanoseconds, more than every JS engine's date parser accepts. */
const toMs = (iso) => {
  const ms = Date.parse(String(iso).replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : ms;
};

const windowOf = (label, percent, resetsAt) =>
  typeof percent === "number" ? { label, percent: Math.min(100, Math.max(0, Math.round(percent))), resetsAt } : null;

const labelOfSeconds = (seconds) => {
  if (seconds === WEEK) return "週";
  if (seconds === FIVE_HOURS) return "5H";
  if (seconds === 86400) return "日";
  if (seconds >= 2419200 && seconds <= 2678400) return "月";
  return `${Math.round(seconds / 3600)}H`;
};

const planName = (plan) => {
  if (plan === "prolite") return "Pro Lite";
  return plan ? plan[0].toUpperCase() + plan.slice(1) : null;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const PROVIDERS = [
  {
    key: "claude",
    name: "Claude",
    agent: "Claude Code",
    loginFile: ".claude/.credentials.json",
    // macOS keeps Claude Code's login in the Keychain, not the file.
    keychain: "Claude Code-credentials",
    // The usage reply is rate limited per account, and every machine signed in to it asks.
    everyMs: 15 * 60 * 1000,
    login(text) {
      const auth = parseJson(text)?.claudeAiOauth;
      if (!auth?.accessToken || !auth.subscriptionType) return null;
      const multiple = /_(\d+x)$/.exec(auth.rateLimitTier ?? "")?.[1];
      // Max 20x is now sold as Ultra, though the login file still says `max` / `default_claude_max_20x`.
      // Ultra has no 5-hour limit, only the weekly one, even though the usage reply still sends `five_hour`.
      const ultra = /ultra/i.test(`${auth.subscriptionType} ${auth.rateLimitTier ?? ""}`) || (auth.subscriptionType === "max" && multiple === "20x");
      return {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        plan: ultra ? "Ultra" : [planName(auth.subscriptionType), multiple].filter(Boolean).join(" "),
        noFiveHour: ultra,
      };
    },
    parse(reply, login) {
      const part = (label, w) => w && windowOf(label, w.utilization, toMs(w.resets_at));
      const fiveHour = login?.noFiveHour ? null : part("5H", reply?.five_hour);
      return { windows: [fiveHour, part("週", reply?.seven_day)].filter(Boolean) };
    },
  },
  {
    key: "codex",
    name: "Codex",
    agent: "Codex",
    loginFile: ".codex/auth.json",
    login(text) {
      const auth = parseJson(text);
      if (auth?.auth_mode !== "chatgpt" || !auth.tokens?.access_token) return null;
      const headers = { Authorization: `Bearer ${auth.tokens.access_token}` };
      if (auth.tokens.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
      return { url: "https://chatgpt.com/backend-api/wham/usage", headers };
    },
    parse(reply) {
      const part = (w) => w && windowOf(labelOfSeconds(w.limit_window_seconds), w.used_percent, w.reset_at * 1000);
      const limits = reply?.rate_limit;
      return { plan: planName(reply?.plan_type), windows: [part(limits?.primary_window), part(limits?.secondary_window)].filter(Boolean) };
    },
  },
  {
    key: "copilot",
    name: "Copilot",
    agent: "Copilot",
    // Asked through the gh CLI, which keeps the GitHub login, so the token never reaches the mod.
    command: ["gh", "api", "/copilot_internal/user"],
    reloginCommand: "gh auth login",
    commandOutcome(result) {
      if (result.code === 0) return { status: 200, body: result.stdout };
      // gh prints "HTTP 401" for a bad token and "gh auth login" when there's none.
      return /HTTP 40[13]|gh auth login/.test(result.stderr ?? "") ? { status: 401 } : { failed: true };
    },
    parse(reply) {
      // Premium requests are the only monthly limit; chat and completions are unlimited on paid plans.
      const premium = reply?.quota_snapshots?.premium_interactions;
      const plan = planName(reply?.copilot_plan);
      if (!premium || premium.unlimited || typeof premium.percent_remaining !== "number") return { plan, windows: [] };
      const resetsAt = toMs(reply.quota_reset_date_utc ?? reply.quota_reset_date);
      return { plan, windows: [windowOf("月", 100 - premium.percent_remaining, resetsAt)] };
    },
  },
  {
    key: "grok",
    name: "Grok",
    agent: "Grok",
    loginFile: ".grok/auth.json",
    login(text) {
      const auth = Object.values(parseJson(text) ?? {}).find((entry) => entry?.auth_mode === "oidc" && entry.key);
      if (!auth) return null;
      const headers = { Authorization: `Bearer ${auth.key}` };
      if (auth.user_id) headers["x-userid"] = auth.user_id;
      return { url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers };
    },
    parse(reply) {
      const config = reply?.config;
      const period = config?.currentPeriod?.type ?? "";
      const label = period.endsWith("WEEKLY") ? "週" : period.endsWith("MONTHLY") ? "月" : "期";
      const end = config?.currentPeriod?.end ?? config?.billingPeriodEnd;
      const part = windowOf(label, config?.creditUsagePercent, end ? toMs(end) : null);
      return { windows: part ? [part] : [] };
    },
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    agent: "opencode",
    // Shown when opencode is installed, since that's what uses the key here.
    program: "opencode",
    icon: { icon: "icons/dsh-tui.svg", tint: true },
    helper: "deepseek-balance.mjs",
    parse(reply) {
      const infos = (reply?.balance_infos ?? [])
        .map((info) => ({ currency: info.currency, amount: Number(info.total_balance) }))
        .filter((info) => info.currency && Number.isFinite(info.amount));
      // One row per currency holding money; an empty account still shows its first, at zero.
      const shown = infos.filter((info) => info.amount > 0);
      const low = reply?.is_available === false;
      return { windows: (shown.length ? shown : infos.slice(0, 1)).map((info) => ({ label: "餘額", ...info, low, resetsAt: null })) };
    },
  },
  {
    key: "antigravity",
    name: "Antigravity",
    agent: "Antigravity",
    // An app, not a terminal agent: the helper decides whether it's installed.
    standalone: true,
    icon: { icon: "icons/antigravity.svg", tint: false },
    helper: "antigravity-quota.mjs",
    // The only rows it makes; saved rows by other names (the old "Argon") are dropped.
    labels: ["Gemini", "Claude"],
    parse(reply) {
      return { plan: reply?.plan ?? null, windows: antigravityPools(reply?.models ?? []) };
    },
  },
];

const baseName = (label) => label.replace(/\s*\(.*?\)\s*/g, " ").trim();

/**
 * Antigravity has two quotas: one for every Gemini model, one that Claude and GPT models share.
 * Each becomes one row, Gemini first. Should the models of one quota ever disagree, the row
 * shows the one with the least left.
 */
export function antigravityPools(models) {
  const pools = new Map([["Gemini", null], ["Claude", null]]);
  for (const m of models) {
    if (typeof m.remainingFraction !== "number") continue;
    const name = /claude|gpt/i.test(m.label) ? "Claude" : "Gemini";
    const resetsAt = m.resetTime ? toMs(m.resetTime) : null;
    const pool = pools.get(name) ?? { labels: [], left: m.remainingFraction, resetsAt };
    if (m.remainingFraction < pool.left) Object.assign(pool, { left: m.remainingFraction, resetsAt });
    pool.labels.push(m.label);
    pools.set(name, pool);
  }
  return [...pools].map(([name, pool]) => {
    const window = pool && windowOf(name, (1 - pool.left) * 100, pool.resetsAt);
    return window && { ...window, detail: [...new Set(pool.labels.map(baseName))].join("、") };
  }).filter(Boolean);
}

const CURRENCY_SIGNS = { CNY: "¥", USD: "$" };

/** "¥10.68"; `short` drops the cents, for the narrow sidebar. */
export function formatMoney(amount, currency, short = false) {
  const number = short ? String(Math.floor(amount)) : amount.toFixed(2);
  const sign = CURRENCY_SIGNS[currency];
  return sign ? `${sign}${number}` : `${number} ${currency}`;
}

export const isBalance = (w) => typeof w.amount === "number";

/**
 * What to remember after asking a service, given `outcome`: `{ status, body }`, or `{ failed: true }`
 * when the request never finished. Null means this login has no quota, so it isn't shown.
 * An expired login or a failed request keeps the last numbers, marked as old.
 */
export function nextEntry(provider, previous, login, outcome, now) {
  if (outcome.status === 200) {
    const usage = provider.parse(parseJson(outcome.body), login);
    if (!usage.windows.length) return null;
    return { state: "fresh", plan: login.plan ?? usage.plan ?? null, windows: usage.windows, at: now };
  }
  const windows = (previous?.windows ?? []).filter((w) => !provider.labels || provider.labels.includes(w.label));
  const kept = { plan: login.plan ?? previous?.plan ?? null, windows, at: previous?.at ?? null };
  // An app that answers only while it runs: keep its last numbers, or show nothing if there are none.
  if (outcome.offline) return kept.windows.length ? { ...kept, state: "offline" } : null;
  // Asking again while limited only extends the limit (Claude's usage reply asks for about an hour),
  // and the mod's fetch can't read Retry-After, so wait a fixed while.
  if (outcome.status === 429) return { ...kept, state: "limited", retryAt: now + RATE_LIMIT_WAIT_MS };
  return { ...kept, state: outcome.status === 401 ? "expired" : "failed" };
}

export const RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;

/** How long a provider that suddenly can't be asked keeps its last numbers before it's dropped. */
export const MISS_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * When a provider gave no answer at all (its login couldn't be read, its CLI didn't start), a
 * one-off hiccup such as a locked Keychain shouldn't make the row vanish: the last numbers stay,
 * marked as old, until they are `MISS_GRACE_MS` old. Null drops the row, as for a signed-out account.
 */
export function missedEntry(previous, now) {
  if (!previous?.windows?.length || previous.at == null || now - previous.at > MISS_GRACE_MS) return null;
  return previous.state === "fresh" ? { ...previous, state: "failed" } : previous;
}

/** While a service has asked to be left alone, its last entry stands and it isn't asked. */
export const isWaiting = (entry, now) => entry?.state === "limited" && entry.retryAt > now;

/** A window past its reset no longer has a known number: it is back near zero until the next reply. */
export const isPastReset = (w, now) => w.resetsAt != null && w.resetsAt <= now;

export function formatReset(resetsAt, now) {
  if (resetsAt == null) return "";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  if (minutes <= 0) return t("resetDone");
  if (minutes < 60) return t("minutes", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? t("hoursMinutes", { h: hours, m: minutes % 60 }) : t("hours", { h: hours });
  const d = Math.floor(hours / 24);
  return hours % 24 ? t("daysHours", { d, h: hours % 24 }) : t("days", { d });
}

/** Local time of a reset, for the tooltip. */
export function formatDate(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "normal", "high" or "full": the theme color a bar uses. */
export const levelOf = (percent) => (percent >= 90 ? "full" : percent >= 70 ? "high" : "normal");

/** The most used window of a subscription, for the narrow sidebar's single number. */
export const busiestPercent = (entry, now) => {
  const known = entry.windows.filter((w) => !isBalance(w) && !isPastReset(w, now)).map((w) => w.percent);
  return known.length ? Math.max(...known) : null;
};
