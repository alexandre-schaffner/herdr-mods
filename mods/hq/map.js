// Map: HQ's home. The org and the work in flight as a live diagram: the PR Lens graph the master
// keeps (`hq lens`), drawn natively (lanes, cards, edges) with live state laid over it from the
// snapshot: a manager working spins, one that needs you turns red. Zoom with ⌘-scroll, + and −,
// or Fit; scroll to pan. Click a card for its inspector: a manager's opens its full detail.

import { h_flex, Scrollbar, v_flex } from "gpui-base";
import { div, PathBuilder } from "gpui-kit";
import { readTextFile } from "herdr";

import { ago, alpha, btn, chip, clip, icon, mdBlock, mix, mono, ok, plain, row, SP, statusGlyph, statusLook, tone, TYPE } from "./ui.js";

// Layout units at zoom 1 (px).
// Cards sit `inset` in from a lane's left edge; same-lane links run down the `gutter` on their right.
const U = { pad: 32, laneW: 250, laneGap: 40, head: 52, cardH: 92, rowGap: 32, inset: 14, gutter: 24 };
/** Units between links that share a track. */
const TRACK = 5;
const ZMIN = 0.35;
const ZMAX = 2;

const KIND_ICON = {
  service: "layers",
  app: "square",
  module: "braces",
  function: "code",
  route: "arrow-right",
  job: "bolt",
  queue: "list",
  datastore: "save",
  cache: "repeat",
  external: "external",
  ui: "eye",
  config: "settings",
  test: "check",
  package: "git-branch",
  other: "square",
};

export class MapView {
  constructor(app) {
    this.app = app;
    this.z = Number(localStorage.getItem("map.zoom.v2") ?? 0) || null; // null: fit on first layout
    this.sel = null;
    this.size = null;
    this.allLinks = localStorage.getItem("map.links") === "all";
    // Zoom follows Fit (reflowing to the window's shape) until the person zooms by hand.
    this.autoFit = localStorage.getItem("map.autofit") !== "0";
  }

  /** Links worth drawing: within a lane (the lane's own story), the hero, what changed, and
   *  every link of the selected card. The master's "directs" links and unchanged context
   *  between lanes stay hidden unless asked for: the lanes already say who owns what. */
  essential(e, g) {
    if (this.allLinks) return true;
    if (this.sel && (e.from === this.sel || e.to === this.sel)) return true;
    if (e.emphasis === "hero") return true;
    const a = g.pos[e.from];
    const b = g.pos[e.to];
    if (a && b && a.lane === b.lane) return true;
    if (e.from === "master" || e.to === "master") return false;
    return !!e.delta && e.delta !== "unchanged" && e.delta !== "removed";
  }

  onShow(cx, arg) {
    if (arg?.node) {
      this.sel = null;
      this.pick(arg.node, cx);
    }
    // TEMP drive (hq pass verification): /tmp/hq-pass/drive.json sets zoom, fit, selection, palette.
    cx.spawn(async cx => {
      const s = JSON.parse((await readTextFile("/tmp/hq-pass/drive.json").catch(() => null)) ?? "null");
      if (!s) return;
      if (s.zoom) this.setZoom(s.zoom, cx);
      if (s.fit) this.fit(cx);
      if ("sel" in s) {
        this.sel = null;
        if (s.sel) this.pick(s.sel, cx);
      }
      if ("palette" in s) s.palette ? this.app.palette.show(cx) : this.app.palette.hide(cx);
      cx.notify();
    });
  }

  setZoom(z, cx, manual = true) {
    // A hand zoom leaves Fit mode; Fit (manual = false) returns to it.
    this.autoFit = !manual;
    localStorage.setItem("map.autofit", this.autoFit ? "1" : "0");
    this.z = Math.max(ZMIN, Math.min(ZMAX, Math.round(z * 100) / 100));
    localStorage.setItem("map.zoom.v2", String(this.z));
    cx.notify();
  }

  fit(cx) {
    if (!this.graph()) return;
    const f = this.fitted();
    if (!f) return;
    this.cols = f.c;
    this.setZoom(f.z, cx, false);
  }

  /** The canvas's own box changed (the window, the panel opening or closing): Fit follows it;
   *  a hand zoom keeps its zoom and reflows the lanes to the new width. */
  onCanvasSize(size, cx) {
    this.size = size;
    if (this.autoFit || this.z == null) return this.fit(cx);
    this.cols = this.colsAt(this.z);
    cx.notify();
  }

  pick(id, cx) {
    this.sel = this.sel === id ? null : id;
    const m = this.sel && this.managerFor(this.sel);
    if (m) this.app.views.org.select(m === "master" ? "master" : m.id, cx);
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "=" || e.key === "+") return this.setZoom((this.z ?? 1) * 1.15, cx), true;
    if (e.key === "-") return this.setZoom((this.z ?? 1) / 1.15, cx), true;
    if (e.key === "0") return this.fit(cx), true;
    if (e.key === "escape" && this.sel) {
      this.sel = null;
      cx.notify();
      return true;
    }
    return false;
  }

  /** A node's live counterpart: the master, a manager (by id or name), or null. */
  managerFor(id) {
    const d = this.app.data;
    if (!d || !id) return null;
    const n = this.graph()?.byId[id];
    if (id === "master") return "master";
    const key = s => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return d.managers.find(m => m.status !== "retired" && (m.id === id || key(m.name) === key(n?.label) || key(m.id) === key(n?.label))) ?? null;
  }

  /** What a manager (or the master) is doing right now, for a card that has no subtitle. */
  liveLine(id) {
    const m = this.managerFor(id);
    const f = m === "master" ? this.app.data.master.facts : m?.facts;
    if (!f) return null;
    const st = m === "master" ? this.app.data.master.status : m.status;
    return clip(plain(st === "working" ? f.doing || f.said : f.said || f.doing), 60) || null;
  }

  liveStatus(id) {
    const m = this.managerFor(id);
    if (m === "master") return this.app.data.master.terminal ? this.app.data.master.status : "gone";
    if (m) return m.live ? m.status : "gone";
    return null;
  }

  // ---- layout: lanes as columns; within a lane, longest path along the lane's own edges.

  graph() {
    const doc = this.app.data?.lens?.doc;
    if (!doc?.nodes?.length) return null;
    if (this._doc !== doc) {
      const lanes = [...(doc.lanes ?? [])].map((l, i) => ({ ...l, i })).sort((a, b) => (a.order ?? 1e3 + a.i) - (b.order ?? 1e3 + b.i));
      const byId = Object.fromEntries(doc.nodes.map(n => [n.id, n]));
      const edges = (doc.edges ?? []).filter(e => byId[e.from] && byId[e.to]);
      const inLane = {};
      for (const e of edges) if (byId[e.from].lane === byId[e.to].lane) (inLane[e.to] ??= []).push(e.from);
      const rank = {};
      const depth = (id, seen = new Set()) => {
        if (rank[id] != null) return rank[id];
        if (seen.has(id)) return 0;
        seen.add(id);
        return (rank[id] = Math.max(-1, ...(inLane[id] ?? []).map(p => depth(p, seen))) + 1);
      };
      doc.nodes.forEach(n => depth(n.id));
      for (const l of lanes)
        l.nodes = doc.nodes.map((n, i) => ({ n, i })).filter(x => x.n.lane === l.id).sort((a, b) => rank[a.n.id] - rank[b.n.id] || a.i - b.i).map(x => x.n);
      this._doc = doc;
      this._base = { doc, lanes, byId, edges };
      this._layouts = {};
      const f = this.size && this.autoFit ? this.fitted() : null;
      if (f) [this.cols, this.z] = [f.c, f.z];
      else if (this.size) this.cols = this.colsAt(this.z ?? 1);
    }
    return this.layout(this.cols ?? this._base.lanes.length);
  }

  /** Lanes in a grid of `cols` columns (reading order), each grid row as tall as its fullest lane. */
  layout(cols) {
    const base = this._base;
    const c = Math.max(1, Math.min(cols, base.lanes.length));
    if (this._layouts[c]) return this._layouts[c];
    const pos = {};
    const bands = [];
    let y = U.pad;
    for (let r = 0; r * c < base.lanes.length; r++) {
      const rowLanes = base.lanes.slice(r * c, r * c + c);
      const rows = Math.max(1, ...rowLanes.map(l => l.nodes.length));
      const bandH = U.head + rows * (U.cardH + U.rowGap) - U.rowGap + U.inset + 4;
      rowLanes.forEach((l, k) => {
        const x = U.pad + k * (U.laneW + U.laneGap);
        bands.push({ l, x, y, h: bandH });
        l.nodes.forEach((n, i) => {
          pos[n.id] = { x: x + U.inset, y: y + U.head + i * (U.cardH + U.rowGap), w: U.laneW - U.inset - U.gutter, h: U.cardH, lane: `${r}:${k}`, col: k, row: r, i, laneX: x, rows: l.nodes.length };
        });
      });
      y += bandH + U.laneGap;
    }
    const W = U.pad * 2 + c * U.laneW + (c - 1) * U.laneGap;
    const H = y - U.laneGap + U.pad;
    return (this._layouts[c] = { ...base, pos, bands, W, H, cols: c });
  }

  /** The column count whose layout fits the canvas at the largest zoom, and that zoom (floored,
   *  so the fitted map never overflows by a rounding pixel). */
  fitted() {
    if (!this._base || !this.size) return null;
    let best = null;
    for (let c = 1; c <= this._base.lanes.length; c++) {
      const g = this.layout(c);
      const z = Math.min(this.size.width / g.W, this.size.height / g.H);
      if (!best || z > best.z + 0.001) best = { c, z };
    }
    return { c: best.c, z: Math.max(ZMIN, Math.min(1.25, Math.floor(best.z * 100) / 100)) };
  }

  /** At a hand-set zoom: the most columns whose width fits the canvas. */
  colsAt(z) {
    for (let c = this._base.lanes.length; c > 1; c--) if (this.layout(c).W * z <= this.size.width) return c;
    return 1;
  }

  // ---- drawing

  render(t, cx) {
    const d = this.app.data;
    const g = this.graph();
    return v_flex()
      .id("map-root")
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(this.toolbar(t, d, g))
      .child(
        row()
          .flex_1()
          .min_h(0)
          .child(g ? v_flex().flex_1().min_w(0).min_h(0).child(this.canvas(t, d, g)).child(this.legend(t)) : this.empty(t))
          .when(!!this.sel && !!g?.byId[this.sel], el => el.child(this.drawer(t, d, g))),
      );
  }

  /** What each kind of card means, and how to move around. */
  legend(t) {
    const item = (mark, word) => h_flex().gap(6).items_center().child(mark).child(div().text_size(TYPE.meta).text_color(t.muted).child(word));
    const swatch = cat => {
      const l = cardLook(t, cat);
      return div().flex_none().w(16).h(11).rounded(l.radius * 0.35).border(1).when(!!l.dashed, el => el.border_dashed()).border_color(l.border).bg(l.bg);
    };
    return h_flex()
      .flex_none()
      .flex_wrap()
      .min_h(30)
      .py(6)
      .px(SP.lg)
      .gap(SP.lg)
      .items_center()
      .border_t(1)
      .border_color(alpha(t.border, 0.6))
      .child(item(div().flex_none().w(12).h(12).rounded_full().border(1.5).border_color(t.muted).bg(alpha(t.muted, 0.16)), "Agent"))
      .child(item(icon(null, 12, t.accent, "mods/hq/icons/git-pull-request.svg"), "Pull request"))
      .child(item(swatch("process"), "Process"))
      .child(item(swatch("file"), "File"))
      .child(div().flex_1())
      .child(div().text_size(TYPE.meta).text_color(t.muted).child("⌘-scroll or + − to zoom · 0 fits · scroll to pan · click a card for details · Esc closes it"));
  }

  toolbar(t, d, g) {
    const l = d.lens ?? {};
    const z = this.z ?? 1;
    const chips = g?.doc.stats?.chips ?? [];
    const tone = c => ({ added: ok(t), modified: t.ansi3 ?? t.working, removed: t.blocked, hero: t.accent })[c.tone] ?? t.muted;
    return row()
      .flex_none()
      .h(48)
      .px(SP.lg)
      .gap(SP.md)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .child(
        v_flex()
          .flex_none()
          .max_w(420)
          .gap(1)
          .child(div().truncate().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(clip(g?.doc.title ?? "Live map", 90)))
          .child(
            div()
              .text_size(TYPE.meta)
              .text_color(t.muted)
              .child(l.auto ? "Drawn from the org until the master publishes its map" : `Kept by the master · updated ${ago(l.at, d.now)}`),
          ),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .overflow_hidden()
          .children(
            chips.map((c, i) =>
              h_flex()
                .id(`map-chip-${i}`)
                .flex_none()
                .h(24)
                .px(8)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(alpha(tone(c), 0.1))
                .child(div().text_size(TYPE.meta).text_color(t.muted).child(c.label))
                .child(div().text_size(TYPE.meta).font_semibold().text_color(c.tone === "neutral" || !c.tone ? t.foreground : tone(c)).child(c.value)),
            ),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .p(2)
          .rounded(8)
          .bg(alpha(t.foreground, 0.05))
          .child(btn(t, "map-zoom-out", null, cx => this.setZoom(z / 1.2, cx), { kind: "ghost", size: "sm", icon: "minus", tooltip: "Zoom out (−)" }))
          .child(
            div()
              .id("map-zoom-level")
              .w(46)
              .text_center()
              .text_size(TYPE.meta)
              .font_medium()
              .text_color(t.foreground)
              .cursor_pointer()
              .tooltip("Back to 100%")
              .on_click((_e, cx) => this.setZoom(1, cx))
              .child(`${Math.round(z * 100)}%`),
          )
          .child(btn(t, "map-zoom-in", null, cx => this.setZoom(z * 1.2, cx), { kind: "ghost", size: "sm", icon: "plus", tooltip: "Zoom in (+)" }))
          .child(btn(t, "map-fit", "Fit", cx => this.fit(cx), { kind: this.autoFit ? "secondary" : "ghost", size: "sm", tooltip: "Fit the whole map and keep it fitted (0)" })),
      )
      .when(!!g, el => {
        const hidden = g.edges.filter(e => !this.essential(e, g)).length;
        return el.child(
          btn(t, "map-links", this.allLinks ? "Essential links" : hidden ? `All links (+${hidden})` : "All links", cx => {
            this.allLinks = !this.allLinks;
            localStorage.setItem("map.links", this.allLinks ? "all" : "essential");
            cx.notify();
          }, { kind: "ghost", size: "sm", icon: "flow", tooltip: "Essential: within a lane, the hero link and what changed. Select a card to see all of its links." }),
        );
      })
      .child(btn(t, "map-new", null, cx => this.app.go("org", cx, { create: true }), { kind: "ghost", size: "sm", icon: "user", tooltip: "New manager" }));
  }

  empty(t) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(SP.sm)
      .child(icon("flow", 26, t.muted))
      .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("No map yet"))
      .child(div().max_w(420).text_center().text_size(TYPE.ui).text_color(t.muted).child("Once the org has a master and managers, the map draws itself here, and the master keeps it current."));
  }

  canvas(t, d, g) {
    const z = this.z ?? 1;
    const S = v => Math.round(v * z);
    const children = [];
    // Lane bands.
    g.bands.forEach(({ l, x, y, h }) => {
      children.push(
        v_flex()
          .absolute()
          .left(S(x))
          .top(S(y))
          .w(S(U.laneW))
          .h(S(h))
          .rounded(S(14))
          .bg(alpha(t.foreground, 0.035))
          .px(S(U.inset))
          .pt(S(14))
          .child(
            h_flex()
              .gap(S(6))
              .items_center()
              .child(div().min_w(0).truncate().text_size(S(12.5)).font_semibold().text_color(t.foreground).child(l.label))
              .when(!!DELTA_TONE[l.delta], el => el.child(deltaDot(t, l.delta, S(7)))),
          )
          .when(!!l.subtitle, el => el.child(div().min_w(0).truncate().text_size(S(11)).text_color(t.muted).child(l.subtitle))),
      );
    });
    // Edges, grouped by look so each look is one native path.
    const pens = {};
    const pen = key =>
      (pens[key] ??= {
        pb: key.endsWith(":dash")
          ? PathBuilder.stroke(Math.max(1, S(1.4))).dash_array([Math.max(3, S(4)), Math.max(3, S(4))])
          : PathBuilder.stroke(key.startsWith("hero") || key.startsWith("focus") ? Math.max(2, S(2.4)) : Math.max(1, S(1.4))),
        heads: [],
      });
    // Orthogonal routes through free space only (see route()), spread where they share a track.
    const routes = spread(g.edges.filter(e => g.pos[e.from] && g.pos[e.to] && this.essential(e, g)).map(e => ({ e, ...route(g.pos[e.from], g.pos[e.to]) })));
    // Labels keep off the cards, the lane titles and each other.
    const taken = [...Object.values(g.pos), ...g.bands.map(b => ({ x: b.x, y: b.y, w: U.laneW, h: U.head }))];
    const labels = [];
    for (const { e, pts, label } of routes) {
      const touches = this.sel && (e.from === this.sel || e.to === this.sel);
      const look = touches ? `focus${e.animated ? ":anim" : ""}` : edgeLook(e);
      const p = pen(look);
      p.pb = roundedPolyline(p.pb, pts.map(([x, y]) => [S(x), S(y)]), S(8));
      const [[px, py], [ex, ey]] = pts.slice(-2);
      p.heads.push(arrowHead(S(ex), S(ey), Math.sign(ex - px), Math.sign(ey - py), Math.max(6, S(7)), Math.max(3.5, S(4))));
      // Labels only where they carry news: the hero, changes, or the selected card's edges.
      if (e.label && (touches || e.emphasis === "hero" || (e.delta && e.delta !== "unchanged" && !this.sel)))
        labels.push({ e, look, ...labelSpot(pts[label], pts[label + 1], labelW(e.label), taken) });
    }
    const dim = this.sel ? 0.35 : 1;
    const color = look =>
      ({ focus: t.accent, hero: alpha(t.accent, dim), removed: alpha(t.muted, 0.45 * dim), unchanged: alpha(t.muted, 0.55 * dim) })[look.split(":")[0]] ??
      alpha(docTone(t, look.split(":")[0]), 0.85 * dim);
    const still = this.app.palette.open;
    for (const [look, p] of Object.entries(pens)) {
      const line = window.paint_path(p.pb.build(), color(look)).absolute().left(0).top(0).w(S(g.W)).h(S(g.H));
      children.push(look.includes(":anim") && !still ? line.loop("opacity", { from: 0.3, to: 1, period: 1400 }) : line);
      let heads = PathBuilder.fill();
      for (const h of p.heads) heads = heads.add_polygon(h, true);
      children.push(window.paint_path(heads.build(), color(look)).absolute().left(0).top(0).w(S(g.W)).h(S(g.H)));
    }
    // Edge labels.
    labels.forEach(({ e, x, y, look }, i) =>
      children.push(
        div()
          .id(`map-elabel-${i}`)
          .absolute()
          .left(S(x) - S(labelW(e.label) / 2))
          .top(S(y) - S(9))
          .w(S(labelW(e.label)))
          .flex()
          .justify_center()
          .child(
            div()
              .px(S(6))
              .h(S(18))
              .flex()
              .items_center()
              .rounded(S(9))
              .bg(t.background)
              .border(1)
              .border_color(alpha(color(look), 0.6))
              .text_size(S(10.5))
              .text_color(look.startsWith("hero") ? t.accent : t.muted)
              .whitespace_nowrap()
              .tooltip(e.summary ? `${e.label}: ${plain(e.summary)}` : e.label)
              .child(clip(e.label, 40)),
          ),
      ),
    );
    // Cards.
    for (const n of g.doc.nodes) {
      const p = g.pos[n.id];
      if (p) children.push(this.card(t, n, p, S));
    }
    const scroll = div()
      .id("map-scroll")
      .size_full()
      .overflow_scroll()
      .on_size_change((size, cx) => this.onCanvasSize(size, cx))
      .on_scroll_wheel((e, cx) => {
        const m = e.modifiers ?? {};
        if (!(m.platform || m.control)) return;
        const dy = e.delta?.y ?? 0;
        if (Math.abs(dy) < 0.5) return;
        this.setZoom(z * (dy > 0 ? 1.08 : 1 / 1.08), cx);
        cx.stop_propagation();
      })
      .on_click((_e, cx) => {
        if (this.sel) {
          this.sel = null;
          cx.notify();
        }
      })
      .child(div().relative().w(S(g.W)).h(S(g.H)).children(children));
    return v_flex()
      .relative()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(scroll)
      .child(Scrollbar.new("map-scroll").mode("always").absolute().inset_0());
  }

  /** What a node stands for, from its live counterpart, kind and label. */
  category(n) {
    if (n.id === "master" || this.managerFor(n.id)) return "agent";
    const label = n.label ?? "";
    if (n.kind === "package" || /^#\d+/.test(label)) return "pr";
    // By the map's convention (hq lens): sessions are `service` (managers, outside sessions) or
    // `job` (units, subagent waves); a merge-queue batch is a process even though it's a job.
    if (n.kind === "service") return "agent";
    if (n.kind === "job") return /^batch\b/i.test(label) ? "process" : "agent";
    if (["module", "function", "route", "config", "test"].includes(n.kind) || (n.files?.length && n.kind !== "external")) return "file";
    return "process";
  }

  card(t, n, p, S) {
    const cat = this.category(n);
    const live = this.liveStatus(n.id);
    const badgeLive = (n.badges ?? []).find(b => /^(working|blocked|needs you|done|idle|gone)$/i.test(b));
    const status = live ?? (badgeLive ? badgeLive.toLowerCase().replace("needs you", "blocked") : null);
    const on = this.sel === n.id;
    const removed = n.delta === "removed";
    const badges = (n.badges ?? []).filter(b => b !== badgeLive);
    const shown = badges.slice(0, 3);
    const alarm = status === "blocked" || status === "gone";
    const changed = !!DELTA_TONE[n.delta];
    const look = cardLook(t, cat, cat === "pr" ? toneColor(t, prTone(n)) : undefined);
    const border = alarm ? t.blocked : on ? t.accent : changed && cat !== "pr" ? alpha(docTone(t, n.delta), 0.75) : look.border;
    const strike = el => el.when(removed, e2 => e2.line_through());

    const badgeRow = shown.length
      ? h_flex()
          .flex_none()
          .gap(S(4))
          .min_w(0)
          .overflow_hidden()
          .children(shown.map((b, i) => badgeChip(t, b, S, `${n.id}-${i}`)))
          .when(badges.length > shown.length, e2 => e2.child(div().text_size(S(10)).text_color(t.muted).child(`+${badges.length - shown.length}`)))
      : null;
    const sub = n.subtitle || (cat === "agent" ? this.liveLine(n.id) : null);
    const corner = status ? statusGlyph(status, t, S(12), { still: this.app.palette.open }) : changed ? deltaDot(t, n.delta, S(7)) : null;
    // A row's lead icon and corner glyph sit on its first line when the title wraps.
    const top = el => div().flex_none().mt(S(2)).child(el);

    // Each kind of thing has its own body; the shell (position, selection, click) is shared.
    // An agent's badges line up with its text, past the avatar.
    const unit = cat === "agent" && n.id !== "master" && !this.managerFor(n.id);
    const avatar = unit ? 26 : 32;
    let body;
    if (cat === "agent") {
      const isMaster = n.id === "master";
      const tint = avatarColor(t, n.id);
      body = h_flex()
        .gap(S(10))
        .items_start()
        .child(
          div()
            .flex_none()
            .mt(S(1))
            .w(S(avatar))
            .h(S(avatar))
            .rounded_full()
            .border(S(2))
            .border_color(status ? statusLook(status, t).color : alpha(t.border, 0.9))
            .bg(alpha(tint, 0.16))
            .flex()
            .items_center()
            .justify_center()
            .child(
              isMaster
                ? icon("crown", S(14), t.accent)
                : unit
                  ? icon("bolt", S(12), tint)
                  : div().text_size(S(12)).font_semibold().text_color(tint).child(initials(n.label)),
            ),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(S(3))
            .child(
              h_flex()
                .gap(S(6))
                .items_center()
                .child(strike(div().flex_1().min_w(0).truncate().text_size(S(13)).line_height(1.3).font_semibold().text_color(t.foreground).child(n.label)))
                .when(!!corner, el => el.child(corner)),
            )
            .when(!!sub, el => el.child(lines(sub, S(11), 2, 20).text_color(t.muted))),
        );
    } else if (cat === "pr") {
      const m = /^(#\d+)\s*(.*)$/.exec(n.label ?? "");
      const num = m ? m[1] : null;
      const title = m ? m[2] || n.subtitle || "" : n.label;
      body = v_flex()
        .gap(S(4))
        .child(
          h_flex()
            .gap(S(6))
            .items_start()
            .child(top(icon(null, S(13), look.c, "mods/hq/icons/git-pull-request.svg")))
            .when(!!num, el => el.child(div().flex_none().text_size(S(13)).line_height(1.3).font_semibold().font_family(mono()).text_color(look.c).child(num)))
            .child(strike(lines(title, S(12.5), 2, 15).flex_1().font_medium().text_color(t.foreground)))
            .when(!!corner && !!status, el => el.child(top(corner))),
        )
        .when(!!(m && n.subtitle), el => el.child(div().min_w(0).truncate().text_size(S(11)).text_color(t.muted).child(n.subtitle)));
    } else if (cat === "file") {
      const path = n.files?.[0]?.path;
      body = v_flex()
        .gap(S(4))
        .child(
          h_flex()
            .gap(S(6))
            .items_start()
            .child(top(icon("file-text", S(13), t.muted)))
            .child(
              path
                ? div().flex_1().min_w(0).text_ellipsis_start().whitespace_nowrap().overflow_hidden().text_size(S(12)).line_height(1.3).font_family(mono()).text_color(t.foreground).child(path)
                : strike(lines(n.label, S(12), 2, 18).flex_1().font_medium().text_color(t.foreground)),
            )
            .when(!!corner, el => el.child(top(corner))),
        )
        .when(!!(path || n.subtitle), el => el.child(div().min_w(0).truncate().text_size(S(11)).text_color(t.muted).child(path ? n.label : n.subtitle)));
    } else {
      const ic = PROCESS_ICON[n.kind];
      body = v_flex()
        .gap(S(4))
        .child(
          h_flex()
            .gap(S(7))
            .items_start()
            .child(
              div()
                .flex_none()
                .w(S(20))
                .h(S(20))
                .rounded(S(4))
                .bg(alpha(t.foreground, 0.08))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(ic ?? null, S(12), t.muted, ic ? undefined : "mods/hq/icons/cpu.svg")),
            )
            .child(strike(lines(n.label, S(12), 2, 18).flex_1().font_medium().text_color(t.foreground)))
            .when(!!corner, el => el.child(top(corner))),
        )
        .when(!!n.subtitle, el => el.child(div().min_w(0).truncate().text_size(S(11)).text_color(t.muted).child(n.subtitle)));
    }

    return v_flex()
      .id(`map-node-${n.id}`)
      .absolute()
      .left(S(p.x))
      .top(S(p.y))
      .w(S(p.w))
      .h(S(p.h))
      .px(S(12))
      .py(S(9))
      .gap(S(5))
      .overflow_hidden()
      .rounded(S(look.radius))
      .bg(on ? mix(look.bg, t.accent, 0.08) : look.bg)
      .border(on ? 2 : 1)
      .when(!!look.dashed, el => el.border_dashed())
      .border_color(border)
      .when(removed, el => el.opacity(0.5))
      .cursor_pointer()
      .hover(s => s.border_color(t.accent))
      .tooltip([`${CAT_WORD[cat]}: ${n.label}`, n.subtitle, n.summary ? plain(n.summary) : null].filter(Boolean).join("\n"))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.pick(n.id, cx);
      })
      .child(body.min_h(0).overflow_hidden())
      .when(!!badgeRow, el => el.child(cat === "agent" ? div().flex_none().pl(S(avatar + 10)).child(badgeRow) : badgeRow));
  }

  drawer(t, d, g) {
    const n = g.byId[this.sel];
    const m = this.managerFor(n.id);
    const body = m
      ? this.app.views.org.detail(t)
      : v_flex()
          .p(SP.xl)
          .gap(SP.md)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .child(icon(KIND_ICON[n.kind] ?? "square", 16, t.muted))
              .child(div().text_size(TYPE.heading).font_semibold().child(n.label)),
          )
          .when(!!n.subtitle, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child(n.subtitle)))
          .child(
            h_flex()
              .gap(6)
              .flex_wrap()
              .child(chip(t, n.kind, t.muted))
              .when(!!n.delta && n.delta !== "unchanged", el => el.child(chip(t, n.delta, { added: ok(t), modified: t.ansi3 ?? t.working, removed: t.blocked }[n.delta])))
              .children((n.badges ?? []).map(b => chip(t, b, t.accent))),
          )
          .when(!!n.summary, el => el.child(mdBlock(t, `map-sum-${n.id}`, n.summary, { maxW: 500 })))
          .child(
            v_flex()
              .gap(4)
              .pt(SP.sm)
              .children(
                g.edges
                  .filter(e => e.from === n.id || e.to === n.id)
                  .map((e, i) => {
                    const other = g.byId[e.from === n.id ? e.to : e.from];
                    return h_flex()
                      .id(`map-rel-${i}`)
                      .gap(6)
                      .items_center()
                      .cursor_pointer()
                      .hover(s => s.underline())
                      .on_click((_e, cx) => this.pick(other.id, cx))
                      .child(icon(e.from === n.id ? "arrow-right" : "arrow-left", 11, t.muted))
                      .child(div().text_size(TYPE.ui).text_color(t.foreground).child(other.label))
                      .when(!!e.label, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(e.label)));
                  }),
              ),
          );
    return v_flex()
      .flex_none()
      .w(560)
      .min_h(0)
      .border_l(1)
      .border_color(t.border)
      .bg(t.background)
      .child(
        row()
          .flex_none()
          .h(36)
          .px(SP.md)
          .items_center()
          .border_b(1)
          .border_color(alpha(t.border, 0.6))
          .child(div().flex_1().text_size(TYPE.meta).text_color(t.muted).child(m ? "Manager" : "On the map"))
          .child(btn(t, "map-drawer-close", null, cx => ((this.sel = null), cx.notify()), { kind: "ghost", size: "sm", icon: "x", tooltip: "Close (Esc)" })),
      )
      .child(v_flex().flex_1().min_h(0).child(m ? body : div().id("map-drawer-scroll").size_full().overflow_y_scroll().child(body)));
  }
}

/**
 * A link's path through free space only, in layout units: its points, and which segment carries
 * its label. Cards sit in lanes (columns) and rows; between lanes run vertical gaps, between card
 * rows horizontal gaps, and inside a lane a gutter to the right of the cards.
 *   - same lane, next card: straight down the middle;
 *   - same lane, further: out the right side, down the gutter, in the right side;
 *   - other lane: out the facing side into the lane gap, along the row gap just above the
 *     target (or below it for a first-row target) to the gap beside the target's lane, then in.
 */
function route(a, b) {
  const midY = p => p.y + p.h / 2;
  const gapR = p => p.laneX + U.laneW + U.laneGap / 2;
  const gapL = p => p.laneX - U.laneGap / 2;
  if (a.lane === b.lane) {
    const down = b.y > a.y;
    if (Math.abs(b.i - a.i) === 1) {
      const x = a.x + a.w / 2;
      return { pts: [[x, down ? a.y + a.h : a.y], [x, down ? b.y : b.y + b.h]], label: 0 };
    }
    const gx = a.x + a.w + U.gutter / 2;
    return { pts: [[a.x + a.w, midY(a)], [gx, midY(a)], [gx, midY(b)], [b.x + b.w, midY(b)]], label: 1 };
  }
  const right = b.col > a.col || (b.col === a.col && b.row !== a.row);
  const sx = right ? a.x + a.w : a.x;
  const g1 = right ? gapR(a) : gapL(a);
  // Entering the target from the side that faces the source (same column: the right side).
  const enterRight = b.col <= a.col;
  const tx = enterRight ? b.x + b.w : b.x;
  const g2 = enterRight ? gapR(b) : gapL(b);
  // Neighbouring lanes (or the same column in another band): one shared gap.
  if (Math.abs(g1 - g2) < 1) return { pts: [[sx, midY(a)], [g1, midY(a)], [g1, midY(b)], [tx, midY(b)]], label: 1 };
  const ch = b.i > 0 ? b.y - U.rowGap / 2 : b.y + b.h + U.rowGap / 2;
  return { pts: [[sx, midY(a)], [g1, midY(a)], [g1, ch], [g2, ch], [g2, midY(b)], [tx, midY(b)]], label: 2 };
}

/** Links that run along the same track (a vertical at one x, a horizontal at one y, which
 *  includes several links leaving or entering one card side) each get their own, TRACK units
 *  apart, alternating either side of it. Mutates and returns the routes. */
function spread(routes) {
  const used = {};
  const take = key => {
    const n = (used[key] = (used[key] ?? 0) + 1) - 1;
    return (n % 2 ? 1 : -1) * Math.ceil(n / 2) * TRACK;
  };
  for (const { pts } of routes) {
    const segs = pts.slice(1).map((q, k) => ({ k, vertical: q[0] === pts[k][0] }));
    for (const { k, vertical } of segs) {
      const off = vertical ? take(`v:${pts[k][0]}`) : take(`h:${pts[k][1]}`);
      for (const q of [pts[k], pts[k + 1]]) q[vertical ? 0 : 1] += off;
    }
  }
  return routes;
}

/** Where a label sits on its segment: the free spot nearest the middle, stepping along it a few
 *  units at a time, so it never covers a box in `taken` (cards, lane titles, labels). Takes its box. */
function labelSpot([x1, y1], [x2, y2], w, taken) {
  const n = Math.max(1, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 6));
  const fs = Array.from({ length: n + 1 }, (_, i) => i / n).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));
  const at = f => ({ x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f });
  const box = s => ({ x: s.x - w / 2, y: s.y - 9, w, h: 18 });
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const spot = fs.map(at).find(s => !taken.some(o => hits(box(s), o))) ?? at(0.5);
  taken.push(box(spot));
  return spot;
}

/** A polyline with its corners rounded (radius r, clipped to half of each segment). */
function roundedPolyline(pb, pts, r) {
  pb = pb.move_to(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    const [x, y] = pts[k];
    if (k === pts.length - 1) {
      pb = pb.line_to(x, y);
      break;
    }
    const [px, py] = pts[k - 1];
    const [nx, ny] = pts[k + 1];
    const d1 = Math.hypot(x - px, y - py);
    const d2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) {
      pb = pb.line_to(x, y);
      continue;
    }
    const ax = x - ((x - px) / d1) * rr;
    const ay = y - ((y - py) / d1) * rr;
    const bx = x + ((nx - x) / d2) * rr;
    const by = y + ((ny - y) / d2) * rr;
    pb = pb.line_to(ax, ay).curve_to(bx, by, x, y);
  }
  return pb;
}

/** A label chip's width in layout units, from its (clipped) text. */
function labelW(text) {
  return Math.min(40, (text ?? "").length) * 6.2 + 16;
}

const CAT_WORD = { agent: "Agent", pr: "Pull request", process: "Process", file: "File" };
const PROCESS_ICON = { queue: "list", datastore: "save", cache: "repeat", external: "external", ui: "eye", app: "square", service: "layers" };

/** A badge's tone from its words, most urgent first; the first match wins. */
const BADGE_TONES = [
  ["merged", /merged|landed/],
  ["alert", /block|fail|\bred\b|conflict|limit|gone|needs you/],
  ["ok", /ready|green|pass|approved|done|ticking/],
  ["warn", /\bci\b|review|wait|held|queue|draft|rerun|re-?gat|restart|batch|needs|\d+k ctx/],
];
const badgeTone = text => BADGE_TONES.find(([, re]) => re.test(text.toLowerCase()))?.[0] ?? "muted";
/** A PR's state from all of its badges: merged, blocked, ready, in flight, else open. */
const prTone = n => ["merged", "alert", "ok", "warn"].find(x => (n.badges ?? []).some(b => badgeTone(b) === x)) ?? "info";
const toneColor = (t, name) => (name === "merged" ? (t.ansi5 ?? t.accent) : tone(t)[name]);

/** The map document's change and chip words, as tones. */
const DELTA_TONE = { added: "ok", modified: "warn", removed: "muted" };
const docTone = (t, word) => tone(t)[{ ...DELTA_TONE, hero: "info" }[word]] ?? t.muted;

/** Each kind of card's surface, shared by the cards and the legend. Fills are opaque so links never show through. */
function cardLook(t, cat, c = t.accent) {
  const base = (t.background ?? "#ffffff").slice(0, 7);
  return {
    agent: { radius: 16, bg: base, border: alpha(t.border, 0.9) },
    pr: { radius: 7, bg: mix(base, c, 0.06), border: alpha(c, 0.55), c },
    process: { radius: 4, bg: mix(base, t.foreground, 0.045), border: alpha(t.foreground, 0.16) },
    file: { radius: 6, bg: base, border: alpha(t.foreground, 0.3), dashed: true },
  }[cat];
}

/** Text wrapped to at most `n` lines: clipped to about that many characters, its height capped as a backstop. */
function lines(text, size, n, perLine) {
  return div().min_w(0).text_size(size).line_height(1.3).max_h(Math.ceil(size * 1.3 * n)).overflow_hidden().child(clip(text, perLine * n));
}

const AVATAR_SLOTS = ["ansi4", "ansi5", "ansi6", "ansi2", "ansi3", "ansi12", "ansi13", "ansi14"];
function avatarColor(t, id) {
  let h = 0;
  for (const ch of id ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return t[AVATAR_SLOTS[h % AVATAR_SLOTS.length]] ?? t.accent;
}

function initials(label) {
  const words = (label ?? "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

function edgeLook(e) {
  const kind = e.emphasis === "hero" ? "hero" : (e.delta ?? "unchanged");
  return `${kind}${e.animated ? ":anim" : ""}${e.delta === "removed" ? ":dash" : ""}`;
}

/** A filled arrowhead at (x, y) pointing along (sx, sy): L long, 2W wide, in pixels. */
function arrowHead(x, y, sx, sy, L, W) {
  if (sy) return [[x, y], [x - W, y - sy * L], [x + W, y - sy * L]];
  return [[x, y], [x - sx * L, y - W], [x - sx * L, y + W]];
}

function deltaDot(t, delta, size) {
  return div().flex_none().w(size).h(size).rounded_full().bg(docTone(t, delta)).tooltip(delta);
}

function badgeChip(t, text, S, key) {
  const c = toneColor(t, badgeTone(text));
  return div()
    .id(`map-badge-${key}`)
    .flex_none()
    .px(S(6))
    .h(S(18))
    .flex()
    .items_center()
    .rounded(S(5))
    .bg(alpha(c, 0.12))
    .text_size(S(10.5))
    .font_medium()
    .text_color(c)
    .whitespace_nowrap()
    .child(clip(text, 20));
}
