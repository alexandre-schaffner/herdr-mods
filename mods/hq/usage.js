// Usage: the local CLIProxyAPI pool (requests, tokens, cache, latency, failures per model,
// account and client) and each subscription's live plan windows, inside HQ. The views are the
// `proxy` mod's own (shared/proxy-views.js); the data is its proxy.py report.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec, notify } from "herdr";

import { accounts, models, overview, requests, routingActions } from "./shared/proxy-views.js";
import { banner, btn, empty, icon, loading, mono, ok, scrollY, segmented, statusGlyph, timeAgo, toolbar, TYPE } from "./ui.js";

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
  /** Every plan window with a reading, fullest first: { who, label, pct, resets (epoch s) }.
   *  Live subscription accounts in the pool only (an API key has no plan; a disabled account
   *  isn't serving). The strip names the first; Home lists the top ones. */
  windows() {
    const out = [];
    for (const a of this.data?.accounts ?? []) {
      if (!a.live || a.kind === "api-key" || a.disabled) continue;
      const who = a.label || a.email || a.name || "account";
      const plan = a.plan ?? {};
      for (const w of plan.windows ?? []) if (w.pct != null) out.push({ who, label: w.label, pct: w.pct, resets: w.resets ?? null });
      if (plan.extra?.pct != null) out.push({ who, label: "extra usage", pct: plan.extra.pct, resets: null });
    }
    return out.sort((x, y) => y.pct - x.pct);
  }

  summary() {
    const d = this.data;
    if (!d) return null;
    const top = this.windows()[0];
    return { up: !!d.proxy?.up, hottest: top ? { ...top, label: `${top.who} · ${top.label}` } : null, requests24h: this.requests24h };
  }

  // ---- drawing

  toolbar(t) {
    const d = this.data;
    const up = d?.proxy?.up;
    // The proxy being up is a health check, not an agent's "done": a green check.
    const mark = d && up ? icon("circle-check", 12, ok(t)) : statusGlyph(!d && !this.error ? "idle" : "gone", t, 12);
    const status = !d
      ? this.error
        ? "Couldn't reach the proxy report"
        : "Connecting…"
      : up
        ? "Proxy up on 127.0.0.1:8317"
        : `Proxy unreachable${d.proxy?.error ? `: ${d.proxy.error}` : ""}`;
    return toolbar(t, [
      segmented(t, "usage-tab", TABS, this.tab, (id, cx) => this.setTab(id, cx)),
      h_flex().gap(6).items_center().min_w(0).child(mark).child(div().truncate().text_size(TYPE.meta).text_color(t.muted).child(status)),
      div().flex_1(),
      this.loading ? div().flex_none().text_size(TYPE.meta).text_color(t.muted).child("Refreshing…") : timeAgo(t, this.updated, Date.now(), { verb: "Updated" }),
      segmented(t, "usage-range", RANGES.map(r => ({ id: r, label: r === "all" ? "All" : r })), this.range, (r, cx) => this.setRange(r, cx)),
      btn(t, "usage-refresh", null, cx => this.refresh(cx), { kind: "ghost", size: "sm", icon: "repeat", tooltip: "Refresh (r) · [ ] switch view" }),
    ]);
  }

  body(t) {
    const d = this.data;
    if (!d)
      return this.error
        ? empty(t, "Couldn't load usage", this.error, { icon: "alert", tone: t.blocked, action: btn(t, "usage-retry", "Retry", cx => this.refresh(cx), { size: "sm" }) })
        : loading(t, "Loading usage…");
    const o = { goto: (tab, cx) => this.setTab(tab, cx), routing: (this.routing ??= routingActions(this, `${appHome()}/mods/proxy/proxy.py`, exec, notify)) };
    // The shared views set numbers in `t.mono`: HQ's is Geist Mono.
    const tv = { ...t, mono: mono() };
    const view =
      this.tab === "models" ? models(tv, d) : this.tab === "accounts" ? accounts(tv, d, o) : this.tab === "requests" ? requests(tv, d) : overview(tv, d, o);
    return scrollY(`usage-scroll-${this.tab}`, v_flex().px(24).py(24).child(view));
  }

  render(t, _cx) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .bg(t.surface ?? t.background)
      .child(this.toolbar(t))
      .when(!!this.error && !!this.data, el =>
        el.child(banner(t, { tone: t.blocked, text: `The last refresh failed: ${this.error}`, action: btn(t, "usage-retry", "Retry", cx => this.refresh(cx), { size: "sm" }) })),
      )
      .child(this.body(t));
  }
}
