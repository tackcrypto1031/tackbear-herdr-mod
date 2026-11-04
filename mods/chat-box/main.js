// A desktop-style message box for the focused terminal: Enter sends, Shift+Enter makes a
// new line, and pasted or dropped images and files go along as paths the agent can open.
// Each terminal keeps its own draft, so switching agents never carries text across.
// For a known agent it also shows and switches the model and reasoning effort.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { appHome, focused, hc, home, nextCommand, panes, props, readTextFile, run, settings, theme } from "herdr";
import * as fs from "fs/promises";
import { agentOf, parseCodexCatalog } from "./agents.js";
import { copyFile, readClipboard } from "./clipboard.js";
import { setLanguage, t as say } from "./i18n.js";
import {
  MAX_INLINE_MESSAGE, baseName, composeMessage, describeSendError, extensionOf, hcError,
  isImagePath, mergeDraftText, stampOf, textBeforeEnter,
} from "./logic.js";

const DATA_FOLDER = "data/chat-box";
const KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1000;
const WIDE_ENOUGH_FOR_HINT = 760;
const READ_TRIES = 6;
const READ_RETRY_MS = 1500;

const absolute = (relative) => `${appHome()}\\${relative.replace(/\//g, "\\")}`;

export default class ChatBox extends View {
  init(initialProps, cx) {
    setLanguage(initialProps?.lang);
    this.drafts = new Map();
    this.target = focused()?.terminal ?? null;
    this.error = null;
    this.notice = null;
    this.hasFocus = false;
    this.pasting = 0;
    this.sending = 0;
    this.seq = 0;
    this.current = "";
    this.previous = "";
    this.agentStates = new Map();
    this.catalog = {};
    this.menu = null;
    this.switchingAgent = false;
    this.width = 0;

    this.input = TextareaState.new({ placeholder: say("placeholder") });
    this.input.set_auto_grow(2, 12);
    this.input.on("change", (_e, cx) => this.changed(cx));
    this.input.on("submit", (e, cx) => { if (!e.shift) this.submit(cx); });
    this.input.on("paste_other", (_e, cx) => this.pasteClipboard(cx));
    this.input.on("focus", (_e, cx) => { this.hasFocus = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.hasFocus = false; cx.notify(); });

    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command.startsWith("type:")) {
          // Typed while the terminal had the keyboard: its own input box is hidden.
          this.input.focus();
          this.input.replace(command.slice("type:".length));
        } else if (command === "focus") this.input.focus();
        else if (command === "send") this.submitValue(this.input.value(), cx);
        else if (command === "paste") this.pasteClipboard(cx);
        cx.notify();
      }
    });
    cx.spawn(async () => this.prepareFolder());
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home()}\\.codex\\models_cache.json`).catch(() => null);
      this.catalog.codex = text ? parseCodexCatalog(text) : [];
      cx.notify();
    });
  }

  async prepareFolder() {
    const folder = absolute(DATA_FOLDER);
    await fs.mkdir(folder, { recursive: true });
    const oldest = Date.now() - KEEP_FILES_MS;
    for (const name of await fs.readdir(folder)) {
      const stamp = stampOf(name);
      if (stamp !== null && stamp < oldest) await fs.unlink(`${folder}\\${name}`).catch(() => {});
    }
  }

  draft(terminal) {
    if (!this.drafts.has(terminal)) this.drafts.set(terminal, { text: "", files: [] });
    return this.drafts.get(terminal);
  }

  changed(cx) {
    this.previous = this.current;
    this.current = this.input.value();
    this.draft(this.target).text = this.current;
    this.error = null;
    this.notice = null;
    cx.notify();
  }

  setText(text) {
    this.previous = text;
    this.current = text;
    this.input.set_value(text);
  }

  targetPane() {
    return panes().find((p) => p.terminal === this.target);
  }

  /** The focused terminal; a focused mod pane leaves the last terminal of the shown tab. */
  liveTarget() {
    const shown = focused();
    if (shown?.terminal) return shown.terminal;
    const stillShown = panes().some((p) => p.terminal === this.target && p.tab === shown?.tab);
    return stillShown ? this.target : null;
  }

  followFocus(cx) {
    const next = this.liveTarget();
    if (next === this.target || this.following) return;
    this.following = true;
    // Text state can't be set while describing the UI.
    cx.timer.after(0, (cx) => {
      this.following = false;
      this.target = this.liveTarget();
      this.error = null;
      this.notice = null;
      this.menu = null;
      this.setText(this.draft(this.target).text);
      cx.notify();
    });
  }

  /** Reads the model and effort off the agent's screen when it settles or changes. */
  watchAgent(cx) {
    const pane = this.targetPane();
    const key = `${this.target}:${pane?.program?.key}:${pane?.status}`;
    if (key === this.watched) return;
    this.watched = key;
    if (agentOf(pane)) {
      const terminal = this.target;
      cx.spawn(async (cx) => this.readAgent(terminal, cx));
    }
  }

  async readAgent(terminal, cx, tries = READ_TRIES) {
    const agent = agentOf(panes().find((p) => p.terminal === terminal));
    if (!agent) return;
    // The screen alone: asking for history as well can take seconds.
    const result = await hc(["read", terminal]);
    if (result.code === 0) {
      // A screen that no longer shows a value (it scrolled away) keeps the last one known.
      const known = this.agentStates.get(terminal) ?? {};
      const seen = agent.parse(result.stdout);
      this.agentStates.set(terminal, { model: seen.model ?? known.model, effort: seen.effort ?? known.effort });
    }
    cx.notify();
    // An agent still starting or redrawing at a new size shows no model yet.
    if (!this.agentStates.get(terminal)?.model && tries > 1 && terminal === this.target) {
      await cx.sleep(READ_RETRY_MS);
      await this.readAgent(terminal, cx, tries - 1);
    }
  }

  /** All an agent's switch can do: talk to that one terminal. */
  agentIo(terminal, cx) {
    const talk = async (args) => {
      const result = await hc(args);
      const error = hcError(result);
      if (error) throw new Error(error.message);
    };
    return {
      send: (text) => talk(["send", "--json", terminal, "--", text]),
      keys: (key) => talk(["keys", "--json", terminal, key]),
      read: async () => (await hc(["read", terminal])).stdout,
      sleep: (ms) => cx.sleep(ms),
    };
  }

  switchAgent(kind, choice, cx) {
    const terminal = this.target;
    const pane = this.targetPane();
    const agent = agentOf(pane);
    this.menu = null;
    this.notice = null;
    this.error = null;
    if (!agent || this.switchingAgent) return;
    if (pane.status === "working" || pane.status === "blocked") {
      this.error = say(pane.status === "working" ? "switch.working" : "switch.blocked");
      cx.notify();
      return;
    }
    this.switchingAgent = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const state = this.agentStates.get(terminal) ?? {};
      try {
        const io = this.agentIo(terminal, cx);
        const done = kind === "model"
          ? await agent.setModel(io, choice, state)
          : await agent.setEffort(io, choice, state, this.catalog);
        this.notice = say("switch.done", { what: done });
      } catch (e) {
        this.error = say("switch.failed", { why: e.message ?? e });
      }
      this.switchingAgent = false;
      await this.readAgent(terminal, cx);
    });
  }

  submit(cx) {
    this.submitValue(textBeforeEnter(this.input.value(), this.current, this.previous), cx);
  }

  submitValue(text, cx) {
    const terminal = this.target;
    const draft = this.draft(terminal);
    const files = draft.files;
    if (!terminal || (!text.trim() && !files.length)) {
      this.setText(text); // Takes back the newline Enter put in.
      draft.text = text;
      if (!terminal) this.error = say("no.target.send");
      cx.notify();
      return;
    }
    // Clears at once, so a slow send never holds up the next message.
    draft.text = "";
    draft.files = [];
    this.setText("");
    this.error = null;
    this.notice = null;
    this.sending += 1;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const failure = await this.deliver(terminal, text, files);
        if (failure) this.restore(terminal, text, files, describeSendError(failure));
      } catch (e) {
        this.restore(terminal, text, files, describeSendError({ kind: "", message: String(e.message ?? e) }));
      }
      this.sending -= 1;
      cx.notify();
    });
  }

  /** Sends a message; answers what went wrong, or null. */
  async deliver(terminal, text, files) {
    let words = text;
    const paths = files.map((f) => f.path);
    if (text.length > MAX_INLINE_MESSAGE) {
      const name = `${DATA_FOLDER}/message-${Date.now()}.md`;
      await fs.writeFile(absolute(name), text);
      paths.push(absolute(name));
      words = say("send.tooLong");
    }
    const there = terminal.includes("/") ? await this.putThere(terminal, paths) : paths;
    if (there.error) return there.error;
    const result = await hc(["send", "--json", terminal, "--", composeMessage(words, there)]);
    return hcError(result);
  }

  /** A terminal on another machine can't open this machine's files: copies them over. */
  async putThere(terminal, paths) {
    const there = [];
    for (const path of paths) {
      const result = await hc(["put", "--json", terminal, path]);
      const error = hcError(result);
      if (error) return { error };
      there.push(JSON.parse(result.stdout).path);
    }
    return there;
  }

  restore(terminal, text, files, message) {
    const draft = this.draft(terminal);
    draft.text = mergeDraftText(text, draft.text);
    draft.files = [...files, ...draft.files];
    if (terminal === this.target) {
      this.setText(draft.text);
      this.error = message;
    }
  }

  pasteClipboard(cx) {
    const terminal = this.target;
    const name = `${DATA_FOLDER}/paste-${Date.now()}-${this.seq++}.png`;
    this.pasting += 1;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const items = await readClipboard(absolute(name));
        if (!items.length) this.error = say("paste.empty");
        for (const item of items) {
          if (item.kind === "image") this.draft(terminal).files.push({ path: item.path, preview: name, name: say("paste.image") });
          else await this.attach(terminal, item.path);
        }
      } catch (e) {
        this.error = say("paste.failed", { why: e.message ?? e });
      }
      this.pasting -= 1;
      cx.notify();
    });
  }

  dropped(paths, cx) {
    const terminal = this.target;
    this.error = null;
    cx.spawn(async (cx) => {
      for (const path of paths) await this.attach(terminal, path);
      cx.notify();
    });
    this.input.focus();
  }

  async attach(terminal, path) {
    const files = this.draft(terminal).files;
    if (files.some((f) => f.path === path)) return;
    const entry = { path, preview: null, name: baseName(path) };
    files.push(entry);
    if (isImagePath(path)) entry.preview = await this.makePreview(path);
  }

  /** Images only draw from inside the app's folder. Without a copy, the file still sends. */
  async makePreview(path) {
    const name = `${DATA_FOLDER}/preview-${Date.now()}-${this.seq++}.${extensionOf(path)}`;
    try {
      await copyFile(path, absolute(name));
      return name;
    } catch {
      return null;
    }
  }

  removeFile(index, cx) {
    this.draft(this.target).files.splice(index, 1);
    cx.notify();
  }

  backToTerminal(e, cx) {
    if (e.key !== "escape" || !this.target) return;
    run("pane.focus", { terminal: this.target });
    cx.stop_propagation();
  }

  /** A block of the layout named in props follows the box's height. */
  fitBlock(size) {
    const zoom = settings().zoom ?? 1;
    this.width = size.width / zoom;
    const block = props()?.fit_block;
    if (!block) return;
    const px = Math.ceil(size.height / zoom) + 1;
    if (px === this.fitted) return;
    this.fitted = px;
    run("layout.resize", { id: block, px });
  }

  thumbnail(t, file, index) {
    const remove = div().id(`chat-remove-${index}`).absolute().top(3).right(3).size(18).rounded(9)
      .flex().items_center().justify_center().bg(t.raised).text_color(t.foreground).text_size(12).cursor_pointer()
      .on_click((_e, cx) => this.removeFile(index, cx)).child("×");
    const body = file.preview
      ? image(file.preview).h(64)
      : h_flex().h(64).px(12).pr(26).gap(8).items_center().text_color(t.muted).text_size(12.5)
        .child(svg("mods/chat-box/file.svg").size(16).text_color(t.dim))
        .child(div().max_w(220).truncate().child(file.name));
    return div().id(`chat-file-${index}`).relative().flex_none().rounded(8).overflow_hidden()
      .border_1().border_color(t.border).bg(t.raised).child(body).child(remove);
  }

  targetLine(t) {
    if (!this.target) return div().text_color(t.dim).child(say("no.target"));
    const pane = this.targetPane();
    const status = pane?.status;
    const color = status ? t[status] ?? t.dim : t.dim;
    const word = status ? say(`status.${status}`) : null;
    // While the box has the keyboard no pane looks focused, so this names which one gets the message.
    const name = pane?.program?.name ?? this.target;
    const title = pane?.title && pane.title !== name ? ` · ${pane.title}` : "";
    return h_flex().gap(6).items_center().min_w(0).text_color(t.muted)
      .child(div().flex_none().size(7).rounded(4).bg(color))
      .child(div().truncate().child(`${name}${title}`))
      .when(Boolean(word), (el) => el.child(div().flex_none().text_color(t.dim).child(word)));
  }

  /** A pill showing the current value, opening its choices above the text. */
  agentChip(t, kind, value) {
    const open = this.menu === kind;
    return h_flex().id(`chat-${kind}`).flex_none().h(24).px(9).gap(5).items_center().rounded(7)
      .bg(open ? t.selected : t.raised).text_color(t.foreground).cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => {
        this.menu = open ? null : kind;
        const terminal = this.target;
        if (!open) cx.spawn(async (cx) => this.readAgent(terminal, cx));
        this.input.focus(); // Enter keeps sending what's typed, not going to the terminal.
        cx.notify();
      })
      .child(div().child(value))
      .child(div().text_color(t.dim).child(open ? "▴" : "▾"));
  }

  agentMenu(t, agent, state) {
    const models = this.menu === "model";
    const choices = models ? agent.models(this.catalog) : agent.efforts(this.catalog, state);
    return h_flex().id("chat-menu").w_full().gap(5).flex_wrap().text_size(12.5).children(choices.map((choice) => {
      const name = models ? choice.name : choice;
      const current = name === (models ? state.model : state.effort);
      return div().id(`chat-choice-${name}`).px(10).py(5).rounded(7).cursor_pointer()
        .border_1().border_color(current ? t.accent : t.border)
        .text_color(current ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.input.focus(); this.switchAgent(this.menu, choice, cx); })
        .child(name);
    }));
  }

  render(cx) {
    this.followFocus(cx);
    this.watchAgent(cx);
    const t = theme();
    const draft = this.draft(this.target);
    const ready = Boolean(this.target) && Boolean(draft.text.trim() || draft.files.length);
    const agent = agentOf(this.targetPane());
    const state = this.agentStates.get(this.target) ?? {};
    const hint = this.sending > 0 ? say("sending") : say("hint");
    return div().id("chat-box").size_full()
      .on_key_down((e, cx) => this.backToTerminal(e, cx))
      .on_drop((e, cx) => this.dropped(e.paths, cx))
      .child(v_flex().id("chat-card").w_full().gap(6).px(12).pt(9).pb(7).rounded(10).border_1()
        .border_color(this.hasFocus ? t.accent : t.border).bg(t.background)
        .on_size_change((size) => this.fitBlock(size))
        .when(draft.files.length > 0 || this.pasting > 0, (el) => el
          .child(h_flex().id("chat-files").w_full().gap(6).flex_wrap()
            .children(draft.files.map((file, index) => this.thumbnail(t, file, index)))
            .when(this.pasting > 0, (row) => row
              .child(h_flex().h(64).px(14).flex_none().items_center().rounded(8).bg(t.raised)
                .text_color(t.dim).text_size(12.5).child(say("paste.reading"))))))
        .when(Boolean(agent && this.menu), (el) => el.child(this.agentMenu(t, agent, state)))
        .child(Textarea.new(this.input).w_full().text_size(14).text_color(t.foreground))
        .child(h_flex().w_full().gap(8).items_center().text_size(11.5)
          .child(div().flex_1().min_w(0).child(this.error
            ? div().text_color(t.blocked).child(this.error)
            : this.notice ? div().text_color(t.muted).truncate().child(this.notice) : this.targetLine(t)))
          .when(Boolean(agent), (el) => el
            .child(this.agentChip(t, "model", this.switchingAgent ? say("chip.switching") : state.model ?? say("chip.model")))
            .child(this.agentChip(t, "effort", state.effort ?? say("chip.effort"))))
          .when(this.sending > 0 || this.width > WIDE_ENOUGH_FOR_HINT, (el) => el
            .child(div().flex_none().text_color(t.dim).child(hint)))
          .child(h_flex().id("chat-send").flex_none().size(26).rounded(13).items_center().justify_center()
            .bg(ready ? t.solid : t.raised)
            .when(ready, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
            .on_click((_e, cx) => { if (ready) this.submitValue(this.input.value(), cx); })
            .child(svg("mods/chat-box/send.svg").size(14).text_color(ready ? t.solid_foreground : t.dim)))));
  }
}
