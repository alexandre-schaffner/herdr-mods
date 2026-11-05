// The panel's sections. Each takes `c`: { t, p, w, now, ui } where `ui` is the
// panel (its state and actions) and `w` its measured width.

import { h_flex, TextView, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { PROVIDER_NAMES } from "./agents.js";
import { btn, card, chip, iconBtn, sectionHeader, seg, stop, textLink } from "./ui.js";
import {
  ago,
  alpha,
  clip,
  elapsed,
  icon,
  location,
  mono,
  plain,
  plural,
  RISK,
  SEVERITY,
  shortSha,
} from "./util.js";

// ── PR header ───────────────────────────────────────────────────────────────

export function prHeader(c, pr) {
  const { t } = c;
  return v_flex()
    .w_full()
    .flex_none()
    .gap(7)
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(chip(t, `#${pr.number}`, t.muted, { mono: true, h: 19 }))
        .when(pr.isDraft, (el) => el.child(chip(t, "Draft", t.dim, { h: 19 })))
        .child(div().flex_1())
        .child(div().text_size(11).font_family(mono()).text_color(c.p.ok).child(`+${pr.additions}`))
        .child(
          div()
            .text_size(11)
            .font_family(mono())
            .text_color(c.p.critical)
            .child(`−${pr.deletions}`),
        )
        .child(div().text_size(11).text_color(t.dim).child(plural(pr.changedFiles, "file"))),
    )
    .child(
      div()
        .w_full()
        .text_size(15)
        .font_semibold()
        .line_height(1.3)
        .text_color(t.foreground)
        .whitespace_normal()
        .child(pr.title),
    )
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .min_w(0)
        .text_size(11.5)
        .text_color(t.muted)
        .child(icon("branch", 12, t.dim))
        .child(
          div()
            .min_w(0)
            .max_w(c.w * 0.42)
            .truncate()
            .font_family(mono())
            .text_size(11)
            .child(pr.sourceBranch),
        )
        .child(icon("chevron-right", 10, t.dim))
        .child(
          div()
            .min_w(0)
            .max_w(c.w * 0.25)
            .truncate()
            .font_family(mono())
            .text_size(11)
            .child(pr.targetBranch),
        )
        .child(div().text_color(t.dim).child("·"))
        .child(div().min_w(0).truncate().child(`@${pr.author}`)),
    );
}

// ── Live run ────────────────────────────────────────────────────────────────

const PHASES = ["Overview", "Analysis", "Verdict", "Scorecard"];
const CURRENT = { none: 0, A: 1, B: 1, C: 3, D: 4 };

function stepper(c, current) {
  const { t } = c;
  const on = t.accent;
  const node = (i) => {
    const done = i < current;
    const live = i === current;
    return div()
      .size(18)
      .flex_none()
      .rounded_full()
      .flex()
      .items_center()
      .justify_center()
      .when(done, (el) => el.bg(on).child(icon("check", 10, t.accent_foreground ?? t.background)))
      .when(live, (el) =>
        el
          .border(2)
          .border_color(on)
          .bg(alpha(on, 0.12))
          .child(
            div()
              .size(6)
              .rounded_full()
              .bg(on)
              .loop("opacity", { from: 0.25, to: 1, period: 1300 }),
          ),
      )
      .when(!done && !live, (el) => el.border(1.5).border_color(t.input ?? t.border));
  };
  const bar = (filled) =>
    div()
      .flex_1()
      .h(2)
      .rounded_full()
      .bg(filled ? on : alpha(t.foreground, 0.1));
  return v_flex()
    .w_full()
    .gap(6)
    .child(
      h_flex()
        .w_full()
        .items_center()
        .children(
          PHASES.map((_, i) =>
            h_flex()
              .flex_1()
              .items_center()
              .child(bar(i > 0 && i <= current).when(i === 0, (el) => el.opacity(0)))
              .child(node(i))
              .child(bar(i < current).when(i === PHASES.length - 1, (el) => el.opacity(0))),
          ),
        ),
    )
    .child(
      h_flex()
        .w_full()
        .children(
          PHASES.map((label, i) =>
            div()
              .flex_1()
              .text_center()
              .text_size(10.5)
              .when(i === current, (el) => el.font_semibold().text_color(t.foreground))
              .when(i !== current, (el) => el.text_color(i < current ? t.muted : t.dim))
              .child(label),
          ),
        ),
    );
}

export function progressBar(c, fraction, color, o = {}) {
  const { t } = c;
  const width = Math.max(0, (o.width ?? c.w - 58) * Math.max(0.02, Math.min(1, fraction)));
  return div()
    .w_full()
    .h(o.h ?? 4)
    .flex_none()
    .rounded_full()
    .bg(alpha(t.foreground, 0.08))
    .overflow_hidden()
    .child(
      div()
        .h_full()
        .w(width)
        .rounded_full()
        .bg(color)
        .transition("width", { duration: 700, easing: "ease-out" })
        .when(Boolean(o.pulse), (el) => el.loop("opacity", { from: 0.6, to: 1, period: 1600 })),
    );
}

export function runCard(c, run, watcher) {
  const { t, ui } = c;
  const current = CURRENT[run.phase] ?? 0;
  const counts = [
    run.steps > 0 ? plural(run.steps, "step") : null,
    run.issues.length > 0 ? `${plural(run.issues.length, "concern")} so far` : null,
    run.generationMode === "incremental" ? "incremental" : null,
  ].filter(Boolean);
  return card(t, { tint: t.accent, gap: 14 })
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon("spinner", 14, t.accent).spin(900))
        .child(
          div()
            .text_size(13)
            .font_semibold()
            .text_color(t.foreground)
            .child(current >= 4 ? "Wrapping up" : "Revv is reviewing"),
        )
        .child(div().flex_1())
        .child(
          div()
            .text_size(11)
            .font_family(mono())
            .text_color(t.dim)
            .child(elapsed(run.startedAt, c.now)),
        ),
    )
    .child(stepper(c, current))
    .child(
      v_flex()
        .gap(6)
        .child(progressBar(c, run.progress / 100, t.accent, { pulse: true }))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .text_size(11)
            .text_color(t.muted)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .child(counts.join(" · ") || `Reviewing ${shortSha(run.headSha)}`),
            )
            .child(div().font_family(mono()).text_color(t.dim).child(`${run.progress}%`)),
        ),
    )
    .when(Boolean(watcher), (el) =>
      el.child(
        h_flex()
          .gap(8)
          .child(
            btn(t, "run-watch", "Watch in terminal", () => ui.peekTerminal(watcher.address), {
              size: "sm",
              icon: "terminal",
            }),
          )
          .child(div().flex_1()),
      ),
    );
}

export function runErrorCard(c, run) {
  const { t, p, ui } = c;
  return card(t, { tint: p.critical, gap: 8 })
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon("alert", 15, p.critical))
        .child(
          div()
            .text_size(13)
            .font_semibold()
            .text_color(t.foreground)
            .child("The last review didn't finish"),
        )
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(ago(run.startedAt, c.now))),
    )
    .child(
      div()
        .text_size(12)
        .text_color(t.muted)
        .whitespace_normal()
        .child(clip(run.error || "Generation stopped before it could complete.", 220)),
    )
    .child(
      h_flex()
        .gap(8)
        .child(
          btn(t, "run-retry", "Try again", (cx) => ui.reReview("full", cx), {
            size: "sm",
            icon: "refresh",
            busy: ui.busy === "review",
          }),
        ),
    );
}

// ── Verdict ─────────────────────────────────────────────────────────────────

function riskBars(color, filled, t) {
  return h_flex()
    .flex_none()
    .items_end()
    .gap(3)
    .h(22)
    .children(
      [10, 16, 22].map((h, i) =>
        div()
          .w(5)
          .h(h)
          .rounded(2)
          .bg(i < filled ? color : alpha(t.foreground, 0.1)),
      ),
    );
}

export function findingsMeter(c, issues) {
  const { t, p } = c;
  const sorted = [...issues].sort(
    (a, b) => (SEVERITY[b.severity]?.rank ?? 0) - (SEVERITY[a.severity]?.rank ?? 0),
  );
  const done = issues.filter((i) => i.resolution.status !== "open").length;
  const bySeverity = ["critical", "warning", "info"]
    .map((s) => [
      s,
      issues.filter((i) => i.severity === s && i.resolution.status === "open").length,
    ])
    .filter(([, n]) => n > 0);
  return v_flex()
    .gap(7)
    .child(
      h_flex()
        .w_full()
        .h(6)
        .gap(3)
        .children(
          sorted.map((issue) => {
            const open = issue.resolution.status === "open";
            const color = open
              ? p[issue.severity]
              : issue.resolution.status === "addressed"
                ? p.ok
                : t.dim;
            return div()
              .flex_1()
              .h_full()
              .rounded(3)
              .bg(open ? alpha(color, 0.9) : alpha(color, 0.55))
              .tooltip(clip(issue.title, 90));
          }),
        ),
    )
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .text_size(11.5)
        .child(
          div()
            .text_color(done === issues.length ? p.ok : t.foreground)
            .font_medium()
            .child(
              done === issues.length
                ? `All ${plural(issues.length, "finding")} handled`
                : `${done} of ${issues.length} handled`,
            ),
        )
        .child(div().flex_1())
        .children(
          bySeverity.map(([s, n]) =>
            h_flex()
              .gap(4)
              .items_center()
              .child(div().size(6).rounded_full().bg(p[s]))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(
                    `${n} ${n === 1 ? SEVERITY[s].label.toLowerCase() : SEVERITY[s].plural.toLowerCase()}`,
                  ),
              ),
          ),
        ),
    );
}

export function verdictCard(c, review, o = {}) {
  const { t, p, ui } = c;
  const risk = RISK[review.riskLevel] ?? RISK.medium;
  const color = p.risk[review.riskLevel] ?? t.accent;
  const summary = plain(review.summary);
  const long = summary.length > 210;
  const expanded = ui.summaryOpen;
  return card(t, { tint: color, gap: 12 })
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .child(riskBars(color, risk.bars, t))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .flex_none()
                    .text_size(15)
                    .font_semibold()
                    .text_color(color)
                    .child(risk.label),
                )
                .child(div().flex_1())
                .child(
                  div()
                    .flex_none()
                    .text_size(10.5)
                    .font_family(mono())
                    .text_color(t.dim)
                    .tooltip(
                      o.previous
                        ? "A newer review is running"
                        : `Reviewed ${review.reviewedHeadSha}`,
                    )
                    .child(
                      `${o.previous ? "previous · " : ""}${shortSha(review.reviewedHeadSha)} · ${ago(review.completedAt ?? review.generatedAt, c.now)}`,
                    ),
                ),
            )
            .child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(risk.line)),
        ),
    )
    .when(summary.length > 0, (el) =>
      el.child(
        v_flex()
          .gap(5)
          .child(
            expanded
              ? div()
                  .id("summary-text")
                  .w_full()
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .on_mouse_down("left", stop)
                  .child(
                    TextView.markdown(
                      `summary-${review.walkthroughId}`,
                      review.summary,
                    ).selectable(),
                  )
              : div()
                  .w_full()
                  .text_size(12.5)
                  .line_height(1.45)
                  .text_color(t.muted)
                  .whitespace_normal()
                  .child(long ? clip(summary, 200) : summary),
          )
          .when(long || expanded, (el) =>
            el.child(
              textLink(
                t,
                "summary-toggle",
                expanded ? "Show less" : "Read the whole summary",
                (cx) => ui.toggleSummary(cx),
                t.accent,
              ),
            ),
          ),
      ),
    )
    .when(review.issues.length > 0, (el) => el.child(findingsMeter(c, review.issues)))
    .when(review.issues.length === 0, (el) =>
      el.child(
        h_flex()
          .gap(7)
          .items_center()
          .child(icon("check-circle", 14, p.ok))
          .child(
            div()
              .text_size(12)
              .font_medium()
              .text_color(p.ok)
              .child("Nothing flagged. A clean review."),
          ),
      ),
    );
}

/** Shown when the review no longer describes what's checked out. */
export function staleStrip(c, pr, review) {
  const { t, p, ui } = c;
  const reason = review?.stale
    ? "The PR moved past this review."
    : !pr.checkoutAtHead
      ? "Your checkout isn't at the PR head Revv knows."
      : null;
  if (!reason) return null;
  return h_flex()
    .w_full()
    .flex_none()
    .gap(9)
    .px(12)
    .py(9)
    .items_center()
    .rounded(10)
    .bg(alpha(p.warning, 0.09))
    .border(1)
    .border_color(alpha(p.warning, 0.25))
    .child(icon("refresh", 13, p.warning))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .text_size(11.5)
        .text_color(t.foreground)
        .whitespace_normal()
        .child(reason),
    )
    .child(
      btn(t, "stale-rereview", "Re-review", (cx) => ui.reReview("incremental", cx), {
        size: "sm",
        kind: "tinted",
        tint: p.warning,
        busy: ui.busy === "review",
      }),
    );
}

export function notReviewedCard(c) {
  const { t, ui } = c;
  return card(t, { tint: t.accent, gap: 12, p: 16 })
    .child(
      h_flex()
        .gap(11)
        .items_center()
        .child(
          div()
            .size(34)
            .flex_none()
            .rounded(10)
            .bg(alpha(t.accent, 0.14))
            .flex()
            .items_center()
            .justify_center()
            .child(icon("scan", 17, t.accent)),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              div()
                .text_size(13.5)
                .font_semibold()
                .text_color(t.foreground)
                .child("Not reviewed yet"),
            )
            .child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .whitespace_normal()
                .child("Revv reads the whole diff, flags what matters and scores it on nine axes."),
            ),
        ),
    )
    .child(
      btn(t, "first-review", "Review with Revv", (cx) => ui.reReview("full", cx), {
        kind: "primary",
        size: "lg",
        icon: "sparkles",
        grow: true,
        busy: ui.busy === "review",
      }),
    );
}

// ── Findings ────────────────────────────────────────────────────────────────

function statusGlyph(c, issue) {
  const { t, p } = c;
  if (issue.resolution.status === "addressed") return icon("check-circle", 14, p.ok);
  if (issue.resolution.status === "wont_fix") return icon("minus", 14, t.dim);
  return icon(SEVERITY[issue.severity]?.icon ?? "info", 14, p[issue.severity] ?? t.muted);
}

function resolutionNote(c, issue) {
  const { t, p } = c;
  const r = issue.resolution;
  if (r.status === "open") return null;
  const tone = r.status === "addressed" ? p.ok : t.muted;
  const who = [r.status === "addressed" ? "Addressed" : "Won't fix", r.by ? `by ${r.by}` : null]
    .filter(Boolean)
    .join(" ");
  const tail = [r.commitSha ? shortSha(r.commitSha) : null, r.at ? ago(r.at, c.now) : null]
    .filter(Boolean)
    .join(" · ");
  return v_flex()
    .w_full()
    .gap(4)
    .px(10)
    .py(8)
    .rounded(8)
    .bg(alpha(tone, 0.08))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(icon(r.status === "addressed" ? "check" : "minus", 12, tone))
        .child(div().text_size(11.5).font_medium().text_color(tone).child(who))
        .child(div().flex_1())
        .when(Boolean(tail), (el) =>
          el.child(div().text_size(10.5).font_family(mono()).text_color(t.dim).child(tail)),
        ),
    )
    .when(Boolean(r.explanation), (el) =>
      el.child(
        div()
          .text_size(11.5)
          .text_color(t.muted)
          .whitespace_normal()
          .child(clip(r.explanation, 400)),
      ),
    );
}

function issueActions(c, issue, live) {
  const { t, ui } = c;
  const open = issue.resolution.status === "open" && !live;
  const target = ui.target();
  const fixLabel = target
    ? target.kind === "send"
      ? `Send to ${target.label}`
      : `Fix with ${target.label}`
    : "Fix";
  return h_flex()
    .w_full()
    .gap(6)
    .items_center()
    .when(open, (el) =>
      el
        .child(
          btn(t, `fix-${issue.id}`, fixLabel, (cx) => ui.fix(issue, cx), {
            size: "sm",
            kind: "primary",
            icon: target?.kind === "send" ? "send" : "sparkles",
            disabled: !target,
            tooltip: target ? undefined : "Connect a coding agent in Revv first",
          }),
        )
        .child(
          iconBtn(
            t,
            `fix-menu-${issue.id}`,
            "chevron-down",
            (_cx, e) => ui.openAgentMenu(issue, e),
            "Choose the agent",
            { size: 26, icon: 12 },
          ),
        ),
    )
    .when(open && issue.submitted, (el) =>
      el.child(chip(t, "On GitHub", t.muted, { icon: "message" })),
    )
    .child(div().flex_1())
    .when(Boolean(issue.filePath), (el) =>
      el.child(iconBtn(t, `peek-${issue.id}`, "eye", () => ui.peek(issue), "Peek at the code")),
    )
    .when(open, (el) =>
      el.child(
        iconBtn(
          t,
          `copy-${issue.id}`,
          "copy",
          (cx) => ui.copyPrompt(issue, cx),
          "Copy the fix prompt",
        ),
      ),
    );
}

function issueRow(c, issue, o) {
  const { t, ui } = c;
  const expanded = ui.expanded.has(issue.id);
  const selected = ui.selected === issue.id && ui.focusedPanel;
  const settled = issue.resolution.status !== "open";
  const loc = location(issue);
  const head = h_flex()
    .id(`row-${issue.id}`)
    .w_full()
    .flex_none()
    .px(10)
    .gap(9)
    .when(!expanded, (el) => el.h(34).items_center())
    .when(expanded, (el) => el.min_h(34).py(9).items_start())
    .rounded(9)
    .cursor_pointer()
    .when(!expanded, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => ui.toggleIssue(issue.id, cx))
    .child(
      div()
        .flex_none()
        .when(expanded, (el) => el.mt(1))
        .child(statusGlyph(c, issue)),
    )
    .child(
      div()
        .flex_1()
        .min_w(0)
        .when(!expanded, (el) => el.truncate())
        .when(expanded, (el) => el.whitespace_normal().line_height(1.35))
        .text_size(12.5)
        .when(settled, (el) => el.text_color(t.dim).line_through())
        .when(!settled, (el) => el.text_color(t.foreground).when(expanded, (e) => e.font_medium()))
        .child(issue.title),
    )
    .when(Boolean(loc) && !expanded && c.w > 300, (el) =>
      el.child(
        div()
          .flex_none()
          .max_w(Math.max(70, c.w * 0.3))
          .truncate()
          .text_size(10.5)
          .font_family(mono())
          .text_color(t.dim)
          .child(loc),
      ),
    )
    .when(o.live, (el) => el.child(chip(t, "new", t.accent, { h: 17, size: 9.5 })))
    .child(
      div()
        .flex_none()
        .when(expanded, (el) => el.mt(2))
        .child(icon(expanded ? "chevron-up" : "chevron-down", 11, t.dim)),
    );
  if (!expanded) {
    return div()
      .w_full()
      .flex_none()
      .rounded(10)
      .border(1)
      .border_color(selected ? alpha(t.accent, 0.6) : alpha(t.border, 0))
      .child(head);
  }
  return v_flex()
    .w_full()
    .flex_none()
    .rounded(10)
    .bg(alpha(t.foreground, 0.03))
    .border(1)
    .border_color(selected ? alpha(t.accent, 0.6) : t.border)
    .child(head)
    .child(
      v_flex()
        .w_full()
        .px(12)
        .pb(12)
        .pt(2)
        .gap(10)
        .when(Boolean(issue.filePath), (el) =>
          el.child(
            h_flex()
              .id(`loc-${issue.id}`)
              .gap(6)
              .items_center()
              .px(8)
              .h(24)
              .rounded(7)
              .bg(alpha(t.foreground, 0.05))
              .cursor_pointer()
              .hover((s) => s.bg(alpha(t.foreground, 0.09)))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                ui.peek(issue);
              })
              .child(icon("file", 12, t.muted))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(11)
                  .font_family(mono())
                  .text_color(t.muted)
                  .child(
                    `${issue.filePath}${issue.startLine != null ? `:${issue.startLine}` : ""}`,
                  ),
              )
              .child(icon("eye", 12, t.dim)),
          ),
        )
        .child(
          div()
            .id(`desc-wrap-${issue.id}`)
            .w_full()
            .text_size(12.5)
            .text_color(t.foreground)
            .on_mouse_down("left", stop)
            .child(
              TextView.markdown(
                `desc-${issue.id}`,
                issue.description || "_No description._",
              ).selectable(),
            ),
        )
        .when(!settled && o.live, (el) =>
          el.child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(
                "Flagged during the run in progress. It may still be retracted or relabelled.",
              ),
          ),
        )
        .when(settled, (el) => el.child(resolutionNote(c, issue)))
        .child(issueActions(c, issue, o.live)),
    );
}

export function findingsSection(c, issues, o = {}) {
  const { t, p, ui } = c;
  const filter = o.live ? "all" : ui.filter;
  const shown = filter === "open" ? issues.filter((i) => i.resolution.status === "open") : issues;
  const openCount = issues.filter((i) => i.resolution.status === "open").length;
  const groups = ["critical", "warning", "info"]
    .map((s) => [s, shown.filter((i) => i.severity === s)])
    .filter(([, list]) => list.length > 0);
  ui.visibleIssues.push(...groups.flatMap(([, list]) => list.map((i) => i.id)));
  return v_flex()
    .w_full()
    .flex_none()
    .gap(6)
    .child(
      sectionHeader(t, o.live ? "Flagged so far" : "Findings", {
        count: o.live ? issues.length : openCount,
        right:
          o.live || openCount === issues.length
            ? null
            : seg(
                t,
                "filter",
                [
                  { id: "open", label: "Open" },
                  { id: "all", label: "All" },
                ],
                filter,
                (id, cx) => ui.setFilter(id, cx),
              ),
      }),
    )
    .when(shown.length === 0, (el) =>
      el.child(
        h_flex()
          .gap(8)
          .px(10)
          .h(34)
          .items_center()
          .rounded(9)
          .bg(alpha(p.ok, 0.07))
          .child(icon("check-circle", 14, p.ok))
          .child(div().text_size(12).text_color(t.foreground).child("Every finding is handled."))
          .child(div().flex_1())
          .child(textLink(t, "show-all", "Show all", (cx) => ui.setFilter("all", cx), t.muted)),
      ),
    )
    .children(
      groups.flatMap(([severity, list]) => [
        h_flex()
          .h(22)
          .pt(4)
          .px(10)
          .gap(6)
          .items_center()
          .child(
            div()
              .text_size(10.5)
              .font_semibold()
              .text_color(p[severity])
              .child(SEVERITY[severity].plural.toUpperCase()),
          )
          .child(
            div().text_size(10.5).font_family(mono()).text_color(t.dim).child(String(list.length)),
          ),
        ...list.map((issue) => issueRow(c, issue, { live: Boolean(o.live) })),
      ]),
    );
}

// ── Conversations ───────────────────────────────────────────────────────────

function avatar(t, name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const slots = ["ansi4", "ansi5", "ansi6", "ansi2", "ansi3", "ansi1"];
  const color = t[slots[h % slots.length]] ?? t.accent;
  return div()
    .size(22)
    .flex_none()
    .rounded_full()
    .bg(alpha(color, 0.18))
    .flex()
    .items_center()
    .justify_center()
    .text_size(10.5)
    .font_semibold()
    .text_color(color)
    .child((name[0] ?? "?").toUpperCase());
}

export function threadsSection(c, threads, pr) {
  const { t, ui } = c;
  if (threads.length === 0) return null;
  return v_flex()
    .w_full()
    .flex_none()
    .gap(4)
    .child(
      sectionHeader(t, "Conversations", {
        count: threads.length,
        right: textLink(t, "threads-open", "Open in Revv", () => ui.openInRevv(pr), t.muted),
      }),
    )
    .children(
      threads.slice(0, 8).map((thread) =>
        h_flex()
          .id(`thread-${thread.id}`)
          .w_full()
          .px(10)
          .py(8)
          .gap(10)
          .items_start()
          .rounded(9)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop)
          .on_click(() => ui.openInRevv(pr))
          .child(avatar(t, thread.author))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .flex_none()
                      .text_size(12)
                      .font_semibold()
                      .text_color(t.foreground)
                      .child(thread.author),
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(10.5)
                      .font_family(mono())
                      .text_color(t.dim)
                      .child(`${thread.filePath.split("/").pop()}:${thread.line}`),
                  )
                  .when(
                    thread.status === "pending_coder" || thread.status === "pending_reviewer",
                    (el) =>
                      el.child(
                        chip(
                          t,
                          thread.status === "pending_coder" ? "needs a reply" : "awaiting reviewer",
                          thread.status === "pending_coder" ? c.p.warning : t.dim,
                          { h: 17, size: 9.5 },
                        ),
                      ),
                  )
                  .when(thread.replies > 0, (el) =>
                    el.child(
                      h_flex()
                        .gap(3)
                        .items_center()
                        .child(icon("message", 11, t.dim))
                        .child(
                          div().text_size(10.5).text_color(t.dim).child(String(thread.replies)),
                        ),
                    ),
                  ),
              )
              .child(
                div()
                  .text_size(12)
                  .line_height(1.4)
                  .text_color(t.muted)
                  .whitespace_normal()
                  .child(clip(plain(thread.excerpt), 150)),
              ),
          ),
      ),
    )
    .when(threads.length > 8, (el) =>
      el.child(
        div()
          .px(10)
          .text_size(11)
          .text_color(t.dim)
          .child(`and ${threads.length - 8} more in Revv`),
      ),
    );
}

// ── Scorecard ───────────────────────────────────────────────────────────────

export function scorecardSection(c, ratings) {
  const { t, p } = c;
  if (ratings.length === 0) return null;
  const cols = c.w < 300 ? 2 : 3;
  const tileW = Math.floor((c.w - 28 - (cols - 1) * 6) / cols);
  const counts = { pass: 0, concern: 0, blocker: 0 };
  for (const r of ratings) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const summary = [
    counts.blocker ? `${counts.blocker} blocking` : null,
    counts.concern ? `${counts.concern} to watch` : null,
    counts.pass ? `${counts.pass} pass` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return v_flex()
    .w_full()
    .flex_none()
    .gap(6)
    .child(
      sectionHeader(t, "Scorecard", {
        right: div().text_size(11).text_color(t.dim).child(summary),
      }),
    )
    .child(
      h_flex()
        .w_full()
        .flex_wrap()
        .gap(6)
        .children(
          ratings.map((r) => {
            const color = p.verdict[r.verdict] ?? t.muted;
            return h_flex()
              .id(`axis-${r.axis}`)
              .w(tileW)
              .h(30)
              .px(9)
              .gap(7)
              .items_center()
              .rounded(8)
              .bg(alpha(color, r.verdict === "pass" ? 0.06 : 0.11))
              .border(1)
              .border_color(alpha(color, r.verdict === "pass" ? 0.12 : 0.3))
              .tooltip(
                `${r.label}: ${r.verdict} (${r.confidence} confidence). ${clip(r.rationale, 260)}`,
              )
              .child(
                r.verdict === "pass"
                  ? icon("check", 11, color)
                  : r.verdict === "blocker"
                    ? icon("x", 11, color)
                    : div().size(7).mx(2).rounded_full().bg(color),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(11.5)
                  .text_color(r.verdict === "pass" ? t.muted : t.foreground)
                  .child(r.label),
              );
          }),
        ),
    );
}

// ── Empty and edge states ───────────────────────────────────────────────────

export function emptyState(c, o) {
  const { t } = c;
  const tint = o.tint ?? t.accent;
  return v_flex()
    .w_full()
    .flex_1()
    .min_h(260)
    .items_center()
    .justify_center()
    .gap(12)
    .px(20)
    .child(
      div()
        .size(46)
        .rounded(14)
        .bg(alpha(tint, 0.11))
        .border(1)
        .border_color(alpha(tint, 0.2))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(o.icon, 21, tint)),
    )
    .child(
      div().text_size(14).font_semibold().text_color(t.foreground).text_center().child(o.title),
    )
    .when(Boolean(o.body), (el) =>
      el.child(
        div()
          .max_w(270)
          .text_size(12)
          .line_height(1.5)
          .text_color(t.muted)
          .text_center()
          .whitespace_normal()
          .child(o.body),
      ),
    )
    .when(Boolean(o.code), (el) =>
      el.child(
        div()
          .max_w(Math.max(120, c.w - 60))
          .px(8)
          .h(22)
          .flex()
          .items_center()
          .rounded(6)
          .bg(alpha(t.foreground, 0.06))
          .text_size(11)
          .font_family(mono())
          .text_color(t.muted)
          .truncate()
          .child(o.code),
      ),
    )
    .when(Boolean(o.actions?.length), (el) => el.child(h_flex().pt(4).gap(8).children(o.actions)));
}

export function skeleton(c) {
  const { t } = c;
  const bar = (w, h = 10) =>
    div()
      .w(w)
      .h(h)
      .rounded(5)
      .bg(alpha(t.foreground, 0.07))
      .loop("opacity", { from: 0.45, to: 1, period: 1400 });
  return v_flex()
    .w_full()
    .gap(10)
    .child(bar(70, 14))
    .child(bar(c.w * 0.75, 16))
    .child(bar(c.w * 0.5))
    .child(div().h(6))
    .child(
      div()
        .w_full()
        .h(110)
        .rounded(12)
        .bg(alpha(t.foreground, 0.05))
        .loop("opacity", { from: 0.45, to: 1, period: 1400 }),
    )
    .child(bar(c.w * 0.6))
    .child(bar(c.w * 0.8))
    .child(bar(c.w * 0.7));
}

export const providerLabel = (provider) => PROVIDER_NAMES[provider] ?? provider;
