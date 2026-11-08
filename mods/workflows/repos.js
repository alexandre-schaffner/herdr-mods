// Where the person works, and the repositories with runs: the strip's repository chip and the
// panel to pick another one. Functions of the Workflows view.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { focused, home, panes, spaces } from "herdr";
import { isLive } from "./runs.js";
import { badge, btn } from "./ui.js";
import { ago, alpha, icon, look, mono, scrollArea, tildify } from "./util.js";

/** Where the person is working: the focused terminal, else the active space's terminals. */
export function hereCwd(app) {
  const f = focused();
  if (f?.cwd) return (app.lastHere = f.cwd);
  const space = spaces().find(s => s.active);
  const tabs = new Map((space?.tabs ?? []).map(tab => [tab.id, tab.active]));
  const terms = panes().filter(p => p.terminal && p.cwd && tabs.has(p.tab));
  const pick = terms.find(p => tabs.get(p.tab) && p.focused) ?? terms.find(p => tabs.get(p.tab)) ?? terms[0];
  return pick?.cwd ?? app.lastHere ?? null;
}

/** The repository the strip shows: one picked in the panel, else the active one. */
export function shownRepo(app) {
  const runs = app.runs ?? [];
  if (app.pinned) return runs.find(r => r.repo?.key === app.pinned)?.repo ?? app.here ?? null;
  return app.here ?? null;
}

export function visibleRuns(app) {
  const runs = app.runs ?? [];
  const repo = shownRepo(app);
  return repo ? runs.filter(r => r.repo?.key === repo.key) : runs;
}

/** Every repository with runs, active first, then by latest activity. */
function repoGroups(app) {
  const groups = new Map();
  for (const r of app.runs ?? []) {
    if (!r.repo) continue;
    const g = groups.get(r.repo.key) ?? { repo: r.repo, runs: [], latest: 0, live: 0 };
    g.runs.push(r);
    g.latest = Math.max(g.latest, r.endedAt ?? r.startedAt ?? 0);
    if (isLive(r.status)) g.live += 1;
    groups.set(r.repo.key, g);
  }
  return [...groups.values()].sort((a, b) => (b.repo.key === app.here?.key) - (a.repo.key === app.here?.key) || b.latest - a.latest);
}

function pinRepo(app, key, cx, runId) {
  app.pinned = key && key !== app.here?.key ? key : null;
  app.repoPanel = false;
  const runs = visibleRuns(app);
  const pick = runId ?? (runs.some(r => r.id === app.runId) ? app.runId : (runs.find(r => isLive(r.status)) ?? runs[0])?.id);
  if (pick) app.selectRun(pick, cx);
  cx.notify();
}

export function repoChip(app, t) {
  const repo = shownRepo(app);
  const others = repoGroups(app).filter(g => g.repo.key !== repo?.key);
  const otherLive = others.reduce((n, g) => n + g.live, 0);
  return h_flex()
    .flex_none()
    .h_full()
    .pl(18)
    .pr(14)
    .gap(10)
    .items_center()
    .border_r(1)
    .border_color(alpha(t.border, 0.8))
    .child(
      v_flex()
        .id("repo-chip")
        .w(210)
        .px(12)
        .py(8)
        .gap(4)
        .rounded(11)
        .border(1)
        .border_color(app.repoPanel ? t.accent : t.border)
        .bg(app.repoPanel ? alpha(t.accent, 0.06) : t.background)
        .cursor_pointer()
        .hover(s => s.border_color(alpha(t.accent, 0.5)))
        .on_click((_e, cx) => {
          app.repoPanel = !app.repoPanel;
          cx.notify();
        })
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(icon("folder", 12, app.pinned ? t.muted : t.accent))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(repo?.name ?? "All repositories"))
            .child(icon("chevron-down", 11, t.dim)),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().text_size(10.5).text_color(app.pinned ? t.working : t.dim).child(app.pinned ? "other repository" : "active repository"))
            .child(div().flex_1())
            .when(others.length > 0, el =>
              el.child(
                h_flex()
                  .gap(4)
                  .items_center()
                  .when(otherLive > 0, el2 => el2.child(div().w(6).h(6).rounded_full().bg(t.working).loop("opacity", { from: 0.3, to: 1, period: 1000 })))
                  .child(div().text_size(10.5).text_color(t.dim).child(`+${others.length} repo${others.length > 1 ? "s" : ""}`)),
              ),
            ),
        ),
    )
    .when(!!app.pinned, el =>
      el.child(btn(t, "repo-back", "", cx => pinRepo(app, null, cx), { icon: "arrow-left", kind: "ghost", size: "sm", tooltip: `Back to ${app.here?.name ?? "the active repository"}` })),
    );
}

/** Other repositories, tidy: each with its count and latest runs; picking one shows it. */
export function repoPanelView(app, t, now) {
  const groups = repoGroups(app);
  const shown = shownRepo(app)?.key;
  const card = g => {
    const active = g.repo.key === app.here?.key;
    return v_flex()
      .id(`rp-${g.repo.key}`)
      .p(10)
      .gap(6)
      .rounded(11)
      .border(1)
      .border_color(g.repo.key === shown ? t.accent : t.border)
      .bg(t.background)
      .child(
        h_flex()
          .id(`rp-head-${g.repo.key}`)
          .gap(8)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => pinRepo(app, g.repo.key, cx))
          .child(icon("folder", 13, active ? t.accent : t.dim))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(g.repo.name))
              .child(div().truncate().font_family(mono()).text_size(10).text_color(t.dim).child(tildify(g.repo.path, home()))),
          )
          .when(g.live > 0, el => el.child(badge(t, `${g.live} live`, t.working)))
          .child(div().text_size(11).text_color(t.dim).child(`${g.runs.length} run${g.runs.length > 1 ? "s" : ""} · ${ago(g.latest, now)}`)),
      )
      .children(
        g.runs.slice(0, 3).map(r => {
          const lk = look(r.status, t);
          return h_flex()
            .id(`rp-run-${r.id}`)
            .h(26)
            .pl(21)
            .pr(6)
            .gap(8)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .hover(s => s.bg(alpha(t.foreground, 0.05)))
            .on_click((_e, cx) => pinRepo(app, g.repo.key, cx, r.id))
            .child(div().w(6).h(6).rounded_full().bg(lk.color))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(r.name))
            .child(div().text_size(10.5).text_color(t.dim).child(isLive(r.status) ? "live" : ago(r.endedAt ?? r.startedAt, now)));
        }),
      )
      .when(g.runs.length > 3, el =>
        el.child(
          h_flex()
            .id(`rp-more-${g.repo.key}`)
            .pl(21)
            .cursor_pointer()
            .on_click((_e, cx) => pinRepo(app, g.repo.key, cx))
            .child(div().text_size(11).text_color(t.accent).child(`Show all ${g.runs.length} runs`)),
        ),
      );
  };
  const active = groups.filter(g => g.repo.key === app.here?.key);
  const others = groups.filter(g => g.repo.key !== app.here?.key);
  return div()
    .absolute()
    .top(0)
    .left(0)
    .right(0)
    .bottom(0)
    .child(div().id("rp-backdrop").absolute().top(0).left(0).right(0).bottom(0).on_click((_e, cx) => ((app.repoPanel = false), cx.notify())))
    .child(
      v_flex()
        .absolute()
        .top(52 + 74)
        .left(18)
        .w(440)
        .max_h(560)
        .rounded(14)
        .bg(t.popover ?? t.background)
        .border(1)
        .border_color(t.border)
        .shadow_lg()
        .child(
          scrollArea(
            "rp-scroll",
            "y",
            v_flex()
              .p(12)
              .gap(8)
              .child(div().px(2).text_size(10.5).font_semibold().text_color(t.dim).child("ACTIVE REPOSITORY"))
              .children(active.length ? active.map(card) : [div().px(2).pb(4).text_size(11.5).text_color(t.dim).child(app.here ? `No runs in ${app.here.name} yet.` : "No repository in focus.")])
              .when(others.length > 0, el =>
                el.child(div().px(2).pt(8).text_size(10.5).font_semibold().text_color(t.dim).child("OTHER REPOSITORIES")).children(others.map(card)),
              ),
          ),
        ),
    );
}
