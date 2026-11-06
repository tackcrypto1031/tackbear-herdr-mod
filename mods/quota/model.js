// What each subscription's login file and usage reply mean. No UI and no I/O, so tests can run it.
// To add a subscription: add an entry to PROVIDERS. `login` returns null when the file holds no
// subscription login, and `parse` returns no windows when the account has no quota to show.
// A pay-as-you-go API has no quota, only a balance: its entry names a `helper` script that asks
// for it (the key lives where the mod can't read it), and its windows carry `amount`, not `percent`.

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
    login(text) {
      const auth = parseJson(text)?.claudeAiOauth;
      if (!auth?.accessToken || !auth.subscriptionType) return null;
      const multiple = /_(\d+x)$/.exec(auth.rateLimitTier ?? "")?.[1];
      return {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
        plan: [planName(auth.subscriptionType), multiple].filter(Boolean).join(" "),
      };
    },
    parse(reply) {
      const part = (label, w) => w && windowOf(label, w.utilization, toMs(w.resets_at));
      return { windows: [part("5H", reply?.five_hour), part("週", reply?.seven_day)].filter(Boolean) };
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
];

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
    const usage = provider.parse(parseJson(outcome.body));
    if (!usage.windows.length) return null;
    return { state: "fresh", plan: login.plan ?? usage.plan ?? null, windows: usage.windows, at: now };
  }
  const state = outcome.status === 401 ? "expired" : "failed";
  return { plan: login.plan ?? previous?.plan ?? null, windows: previous?.windows ?? [], at: previous?.at ?? null, state };
}

/** A window past its reset no longer has a known number: it is back near zero until the next reply. */
export const isPastReset = (w, now) => w.resetsAt != null && w.resetsAt <= now;

export function formatReset(resetsAt, now) {
  if (resetsAt == null) return "";
  const minutes = Math.ceil((resetsAt - now) / 60000);
  if (minutes <= 0) return "已重置";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}時${minutes % 60}分` : `${hours}時`;
  return hours % 24 ? `${Math.floor(hours / 24)}天${hours % 24}時` : `${Math.floor(hours / 24)}天`;
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
