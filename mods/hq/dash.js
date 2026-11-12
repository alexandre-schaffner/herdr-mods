// Home's dashboard: three signals, nothing else.
//   Merged PRs: today against the usual pace, and the last two weeks as bars. Is the work landing?
//   Plan limits: each subscription's windows and when they reset. Are we about to hit a wall?
//   Roadmap: the shown epic's progress, what's moving now, what's stuck. Is the plan on course?
// Data: the snapshot's `merges` (gh, cached by hq.py) and `epics` (each with its plan), and the Usage view's windows().

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { doneCount, epicColor, rail, where } from "./plan.js";
import { alpha, DAY, inTime, ok, panel, SP, tone, TYPE, usageTone } from "./ui.js";

const box = (t, id) => panel(t, id).p(SP.lg).gap(SP.md);

export class Dashboard {
  constructor(app) {
    this.app = app;
  }

  render(t, d, wide) {
    const merged = this.merged(t, d);
    const plans = this.plans(t, d);
    const epics = this.epics(t, d);
    const top = !merged && !plans
      ? null
      : wide
        ? h_flex()
            .gap(SP.lg)
            .items_stretch()
            .when(!!merged, el => el.child(v_flex().flex_1().min_w(0).child(merged.flex_1())))
            .when(!!plans, el => el.child(v_flex().w(340).flex_none().child(plans.flex_1())))
        : v_flex().gap(SP.lg).when(!!merged, el => el.child(merged)).when(!!plans, el => el.child(plans));
    return v_flex().gap(SP.lg).when(!!top, el => el.child(top)).when(!!epics, el => el.child(epics));
  }

  /** The epic HQ is showing, when it has a plan: name and state, a segment per phase, the one
   *  line that says where it is (stuck on, now, next), and how far along. The strip's epic menu
   *  switches epics, so the others aren't listed here. */
  epics(t, d) {
    const e = (d.epics ?? []).find(x => x.current && !x.main)?.plan;
    if (!e?.phases?.length) return null;
    const ph = e.phases;
    const done = doneCount(ph);
    const w = where(t, ph);
    const open = cx => this.app.go("roadmap", cx);
    return panel(t, "dash-epics")
      .p(SP.sm)
      .gap(2)
      .child(
        h_flex()
          .px(SP.md)
          .pt(SP.sm)
          .gap(SP.sm)
          .child(div().text_size(TYPE.ui).font_medium().text_color(t.muted).child("Roadmap"))
          .child(div().flex_1())
          .child(
            div()
              .id("dash-epics-open")
              .text_size(TYPE.meta)
              .text_color(t.muted)
              .cursor_pointer()
              .hover(s => s.text_color(t.foreground))
              .on_click((_e, cx) => open(cx))
              .child("Open →"),
          ),
      )
      .child(
        v_flex()
          .id(`dash-epic-${e.group}`)
          .gap(SP.sm)
          .py(SP.md)
          .px(SP.md)
          .rounded(9)
          .cursor_pointer()
          .hover(s => s.bg(alpha(t.foreground, 0.04)))
          .on_click((_e, cx) => open(cx))
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .child(div().flex_none().size(8).rounded_full().bg(epicColor(t, e.status)))
              .child(div().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(e.group))
              .child(div().text_size(TYPE.meta).text_color(epicColor(t, e.status ?? "on track")).child(e.status ?? "on track"))
              .child(div().flex_1())
              .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(`${done}`))
              .child(div().text_size(TYPE.ui).text_color(t.muted).child(`of ${ph.length} phases`)),
          )
          .child(rail(t, ph, 6, `dash-ph-${e.group}`))
          .child(div().truncate().text_size(TYPE.ui).text_color(w.color).child(w.text))
          .when(!!e.goal, el => el.child(div().truncate().text_size(TYPE.meta).text_color(t.muted).child(e.goal))),
      );
  }

  /** Today's count, its pace against a usual day (scaled to the hour, so mornings aren't
   *  "behind"), and two weeks of bars with a usual day as a faint line. */
  merged(t, d) {
    const days = d.merges?.days ?? [];
    if (days.length < 2) return null;
    const counts = days.map(x => x.count);
    const today = counts[counts.length - 1];
    const usual = counts.slice(0, -1).reduce((s, n) => s + n, 0) / (counts.length - 1);
    const now = new Date(d.now);
    const share = Math.min(1, Math.max(0.25, (now.getHours() + now.getMinutes() / 60) / 20));
    const pace = usual ? today / (usual * share) - 1 : 0;
    const paceText = Math.abs(pace) < 0.1 ? "on a usual pace" : `${Math.round(Math.abs(pace) * 100)}% ${pace > 0 ? "ahead of" : "behind"} a usual day`;
    const H = 96;
    const max = Math.max(1, ...counts);
    return box(t, "dash-merged")
      .tooltip("Merged PRs in the whole repo (everyone), per day. The line is a usual day.")
      .child(
        h_flex()
          .gap(SP.sm)
          .items_baseline()
          .child(div().text_size(TYPE.ui).font_medium().text_color(t.muted).child("Merged today"))
          .child(div().flex_1())
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(`usually ${Math.round(usual)} a day`)),
      )
      .child(
        h_flex()
          .gap(SP.md)
          .items_baseline()
          .child(div().text_size(30).font_semibold().text_color(t.foreground).child(String(today)))
          .child(div().text_size(TYPE.ui).font_medium().text_color(pace >= -0.1 ? ok(t) : tone(t).warn).child(paceText)),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .w_full()
          .min_h(H)
          .child(
            h_flex()
              .absolute()
              .inset_0()
              .gap(5)
              .items_end()
              .children(
                days.map((x, i) => {
                  const last = i === days.length - 1;
                  const dt = new Date(`${x.date}T12:00:00`);
                  return v_flex()
                    .id(`dash-day-${x.date}`)
                    .flex_1()
                    .h_full()
                    .justify_end()
                    .tooltip(`${DAY[dt.getDay()]} ${dt.getDate()}: ${x.count}`)
                    .child(div().w_full().min_h(2).h(`${(x.count / max) * 100}%`).rounded_t(3).bg(last ? t.accent : alpha(t.foreground, 0.16)));
                }),
              ),
          )
          .child(div().absolute().left(0).bottom(`${(usual / max) * 100}%`).w_full().h(0).border_t(1).border_dashed().border_color(alpha(t.foreground, 0.28))),
      );
  }

  /** Every subscription window that has a reading, fullest first, with when it resets. */
  plans(t, d) {
    const rows = this.app.views.usage?.windows() ?? [];
    if (!rows.length) return null;
    return box(t, "dash-plans")
      .child(div().text_size(TYPE.ui).font_medium().text_color(t.muted).child("Plan limits"))
      .child(
        v_flex()
          .flex_1()
          .justify_center()
          .gap(14)
          .children(
            rows.slice(0, 4).map(r => {
              const c = usageTone(t, r.pct);
              return v_flex()
                .gap(5)
                .child(
                  h_flex()
                    .gap(SP.sm)
                    .items_baseline()
                    .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).text_color(t.foreground).child(`${r.who} · ${r.label}`))
                    .child(div().text_size(TYPE.ui).font_semibold().text_color(c).child(`${Math.round(r.pct)}%`)),
                )
                .child(div().w_full().h(4).rounded_full().bg(alpha(t.foreground, 0.09)).child(div().h_full().rounded_full().bg(c).w(`${Math.max(2, Math.min(100, r.pct))}%`)))
                .when(!!r.resets && r.pct >= 70, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(`resets ${inTime(r.resets * 1000, d.now)}`)));
            }),
          ),
      );
  }
}
