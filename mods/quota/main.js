// Used quota of each subscription that is installed in Herdr and logged in, as a sidebar section.
// Login tokens are read when asking, sent only to the service that issued them and never kept:
// localStorage holds only the percentages. Tokens are never refreshed here, because a refresh
// could sign out the agent that owns them; the agents renew them when they run.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home, knownAgents, layout, props, readTextFile, run, settings, setShared, shared, theme } from "herdr";
import { PROVIDERS, busiestPercent, formatDate, formatReset, isPastReset, levelOf, nextEntry } from "./model.js";

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

export default class Quota extends View {
  init(_props, cx) {
    this.loading = true;
    this.entries = {};
    this.programs = {};
    try {
      const saved = JSON.parse(localStorage.getItem("saved") ?? "{}");
      this.entries = saved.entries ?? {};
      this.programs = saved.programs ?? {};
    } catch {
      // Unreadable saved numbers only cost the first paint.
    }
    this.lastAsked = 0;
    // While folded nothing shows these numbers, so the services aren't asked.
    cx.timer.every(POLL_MS, (cx) => { if (!folded()) this.refresh(cx); });
    cx.timer.every(60000, (cx) => cx.notify()); // The time left to each reset.
    if (folded()) this.loading = false;
    else this.refresh(cx);
  }

  toggleFold(cx) {
    const fold = !folded();
    setShared("quota.folded", fold);
    if (!fold) this.refreshByHand(cx);
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    this.lastAsked = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Only agents Herdr can run; if it can't tell, the login files alone decide.
        const agents = await knownAgents().catch(() => null);
        const entries = {};
        await Promise.all(PROVIDERS.map(async (provider) => {
          const program = agents?.find((a) => a.key === provider.key);
          if (agents && !program?.installed) return;
          if (program) this.programs[provider.key] = { icon: program.icon, tint: program.tint };
          const text = await readTextFile(`${home()}/${provider.loginFile}`).catch(() => null);
          const login = text ? provider.login(text) : null;
          if (!login) return;
          const entry = nextEntry(provider, this.entries[provider.key], login, await ask(login), Date.now());
          if (entry) entries[provider.key] = entry;
        }));
        this.entries = entries;
        localStorage.setItem("saved", JSON.stringify({ entries, programs: this.programs }));
      } finally {
        this.refreshing = false;
        this.loading = false;
        cx.notify();
      }
    });
  }

  refreshByHand(cx) {
    if (Date.now() - this.lastAsked >= MIN_MANUAL_GAP_MS) this.refresh(cx);
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

  whyOld(provider, entry) {
    if (entry.state === "fresh") return "";
    const when = entry.at ? `資料時間 ${formatDate(entry.at)}，` : "";
    return entry.state === "expired" ? `${when}登入憑證已過期，開啟 ${provider.agent} 後會更新` : `${when}暫時查不到額度`;
  }

  barColor(t, percent) {
    return { normal: t.accent, high: t.working, full: t.blocked }[levelOf(percent)];
  }

  windowRow(t, provider, entry, w, first, now) {
    const old = entry.state !== "fresh";
    const past = isPastReset(w, now);
    const percent = past ? null : w.percent;
    const title = [provider.name, entry.plan].filter(Boolean).join(" ");
    const tip = [
      `${title} · ${w.label}額度已用 ${percent == null ? "未知" : `${percent}%`}`,
      w.resetsAt == null ? "" : `重置時間 ${formatDate(w.resetsAt)}`,
      this.whyOld(provider, entry),
    ].filter(Boolean).join("\n");
    return h_flex().id(`row-${provider.key}-${w.label}`).h(21).px(16).gap(6).items_center().tooltip(tip)
      .child(this.nameCell(t, provider, first))
      .child(div().w(18).flex_none().text_color(t.muted).child(w.label))
      .child(h_flex().flex_1().min_w(0).h(4).rounded(2).overflow_hidden().bg(t.border)
        .when(percent > 0, (el) => el.child(div().h_full().flex_basis(0).flex_grow(percent).bg(old ? t.dim : this.barColor(t, percent))))
        .child(div().h_full().flex_basis(0).flex_grow(100 - (percent ?? 0))))
      .child(h_flex().w(30).flex_none().justify_end().text_color(old || past ? t.dim : t.foreground).child(percent == null ? "—" : `${percent}%`))
      .child(h_flex().w(50).flex_none().justify_end().text_color(t.dim).child(formatReset(w.resetsAt, now)));
  }

  nameCell(t, provider, first) {
    const cell = h_flex().w(60).flex_none().gap(6).items_center();
    if (!first) return cell;
    return cell.child(icon(this.programs[provider.key], provider.key, 13, t.foreground)).child(div().truncate().text_color(t.muted).child(provider.name));
  }

  rows(t, now) {
    return this.shown().flatMap((provider) => {
      const entry = this.entries[provider.key];
      if (entry.windows.length) return entry.windows.map((w, i) => this.windowRow(t, provider, entry, w, i === 0, now));
      return [h_flex().id(`row-${provider.key}`).h(21).px(16).gap(6).items_center().tooltip(this.whyOld(provider, entry))
        .child(this.nameCell(t, provider, true))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(entry.state === "expired" ? `開啟 ${provider.agent} 後更新` : "暫時查不到額度"))];
    });
  }

  railRows(t, now) {
    return this.shown().map((provider) => {
      const entry = this.entries[provider.key];
      const percent = busiestPercent(entry, now);
      const color = percent == null || entry.state !== "fresh" ? t.dim : levelOf(percent) === "normal" ? t.muted : this.barColor(t, percent);
      const tip = entry.windows.map((w) => `${w.label} ${isPastReset(w, now) ? "—" : `${w.percent}%`}`).join(" · ");
      return v_flex().id(`rail-${provider.key}`).py(4).gap(2).items_center().tooltip(`${provider.name}${tip ? ` · ${tip}` : ""}`)
        .child(icon(this.programs[provider.key], provider.key, 14, t.foreground))
        .child(div().text_size(9.5).text_color(color).child(percent == null ? "—" : `${percent}`));
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
    const foldTip = isFolded ? "展開訂閱額度" : "收合訂閱額度";
    return div().size_full().bg(t.chrome).child(
      v_flex().id("quota").w_full().border_t(1).border_color(t.border).pb(isFolded ? 2 : 8).text_size(11.5)
        .on_size_change((size) => this.fitBlock(size))
        .when(!collapsed, (el) => el
          .child(h_flex().px(16).h(36).pt(10).flex_none().items_center().justify_between()
            .child(h_flex().id("quota-fold").flex_1().min_w(0).gap(6).items_center().cursor_pointer().text_color(t.dim)
              .hover((s) => s.text_color(t.foreground)).tooltip(foldTip)
              .on_click((_e, cx) => this.toggleFold(cx))
              .child(chevron)
              .child(div().font_medium().child("訂閱額度"))
              .when(!isFolded, (el) => el.child(div().text_size(10.5).child("已用"))))
            .when(!isFolded, (el) => el.child(div().id("quota-refresh").text_color(t.dim).hover((s) => s.text_color(t.foreground)).tooltip("重新整理")
              .on_click((_e, cx) => this.refreshByHand(cx))
              .child(this.refreshing ? spinner.spin(900) : spinner))))
          .when(!isFolded, (el) => el
            .children(this.rows(t, now))
            .when(!listed, (el) => el.child(div().px(16).h(21).text_color(t.dim).child(this.loading ? "讀取中…" : "沒有偵測到已登入的訂閱")))))
        .when(collapsed, (el) => el.pt(4)
          .child(h_flex().id("quota-fold-rail").h(20).justify_center().items_center().cursor_pointer().text_color(t.dim)
            .hover((s) => s.text_color(t.foreground)).tooltip(foldTip)
            .on_click((_e, cx) => this.toggleFold(cx))
            .child(chevron))
          .when(!isFolded, (el) => el.children(this.railRows(t, now)))),
    );
  }
}
