// The Runs view's bars: the top bar, the strip of runs, and the selected run's header.
// Functions of the Workflows view.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home } from "herdr";
import { dirSwitch } from "./graph.js";
import { hasOutput } from "./output.js";
import { repoChip, shownRepo } from "./repos.js";
import { livenessLine, ownerChip, resumeButton, resumeConfirm } from "./resume.js";
import { isLive, RESUMABLE } from "./runs.js";
import { btn, seg as segmented } from "./ui.js";
import { ago, alpha, clip, compact, duration, icon, look, mix, mono, ok, tildify } from "./util.js";

export function topBar(app, t, live) {
  return h_flex()
    .flex_none()
    .h(52)
    .px(18)
    .gap(12)
    .items_center()
    .border_b(1)
    .border_color(alpha(t.border, 0.8))
    .child(
      div()
        .w(30)
        .h(30)
        .rounded(9)
        .bg(alpha(t.accent, 0.14))
        .border(1)
        .border_color(alpha(t.accent, 0.35))
        .flex()
        .items_center()
        .justify_center()
        .child(icon("flow", 16, t.accent)),
    )
    .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Workflows"))
    .child(
      segmented(
        t,
        "view",
        [
          { id: "runs", label: "Runs", icon: "flow" },
          { id: "library", label: "Library", icon: "layers" },
        ],
        app.view,
        (id, cx) => app.setView(id, cx),
      ),
    )
    .child(div().flex_1())
    .when(live > 0, el =>
      el.child(
        h_flex()
          .gap(7)
          .px(10)
          .h(24)
          .rounded_full()
          .items_center()
          .bg(alpha(t.working, 0.12))
          .child(div().w(7).h(7).rounded_full().bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1000 }))
          .child(div().text_size(11.5).font_medium().text_color(t.working).child(`${live} live`)),
      ),
    );
}

export function runStrip(app, t, runs, now) {
  return h_flex()
    .flex_none()
    .h(78)
    .min_w(0)
    .items_center()
    .border_b(1)
    .border_color(alpha(t.border, 0.8))
    .bg(alpha(t.foreground, 0.015))
    .child(repoChip(app, t))
    .child(
      h_flex()
        .id("runs")
        .flex_1()
        .min_w(0)
        .h_full()
        .items_center()
        .overflow_x_scroll()
        .px(14)
        .gap(10)
        .when(!runs.length, el => el.child(div().text_size(12).text_color(t.dim).child(`No workflow runs in ${shownRepo(app)?.name ?? "this repository"} yet.`)))
        .children(
      runs.map(r => {
        const lk = look(r.status, t);
        const sel = r.id === app.runId;
        const when = isLive(r.status) ? `started ${ago(r.startedAt, now)}` : ago(r.endedAt ?? r.startedAt, now);
        return v_flex()
          .id(`run-${r.id}`)
          .flex_none()
          .w(228)
          .px(12)
          .py(9)
          .gap(5)
          .rounded(11)
          .bg(sel ? mix(t.background, t.accent, 0.08) : t.background)
          .border(1)
          .border_color(sel ? t.accent : t.border)
          .cursor_pointer()
          .hover(s => s.border_color(sel ? t.accent : alpha(t.accent, 0.5)))
          .on_click((_e, cx) => app.selectRun(r.id, cx))
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(
                div()
                  .flex_none()
                  .w(7)
                  .h(7)
                  .rounded_full()
                  .bg(lk.color)
                  .when(lk.key === "running", el => el.loop("opacity", { from: 0.25, to: 1, period: 1000 })),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(r.name),
              ),
          )
          .child(
            div()
              .truncate()
              .text_size(10.5)
              .text_color(t.dim)
              .child(
                [
                  r.owner?.master ? "master" : r.owner?.name,
                  when,
                  `${r.agents ?? 0} agents`,
                  r.failed ? `${r.failed} failed` : null,
                  r.resumed && isLive(r.status) ? "resumed" : null,
                  r.liveness?.reason === "gone" ? "session gone" : r.liveness?.reason === "quiet" ? "quiet" : null,
                  r.liveness?.reason === "waiting" ? `waiting on ${r.liveness.waiting[0]?.tool}` : null,
                ]
                  .filter(Boolean)
                  .join("  ·  "),
              ),
          );
      }),
    ),
    );
}

export function runHeader(app, t, run, lanes, now) {
  const lk = look(run.status, t);
  const span = (run.endedAt ?? now) - (run.startedAt ?? now);
  const total = lanes.reduce((n, l) => n + l.nodes.length, 0) || 1;
  const pill = (text, color) =>
    h_flex()
      .gap(6)
      .px(9)
      .h(22)
      .rounded_full()
      .items_center()
      .bg(alpha(color, 0.13))
      .child(div().w(6).h(6).rounded_full().bg(color))
      .child(div().text_size(11).font_medium().text_color(color).child(text));
  const fact = (name, value) =>
    h_flex()
      .gap(5)
      .items_center()
      .child(icon(name, 12, t.dim))
      .child(div().font_family(mono()).text_size(11.5).text_color(t.muted).child(value));
  const lastLog = run.logs?.[run.logs.length - 1];
  return v_flex()
    .flex_none()
    .px(28)
    .pt(22)
    .pb(18)
    .gap(10)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(ownerChip(app, t, run))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .font_family(mono())
            .text_size(10.5)
            .text_color(t.dim)
            .truncate()
            .child([run.id, tildify(run.cwd, home())].filter(Boolean).join("  ·  ")),
        ),
    )
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .child(div().text_size(23).font_semibold().text_color(t.foreground).child(run.name))
        .child(pill(lk.label, lk.color))
        .child(div().flex_1())
        .when(app.runTab(run) === "graph", el => el.child(dirSwitch(t, "run-dir")))
        .child(
          segmented(t, "run-tab", [
            { id: "graph", label: "Graph", icon: "flow" },
            { id: "terminals", label: "Terminals", icon: "terminal" },
            ...(hasOutput(run)
              ? [{ id: "output", label: run.output.files.filter(f => f.exists).length ? `Output · ${run.output.files.filter(f => f.exists).length}` : "Output", icon: "sparkles" }]
              : []),
          ], app.runTab(run), (id, cx) => app.setRunTab(id, cx), { size: "sm" }),
        )
        .when(RESUMABLE.includes(run.status), el => el.child(resumeButton(app, t, run)))
        .child(btn(t, "edit-run", "Edit as workflow", cx => app.editRun(cx), { icon: "square-pen", size: "sm", tooltip: "Open this run's script in the editor" })),
    )
    .when(!!run.liveness?.text, el => el.child(livenessLine(app, t, run)))
    .when(app.resume?.runId === run.id && app.resume.phase === "armed", el => el.child(resumeConfirm(app, t, run)))
    .when(!!run.description, el =>
      el.child(
        div().max_w(880).text_size(12.5).line_height(1.5).text_color(t.muted).child(clip(run.description, 260)),
      ),
    )
    .child(
      h_flex()
        .gap(18)
        .items_center()
        .child(fact("clock", duration(span)))
        .child(fact("layers", `${run.done ?? 0}/${run.agentList?.length ?? run.agents ?? 0} agents`))
        .when(run.tokens != null, el => el.child(fact("bolt", `${compact(run.tokens)} tokens`)))
        .when(run.toolCalls != null, el => el.child(fact("wrench", `${run.toolCalls} tool calls`)))
        .child(
          div()
            .text_size(11.5)
            .text_color(t.dim)
            .child(isLive(run.status) ? `started ${ago(run.startedAt, now)}` : `finished ${ago(run.endedAt, now)}`),
        ),
    )
    .child(
      h_flex()
        .mt(4)
        .gap(4)
        .w_full()
        .max_w(880)
        .children(
          lanes.map(l => {
            const n = l.nodes.length || 1;
            return v_flex()
              .w(`${Math.max(6, (l.nodes.length / total) * 100)}%`)
              .gap(5)
              .child(
                h_flex()
                  .h(5)
                  .rounded_full()
                  .overflow_hidden()
                  .bg(alpha(t.foreground, 0.08))
                  .child(
                    div()
                      .h_full()
                      .w(`${(l.done / n) * 100}%`)
                      .bg(ok(t)),
                  )
                  .child(
                    div()
                      .h_full()
                      .w(`${(l.failed / n) * 100}%`)
                      .bg(t.blocked),
                  )
                  .child(
                    div()
                      .h_full()
                      .w(`${(l.live / n) * 100}%`)
                      .bg(t.working)
                      .loop("opacity", { from: 0.4, to: 1, period: 1200 }),
                  ),
              )
              .child(
                div()
                  .truncate()
                  .text_size(10)
                  .text_color(l.live ? t.working : t.dim)
                  .child(l.title),
              );
          }),
        ),
    )
    .when(!!run.error, el =>
      el.child(
        h_flex()
          .gap(8)
          .px(12)
          .py(8)
          .rounded(9)
          .max_w(880)
          .bg(alpha(t.blocked, 0.1))
          .border(1)
          .border_color(alpha(t.blocked, 0.35))
          .child(icon("x", 13, t.blocked))
          .child(
            div()
              .flex_1()
              .text_size(11.5)
              .text_color(t.blocked)
              .child(clip(String(run.error), 300)),
          ),
      ),
    )
    .when(!!lastLog && !run.error, el =>
      el.child(
        h_flex()
          .gap(7)
          .items_center()
          .child(icon("terminal", 12, t.dim))
          .child(
            div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.dim).child(lastLog),
          ),
      ),
    );
}
