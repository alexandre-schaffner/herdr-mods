// Generated from mods/workflows/header.js by shared/sync.sh: edit it there.

// The Runs view's bars: the top bar, the strip of runs, and the selected run's header.
// Functions of the Workflows view.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { hasOutput } from "./output.js";
import { repoChip, repoRuns, shownRepo } from "./repos.js";
import { livenessLine, ownerChip, resumeButton, resumeConfirm } from "./resume.js";
import { isLive, RESUMABLE } from "./runs.js";
import { btn, iconBtn, seg as segmented } from "./ui.js";
import { ago, alpha, clip, compact, duration, host, icon, look, mix, mono } from "./util.js";

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
  const shelved = repoRuns(app).filter(r => r.archivedAt).length;
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
        .when(!runs.length && !shelved, el => el.child(div().text_size(12).text_color(t.dim).child(`No workflow runs in ${shownRepo(app)?.name ?? "this repository"} yet.`)))
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
          .when(!!r.archivedAt && !sel, el => el.opacity(0.6))
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
                  r.archivedAt ? "archived" : null,
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
    )
    .when(shelved > 0, el => el.child(archivedToggle(app, t, shelved)));
}

/** Shows or hides the repository's archived runs in the strip. */
function archivedToggle(app, t, n) {
  const on = app.showArchived;
  return h_flex()
    .id("runs-archived")
    .flex_none()
    .mx(14)
    .h(28)
    .px(10)
    .gap(6)
    .items_center()
    .rounded(8)
    .border(1)
    .border_color(on ? t.accent : t.border)
    .bg(on ? mix(t.background, t.accent, 0.08) : t.background)
    .cursor_pointer()
    .hover(s => s.border_color(alpha(t.accent, 0.5)))
    .tooltip(on ? "Hide archived runs" : "Show archived runs in the strip")
    .on_click((_e, cx) => app.toggleArchived(cx))
    .child(icon("archive", 13, on ? t.accent : t.muted))
    .child(div().text_size(11.5).font_medium().text_color(on ? t.foreground : t.muted).child(`Archived · ${n}`));
}

export function runHeader(app, t, run, _lanes, now) {
  const lk = look(run.status, t);
  const live = isLive(run.status);
  const agents = run.agentList?.length ?? run.agents ?? 0;
  const took = run.startedAt && run.endedAt > run.startedAt ? duration(run.endedAt - run.startedAt) : null;
  // A stalled run's liveness line already says when it last changed.
  const when = live ? `started ${ago(run.startedAt, now)}` : run.status !== "stalled" && run.endedAt ? `ended ${ago(run.endedAt, now)}` : null;
  const meta = [
    agents ? `${run.done ?? 0} of ${agents} agents done` : "No agents yet",
    run.failed ? `${run.failed} failed` : null,
    when,
    ["completed", "failed", "killed"].includes(run.status) && took ? `took ${took}` : null,
    run.tokens != null ? `${compact(run.tokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  const lastLog = live && !run.liveness?.text ? run.logs?.[run.logs.length - 1] : null;
  const files = hasOutput(run) ? run.output.files.filter(f => f.exists).length : 0;
  const extra = host.runExtra?.(t, run) ?? null;
  return v_flex()
    .flex_none()
    .px(28)
    .pt(20)
    .pb(16)
    .gap(8)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .min_w(0)
        .child(div().min_w(0).truncate().text_size(18).font_semibold().text_color(t.foreground).child(run.name))
        .child(statusPill(t, lk))
        .child(div().flex_1())
        .child(
          segmented(t, "run-tab", [
            { id: "graph", label: "Graph" },
            { id: "terminals", label: "Terminals" },
            ...(hasOutput(run) ? [{ id: "output", label: files ? `Output ${files}` : "Output" }] : []),
          ], app.runTab(run), (id, cx) => app.setRunTab(id, cx), { size: "sm" }),
        )
        .when(RESUMABLE.includes(run.status), el => el.child(resumeButton(app, t, run)))
        .child(archiveButton(app, t, run))
        .child(iconBtn(t, "edit-run", "square-pen", cx => app.editRun(cx), "Edit as workflow: open this run's script in the editor", { size: 26 })),
    )
    .when(!!run.description, el =>
      el.child(div().max_w(880).text_size(12.5).line_height(1.5).text_color(t.muted).child(clip(run.description, 220))),
    )
    .when(!!run.liveness?.text, el => el.child(livenessLine(app, t, run)))
    .when(!!run.error, el =>
      el.child(
        h_flex()
          .gap(8)
          .items_center()
          .max_w(880)
          .child(icon("x", 12, t.blocked))
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.blocked).child(clip(String(run.error), 300))),
      ),
    )
    .when(!!lastLog && !run.error, el =>
      el.child(
        h_flex()
          .gap(8)
          .items_center()
          .max_w(880)
          .child(icon("terminal", 12, t.dim))
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.dim).child(lastLog)),
      ),
    )
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .min_w(0)
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(meta))
        .child(ownerChip(app, t, run)),
    )
    .when(app.resume?.runId === run.id && app.resume.phase === "armed", el => el.child(resumeConfirm(app, t, run)))
    .when(!!extra, el => el.child(extra));
}

function statusPill(t, lk) {
  return h_flex()
    .flex_none()
    .gap(6)
    .px(8)
    .h(20)
    .rounded_full()
    .items_center()
    .bg(alpha(lk.color, 0.12))
    .child(div().w(6).h(6).rounded_full().bg(lk.color).when(lk.key === "running", el => el.loop("opacity", { from: 0.3, to: 1, period: 1000 })))
    .child(div().text_size(11).font_medium().text_color(lk.color).child(lk.label));
}

/** Archive / Unarchive for the shown run. A running run stays: archiving would hide live work. */
function archiveButton(app, t, run) {
  const shelved = (app.runs ?? []).find(r => r.id === run.id)?.archivedAt;
  if (shelved)
    return iconBtn(t, "unarchive-run", "archive", cx => app.archiveRun(run.id, false, cx), "Archived. Click to bring it back to the list.", { size: 26, color: t.accent });
  const live = isLive(run.status);
  return iconBtn(t, "archive-run", "archive", cx => app.archiveRun(run.id, true, cx), live ? "Still running: archive it once it ends" : "Archive: hide it from the list. Nothing is deleted.", {
    size: 26,
    disabled: live,
  });
}
