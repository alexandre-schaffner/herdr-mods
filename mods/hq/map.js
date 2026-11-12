// Map: HQ's home. The org and the work in flight as a live diagram: the PR Lens graph the master
// keeps (`hq lens`), drawn natively as a tree (the master at the root, each manager a branch, its
// work below it) with the links that cut across (stacked PRs, the merge queue) curving over it,
// and live state laid over it from the
// snapshot: a manager working spins, one that needs you turns red. Zoom with ⌘-scroll, + and −,
// or Fit; scroll to pan. Click a card for its inspector: a manager's opens its full detail.

import { h_flex, Scrollbar, v_flex } from "gpui-base";
import { div, PathBuilder } from "gpui-kit";

import { loadPr, prNumber, prPanel } from "./map-pr.js";
import { branch, buildTree, cross, fitted, labelSpot, labelW, layout, roundedPolyline, ZMAX, ZMIN } from "./map-tree.js";
import { agentMark, ago, alpha, btn, chip, clip, clock, drawer, empty, icon, lines, mdBlock, mix, mono, pageHeader, pane, plain, row, SP, statusGlyph, tone, toolbar, TYPE } from "./ui.js";

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
    this.z = Number(localStorage.getItem("map.zoom.v3") ?? 0) || null; // null: fit on first layout
    this.sel = null;
    this.size = null;
    this.allLinks = localStorage.getItem("map.links") === "all";
    // Zoom follows Fit (reflowing to the window's shape) until the person zooms by hand.
    this.autoFit = localStorage.getItem("map.autofit.v3") !== "0";
  }

  /** Links worth drawing: the tree's branches, the hero, what changed, and every link of the
   *  selected card. Unchanged links across branches stay hidden unless asked for. */
  essential(e, g) {
    if (g.tree.has(e.id ?? `${e.from}>${e.to}`)) return true; // the branches: always
    if (this.allLinks) return true;
    if (this.sel && (e.from === this.sel || e.to === this.sel)) return true;
    if (e.emphasis === "hero") return true;
    if (e.from === "master" || e.to === "master") return false;
    return !!e.delta && e.delta !== "unchanged" && e.delta !== "removed";
  }

  onShow(cx, arg) {
    if (arg?.node) {
      this.sel = null;
      this.pick(arg.node, cx);
    }
  }

  setZoom(z, cx, manual = true) {
    // A hand zoom leaves Fit mode; Fit (manual = false) returns to it.
    this.autoFit = !manual;
    localStorage.setItem("map.autofit.v3", this.autoFit ? "1" : "0");
    this.z = Math.max(ZMIN, Math.min(ZMAX, Math.round(z * 100) / 100));
    localStorage.setItem("map.zoom.v3", String(this.z));
    cx.notify();
  }

  fit(cx) {
    const f = this.fitting();
    if (!f) return;
    this.orient = f.o;
    this.setZoom(f.z, cx, false);
  }

  /** The canvas's own box changed (the window, the panel opening or closing): Fit follows it
   *  (and picks the tree's direction); a hand zoom keeps its zoom and direction. */
  onCanvasSize(size, cx) {
    this.size = size;
    if (this.autoFit || this.z == null) return this.fit(cx);
    cx.notify();
  }

  pick(id, cx) {
    const pn = this.graph()?.byId[id];
    if (pn && this.category(pn) === "pr" && prNumber(pn)) {
      this.allChecks = false;
      this.fullBody = false;
      loadPr(this, prNumber(pn), cx);
    }
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

  // ---- the map: the lens doc's tree (map-tree.js), laid out in the direction Fit picked

  /** The tree, rebuilt when a new map arrives; null until there is one. */
  base() {
    const doc = this.app.data?.lens?.doc;
    if (!doc?.nodes?.length) return null;
    if (this._doc !== doc) {
      this._doc = doc;
      this._base = buildTree(doc);
      this._layouts = {};
    }
    return this._base;
  }

  /** The tree laid out in direction `o`, kept until the map changes. */
  laid(o) {
    return (this._layouts[o] ??= layout(this._base, o));
  }

  /** The map as drawn. Only reads: Fit (and a new map, in onData) sets the direction and zoom. */
  graph() {
    return this.base() && this.laid(this.orient ?? "down");
  }

  /** The direction and zoom Fit picks for this map in this canvas; null before there's either. */
  fitting() {
    return this.base() && this.size ? fitted(["down", "right"].map(o => this.laid(o)), this.size) : null;
  }

  /** A new map reflows Fit to its shape; a hand zoom keeps its zoom and direction. */
  onData() {
    const prev = this._base;
    if (this.base() === prev || !this.autoFit) return;
    const f = this.fitting();
    if (f) [this.orient, this.z] = [f.o, f.z];
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
          .child(
            g
              ? v_flex().flex_1().min_w(0).min_h(0).child(this.canvas(t, d, g)).child(this.legend(t))
              : empty(t, "No map yet", "Once the org has a master and managers, the map draws itself here, and the master keeps it current.", { icon: "flow" }),
          )
          .when(!!this.sel && !!g?.byId[this.sel], el => el.child(this.drawer(t, g))),
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
    const shown = chips.slice(0, 3);
    const title = g?.doc.title ?? "Live map";
    // The strip already names the repo.
    const repo = `${d.repo?.name ?? ""}: `.toLowerCase();
    const short = title.toLowerCase().startsWith(repo) ? title.slice(repo.length) : title;
    const asOf = l.at ? `From the master's map, as of ${clock(l.at)}` : null;
    return toolbar(t, [])
      .child(
        v_flex()
          .id("map-title")
          .flex_1()
          .min_w(0)
          .gap(1)
          .tooltip(title)
          .child(div().truncate().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(short))
          .child(
            div()
              .truncate()
              .text_size(TYPE.meta)
              .text_color(t.muted)
              .child(l.auto ? "Drawn from the org until the master publishes its map" : `Kept by the master · updated ${ago(l.at, d.now)}`),
          ),
      )
      .children(
        shown.map((c, i) => chip(t, c.label, docTone(t, c.tone), { id: `map-chip-${i}`, value: c.value, h: 24, size: TYPE.meta, tooltip: asOf })),
      )
      .when(chips.length > shown.length, el =>
        el.child(
          div()
            .id("map-chip-more")
            .flex_none()
            .text_size(TYPE.meta)
            .text_color(t.muted)
            .tooltip(chips.slice(shown.length).map(c => `${c.label}: ${c.value}`).join("\n"))
            .child(`+${chips.length - shown.length}`),
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
          }, { kind: "ghost", size: "sm", icon: "flow", tooltip: "Essential: the tree, the hero link and what changed. Select a card to see all of its links." }),
        );
      })
      .child(btn(t, "map-new", null, cx => this.app.go("org", cx, { create: true }), { kind: "ghost", size: "sm", icon: "plus", tooltip: "New manager" }));
  }

  canvas(t, d, g) {
    const z = this.z ?? 1;
    const S = v => Math.round(v * z);
    const children = [];
    // Lane headings: a branch for a lane whose work has no card of its own above it.
    for (const [id, gr] of Object.entries(g.groups)) {
      const p = g.pos[id];
      children.push(
        v_flex()
          .absolute()
          .left(S(p.x))
          .top(S(p.y))
          .w(S(p.w))
          .h(S(p.h))
          .justify_center()
          .rounded(S(10))
          .bg(alpha(t.foreground, 0.05))
          .px(S(12))
          .child(
            h_flex()
              .gap(S(6))
              .items_center()
              .child(div().min_w(0).truncate().text_size(S(12)).font_semibold().text_color(t.foreground).child(gr.label))
              .when(!!DELTA_TONE[gr.delta], el => el.child(deltaDot(t, gr.delta, S(7)))),
          )
          .when(!!gr.subtitle, el => el.child(div().min_w(0).truncate().text_size(S(10.5)).text_color(t.muted).child(gr.subtitle))),
      );
    }
    // Edges, grouped by look so each look is one native path.
    const pens = {};
    const pen = key =>
      (pens[key] ??= {
        pb: key.endsWith(":dash")
          ? PathBuilder.stroke(Math.max(1, S(1.4))).dash_array([Math.max(3, S(4)), Math.max(3, S(4))])
          : PathBuilder.stroke(key.startsWith("hero") || key.startsWith("focus") ? Math.max(2, S(2.4)) : Math.max(1, S(1.4))),
        heads: [],
      });
    // Branches: elbows from parent to child (siblings share the trunk, like a tree), lane
    // headings included. Cross links: S-curves over the tree, with an arrowhead.
    const down = g.orient === "down";
    const keyOf = e => e.id ?? `${e.from}>${e.to}`;
    const headEdges = Object.keys(g.groups).map(id => ({ id: `head:${id}`, from: g.root, to: id, kind: "call" }));
    const routes = [
      ...headEdges.map(e => ({ e, isBranch: true, ...branch(g.pos[e.from], g.pos[e.to], down) })),
      ...g.edges
        .filter(e => g.pos[e.from] && g.pos[e.to] && this.essential(e, g))
        .map(e => (g.tree.has(keyOf(e)) ? { e, isBranch: true, ...branch(g.pos[e.from], g.pos[e.to], down) } : { e, ...cross(g.pos[e.from], g.pos[e.to], down) })),
    ];
    // Labels keep off the cards, the headings and each other.
    const taken = Object.values(g.pos).map(p => ({ ...p }));
    const labels = [];
    for (const { e, pts, curve, label, isBranch } of routes) {
      const touches = this.sel && (e.from === this.sel || e.to === this.sel);
      const look = touches ? `focus${e.animated ? ":anim" : ""}` : isBranch && !e.emphasis && (!e.delta || e.delta === "unchanged") ? "unchanged" : edgeLook(e);
      const p = pen(look);
      const P = pts.map(([x, y]) => [S(x), S(y)]);
      if (curve) p.pb = p.pb.move_to(P[0][0], P[0][1]).cubic_bezier_to(P[3][0], P[3][1], P[1][0], P[1][1], P[2][0], P[2][1]);
      else p.pb = roundedPolyline(p.pb, P, S(8));
      if (!isBranch) {
        const [[px, py], [ex, ey]] = pts.slice(-2);
        p.heads.push(arrowHead(S(ex), S(ey), Math.sign(ex - px), Math.sign(ey - py), Math.max(6, S(7)), Math.max(3.5, S(4))));
      }
      // Labels only where they carry news: the hero, changes, or the selected card's edges.
      if (e.label && e.label !== "directs" && (touches || e.emphasis === "hero" || (e.delta && e.delta !== "unchanged" && !this.sel)))
        labels.push({ e, look, ...labelSpot(pts[label], pts[label + 1], labelW(e.label), taken, g.W, g.H) });
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
              .w(S(labelW(e.label)))
              .px(S(6))
              .h(S(18))
              .flex()
              .items_center()
              .justify_center()
              .overflow_hidden()
              .rounded(S(9))
              .bg(t.background)
              .border(1)
              .border_color(alpha(color(look), 0.6))
              .text_size(S(10.5))
              .text_color(look.startsWith("hero") ? t.accent : t.muted)
              .tooltip(e.summary ? `${e.label}: ${plain(e.summary)}` : e.label)
              .child(div().min_w(0).truncate().child(clip(e.label, 40))),
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
          .children(shown.map((b, i) => chip(t, clip(b, 20), toneColor(t, badgeTone(b)), { id: `map-badge-${n.id}-${i}`, scale: this.z ?? 1 })))
          .when(badges.length > shown.length, e2 => e2.child(div().text_size(S(10)).text_color(t.muted).child(`+${badges.length - shown.length}`)))
      : null;
    const sub = n.subtitle || (cat === "agent" ? this.liveLine(n.id) : null);
    // An agent's orb shows its status itself: only other nodes get a status glyph in the corner.
    const corner = status && cat !== "agent" ? statusGlyph(status, t, S(12), { still: this.app.palette.open }) : changed ? deltaDot(t, n.delta, S(7)) : null;
    // A row's lead icon and corner glyph sit on its first line when the title wraps.
    const top = el => div().flex_none().mt(S(2)).child(el);

    // Each kind of thing has its own body; the shell (position, selection, click) is shared.
    // An agent's badges line up with its text, past the avatar.
    const unit = cat === "agent" && n.id !== "master" && !this.managerFor(n.id);
    const avatar = unit ? 26 : 32;
    let body;
    if (cat === "agent") {
      const m = this.managerFor(n.id);
      const kind = m === "master" ? "master" : unit ? "unit" : m?.kind === "merge-queue" ? "merge-queue" : "area";
      // The subline gets the whole lines left under the title (two at most): rounding at small zooms leaves room for one.
      const room = S(p.h) - 2 * S(9) - S(13) * 1.3 - S(3) - (badgeRow ? S(18) + S(5) : 0);
      const subLines = Math.min(2, Math.floor(room / (S(11) * 1.3)));
      body = h_flex()
        .gap(S(10))
        .items_start()
        .child(agentMark(t, { avatar: true, kind, id: n.id, label: n.label, status, size: S(avatar), still: this.app.palette.open }).mt(S(1)))
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
            .when(!!sub && subLines > 0, el => el.child(lines(sub, S(11), subLines, 20).text_color(t.muted))),
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
            .child(div().flex_none().h(S(13) * 1.3).flex().items_center().child(icon(null, S(13), look.c, "mods/hq/icons/git-pull-request.svg")))
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

  drawer(t, g) {
    const n = g.byId[this.sel];
    const m = this.managerFor(n.id);
    const cat = this.category(n);
    const rels = g.edges.filter(e => e.from === n.id || e.to === n.id);
    const body = m
      ? this.app.views.org.detail(t)
      : pane(
          "map-drawer-scroll",
          v_flex()
            .gap(SP.lg)
            .when(cat === "pr" && !!prNumber(n), el => el.child(prPanel(this, t, prNumber(n), n)))
            .when(!(cat === "pr" && prNumber(n)), el => el.child(
              pageHeader(t, {
                glyph: icon(KIND_ICON[n.kind] ?? "square", 16, t.muted),
                title: n.label,
                chips: [
                  ...(DELTA_TONE[n.delta] ? [chip(t, n.delta, docTone(t, n.delta))] : []),
                  ...(n.badges ?? []).map(b => chip(t, b, toneColor(t, badgeTone(b)))),
                ],
                meta: [n.kind, n.subtitle].filter(Boolean).join(" · ") || null,
              }),
            ))
            .when(!!n.summary, el => el.child(mdBlock(t, `map-sum-${n.id}`, n.summary, { maxW: 500 })))
            .when(rels.length > 0, el =>
              el.child(
                v_flex()
                  .gap(4)
                  .children(
                    rels.map((e, i) => {
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
              ),
            ),
        );
    return drawer(t, { id: "map-drawer", title: m ? "Manager" : CAT_WORD[cat], onClose: cx => ((this.sel = null), cx.notify()), body });
  }
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
