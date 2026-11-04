// Run from the repo root: node --test "test/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeMessage, describeSendError, hcError, isImagePath, mergeDraftText, parseClipboard,
  quotePath, stampOf, textBeforeEnter,
} from "../mods/chat-box/logic.js";
import {
  agentOf, parseClaudeEffortPicker, parseClaudeModelPicker, parseClaudeState, parseCodexCatalog,
  parseCodexState, parseGrokState,
} from "../mods/chat-box/agents.js";
import { LANGUAGES, keysOf, setLanguage, t } from "../mods/chat-box/i18n.js";

test("every language has every string, and an unknown one falls back to English", () => {
  for (const lang of LANGUAGES) assert.deepEqual(keysOf(lang), keysOf("en"));
  setLanguage("zh-TW");
  assert.equal(t("switch.done", { what: "Opus 5.5" }), "已切換為 Opus 5.5");
  setLanguage("nope");
  assert.equal(t("switch.done", { what: "Opus 5.5" }), "Switched to Opus 5.5");
  setLanguage(undefined);
});

test("paths are quoted the way a Herdr terminal drop quotes them on Windows", () => {
  assert.equal(quotePath("plain/path.png"), "plain/path.png");
  assert.equal(quotePath("C:\\a b\\圖.png"), "'C:\\a b\\圖.png'");
  assert.equal(quotePath("C:\\it's.png"), "'C:\\it''s.png'");
});

test("a message puts its words first and its paths on a line of their own", () => {
  assert.equal(composeMessage(" 看這張 ", ["C:\\x.png"]), "看這張\n\n'C:\\x.png'");
  assert.equal(composeMessage("", ["C:\\x.png", "D:\\y.txt"]), "'C:\\x.png' 'D:\\y.txt'");
  assert.equal(composeMessage("只有文字\n第二行", []), "只有文字\n第二行");
});

test("the text before Enter holds whether or not the newline reported a change first", () => {
  assert.equal(textBeforeEnter("hi\n", "hi\n", "hi"), "hi");
  assert.equal(textBeforeEnter("hi\n", "hi", "h"), "hi");
  assert.equal(textBeforeEnter("a\nb", "a\nb", "ab"), "ab");
});

test("image files are told apart from other files by extension", () => {
  assert.equal(isImagePath("C:\\a\\B.PNG"), true);
  assert.equal(isImagePath("C:\\a.b\\report.pdf"), false);
  assert.equal(isImagePath("C:\\a.png\\noextension"), false);
});

test("core failures are read from either stream, and success is no failure", () => {
  const body = JSON.stringify({ error: { kind: "blocked", message: "it is waiting" } });
  assert.deepEqual(hcError({ code: 1, stdout: body, stderr: "" }), { kind: "blocked", message: "it is waiting" });
  assert.deepEqual(hcError({ code: 1, stdout: "", stderr: body }), { kind: "blocked", message: "it is waiting" });
  assert.equal(hcError({ code: 0, stdout: '{"started":true}', stderr: "" }), null);
  assert.equal(hcError({ code: 2, stdout: "", stderr: "boom\n" }).message, "boom");
});

test("a blocked agent gets its own explanation, other failures warn it may have arrived", () => {
  assert.match(describeSendError({ kind: "blocked", message: "x" }), /waiting for you/);
  assert.match(describeSendError({ kind: "", message: "timeout" }), /may have arrived.*timeout/);
});

test("clipboard output keeps paths whole and ignores anything else", () => {
  const out = "file\tC:\\a b\\圖.png\r\nimage\tC:\\c.png\r\nnoise\nother\tx\n";
  assert.deepEqual(parseClipboard(out), [
    { kind: "file", path: "C:\\a b\\圖.png" },
    { kind: "image", path: "C:\\c.png" },
  ]);
});

test("a failed draft comes back ahead of what was typed since", () => {
  assert.equal(mergeDraftText("failed", ""), "failed");
  assert.equal(mergeDraftText("failed", "new"), "failed\nnew");
  assert.equal(mergeDraftText("", "new"), "new");
});

test("agents' state reads off their screens", () => {
  assert.deepEqual(parseClaudeState("▝▜██████▀  Sonnet 5.5 with low effort · Claude Max\n"), { model: "Sonnet 5.5", effort: "low" });
  assert.deepEqual(parseClaudeState("  Haiku 5.5 · Claude Max\n  ⎿  Set effort level to high (this session only): x\n"), { model: "Haiku 5.5", effort: "high" });
  assert.deepEqual(parseCodexState("› Ask\n  GPT-6.1 Terra high · Context 100% left · 0 in\n"), { model: "GPT-6.1 Terra", effort: "high" });
  assert.deepEqual(parseGrokState("──── Grok 4.7 (high) · always-approve ─"), { model: "Grok 4.7", effort: "high" });
  assert.deepEqual(parseClaudeState("nothing here"), { model: null, effort: null });
});

test("Claude's pickers are read as shown", () => {
  const models = [
    "   Select model",
    "     1.  Default (recommended)  Opus 5.5 · Best",
    "     4.  Sonnet 5.5             Most efficient",
    "   ❯ 5.  Haiku 5.5 ✔            Fastest",
    "   ↓ 10. Opus 4.8               Best",
  ].join("\n");
  assert.deepEqual(parseClaudeModelPicker(models), { rows: ["Default (recommended)", "Sonnet 5.5", "Haiku 5.5", "Opus 4.8"], cursor: 2 });
  const effort = [
    "   Effort",
    "        Faster                             Smarter",
    "        ─────────────▲──────",
    "        low     medium     high     xhigh      max",
  ].join("\n");
  assert.deepEqual(parseClaudeEffortPicker(effort), { levels: ["low", "medium", "high", "xhigh", "max"], current: 1 });
  assert.equal(parseClaudeEffortPicker("no scale"), null);
});

/** An agent's terminal that answers what a script expects, recording what it was told. */
function fakeIo(answers) {
  const told = [];
  let screen = "";
  const step = (input) => { told.push(input); screen = answers[input] ?? screen; };
  return { told, send: async (t) => step(t), keys: async (k) => step(k), read: async () => screen, sleep: async () => {} };
}

test("Claude switches for this session only and never presses Enter", async () => {
  const claude = agentOf({ program: { key: "claude" } });
  const picker = "Select model\n 4.  Sonnet 5.5   Most\n ❯ 5.  Haiku 5.5 ✔   Fast";
  const moved = "Select model\n ❯ 4.  Sonnet 5.5   Most\n 5.  Haiku 5.5 ✔   Fast";
  const io = fakeIo({ "/model": picker, up: moved, s: "⎿  Set model to Sonnet 5.5 for this session only" });
  assert.match(await claude.setModel(io, { id: "Sonnet 5.5", name: "Sonnet 5.5" }), /this session only/);
  assert.deepEqual(io.told, ["/model", "up", "s"]);
});

test("a model the picker doesn't offer leaves it with Esc and changes nothing", async () => {
  const claude = agentOf({ program: { key: "claude" } });
  const io = fakeIo({ "/model": "Select model\n ❯ 5.  Haiku 5.5 ✔   Fast" });
  await assert.rejects(claude.setModel(io, { id: "Opus 5.5", name: "Opus 5.5" }), /isn't in the menu/);
  assert.deepEqual(io.told, ["/model", "up", "up", "down", "down", "esc"]);
});

/** Claude Code's picker in a short pane: two rows at a time, stopping at both ends. */
function scrollingPicker(names, start) {
  const told = [];
  let at = start;
  let result = null;
  const row = (i) => `${i === at ? "❯" : " "} ${i + 1}.  ${names[i]}   Words`;
  return {
    told,
    send: async (t) => { told.push(t); },
    keys: async (k) => {
      told.push(k);
      if (k === "up") at = Math.max(at - 1, 1);
      if (k === "down") at = Math.min(at + 1, names.length - 1);
      if (k === "s") result = `⎿  Set model to ${names[at]} for this session only`;
      if (k === "esc") result = "⎿  Kept model";
    },
    read: async () => result ?? ["1. a numbered list the agent printed", "Select model", row(Math.max(at - 1, 0)), row(at)].join("\n"),
    sleep: async () => {},
  };
}

const PICKER_NAMES = ["Default (recommended)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5", "Haiku 4.5", "Opus 4.8"];

test("Claude finds a model that a short pane hasn't scrolled to yet", async () => {
  const claude = agentOf({ program: { key: "claude" } });
  const io = scrollingPicker(PICKER_NAMES, 4);
  await claude.setModel(io, { id: "Opus 5.5", name: "Opus 5.5" });
  assert.deepEqual(io.told, ["/model", "up", "up", "up", "s"]);
});

test("Claude turns back at the end of the list to find a model further down", async () => {
  const claude = agentOf({ program: { key: "claude" } });
  const io = scrollingPicker(PICKER_NAMES, 2);
  await claude.setModel(io, { id: "Opus 4.8", name: "Opus 4.8" });
  assert.equal(io.told.at(-1), "s");
  assert.ok(!io.told.includes("esc"));
  assert.equal(io.told.filter((k) => k === "down").length, 5); // From the top row it stopped at, row 2, to row 7.
});

test("Claude heads straight for a known model further down, without a detour", async () => {
  const claude = agentOf({ program: { key: "claude" } });
  const io = scrollingPicker(PICKER_NAMES, 1);
  await claude.setModel(io, { id: "Haiku 5.5", name: "Haiku 5.5" });
  assert.deepEqual(io.told, ["/model", "down", "down", "down", "s"]);
});

test("a numbered list above the picker isn't taken for its rows", () => {
  const { rows } = parseClaudeModelPicker("1. a numbered list\nSelect model\n ❯ 5.  Haiku 5.5 ✔   Fast");
  assert.deepEqual(rows, ["Haiku 5.5"]);
});

test("Codex always names a level, since leaving it out resets to the lowest", async () => {
  const codex = agentOf({ program: { key: "codex" } });
  const model = { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "high"] };
  const io = fakeIo({ "/model gpt-6-luna --reasoning=high": "• Model changed to gpt-6-luna high for this session only" });
  await codex.setModel(io, model, { effort: "high" });
  assert.deepEqual(io.told, ["/model gpt-6-luna --reasoning=high"]);
});

test("the Codex catalog lists what its picker lists, and bad data lists nothing", () => {
  const text = JSON.stringify({ models: [
    { slug: "a", display_name: "A", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "b", display_name: "B", visibility: "hide" },
  ] });
  assert.deepEqual(parseCodexCatalog(text), [{ id: "a", name: "A", efforts: ["low"] }]);
  assert.deepEqual(parseCodexCatalog("not json"), []);
});

test("only known agents get model controls", () => {
  assert.equal(agentOf({ program: { key: "shell" } }), null);
  assert.equal(agentOf(undefined), null);
});

test("only files this mod named can be pruned", () => {
  assert.equal(stampOf("paste-1793778443350-0.png"), 1793778443350);
  assert.equal(stampOf("preview-5-1.jpg"), 5);
  assert.equal(stampOf("message-7.md"), 7);
  assert.equal(stampOf("keep-me.png"), null);
});
