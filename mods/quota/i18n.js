// The section's words. Traditional Chinese unless the layout's block sets `props.lang` to "en".
// Window labels ("5H", "週", ...) are saved with the numbers, so they stay as they are and are only
// translated when shown.

const STRINGS = {
  "zh-TW": {
    title: "訂閱額度",
    titleHint: "已用 %",
    fold: "收合訂閱額度",
    unfold: "展開訂閱額度",
    refresh: "重新整理",
    loading: "讀取中…",
    none: "沒有偵測到已登入的訂閱",
    balance: "餘額",
    unknown: "未知",
    usedTip: "{title} · {label}額度已用 {percent}",
    resetTip: "重置時間 {date}",
    modelsTip: "模型：{models}",
    balanceTip: "{name} · 餘額 {money}",
    lowBalance: "餘額不足，API 目前無法使用",
    dataAt: "資料時間 {date}，",
    limited: "{when}查詢太頻繁被限流，{date} 後再查",
    offline: "{when}{agent} 沒有在執行，開啟後會更新",
    failed: "{when}暫時查不到額度",
    badKey: "{when}API 金鑰無效，請在 {agent} 重新設定",
    expired: "{when}登入憑證已過期，{relogin} 後會更新",
    open: "開啟 {agent}",
    run: "執行 {command}",
    rowLimited: "限流中，{time} 後再查",
    rowFailed: "暫時查不到額度",
    rowBadKey: "API 金鑰無效",
    rowExpired: "{relogin} 後更新",
    resetDone: "已重置",
    minutes: "{m}分",
    hours: "{h}時",
    hoursMinutes: "{h}時{m}分",
    days: "{d}天",
    daysHours: "{d}天{h}時",
    labels: {},
  },
  en: {
    title: "Quota",
    titleHint: "% used",
    fold: "Hide quota",
    unfold: "Show quota",
    refresh: "Refresh",
    loading: "Loading…",
    none: "No signed-in subscription found",
    balance: "Balance",
    unknown: "unknown",
    usedTip: "{title} · {label} used {percent}",
    resetTip: "Resets {date}",
    modelsTip: "Models: {models}",
    balanceTip: "{name} · balance {money}",
    lowBalance: "Balance too low, the API can't be used",
    dataAt: "As of {date}. ",
    limited: "{when}Asked too often, rate limited until {date}",
    offline: "{when}{agent} isn't running; it updates once it opens",
    failed: "{when}Couldn't get the quota right now",
    badKey: "{when}The API key is invalid; set it again in {agent}",
    expired: "{when}The login has expired; it updates after you {relogin}",
    open: "open {agent}",
    run: "run {command}",
    rowLimited: "Rate limited until {time}",
    rowFailed: "Quota unavailable",
    rowBadKey: "Invalid API key",
    rowExpired: "Updates after you {relogin}",
    resetDone: "reset",
    minutes: "{m}m",
    hours: "{h}h",
    hoursMinutes: "{h}h{m}m",
    days: "{d}d",
    daysHours: "{d}d{h}h",
    labels: { 週: "Wk", 月: "Mo", 日: "Day", 期: "Cycle", 餘額: "Bal" },
  },
};

let active = STRINGS["zh-TW"];
let activeLang = "zh-TW";

export function setLanguage(lang) {
  activeLang = STRINGS[lang] ? lang : "zh-TW";
  active = STRINGS[activeLang];
}

export const language = () => activeLang;

export function t(key, values = {}) {
  return active[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

/** A saved window label as shown in the current language. */
export const labelText = (label) => active.labels[label] ?? label;

export const LANGUAGES = Object.keys(STRINGS);
export const keysOf = (lang) => Object.keys(STRINGS[lang]);
