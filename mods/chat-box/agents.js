// How each coding agent shows and changes its model and reasoning effort. There's no API
// for this, so it reads the agent's screen and drives its own commands. Pure apart from
// the `io` handed in: tested by test/chat-box.test.mjs.
//
// Claude Code's `/model sonnet` and `/effort low` also save a new default for every later
// session, so it goes through the pickers and presses `s` (this session only). Enter there
// is what saves the default: this file never presses it.
import { t } from "./i18n.js";

const WAIT_MS = 4000;
const POLL_MS = 150;
const MAX_PICKER_STEPS = 40;
const STUCK_CHECKS = 6;
/** A picker just drawn can miss the first key pressed in it. */
const SETTLE_MS = 400;

function lastMatch(screen, pattern) {
  return [...screen.matchAll(pattern)].pop() ?? null;
}

/** The tail of a screen: earlier switches further up can't answer for this one. */
function tail(screen, lines = 12) {
  return screen.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");
}

async function waitFor(io, check, what) {
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    const screen = await io.read();
    if (check(screen)) return screen;
    await io.sleep(POLL_MS);
  }
  throw new Error(t("wait.for", { what }));
}

async function press(io, key, times) {
  for (let i = 0; i < times; i++) await io.keys(key);
}

/** Leaves a picker without changing anything, then reports what went wrong. */
async function abandon(io, error) {
  await io.keys("esc");
  throw error;
}

export function parseClaudeState(screen) {
  const banner = lastMatch(screen, /([A-Z][a-z]+ \d[\d.]*)(?: with (\w+) effort)? · /g);
  const model = lastMatch(screen, /Set model to `?([A-Z][a-z]+ \d[\d.]*)/g);
  const effort = lastMatch(screen, /Set effort level to (\w+)/g) ?? lastMatch(screen, /[◐○●◑] (\w+) · \/effort/g);
  return { model: model?.[1] ?? banner?.[1] ?? null, effort: effort?.[1] ?? banner?.[2] ?? null };
}

/**
 * The rows Claude Code's model picker shows, and which one the cursor is on. A short pane
 * shows as few as two of them, scrolling as the cursor moves. A numbered list the
 * conversation printed above the picker doesn't count.
 */
export function parseClaudeModelPicker(screen) {
  const rows = [];
  let cursor = -1;
  const lines = screen.split(/\r?\n/);
  const title = lines.findLastIndex((line) => line.includes("Select model"));
  for (const line of lines.slice(title + 1)) {
    const row = /^\s*(❯|↓|↑)?\s*(\d+)\.\s+(.+?)(?:\s+✔)?(?:\s{2,}.*)?$/.exec(line);
    if (!row) continue;
    if (row[1] === "❯") cursor = rows.length;
    rows.push(row[3].trim());
  }
  return { rows, cursor };
}

/** The levels on Claude Code's effort scale, and the one its marker points at. */
export function parseClaudeEffortPicker(screen) {
  const lines = screen.split(/\r?\n/);
  const scale = lines.findIndex((line) => /\blow\b.*\bhigh\b/.test(line));
  const marker = lines.slice(0, Math.max(scale, 0)).reverse().find((line) => line.includes("▲"));
  if (scale < 0 || !marker) return null;
  const levels = [...lines[scale].matchAll(/\b(low|medium|high|xhigh|max)\b/g)]
    .map((match) => ({ name: match[1], middle: match.index + match[1].length / 2 }));
  const at = marker.indexOf("▲");
  let current = 0;
  levels.forEach((level, index) => {
    if (Math.abs(level.middle - at) < Math.abs(levels[current].middle - at)) current = index;
  });
  return { levels: levels.map((level) => level.name), current };
}

const CLAUDE_MODELS = ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"];

/** Which way a model is, while it isn't on screen: the picker lists them in this order. */
function directionTo(id, from) {
  const target = CLAUDE_MODELS.indexOf(id);
  const current = CLAUDE_MODELS.indexOf(from);
  return target >= 0 && current >= 0 && target > current ? "down" : "up";
}

/**
 * Walks the cursor onto a model, one row at a time, turning back when it stops at an
 * end of the list. A key can get lost, so it takes two tries to call that an end.
 */
async function walkToModel(io, id) {
  const picker = async () => parseClaudeModelPicker(tail(await io.read(), 24));
  let direction = null;
  let stuck = 0;
  for (let step = 0; step < MAX_PICKER_STEPS; step++) {
    const { rows, cursor } = await picker();
    if (cursor < 0) await abandon(io, new Error(t("picker.gone")));
    if (rows[cursor] === id) return;
    const seen = rows.indexOf(id);
    if (seen >= 0) direction = seen > cursor ? "down" : "up";
    direction ??= directionTo(id, rows[cursor]);
    await io.keys(direction);
    let moved = false;
    for (let check = 0; check < STUCK_CHECKS && !moved; check++) {
      await io.sleep(POLL_MS);
      const now = await picker();
      moved = now.rows[now.cursor] !== rows[cursor];
    }
    stuck = moved ? 0 : stuck + 1;
    if (stuck === 4) break;
    if (stuck === 2) direction = direction === "up" ? "down" : "up";
  }
  await abandon(io, new Error(t("picker.missing", { what: id })));
}

const claude = {
  models: () => CLAUDE_MODELS.map((name) => ({ id: name, name })),
  efforts: () => ["low", "medium", "high", "xhigh", "max"],
  parse: parseClaudeState,
  async setModel(io, model) {
    await io.send("/model");
    await waitFor(io, (s) => tail(s, 24).includes("Select model"), t("wait.modelMenu"));
    await io.sleep(SETTLE_MS);
    await walkToModel(io, model.id);
    await io.keys("s");
    // A conversation cached for the old model first asks "Switch model?", with
    // "1. Yes, switch to <model>" and "2. No, go back". 1 picks yes; it doesn't save a default.
    const asking = (s) => tail(s).includes(`Yes, switch to ${model.id}`);
    const screen = await waitFor(io, (s) => asking(s) || tail(s).includes(`Set model to ${model.id}`), t("wait.result"))
      .catch((error) => abandon(io, error));
    if (asking(screen)) {
      await io.keys("1");
      await waitFor(io, (s) => tail(s).includes(`Set model to ${model.id}`), t("wait.result"))
        .catch((error) => abandon(io, error));
    }
    return t("switch.session", { what: model.name });
  },
  async setEffort(io, effort) {
    await io.send("/effort");
    const screen = await waitFor(io, (s) => parseClaudeEffortPicker(tail(s, 24)) !== null, t("wait.effortMenu"));
    await io.sleep(SETTLE_MS);
    const { levels, current } = parseClaudeEffortPicker(tail(screen, 24));
    const target = levels.indexOf(effort);
    if (target < 0) await abandon(io, new Error(t("picker.noEffort", { what: effort })));
    await press(io, target > current ? "right" : "left", Math.abs(target - current));
    await waitFor(io, (s) => parseClaudeEffortPicker(tail(s, 24))?.current === target, t("wait.marker"))
      .catch((error) => abandon(io, error));
    await io.keys("s");
    await waitFor(io, (s) => tail(s).includes(`Set effort level to ${effort}`), t("wait.result"));
    return t("switch.session", { what: effort });
  },
};

export function parseCodexState(screen) {
  const footer = lastMatch(screen, /^\s*(.+?) (low|medium|high|xhigh|max|ultra) · Context/gm);
  return { model: footer?.[1] ?? null, effort: footer?.[2] ?? null };
}

/** Codex's model list from its cache, limited to what its picker offers. */
export function parseCodexCatalog(text) {
  try {
    return JSON.parse(text).models
      .filter((model) => model.visibility === "list")
      .map((model) => ({
        id: model.slug,
        name: model.display_name,
        efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
      }));
  } catch {
    return [];
  }
}

const CODEX_FALLBACK = [{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra", efforts: ["low", "medium", "high", "xhigh"] }];

const codex = {
  models: (catalog) => (catalog.codex?.length ? catalog.codex : CODEX_FALLBACK),
  efforts(catalog, state) {
    const models = this.models(catalog);
    return (models.find((model) => model.name === state.model) ?? models[0]).efforts;
  },
  parse: parseCodexState,
  /** `/model` without a level falls back to the model's lowest, so it always names one. */
  async change(io, slug, effort) {
    await io.send(`/model ${slug} --reasoning=${effort}`);
    await waitFor(io, (s) => tail(s).includes(`Model changed to ${slug} ${effort}`), t("wait.result"));
  },
  async setModel(io, model, state) {
    const effort = model.efforts.includes(state.effort) ? state.effort : "medium";
    await this.change(io, model.id, effort);
    return t("switch.session", { what: model.name });
  },
  async setEffort(io, effort, state, catalog) {
    const model = this.models(catalog).find((candidate) => candidate.name === state.model);
    if (!model) throw new Error(t("picker.noModel"));
    await this.change(io, model.id, effort);
    return t("switch.session", { what: effort });
  },
};

export function parseGrokState(screen) {
  const border = lastMatch(screen, /(Grok [\d.]+(?: Fast)?) \((\w+)\)/g);
  return { model: border?.[1] ?? null, effort: border?.[2] ?? null };
}

const grok = {
  models: () => [
    { id: "grok-4.7", name: "Grok 4.7" },
    { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "grok-4.5", name: "Grok 4.5" },
  ],
  efforts: () => ["low", "medium", "high", "xhigh"],
  parse: parseGrokState,
  // Grok has no session-only switch: these also become its default, and the box says so.
  async setModel(io, model) {
    await io.send(`/model ${model.id}`);
    await waitFor(io, (s) => parseGrokState(s).model === model.name, t("wait.result"));
    return t("switch.default", { what: model.name });
  },
  async setEffort(io, effort) {
    await io.send(`/effort ${effort}`);
    await waitFor(io, (s) => parseGrokState(s).effort === effort, t("wait.result"));
    return t("switch.default", { what: effort });
  },
};

const AGENTS = { claude, codex, grok };

/** The agent running in a pane, by Herdr's program table; null for anything else. */
export function agentOf(pane) {
  return AGENTS[pane?.program?.key] ?? null;
}
