// Proxy: what the local CLIProxyAPI pool did. Requests, tokens, cache, latency and failures per
// model, account and client, with each subscription's live plan usage. The data side is
// proxy.py (collects the proxy's usage queue into SQLite and reports it as JSON).

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { appHome, closeOverlay, exec, home, notify, props, readTextFile, theme } from "herdr";

import { ago, alpha, badge, dot, icon, num, ok, scrollArea } from "./shared/proxy-ui.js";
import { accounts, models, overview, requests, routingActions } from "./shared/proxy-views.js";

const REFRESH_MS = 30_000;
const RANGES = ["1h", "24h", "7d", "30d", "all"];
const TABS = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "accounts", label: "Accounts", key: "3" },
  { id: "requests", label: "Requests", key: "4" },
];
const PLIST = () => `${home()}/Library/LaunchAgents/sh.herdr.proxy-stats.plist`;
const SCRIPT = () => `${appHome()}/mods/proxy/proxy.py`;

export default class Proxy extends View {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.h.focus();
    this.range = localStorage.getItem("range") ?? "24h";
    this.tab = localStorage.getItem("tab") ?? "overview";
    this.data = null;
    this.error = null;
    this.loading = false;
    this.collector = true;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const range = this.range;
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", [SCRIPT(), "report", range]);
        const out = JSON.parse(r.stdout || "{}");
        if (!out.ok) throw new Error(out.error || r.stderr || "proxy.py failed");
        if (range === this.range) {
          this.data = out;
          this.error = null;
          this.updated = Date.now() / 1000;
        }
        this.collector = (await readTextFile(PLIST()).catch(() => null)) != null;
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
    localStorage.setItem("range", r);
    this.refresh(cx);
  }

  setTab(id, cx) {
    this.tab = id;
    localStorage.setItem("tab", id);
    cx.notify();
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  header(t) {
    const d = this.data;
    const up = d?.proxy?.up;
    const pill = (id, label, on, click) =>
      div()
        .id(id)
        .h(24)
        .px(10)
        .flex()
        .items_center()
        .rounded(7)
        .text_size(12)
        .cursor_pointer()
        .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
        .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => click(cx))
        .child(label);
    const group = children => h_flex().flex_none().p(3).gap(2).rounded(9).bg(alpha(t.foreground, 0.055)).children(children);
    return v_flex()
      .gap(12)
      .px(20)
      .pt(16)
      .pb(12)
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(icon("layers", 16, t.accent))
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Proxy usage"))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(dot(d ? (up ? ok(t) : t.blocked) : t.dim))
              .child(
                div()
                  .text_size(11.5)
                  .text_color(t.dim)
                  .child(!d ? "connecting…" : up ? "CLIProxyAPI on 127.0.0.1:8317" : `proxy unreachable: ${d.proxy.error ?? ""}`),
              ),
          )
          .child(div().flex_1())
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(this.loading ? "refreshing…" : this.updated ? `updated ${ago(this.updated)}` : ""),
          )
          .child(
            div()
              .id("refresh")
              .size(26)
              .flex()
              .items_center()
              .justify_center()
              .rounded(7)
              .cursor_pointer()
              .hover(s => s.bg(alpha(t.foreground, 0.07)))
              .tooltip("Refresh (R)")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => this.refresh(cx))
              .child(icon("repeat", 13, t.muted)),
          )
          .when(!!props()?.overlay, el =>
            el.child(
              div()
                .id("close")
                .size(26)
                .flex()
                .items_center()
                .justify_center()
                .rounded(7)
                .cursor_pointer()
                .hover(s => s.bg(alpha(t.foreground, 0.07)))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click(() => this.close())
                .child(icon("x", 13, t.muted)),
            ),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(group(TABS.map(x => pill(`tab-${x.id}`, x.label, this.tab === x.id, cx => this.setTab(x.id, cx)))))
          .child(div().flex_1())
          .child(group(RANGES.map(r => pill(`range-${r}`, r === "all" ? "All" : r, this.range === r, cx => this.setRange(r, cx))))),
      );
  }

  footer(t) {
    const d = this.data;
    return h_flex()
      .gap(10)
      .items_center()
      .px(20)
      .h(34)
      .border_t(1)
      .border_color(alpha(t.border, 0.8))
      .text_size(11)
      .text_color(t.dim)
      .child(div().child(d?.db?.rows ? `${num(d.db.rows)} requests recorded since ${new Date(d.db.first * 1000).toLocaleDateString()}` : "No requests recorded yet"))
      .child(div().flex_1())
      .when(!this.collector, el =>
        el.child(
          h_flex()
            .id("collector-hint")
            .gap(6)
            .items_center()
            .tooltip(`The proxy forgets usage after an hour. Run once to keep collecting while this is closed:\npython3 ${SCRIPT()} install`)
            .child(badge(t, "collecting only while open", t.working)),
        ),
      )
      .child(div().child("1–4 views · R refresh · Esc close"));
  }

  body(t) {
    const d = this.data;
    if (!d)
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(6)
        .child(div().text_size(13).text_color(this.error ? t.blocked : t.muted).child(this.error ? "Couldn't load usage" : "Loading…"))
        .when(!!this.error, el => el.child(div().max_w(560).text_size(11.5).text_color(t.dim).child(this.error)));
    const o = { goto: (tab, cx) => this.setTab(tab, cx), routing: (this.routing ??= routingActions(this, SCRIPT(), exec, notify)) };
    const view =
      this.tab === "models" ? models(t, d) : this.tab === "accounts" ? accounts(t, d) : this.tab === "requests" ? requests(t, d) : overview(t, d, o);
    return scrollArea(`scroll-${this.tab}`, v_flex().px(20).py(16).gap(14).child(view));
  }

  render() {
    const t = theme();
    return v_flex()
      .id("proxy")
      .size_full()
      .bg(t.surface ?? t.background)
      .track_focus(this.h)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const tab = TABS.find(x => x.key === e.key);
        if (tab) this.setTab(tab.id, cx);
        else if (e.key === "r") this.refresh(cx);
        else if (e.key === "escape") this.close();
        else return;
        cx.stop_propagation();
      })
      .child(this.header(t))
      .child(this.body(t))
      .when(!!this.error && !!this.data, el =>
        el.child(div().px(20).py(6).text_size(11).text_color(t.blocked).bg(alpha(t.blocked, 0.08)).child(`Last refresh failed: ${this.error}`)),
      )
      .child(this.footer(t));
  }
}
