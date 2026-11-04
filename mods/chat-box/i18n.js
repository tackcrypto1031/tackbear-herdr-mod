// The box's words. English unless the layout's block sets `props.lang`, as "zh-TW" does.

const STRINGS = {
  en: {
    placeholder: "Message… paste or drop images and files",
    hint: "Enter to send · Shift+Enter for a new line",
    sending: "Sending…",
    "status.working": "working",
    "status.blocked": "needs you",
    "status.done": "done",
    "status.idle": "idle",
    "no.target": "No terminal selected",
    "no.target.send": "No terminal to send to: click a terminal pane first.",
    "chip.model": "Model",
    "chip.effort": "Effort",
    "chip.switching": "Switching…",
    "switch.working": "The agent is working: wait for it to finish, then switch.",
    "switch.blocked": "The agent is waiting for you: answer it in the terminal first.",
    "switch.done": "Switched to {what}",
    "switch.failed": "Couldn't switch: {why}",
    "switch.session": "{what} (this session only)",
    "switch.default": "{what} (also Grok's new default)",
    "wait.for": "Timed out waiting for {what}",
    "wait.modelMenu": "the model menu",
    "wait.effortMenu": "the effort menu",
    "wait.marker": "the marker to move",
    "wait.result": "the result",
    "picker.gone": "the model menu went away",
    "picker.missing": "{what} isn't in the menu",
    "picker.noEffort": "this model has no {what}",
    "picker.noModel": "can't read the current model",
    "send.blocked": "The agent is waiting for you: answer it in the terminal first. Your draft is kept.",
    "send.failed": "Couldn't send, draft kept (it may have arrived: check the terminal first): {why}",
    "send.tooLong": "The full message was too long and is in the attached file: read it and follow it.",
    "paste.image": "Pasted image",
    "paste.reading": "Reading clipboard…",
    "paste.empty": "No image or file on the clipboard.",
    "paste.failed": "Couldn't read the clipboard: {why}",
  },
  "zh-TW": {
    placeholder: "輸入訊息…可貼上或拖曳圖片、檔案",
    hint: "Enter 送出 · Shift+Enter 換行",
    sending: "傳送中…",
    "status.working": "工作中",
    "status.blocked": "等你回應",
    "status.done": "已完成",
    "status.idle": "閒置",
    "no.target": "沒有選取終端機",
    "no.target.send": "沒有可傳送的終端機，請先點選一個終端機窗格。",
    "chip.model": "模型",
    "chip.effort": "推理",
    "chip.switching": "切換中…",
    "switch.working": "代理程式工作中，等它完成再切換。",
    "switch.blocked": "代理程式正在等你回應，請先到終端機處理。",
    "switch.done": "已切換為 {what}",
    "switch.failed": "切換失敗：{why}",
    "switch.session": "{what}（僅此對話）",
    "switch.default": "{what}（Grok 的預設值也會跟著改）",
    "wait.for": "等不到{what}",
    "wait.modelMenu": "模型選單",
    "wait.effortMenu": "推理選單",
    "wait.marker": "標記移到目標",
    "wait.result": "切換結果",
    "picker.gone": "模型選單不見了",
    "picker.missing": "選單裡找不到 {what}",
    "picker.noEffort": "這個模型沒有 {what}",
    "picker.noModel": "讀不到目前的模型",
    "send.blocked": "代理程式正在等你回應，請先到終端機處理，草稿已保留。",
    "send.failed": "傳送失敗，草稿已保留（可能已送達，請先確認終端機）：{why}",
    "send.tooLong": "完整訊息太長，內容在附加的檔案裡，請讀取並照著處理。",
    "paste.image": "貼上的圖片",
    "paste.reading": "讀取剪貼簿…",
    "paste.empty": "剪貼簿裡沒有圖片或檔案。",
    "paste.failed": "無法讀取剪貼簿：{why}",
  },
};

let active = STRINGS.en;

export function setLanguage(lang) {
  active = STRINGS[lang] ?? STRINGS.en;
}

export function t(key, values = {}) {
  return active[key].replace(/\{(\w+)\}/g, (_, name) => values[name]);
}

export const LANGUAGES = Object.keys(STRINGS);
export const keysOf = (lang) => Object.keys(STRINGS[lang]);
