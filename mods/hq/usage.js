// Usage: the local CLIProxyAPI pool (requests, tokens, cache, latency, failures per model,
// account and client) and each subscription's live plan windows, inside HQ. The views are the
// `proxy` mod's own (shared/proxy-views.js); the data is its proxy.py report.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec, notify } from "herdr";

import { accounts, models, overview, requests, routingActions } from "./shared/proxy-views.js";
import { alpha, btn, chip, icon, label, ok, row, scrollY, statusGlyph, TYPE } from "./ui.js";

const SHOWN_MS = 60_000;
const BACKGROUND_MS = 5 * 60_000;
const RANGES = ["1h", "24h", "7d", "30d", "all"];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "accounts", label: "Accounts" },
  { id: "requests", label: "Requests" },
];

export class UsageView {
  constructor(app) {
    this.app = app;
    this.range = localStorage.getItem("usage.range") ?? "24h";
    this.tab = localStorage.getItem("usage.tab") ?? "overview";
    this.data = null;
    this.error = null;
    this.loading = false;
    this.updated = 0; // ms
    this.requests24h = null;
    this.timer = false;
  }

  typing() {
    return false;
  }

  /** From the host's init: starts the timer and a first report, so summary() is ready early. */
  start(cx) {
    this.ensureTimer(cx);
    this.refresh(cx);
  }

  onShow(cx) {
    this.ensureTimer(cx);
    if (Date.now() - this.updated > 15_000) this.refresh(cx);
  }

  /** One timer for both cadences: every minute while shown, every five minutes otherwise. */
  ensureTimer(cx) {
    if (this.timer) return;
    this.timer = true;
    cx.timer.every(SHOWN_MS, cx => {
      const shown = this.app.view === "usage";
      if (shown || Date.now() - this.updated >= BACKGROUND_MS - 1000) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const range = this.range;
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/proxy/proxy.py`, "report", range]);
        const out = JSON.parse(r.stdout || "{}");
        if (!out.ok) throw new Error(out.error || r.stderr.trim() || "proxy.py failed");
        if (range === this.range) {
          this.data = out;
          this.error = null;
          this.updated = Date.now();
          if (range === "24h") this.requests24h = out.totals?.requests ?? null;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  setRange(r, cx) {
    if (r === this.range) return;
    this.range = r;
    localStorage.setItem("usage.range", r);
    this.refresh(cx);
  }

  setTab(id, cx) {
    this.tab = id;
    localStorage.setItem("usage.tab", id);
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "[" || e.key === "]") {
      const i = TABS.findIndex(x => x.id === this.tab);
      this.setTab(TABS[(i + (e.key === "]" ? 1 : TABS.length - 1)) % TABS.length].id, cx);
      return true;
    }
    if (e.key === "r") {
      this.refresh(cx);
      return true;
    }
    return false;
  }

  /** For the status strip: is the proxy up, the fullest plan window (or extra-usage budget)
   *  across accounts, and the last 24 h request count when known. Null before the first report. */
  summary() {
    const d = this.data;
    if (!d) return null;
    let hottest = null;
    for (const a of d.accounts ?? []) {
      const name = a.label || a.email || a.name || "account";
      const plan = a.plan ?? {};
      const cands = [...(plan.windows ?? []).map(w => ({ label: `${name} · ${w.label}`, pct: w.pct, resets: w.resets ?? null }))];
      if (plan.extra?.pct != null) cands.push({ label: `${name} · extra usage`, pct: plan.extra.pct, resets: null });
      for (const c of cands) if (c.pct != null && (!hottest || c.pct > hottest.pct)) hottest = c;
    }
    return { up: !!d.proxy?.up, hottest, requests24h: this.requests24h };
  }

  // ---- drawing

  segmented(t, id, items, value, pick) {
    return h_flex()
      .flex_none()
      .p(2)
      .gap(2)
      .rounded(8)
      .bg(alpha(t.foreground, 0.055))
      .children(
        items.map(x => {
          const on = x.id === value;
          return div()
            .id(`${id}-${x.id}`)
            .h(24)
            .px(10)
            .flex()
            .items_center()
            .rounded(6)
            .text_size(TYPE.ui)
            .cursor_pointer()
            .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium())
            .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
            .on_click((_e, cx) => pick(x.id, cx))
            .child(x.label);
        }),
      );
  }

  toolbar(t) {
    const d = this.data;
    const up = d?.proxy?.up;
    const state = !d ? (this.error ? "gone" : "idle") : up ? "done" : "gone";
    const status = !d
      ? this.error
        ? "Couldn't reach the proxy report"
        : "Connecting…"
      : up
        ? "Proxy up on 127.0.0.1:8317"
        : `Proxy unreachable${d.proxy?.error ? `: ${d.proxy.error}` : ""}`;
    const mins = this.updated ? Math.round((Date.now() - this.updated) / 60_000) : null;
    return row()
      .flex_none()
      .items_center()
      .gap(12)
      .px(20)
      .py(10)
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .child(this.segmented(t, "usage-tab", TABS, this.tab, (id, cx) => this.setTab(id, cx)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .min_w(0)
          .child(state === "done" ? icon("circle-check", 12, ok(t)) : statusGlyph(state, t, 12))
          .child(div().truncate().text_size(TYPE.meta).text_color(t.muted).child(status)),
      )
      .child(div().flex_1())
      .child(
        div()
          .flex_none()
          .text_size(TYPE.meta)
          .text_color(t.dim)
          .child(this.loading ? "Refreshing…" : mins == null ? "" : mins < 1 ? "Updated just now" : `Updated ${mins}m ago`),
      )
      .child(this.segmented(t, "usage-range", RANGES.map(r => ({ id: r, label: r === "all" ? "All" : r })), this.range, (r, cx) => this.setRange(r, cx)))
      .child(btn(t, "usage-refresh", null, cx => this.refresh(cx), { kind: "ghost", size: "sm", icon: "repeat", tooltip: "Refresh (r) · [ ] switch view" }));
  }

  body(t) {
    const d = this.data;
    if (!d)
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(8)
        .child(label(t, this.error ? "Couldn't load usage" : "Loading usage…"))
        .when(!!this.error, el => el.child(div().max_w(560).text_size(TYPE.meta).text_color(t.dim).child(this.error)))
        .when(!!this.error, el => el.child(btn(t, "usage-retry", "Retry", cx => this.refresh(cx), { size: "sm" })));
    const o = { goto: (tab, cx) => this.setTab(tab, cx), routing: (this.routing ??= routingActions(this, `${appHome()}/mods/proxy/proxy.py`, exec, notify)) };
    const view =
      this.tab === "models" ? models(t, d) : this.tab === "accounts" ? accounts(t, d) : this.tab === "requests" ? requests(t, d) : overview(t, d, o);
    return scrollY(`usage-scroll-${this.tab}`, v_flex().px(20).py(16).gap(14).child(view));
  }

  render(t, _cx) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .bg(t.surface ?? t.background)
      .child(this.toolbar(t))
      .when(!!this.error && !!this.data, el =>
        el.child(
          h_flex()
            .px(20)
            .py(6)
            .gap(8)
            .bg(alpha(t.blocked, 0.08))
            .child(chip(t, "Last refresh failed", t.blocked))
            .child(div().truncate().text_size(TYPE.meta).text_color(t.blocked).child(this.error)),
        ),
      )
      .child(this.body(t));
  }
}
