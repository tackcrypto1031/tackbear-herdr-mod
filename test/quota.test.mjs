// Run: node --test "test/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS, RATE_LIMIT_WAIT_MS, antigravityPools, busiestPercent, formatMoney, formatReset, isPastReset, isWaiting, levelOf, nextEntry } from "../mods/quota/model.js";

const provider = (key) => PROVIDERS.find((p) => p.key === key);
const NOW = Date.parse("2026-11-04T14:00:00Z");

const claudeLogin = JSON.stringify({
  claudeAiOauth: { accessToken: "SECRET", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
});
const codexLogin = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "SECRET", account_id: "acc" } });
const grokLogin = JSON.stringify({ "https://auth.x.ai::id": { key: "SECRET", auth_mode: "oidc", user_id: "u" } });

test("Claude shows both its 5-hour and weekly windows", () => {
  const { windows } = provider("claude").parse({
    five_hour: { utilization: 6, resets_at: "2026-11-04T15:59:59.792264+00:00" },
    seven_day: { utilization: 11, resets_at: "2026-11-10T11:59:59.792285+00:00" },
    seven_day_opus: null,
  });
  assert.deepEqual(windows.map((w) => [w.label, w.percent]), [["5H", 6], ["週", 11]]);
  assert.equal(windows[0].resetsAt, Date.parse("2026-11-04T15:59:59.792Z"));
});

test("Claude Ultra has no 5-hour limit, so only the weekly window shows", () => {
  const p = provider("claude");
  const login = p.login(JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: "ultra", rateLimitTier: "default_claude_ultra" } }));
  assert.equal(login.plan, "Ultra");
  const reply = { five_hour: { utilization: 6, resets_at: "2026-11-04T15:00:00Z" }, seven_day: { utilization: 11, resets_at: "2026-11-10T12:00:00Z" } };
  const entry = nextEntry(p, null, login, { status: 200, body: JSON.stringify(reply) }, NOW);
  assert.deepEqual(entry.windows.map((w) => w.label), ["週"]);
  assert.deepEqual(p.parse(reply, p.login(claudeLogin)).windows.map((w) => w.label), ["5H", "週"]);
});

test("Max 20x is now Ultra: named Ultra, and no 5-hour window", () => {
  const p = provider("claude");
  const login = p.login(JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
  assert.equal(login.plan, "Ultra");
  const reply = { five_hour: { utilization: 2, resets_at: "2026-11-07T19:20:00Z" }, seven_day: { utilization: 0, resets_at: "2026-11-10T12:00:00Z" } };
  assert.deepEqual(p.parse(reply, login).windows.map((w) => w.label), ["週"]);
});

test("Codex shows only the windows the service reports", () => {
  const usage = provider("codex").parse({
    plan_type: "prolite",
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1794378965 }, secondary_window: null },
  });
  assert.equal(usage.plan, "Pro Lite");
  assert.deepEqual(usage.windows, [{ label: "週", percent: 7, resetsAt: 1794378965000 }]);
  const both = provider("codex").parse({
    rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 1 }, secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 2 } },
  });
  assert.deepEqual(both.windows.map((w) => w.label), ["5H", "週"]);
});

test("Grok names its window from the billing period", () => {
  const reply = (type) => ({ config: { creditUsagePercent: 2, currentPeriod: { type, end: "2026-11-05T12:34:04.496121+00:00" } } });
  assert.deepEqual(provider("grok").parse(reply("USAGE_PERIOD_TYPE_WEEKLY")).windows.map((w) => [w.label, w.percent]), [["週", 2]]);
  assert.equal(provider("grok").parse(reply("USAGE_PERIOD_TYPE_MONTHLY")).windows[0].label, "月");
  assert.deepEqual(provider("grok").parse({ config: {} }).windows, []);
});

test("a login file only counts when it holds a subscription login", () => {
  assert.equal(provider("claude").login(claudeLogin).plan, "Max 5x");
  assert.equal(provider("claude").login(JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: null } })), null);
  assert.equal(provider("claude").login("not json"), null);
  assert.ok(provider("codex").login(codexLogin));
  assert.equal(provider("codex").login(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "k" })), null);
  assert.ok(provider("grok").login(grokLogin));
  assert.equal(provider("grok").login(JSON.stringify({ a: { key: "k", auth_mode: "api_key" } })), null);
  assert.equal(provider("grok").login("{}"), null);
});

test("each login goes only to its own service", () => {
  const host = (key, text) => new URL(provider(key).login(text).url).host;
  assert.equal(host("claude", claudeLogin), "api.anthropic.com");
  assert.equal(host("codex", codexLogin), "chatgpt.com");
  assert.equal(host("grok", grokLogin), "cli-chat-proxy.grok.com");
});

test("what is remembered never holds the token", () => {
  const p = provider("claude");
  const login = p.login(claudeLogin);
  const fresh = nextEntry(p, null, login, { status: 200, body: JSON.stringify({ five_hour: { utilization: 1, resets_at: "2026-11-04T15:00:00Z" } }) }, NOW);
  const expired = nextEntry(p, fresh, login, { status: 401 }, NOW);
  assert.ok(!JSON.stringify([fresh, expired]).includes("SECRET"));
});

test("an account without quota isn't listed", () => {
  const p = provider("grok");
  assert.equal(nextEntry(p, null, p.login(grokLogin), { status: 200, body: "{}" }, NOW), null);
  assert.equal(nextEntry(p, null, p.login(grokLogin), { status: 200, body: "<html>" }, NOW), null);
});

test("an expired login or failed request keeps the last numbers, marked as old", () => {
  const p = provider("codex");
  const login = p.login(codexLogin);
  const previous = { state: "fresh", plan: "Pro Lite", windows: [{ label: "週", percent: 7, resetsAt: NOW + 1000 }], at: NOW - 5000 };
  const expired = nextEntry(p, previous, login, { status: 401 }, NOW);
  assert.equal(expired.state, "expired");
  assert.equal(expired.at, previous.at);
  assert.deepEqual(expired.windows, previous.windows);
  const limited = nextEntry(p, previous, login, { status: 429 }, NOW);
  assert.equal(limited.state, "limited");
  assert.deepEqual(limited.windows, previous.windows);
  assert.equal(isWaiting(limited, NOW + RATE_LIMIT_WAIT_MS - 1), true);
  assert.equal(isWaiting(limited, NOW + RATE_LIMIT_WAIT_MS), false);
  assert.equal(nextEntry(p, previous, login, { failed: true }, NOW).state, "failed");
  assert.deepEqual(nextEntry(p, null, login, { status: 401 }, NOW).windows, []);
});

const deepseekReply = (cny, usd = "0.00", available = true) => JSON.stringify({
  is_available: available,
  balance_infos: [
    { currency: "CNY", total_balance: cny, granted_balance: "0.00", topped_up_balance: cny },
    { currency: "USD", total_balance: usd, granted_balance: "0.00", topped_up_balance: usd },
  ],
});

test("DeepSeek shows what's left in each currency holding money", () => {
  const p = provider("deepseek");
  const entry = nextEntry(p, null, {}, { status: 200, body: deepseekReply("10.68") }, NOW);
  assert.deepEqual(entry.windows.map((w) => [w.currency, w.amount, w.low]), [["CNY", 10.68, false]]);
  assert.deepEqual(p.parse(JSON.parse(deepseekReply("1.00", "2.50"))).windows.map((w) => w.currency), ["CNY", "USD"]);
  // An empty account still shows, at zero, and is marked when the API stops serving it.
  const empty = p.parse(JSON.parse(deepseekReply("0.00", "0.00", false))).windows;
  assert.deepEqual(empty.map((w) => [w.currency, w.amount, w.low]), [["CNY", 0, true]]);
  assert.equal(nextEntry(p, null, {}, { status: 200, body: "{}" }, NOW), null);
});

test("a balance reads as money and doesn't count as a used percent", () => {
  assert.equal(formatMoney(10.68, "CNY"), "¥10.68");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(10.68, "CNY", true), "¥10");
  assert.equal(formatMoney(3, "EUR"), "3.00 EUR");
  const entry = nextEntry(provider("deepseek"), null, {}, { status: 200, body: deepseekReply("10.68") }, NOW);
  assert.equal(busiestPercent(entry, NOW), null);
  assert.equal(isPastReset(entry.windows[0], NOW), false);
});

test("time to reset reads in the largest useful units", () => {
  const min = 60000;
  assert.equal(formatReset(null, NOW), "");
  assert.equal(formatReset(NOW - 1, NOW), "已重置");
  assert.equal(formatReset(NOW + 12 * min, NOW), "12分");
  assert.equal(formatReset(NOW + 120 * min, NOW), "2時");
  assert.equal(formatReset(NOW + 92 * min, NOW), "1時32分");
  assert.equal(formatReset(NOW + 48 * 60 * min, NOW), "2天");
  assert.equal(formatReset(NOW + (5 * 24 + 22) * 60 * min, NOW), "5天22時");
});

test("bars change color near the limit", () => {
  assert.deepEqual([0, 69, 70, 89, 90, 100].map(levelOf), ["normal", "normal", "high", "high", "full", "full"]);
});

test("a window past its reset has no known number", () => {
  const entry = { windows: [{ percent: 95, resetsAt: NOW - 1 }, { percent: 11, resetsAt: NOW + 1 }] };
  assert.equal(isPastReset(entry.windows[0], NOW), true);
  assert.equal(busiestPercent(entry, NOW), 11);
  assert.equal(busiestPercent({ windows: [entry.windows[0]] }, NOW), null);
});

const agModels = [
  { label: "Gemini 4 Neon (High)", remainingFraction: 0.97, resetTime: "2026-11-04T18:00:00Z" },
  { label: "Gemini 3.8 Flash (Low)", remainingFraction: 0.97, resetTime: "2026-11-04T18:00:00Z" },
  { label: "Orchestrator (Neon)", remainingFraction: 0.97, resetTime: "2026-11-04T18:00:00Z" },
  { label: "Gemini 4 Argon (High)", remainingFraction: 0.97, resetTime: "2026-11-04T18:00:00Z" },
  { label: "Orchestrator (Argon)", remainingFraction: 0.97, resetTime: "2026-11-04T18:00:00Z" },
  { label: "Claude Opus 5.5 (High)", remainingFraction: 0.4, resetTime: "2026-11-04T18:07:00Z" },
  { label: "GPT-OSS 120B (Medium)", remainingFraction: 0.4, resetTime: "2026-11-04T18:07:00Z" },
];

test("Antigravity shows a Gemini row and a shared Claude + GPT row, as used percent", () => {
  const windows = antigravityPools(agModels);
  assert.deepEqual(windows.map((w) => [w.label, w.percent]), [["Gemini", 3], ["Claude", 60]]);
  assert.equal(windows[0].resetsAt, Date.parse("2026-11-04T18:00:00Z"));
  assert.equal(windows[1].detail, "Claude Opus 5.5、GPT-OSS 120B");
  // Models of one quota that disagree show the one with the least left.
  const mixed = antigravityPools([...agModels.slice(0, 2), { ...agModels[2], remainingFraction: 0.5, resetTime: "2026-11-05T00:00:00Z" }]);
  assert.deepEqual(mixed.map((w) => [w.label, w.percent, w.resetsAt]), [["Gemini", 50, Date.parse("2026-11-05T00:00:00Z")]]);
  // The helper sends a used-up pool with fraction 0.
  assert.equal(antigravityPools([{ label: "Gemini 4 Neon (High)", remainingFraction: 0, resetTime: "2026-11-04T18:00:00Z" }])[0].percent, 100);
});

test("Antigravity keeps its last numbers while the app is closed", () => {
  const p = provider("antigravity");
  const fresh = nextEntry(p, null, {}, { status: 200, body: JSON.stringify({ plan: "Google AI Pro", models: agModels }) }, NOW);
  assert.equal(fresh.plan, "Google AI Pro");
  assert.equal(fresh.windows.length, 2);
  const offline = nextEntry(p, fresh, {}, { offline: true }, NOW + 1000);
  assert.equal(offline.state, "offline");
  assert.deepEqual(offline.windows, fresh.windows);
  // Rows saved under the old grouping go away.
  const old = { ...fresh, windows: [...fresh.windows, { ...fresh.windows[0], label: "Argon" }] };
  assert.deepEqual(nextEntry(p, old, {}, { offline: true }, NOW).windows.map((w) => w.label), ["Gemini", "Claude"]);
  assert.equal(nextEntry(p, null, {}, { offline: true }, NOW), null);
  assert.equal(nextEntry(p, null, {}, { status: 200, body: JSON.stringify({ models: [] }) }, NOW), null);
});
