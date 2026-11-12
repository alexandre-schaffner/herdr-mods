// Roadmap: the plan of the epic HQ is showing, in phases. An epic is one of the person's worktree
// groups; the strip's epic menu switches between them, so this view never lists the others. The master keeps the plan
// (`hq roadmap`); this view only draws it: phases left to right in the order they can happen,
// phases that can run at the same time stacked in one step, a line from each phase to the
// ones waiting on it.

import { h_flex, Scrollbar, v_flex } from "gpui-base";
import { div, PathBuilder } from "gpui-kit";

import { doneCount, epicColor, phaseColor, rail, where } from "./plan.js";
import { ago, alpha, chip, clip, empty, icon, mix, ok, row, scrollY, SP, TYPE } from "./ui.js";

// Layout units (px): card width, gap between steps, gap between parallel phases, step label height.
const L = { pad: 28, w: 248, gapX: 64, gapY: 14, label: 26 };
const ITEMS_SHOWN = 4;
// A phase card's rows (px). card() draws with these and cardH() adds them up, so the two can't
// drift apart (a card taller than its slot clips; the diagram places cards by cardH).
const CARD = { pad: 14, gap: 6, head: 16, title: 20, summary: 36, itemsTop: SP.xs, itemH: 18, itemGap: 3, more: 17, foot: 18 };

const PHASE = {
  done: { word: "Done", glyph: "check" },
  doing: { word: "Now", glyph: "dot" },
  next: { word: "Next", glyph: "ring" },
  later: { word: "Later", glyph: "ring" },
  blocked: { word: "Stuck", glyph: "alert" },
};

export class RoadmapView {
  constructor(app) {
    this.app = app;
    this.open = new Set(); // phases shown in full
  }

  typing() {
    return false;
  }

  /** Asked for another epic's plan (Home's Epics panel, the palette): HQ switches to that epic,
   *  since this view only ever shows the epic HQ is on. */
  onShow(cx, arg) {
    if (arg?.epic && arg.epic !== this.current()?.name) this.app.pickEpic(arg.epic, cx);
  }

  /** The epic HQ is showing, from the snapshot's epics (the main master's own row plans nothing). */
  current() {
    return (this.app.data?.epics ?? []).find(e => e.current && !e.main) ?? null;
  }

  onKey() {
    return false;
  }

  // ---- drawing

  render(t, _cx) {
    const cur = this.current();
    if (!cur)
      return (this.app.data?.epics ?? []).some(e => !e.main)
        ? empty(t, "The main master plans no epic", "Switch to an epic from the menu next to the repository name to see its plan.", { icon: "git-branch" })
        : empty(t, "No epics yet", "Group worktrees in the sidebar (each group is an epic), and the master writes a plan for each one here.", { icon: "git-branch" });
    return v_flex().id("roadmap-root").flex_1().min_h(0).min_w(0).child(cur.plan ? this.page(t, cur) : this.unplanned(t, cur));
  }

  unplanned(t, e) {
    return empty(
      t,
      `No plan for ${e.name} yet`,
      `${e.worktrees ? `${e.worktrees} worktree${e.worktrees === 1 ? "" : "s"} in this group. ` : ""}The master writes each epic's phases in its next tick (\`hq roadmap\`).`,
      { icon: "git-branch" },
    );
  }

  page(t, e) {
    const p = e.plan;
    const ph = p.phases ?? [];
    const done = doneCount(ph);
    const st = p.status ?? "on track";
    const w = where(t, ph);
    return scrollY(
      `roadmap-page-${e.name}`,
      v_flex()
        .px(SP.xl)
        .py(SP.xl)
        .gap(SP.xl)
        .child(
          v_flex()
            .gap(SP.sm)
            .child(
              h_flex()
                .gap(SP.sm)
                .items_center()
                .child(div().text_size(TYPE.display).font_semibold().text_color(t.foreground).child(e.name))
                .child(chip(t, st[0].toUpperCase() + st.slice(1), epicColor(t, st), { h: 22, size: TYPE.meta }))
                .when(!!e.orphan, el => el.child(chip(t, "No worktree group", t.muted, { h: 22, size: TYPE.meta })))
                .child(div().flex_1())
                .when(!!p.at, el => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(`Kept by the master · ${ago(p.at, this.app.data?.now)}`))),
            )
            .when(!!p.goal, el => el.child(div().max_w(720).text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(p.goal)))
            .child(
              v_flex()
                .pt(SP.sm)
                .gap(SP.sm)
                .max_w(720)
                .child(rail(t, ph, 6))
                .child(
                  h_flex()
                    .gap(SP.md)
                    .text_size(TYPE.ui)
                    .child(div().font_semibold().text_color(w.color).child(w.text))
                    .child(div().flex_1())
                    .child(div().text_color(t.muted).child(`${done} of ${ph.length} done`)),
                ),
            )
            .when(!!p.note, el => el.child(div().max_w(720).text_size(TYPE.ui).line_height(1.45).text_color(t.muted).child(p.note))),
        )
        .child(ph.length ? this.diagram(t, e.name, ph) : div().text_size(TYPE.ui).text_color(t.muted).child("No phases yet.")),
    );
  }

  /** Phases in steps: a phase's step is one past the latest of the phases it waits on. Each step
   *  is a column; its phases stack, centred on the tallest column; a curve joins each phase to
   *  the ones waiting on it. */
  diagram(t, epic, phases) {
    const byId = Object.fromEntries(phases.map(p => [p.id, p]));
    const step = {};
    const stepOf = (id, seen = new Set()) => {
      if (step[id] != null) return step[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const after = (byId[id]?.after ?? []).filter(a => byId[a]);
      return (step[id] = after.length ? 1 + Math.max(...after.map(a => stepOf(a, seen))) : 0);
    };
    phases.forEach(p => stepOf(p.id));
    const cols = [];
    for (const p of phases) (cols[step[p.id]] ??= []).push(p);
    const heightOf = p => this.cardH(p);
    const colH = Array.from(cols, c => (c ?? []).reduce((h, p) => h + heightOf(p), 0) + Math.max(0, (c?.length ?? 1) - 1) * L.gapY);
    const H = L.pad * 2 + L.label + Math.max(...colH);
    const W = L.pad * 2 + cols.length * L.w + (cols.length - 1) * L.gapX;
    const pos = {};
    Array.from(cols).forEach((c, k) => {
      let y = L.pad + L.label + (Math.max(...colH) - colH[k]) / 2;
      for (const p of c ?? []) {
        pos[p.id] = { x: L.pad + k * (L.w + L.gapX), y, h: heightOf(p) };
        y += heightOf(p) + L.gapY;
      }
    });
    // Links, one path per look (done, live, waiting).
    const pens = {};
    const pen = key => (pens[key] ??= key === "wait" ? PathBuilder.stroke(1.4).dash_array([4, 4]) : PathBuilder.stroke(key === "live" ? 2 : 1.5));
    for (const p of phases)
      for (const a of p.after ?? []) {
        const s = pos[a];
        const d = pos[p.id];
        if (!s || !d) continue;
        const key = byId[a].status === "done" && p.status !== "later" ? (p.status === "doing" ? "live" : "done") : "wait";
        const [x1, y1, x2, y2] = [s.x + L.w, s.y + s.h / 2, d.x, d.y + d.h / 2];
        const mx = (x1 + x2) / 2;
        pens[key] = pen(key).move_to(x1, y1).cubic_bezier_to(x2, y2, mx, y1, mx, y2);
      }
    const color = { done: alpha(ok(t), 0.55), live: t.accent, wait: alpha(t.foreground, 0.22) };
    const children = Object.entries(pens).map(([k, pb]) => window.paint_path(pb.build(), color[k]).absolute().left(0).top(0).w(W).h(H));
    // Step labels.
    cols.forEach((c, k) => {
      const st = (c ?? []).every(p => p.status === "done") ? "done" : (c ?? []).some(p => p.status === "doing") ? "now" : null;
      children.push(
        h_flex()
          .absolute()
          .left(L.pad + k * (L.w + L.gapX))
          .top(L.pad - 4)
          .w(L.w)
          .gap(6)
          .items_center()
          .child(div().text_size(TYPE.meta).font_semibold().text_color(st === "now" ? t.accent : t.muted).child(`Step ${k + 1}`))
          .when((c?.length ?? 0) > 1, el => el.child(div().text_size(TYPE.meta).text_color(t.dim).child(`· ${c.length} in parallel`)))
          .when(st === "done", el => el.child(icon("check", 11, ok(t)))),
      );
    });
    for (const p of phases) children.push(this.card(t, epic, p, pos[p.id]));
    const id = `roadmap-plan-${epic}`;
    return v_flex()
      .relative()
      .w_full()
      .h(H + 14)
      .child(div().id(id).size_full().overflow_x_scroll().child(div().relative().w(W).h(H).children(children)))
      .child(Scrollbar.new(id).absolute().inset_0());
  }

  cardH(p) {
    const C = CARD;
    const n = (p.items ?? []).length;
    const shown = this.open.has(p.id) ? n : Math.min(n, ITEMS_SHOWN);
    const items = shown ? C.gap + C.itemsTop + shown * C.itemH + (shown - 1) * C.itemGap + (n > shown ? C.itemGap + C.more : 0) : 0;
    return C.pad * 2 + C.head + C.gap + C.title + (p.summary ? C.gap + C.summary : 0) + items + (p.owner || p.eta ? C.gap + C.itemsTop + C.foot : 0);
  }

  card(t, epic, p, at) {
    const look = PHASE[p.status] ?? PHASE.next;
    const c = phaseColor(t, p.status);
    const live = p.status === "doing";
    const stuck = p.status === "blocked";
    const done = p.status === "done";
    const items = p.items ?? [];
    const full = this.open.has(p.id);
    const shown = full ? items : items.slice(0, ITEMS_SHOWN);
    const border = stuck ? t.blocked : live ? t.accent : alpha(t.border, done ? 0.5 : 0.9);
    return v_flex()
      .id(`roadmap-phase-${epic}-${p.id}`)
      .absolute()
      .left(at.x)
      .top(at.y)
      .w(L.w)
      .h(at.h)
      .p(CARD.pad)
      .gap(CARD.gap)
      .rounded(12)
      .border(1)
      .when(p.status === "later", el => el.border_dashed())
      .border_color(border)
      .bg(live ? mix(t.background, t.accent, 0.06) : stuck ? mix(t.background, t.blocked, 0.05) : t.background)
      .when(live, el => el.shadow_md())
      .when(items.length > ITEMS_SHOWN, el =>
        el.cursor_pointer().on_click((_e, cx) => {
          if (this.open.has(p.id)) this.open.delete(p.id);
          else this.open.add(p.id);
          cx.notify();
        }),
      )
      .child(
        h_flex()
          .flex_none()
          .h(CARD.head)
          .gap(SP.sm)
          .items_center()
          .child(this.glyph(t, look.glyph, c, live))
          .child(div().flex_1().min_w(0).text_size(TYPE.meta).font_semibold().text_color(stuck ? t.blocked : live ? t.accent : done ? ok(t) : t.muted).child(look.word)),
      )
      .child(
        div()
          .id(`roadmap-title-${epic}-${p.id}`)
          .flex_none()
          .h(CARD.title)
          .truncate()
          .text_size(TYPE.body)
          .font_semibold()
          .text_color(done ? t.muted : t.foreground)
          .tooltip(p.title)
          .child(p.title),
      )
      .when(!!p.summary, el =>
        el.child(div().flex_none().h(CARD.summary).overflow_hidden().text_size(TYPE.ui).line_height(1.35).text_color(t.muted).child(clip(p.summary, 110))),
      )
      .when(shown.length > 0, el =>
        el.child(
          v_flex()
            .flex_none()
            .pt(CARD.itemsTop)
            .gap(CARD.itemGap)
            .children(
              shown.map(it =>
                h_flex()
                  .h(CARD.itemH)
                  .gap(7)
                  .items_center()
                  .child(this.itemMark(t, it.status))
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(TYPE.ui)
                      .text_color(it.status === "done" ? t.muted : t.foreground)
                      .when(it.status === "done", e2 => e2.line_through())
                      .child(it.label),
                  ),
              ),
            )
            .when(items.length > shown.length, e2 => e2.child(div().h(CARD.more).pt(2).text_size(TYPE.meta).text_color(t.muted).child(`+${items.length - shown.length} more`))),
        ),
      )
      .when(!!(p.owner || p.eta), el =>
        el.child(
          h_flex()
            .flex_none()
            .pt(CARD.itemsTop)
            .gap(6)
            .when(!!p.owner, e2 => e2.child(chip(t, p.owner, t.muted, { icon: "user" })))
            .when(!!p.eta, e2 => e2.child(chip(t, p.eta, t.muted, { icon: "clock" }))),
        ),
      );
  }

  glyph(t, kind, c, live) {
    if (kind === "check") return div().flex_none().size(16).rounded_full().bg(c).flex().items_center().justify_center().child(icon("check", 10, t.background));
    if (kind === "alert") return icon("alert", 15, c);
    if (kind === "dot")
      return div()
        .flex_none()
        .size(16)
        .rounded_full()
        .border(2)
        .border_color(alpha(c, 0.35))
        .flex()
        .items_center()
        .justify_center()
        .child(div().size(7).rounded_full().bg(c).when(live && !this.app.palette?.open, el => el.loop("opacity", { from: 0.4, to: 1, period: 1400 })));
    return div().flex_none().size(16).rounded_full().border(1.5).border_color(c);
  }

  itemMark(t, status) {
    if (status === "done") return icon("check", 11, ok(t));
    if (status === "doing") return div().flex_none().size(8).mx(1).rounded_full().bg(t.accent);
    return div().flex_none().size(8).mx(1).rounded_full().border(1.2).border_color(alpha(t.foreground, 0.35));
  }
}
