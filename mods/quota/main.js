// Used quota of each subscription that is installed in Herdr and logged in, as a sidebar section,
// and what's left on a pay-as-you-go API account (DeepSeek, through opencode's key),
// and the model pools of the Antigravity app, asked of its own local server while it runs.
// Login tokens are read when asking, sent only to the service that issued them and never kept:
// localStorage holds only the percentages and balances. Tokens are never refreshed here, because a refresh
// could sign out the agent that owns them; the agents renew them when they run.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, home, knownAgents, layout, props, readTextFile, run, settings, setShared, shared, theme, window } from "herdr";
import { PROVIDERS, busiestPercent, formatDate, formatMoney, formatReset, isBalance, isPastReset, isWaiting, levelOf, missedEntry, nextEntry } from "./model.js";
import { labelText, setLanguage, t as say } from "./i18n.js";

const POLL_MS = 5 * 60 * 1000;
const MIN_MANUAL_GAP_MS = 30 * 1000; // These services limit how often they can be asked.

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const folded = () => Boolean(shared("quota.folded"));
// Timers keep running while the window is hidden; nothing is seen then, so nothing is asked.
const hidden = () => window()?.visible === false;

function icon(program, key, size, color) {
  const path = program?.icon ?? `icons/${key}.svg`;
  return program && !program.tint ? image(path).w(size).h(size).flex_none() : svg(path).size(size).flex_none().text_color(color);
}

async function ask(login) {
  try {
    const reply = await fetch(login.url, { headers: login.headers });
    return { status: reply.status, body: reply.status === 200 ? await reply.text() : null };
  } catch {
    return { failed: true };
  }
}

/**
 * Runs a provider's helper script, which asks the service itself and prints `{ status, body }`.
 * Null when there's nothing to show: no key set up, or no node to run it.
 */
async function askHelper(helper) {
  try {
    const result = await exec("node", [`${appHome()}/mods/quota/${helper}`]);
    const reply = JSON.parse(result.stdout.trim().split("\n").pop());
    return reply.login === false ? null : reply;
  } catch {
    return null;
  }
}

/**
 * Runs a provider's CLI, which holds the login and prints the usage reply, so the token never
 * reaches the mod. A GUI app on macOS may not have the shell's PATH, so a program that can't be
 * started is tried once more through a login shell. Null when the program isn't there.
 */
async function askCommand(provider) {
  const [program, ...args] = provider.command;
  let result = await exec(program, args).catch(() => null);
  if (!result && window()?.platform !== "windows") {
    const quoted = provider.command.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    result = await exec("/bin/sh", ["-lc", `exec ${quoted}`]).catch(() => null);
    if (result?.code === 127) result = null;
  }
  if (!result) return null;
  return provider.commandOutcome(result);
}

/** A provider's login, from its file or, on macOS, the Keychain. Null when signed out. */
async function readLogin(provider) {
  const text = await readTextFile(`${home()}/${provider.loginFile}`).catch(() => null);
  let login = text ? provider.login(text) : null;
  if (!login && provider.keychain) {
    // Several items can share the service name (one left by an older Claude Code under the
    // account "unknown"); the one under this user's account holds the current login.
    const account = home().split("/").pop();
    for (const only of [["-a", account], []]) {
      const found = await exec("/usr/bin/security", ["find-generic-password", "-s", provider.keychain, ...only, "-w"]).catch(() => null);
      login = found?.code === 0 ? provider.login(found.stdout.trim()) : null;
      if (login) break;
    }
  }
  return login;
}

/**
 * The three ways of asking a service. Each gives `{ login, outcome }`; no outcome means there was
 * nothing to ask with (no login, no key, no program).
 */
const SOURCES = {
  helper: async (provider) => ({ login: {}, outcome: await askHelper(provider.helper) }),
  command: async (provider) => ({ login: {}, outcome: await askCommand(provider) }),
  loginFile: async (provider) => {
    const login = await readLogin(provider);
    return { login, outcome: login && await ask(login) };
  },
};

const sourceOf = (provider) => SOURCES[provider.helper ? "helper" : provider.command ? "command" : "loginFile"];

export default class Quota extends View {
  init(initialProps, cx) {
    setLanguage(initialProps?.lang);
    this.loading = true;
    this.entries = {};
    this.programs = {};
    this.inFlight = new Set(); // Providers being asked; each shows as soon as its own answer comes.
    try {
      const saved = JSON.parse(localStorage.getItem("saved") ?? "{}");
      this.entries = saved.entries ?? {};
      this.programs = saved.programs ?? {};
      this.askedAt = saved.askedAt ?? {};
    } catch {
      // Unreadable saved numbers only cost the first paint.
    }
    this.askedAt ??= {}; // When each provider was last asked, for those with their own `everyMs`.
    this.lastAsked = 0;
    // While folded or hidden nothing shows these numbers, so the services aren't asked.
    // A poll skipped while hidden is made up the first minute the window shows again.
    cx.timer.every(POLL_MS, (cx) => {
      if (folded()) return;
      if (hidden()) this.missedPoll = true;
      else this.refresh(cx);
    });
    cx.timer.every(60000, (cx) => { // The time left to each reset.
      if (hidden()) return;
      if (this.missedPoll && !folded()) {
        this.missedPoll = false;
        this.refresh(cx);
      }
      cx.notify();
    });
    if (folded()) this.loading = false;
    else this.refresh(cx);
  }

  get refreshing() {
    return this.inFlight.size > 0;
  }

  toggleFold(cx) {
    const fold = !folded();
    setShared("quota.folded", fold);
    if (!fold) this.refreshByHand(cx, false);
  }

  save() {
    localStorage.setItem("saved", JSON.stringify({ entries: this.entries, programs: this.programs, askedAt: this.askedAt }));
  }

  setEntry(key, entry) {
    const entries = { ...this.entries };
    if (entry) entries[key] = entry;
    else delete entries[key];
    this.entries = entries;
    this.save();
  }

  /**
   * Asks every provider at once, and shows each as soon as it answers, so a slow one (a helper
   * can take up to 30 s) holds up only its own row. A provider still being asked is left alone.
   * `byHand` is the refresh button: it asks even a provider whose own interval hasn't passed.
   */
  refresh(cx, byHand = false) {
    this.lastAsked = Date.now();
    cx.spawn(async (cx) => {
      try {
        // Only agents Herdr can run; if it can't tell, the login files alone decide.
        const agents = await knownAgents().catch(() => null);
        const installed = new Set();
        await Promise.all(PROVIDERS.map(async (provider) => {
          const program = agents?.find((a) => a.key === (provider.program ?? provider.key));
          if (agents && !provider.standalone && !program?.installed) return;
          installed.add(provider.key);
          if (this.inFlight.has(provider.key)) return;
          if (provider.icon) this.programs[provider.key] = provider.icon;
          else if (program) this.programs[provider.key] = { icon: program.icon, tint: program.tint };
          const previous = this.entries[provider.key];
          const tooSoon = !byHand && previous && provider.everyMs && Date.now() - (this.askedAt[provider.key] ?? 0) < provider.everyMs;
          if (tooSoon || isWaiting(previous, Date.now())) return;
          this.inFlight.add(provider.key);
          cx.notify();
          try {
            const { login, outcome } = await sourceOf(provider)(provider);
            const now = Date.now();
            if (outcome) this.askedAt[provider.key] = now;
            const latest = this.entries[provider.key];
            this.setEntry(provider.key, outcome ? nextEntry(provider, latest, login, outcome, now) : missedEntry(latest, now));
          } finally {
            this.inFlight.delete(provider.key);
            cx.notify();
          }
        }));
        // An agent that was uninstalled takes its row with it.
        if (agents) for (const key of Object.keys(this.entries)) if (!installed.has(key)) this.setEntry(key, null);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  refreshByHand(cx, button = true) {
    if (Date.now() - this.lastAsked >= MIN_MANUAL_GAP_MS) this.refresh(cx, button);
  }

  // Grows and shrinks the layout's block to what's listed, as the chat box does.
  fitBlock(size) {
    const block = props()?.fit_block;
    if (!block) return;
    const px = Math.ceil(size.height / (settings().zoom ?? 1)) + 1;
    if (px === this.fitted) return;
    this.fitted = px;
    run("layout.resize", { id: block, px });
  }

  shown() {
    return PROVIDERS.filter((provider) => this.entries[provider.key]);
  }

  relogin(provider) {
    return provider.reloginCommand ? say("run", { command: provider.reloginCommand }) : say("open", { agent: provider.agent });
  }

  whyOld(provider, entry) {
    if (entry.state === "fresh") return "";
    const when = entry.at ? say("dataAt", { date: formatDate(entry.at) }) : "";
    if (entry.state === "limited") return say("limited", { when, date: formatDate(entry.retryAt) });
    if (entry.state === "offline") return say("offline", { when, agent: provider.agent });
    if (entry.state !== "expired") return say("failed", { when });
    return provider.helper ? say("badKey", { when, agent: provider.agent }) : say("expired", { when, relogin: this.relogin(provider) });
  }

  /** What a provider without numbers says in place of them. */
  statusText(provider, entry) {
    if (entry.state === "limited") return say("rowLimited", { time: formatDate(entry.retryAt).slice(6) });
    if (entry.state !== "expired") return say("rowFailed");
    return provider.helper ? say("rowBadKey") : say("rowExpired", { relogin: this.relogin(provider) });
  }

  barColor(t, percent) {
    return { normal: t.accent, high: t.working, full: t.blocked }[levelOf(percent)];
  }

  // Rows sit in an 8px gutter and round their hover, as the Agents list's do; text stays 16px in.
  row(t, id) {
    return h_flex().id(id).px(8).rounded(6).gap(6).items_center().flex_none().hover((s) => s.bg(t.hover));
  }

  /** The model's own line: icon, name and plan; a model without numbers says why here. */
  headRow(t, provider, entry) {
    const title = [provider.name, entry.plan].filter(Boolean).join(" ");
    const old = entry.state !== "fresh";
    return this.row(t, `head-${provider.key}`).h(22).tooltip(this.whyOld(provider, entry) || title)
      .child(icon(this.programs[provider.key], provider.key, 13, old ? t.dim : t.foreground))
      .child(div().flex_none().text_color(old ? t.dim : t.muted).font_medium().child(provider.name))
      .when(Boolean(entry.plan), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(entry.plan)))
      .when(!entry.windows.length, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.statusText(provider, entry))));
  }

  /** A pay-as-you-go account: what's left, in place of a bar. */
  balanceRow(t, provider, entry, w) {
    const old = entry.state !== "fresh";
    const money = formatMoney(w.amount, w.currency);
    const tip = [
      say("balanceTip", { name: provider.name, money }),
      w.low ? say("lowBalance") : "",
      this.whyOld(provider, entry),
    ].filter(Boolean).join("\n");
    return this.row(t, `row-${provider.key}-${w.currency}`).h(20).pl(27).tooltip(tip)
      .child(div().w(this.labelWidth).flex_none().truncate().text_color(t.muted).child(labelText(w.label)))
      .child(div().flex_1())
      .child(h_flex().flex_none().justify_end().text_color(old ? t.dim : w.low ? t.blocked : t.foreground).child(money));
  }

  windowRow(t, provider, entry, w, now) {
    if (isBalance(w)) return this.balanceRow(t, provider, entry, w);
    const old = entry.state !== "fresh";
    const past = isPastReset(w, now);
    const percent = past ? null : w.percent;
    const label = labelText(w.label);
    const tip = [
      say("usedTip", { title: [provider.name, entry.plan].filter(Boolean).join(" "), label, percent: percent == null ? say("unknown") : `${percent}%` }),
      w.resetsAt == null ? "" : say("resetTip", { date: formatDate(w.resetsAt) }),
      w.detail ? say("modelsTip", { models: w.detail }) : "",
      this.whyOld(provider, entry),
    ].filter(Boolean).join("\n");
    // Indented under the model's name (8 + 13px icon + 6 gap), so the bar gets the width a name column took.
    return this.row(t, `row-${provider.key}-${w.label}`).h(20).pl(27).tooltip(tip)
      .child(div().w(this.labelWidth).flex_none().truncate().text_color(t.muted).child(label))
      .child(h_flex().flex_1().min_w(0).h(4).rounded(2).overflow_hidden().bg(t.border)
        .when(percent > 0, (el) => el.child(div().h_full().flex_basis(0).flex_grow(percent).bg(old ? t.dim : this.barColor(t, percent))))
        .child(div().h_full().flex_basis(0).flex_grow(100 - (percent ?? 0))))
      .child(h_flex().w(32).flex_none().justify_end().text_color(old || past ? t.dim : t.foreground).child(percent == null ? "—" : `${percent}%`))
      .child(h_flex().w(52).flex_none().justify_end().text_color(t.dim).child(formatReset(w.resetsAt, now)));
  }

  rows(t, now) {
    // Room for a pool name ("Gemini") when one is listed, else just "5H" / "週".
    const long = this.shown().some((p) => this.entries[p.key].windows.some((w) => labelText(w.label).length > 3));
    this.labelWidth = long ? 42 : 22;
    return this.shown().flatMap((provider) => {
      const entry = this.entries[provider.key];
      return [this.headRow(t, provider, entry), ...entry.windows.map((w) => this.windowRow(t, provider, entry, w, now))];
    });
  }

  railRows(t, now) {
    return this.shown().map((provider) => {
      const entry = this.entries[provider.key];
      const percent = busiestPercent(entry, now);
      const balance = entry.windows.find(isBalance);
      const color = entry.state !== "fresh" ? t.dim
        : balance && percent == null ? (balance.low ? t.blocked : t.muted)
        : percent == null ? t.dim : levelOf(percent) === "normal" ? t.muted : this.barColor(t, percent);
      const shownNumber = percent != null ? `${percent}` : balance ? formatMoney(balance.amount, balance.currency, true) : "—";
      const tip = entry.windows.map((w) => (isBalance(w) ? `${say("balance")} ${formatMoney(w.amount, w.currency)}`
        : `${labelText(w.label)} ${isPastReset(w, now) ? "—" : `${w.percent}%`}`)).join(" · ");
      return v_flex().id(`rail-${provider.key}`).py(4).gap(2).items_center().tooltip(`${provider.name}${tip ? ` · ${tip}` : ""}`)
        .child(icon(this.programs[provider.key], provider.key, 14, t.foreground))
        .child(div().text_size(9.5).text_color(color).child(shownNumber));
    });
  }

  render() {
    const t = theme();
    const now = Date.now();
    const collapsed = narrow();
    const isFolded = folded();
    const listed = this.shown().length > 0;
    const spinner = svg("mods/quota/refresh.svg").size(12);
    const chevron = svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`).size(11).flex_none();
    const foldTip = say(isFolded ? "unfold" : "fold");
    return div().size_full().bg(t.chrome).child(
      v_flex().id("quota").w_full().border_t(1).border_color(t.border).pb(isFolded ? 2 : 8).text_size(11.5)
        .on_size_change((size) => this.fitBlock(size))
        .when(!collapsed, (el) => el
          // The same header as the Agents section above it.
          .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
            .child(h_flex().id("quota-fold").flex_1().min_w(0).gap(6).items_center().cursor_pointer().text_color(t.dim)
              .hover((s) => s.text_color(t.foreground)).tooltip(foldTip)
              .on_click((_e, cx) => this.toggleFold(cx))
              .child(chevron)
              .child(div().font_medium().child(say("title")))
              .when(!isFolded, (el) => el.child(div().text_size(10.5).child(say("titleHint")))))
            .when(!isFolded, (el) => el.child(div().id("quota-refresh").text_color(t.dim).hover((s) => s.text_color(t.foreground)).tooltip(say("refresh"))
              .on_click((_e, cx) => this.refreshByHand(cx))
              .child(this.refreshing ? spinner.spin(900) : spinner))))
          .when(!isFolded, (el) => el
            .child(v_flex().px(8).gap(1).children(this.rows(t, now)))
            .when(!listed, (el) => el.child(div().px(16).h(21).text_color(t.dim).child(say(this.loading ? "loading" : "none"))))))
        .when(collapsed, (el) => el.pt(4)
          .child(h_flex().id("quota-fold-rail").h(20).justify_center().items_center().cursor_pointer().text_color(t.dim)
            .hover((s) => s.text_color(t.foreground)).tooltip(foldTip)
            .on_click((_e, cx) => this.toggleFold(cx))
            .child(chevron))
          .when(!isFolded, (el) => el.children(this.railRows(t, now)))),
    );
  }
}
