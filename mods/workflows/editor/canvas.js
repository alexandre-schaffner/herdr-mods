// The editor's center: a design drawn as a graph (phases as lanes, steps as cards), the code
// view, the issue list, the bar on a design edited by hand, and the run sheet.

import { Editor as CodeView, h_flex, v_flex } from "gpui-base";
import { div, PathBuilder } from "gpui-kit";
import { home } from "herdr";
import { callCard } from "../codegraph.js";
import { cardRows, cardShell, fanStacks, G, graph, graphDir, laneShell } from "../graph.js";
import { MODES, stopText } from "../model.js";
import { badge, btn, field, iconBtn } from "../ui.js";
import { alpha, clip, icon, kindColor, mono, scrollArea, tildify } from "../util.js";
import { scriptGraph } from "../scriptgraph.js";
import { cwd } from "./files.js";

export const MODE_ICON = { parallel: "layers", sequential: "list", fanout: "split", code: "code" };

export function canvas(ed, t) {
  const m = ed.model;
  const lanes = m.phases.map((p, i) => ({
    index: i + 1,
    title: p.title,
    phase: p,
    look: { key: "done", color: t.accent },
    done: 0,
    live: 0,
    failed: 0,
    nodes:
      p.mode === "code"
        ? // A code phase draws the agent() calls its code makes; a click opens the phase.
          phaseCalls(ed, p).map(c => ({
            id: `${p.id}:${c.id}`,
            step: c,
            call: true,
            phase: p,
            look: { key: "done", color: t.accent },
            portColor: alpha(t.accent, 0.7),
          }))
        : [
            ...p.steps.map(s => ({
              id: s.id,
              step: s,
              phase: p,
              look: { key: "done", color: t.accent },
              portColor: alpha(t.accent, 0.7),
            })),
            { id: `add-${p.id}`, ghost: true, phase: p },
          ],
  }));
  lanes.push({ index: lanes.length + 1, title: "", ghost: true, nodes: [], look: { key: "queued", color: t.dim } });
  const selected = ed.sel.kind === "step" ? ed.sel.id : null;
  return scrollArea(
    "ed-canvas",
    "both",
    div()
      .pb(160)
      .child(
        graph(lanes, t, selected, (id, cx) => {
          const n = lanes.flatMap(l => l.nodes).find(x => x.id === id);
          ed.select(cx, n?.call ? { kind: "phase", id: n.phase.id } : { kind: "step", id });
        }, {
          card: (n, tt, sel, onSelect) => card(ed, n, tt, sel, onSelect),
          lane: (l, size, tt) => laneFrame(ed, l, size, tt),
          palette: { done: alpha(t.accent, 0.45) },
        }),
      ),
  );
}

/** The agent() calls a code phase's code makes, re-read when the code changes. */
function phaseCalls(ed, p) {
  ed._phaseCalls ??= new Map();
  const hit = ed._phaseCalls.get(p.id);
  if (hit?.code === p.code) return hit.calls;
  const calls = scriptGraph(p.code).lanes.flatMap(l => l.steps);
  ed._phaseCalls.set(p.id, { code: p.code, calls });
  return calls;
}

function card(ed, n, t, selected, onSelect) {
  if (n.call) return callCard(n, t, ed.sel.kind === "phase" && ed.sel.id === n.phase.id, onSelect);
  if (n.ghost)
    return h_flex()
      .absolute()
      .left(n.x)
      .top(graphDir() === "v" ? n.y + (G.nodeH - 44) / 2 : n.y)
      .w(G.laneW)
      .h(44)
      .gap(8)
      .child(ghostButton(t, `ghost-${n.id}`, "plus", n.phase.mode === "fanout" ? "Add stage" : "Add step", cx => ed.addStep(cx, n.phase.id)).flex_1())
      .child(ghostButton(t, `ghost-code-${n.id}`, "code", "Code", cx => ed.addStep(cx, n.phase.id, true)).w(86));
  const s = n.step;
  if (s.kind === "code") return codeCard(ed, n, t, selected, onSelect);
  return agentCard(ed, n, t, selected, onSelect);
}

function ghostButton(t, id, iconName, label, onClick) {
  return h_flex()
    .id(id)
    .h_full()
    .rounded(12)
    .border(1)
    .border_dashed()
    .border_color(alpha(t.muted, 0.4))
    .justify_center()
    .items_center()
    .gap(6)
    .cursor_pointer()
    .hover(s => s.border_color(t.accent).bg(alpha(t.accent, 0.05)))
    .on_click((_e, cx) => onClick(cx))
    .child(icon(iconName, 12, t.muted))
    .child(div().text_size(12).text_color(t.muted).child(label));
}

/** A code step: its label and its first line of code. */
function codeCard(ed, n, t, selected, onSelect) {
  const s = n.step;
  const err = ed.issues.find(i => i.level === "error" && i.target?.step === s.id);
  const first = s.code.split("\n").find(l => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "";
  return cardShell(n, t, {
    id: `card-${s.id}`,
    selected,
    onSelect,
    dashed: true,
    shadow: false,
    border: err ? alpha(t.blocked, 0.6) : alpha(t.muted, 0.6),
    body: cardRows(
      h_flex()
        .gap(6)
        .items_center()
        .child(icon("code", 13, t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(s.label))
        .when(n.phase.loop.enabled && s.when !== "always", el =>
          el.child(badge(t, s.when === "first" ? "1st" : "2+", t.ansi5 ?? t.accent, { mono: true })),
        )
        .child(badge(t, "code", t.muted, { mono: true })),
      div()
        .truncate()
        .font_family(mono())
        .text_size(11)
        .text_color(err ? t.blocked : first ? t.muted : t.dim)
        .child(err ? err.msg : first ? clip(first, 70) : "Empty: click to write it"),
    ),
  });
}

function agentCard(ed, n, t, selected, onSelect) {
  const s = n.step;
  const err = ed.issues.find(i => i.level === "error" && i.target?.step === s.id);
  const first = s.prompt.trim().split("\n")[0];
  return cardShell(n, t, {
    id: `card-${s.id}`,
    selected,
    onSelect,
    border: err ? alpha(t.blocked, 0.6) : t.border,
    bar: { color: kindColor(s.label, t) },
    body: cardRows(
      h_flex()
        .gap(6)
        .items_center()
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(13.5)
            .font_semibold()
            .text_color(t.foreground)
            .child(s.label),
        )
        .when(n.phase.loop.enabled && s.when !== "always", el =>
          el.child(badge(t, s.when === "first" ? "1st" : "2+", t.ansi5 ?? t.accent, { mono: true })),
        )
        .when(s.repeat > 1, el => el.child(badge(t, `×${s.repeat}`, t.muted, { icon: "repeat", mono: true })))
        .when((s.files?.length ?? 0) > 0, el => el.child(badge(t, String(s.files.length), t.muted, { icon: "file-text", mono: true })))
        .when(s.output.kind !== "text", el =>
          el.child(badge(t, "schema", t.ansi6 ?? t.accent, { icon: "braces" })),
        )
        .when(s.isolation, el => el.child(badge(t, "worktree", t.ansi3 ?? t.accent, { icon: "git-branch" })))
        .when(!!(s.model || ed.model.defaults.model), el =>
          el.child(badge(t, s.model || ed.model.defaults.model, t.muted)),
        ),
      div()
        .truncate()
        .text_size(11.5)
        .text_color(err ? t.blocked : first ? t.muted : t.dim)
        .child(err ? err.msg : first ? clip(first, 80) : "Empty prompt: click to write it"),
    ),
  });
}

function laneFrame(ed, lane, size, t) {
  const v = size.dir === "v";
  const box = lane.box;
  if (lane.ghost)
    return (v ? h_flex() : v_flex())
      .id("lane-add")
      .absolute()
      .left(box.x)
      .top(box.y)
      .w(box.w)
      .h(v ? box.h : Math.max(220, box.h))
      .rounded(18)
      .border(1)
      .border_dashed()
      .border_color(alpha(t.muted, 0.35))
      .items_center()
      .justify_center()
      .gap(12)
      .child(icon("plus", 18, t.dim))
      .child(div().text_size(12.5).text_color(t.muted).child("Add a phase"))
      .child(
        h_flex()
          .gap(6)
          .child(btn(t, "lane-add-p", "Steps", cx => ed.addPhase(cx), { icon: "layers", size: "sm" }))
          .child(btn(t, "lane-add-f", "Fan-out", cx => ed.addPhase(cx, "fanout"), { icon: "split", size: "sm" })),
      );
  const p = lane.phase;
  const mode = MODES.find(x => x.id === p.mode);
  const real = lane.nodes.filter(x => !x.ghost);
  const decorations = p.mode === "fanout" ? fanStacks(real, box, t) : [];
  if (p.mode === "sequential") {
    real.slice(0, -1).forEach(n =>
      decorations.push(
        v
          ? div()
              .absolute()
              .left(n.x - box.x + G.laneW + (G.colGap - 12) / 2)
              .top(n.y - box.y + G.nodeH / 2 - 6)
              .child(icon("arrow-right", 12, t.accent))
          : div()
              .absolute()
              .left(n.x - box.x + G.laneW / 2 - 6)
              .top(n.y - box.y + G.nodeH - 1)
              .child(icon("arrow-down", 12, t.accent)),
      ),
    );
  }
  if (p.loop.enabled && real.length) {
    // A dashed arc from the last step back to the first: down the lane's left edge, or
    // under the row when top to bottom. `a` is the depth into the frame's edge, `p` the
    // distance along the steps.
    const first = real[0];
    const last = real[real.length - 1];
    const p0 = v ? first.x - box.x + 18 : first.y - box.y + 18;
    const p1 = v ? last.x - box.x + G.laneW - 18 : last.y - box.y + G.nodeH - 18;
    const at = (a, p) => (v ? [p, box.h - a] : [a, p]);
    const c = t.ansi5 ?? t.accent;
    const arc = PathBuilder.stroke(1.5)
      .dash_array([4, 3])
      .move_to(...at(12, p1))
      .curve_to(...at(5, p1 - 7), ...at(5, p1))
      .line_to(...at(5, p0 + 7))
      .curve_to(...at(12, p0), ...at(5, p0))
      .build();
    const head = PathBuilder.fill()
      .move_to(...at(13, p0))
      .line_to(...at(8, p0 - 3.5))
      .line_to(...at(8, p0 + 3.5))
      .close()
      .build();
    decorations.push(window.paint_path(arc, alpha(c, 0.8)).absolute().left(0).top(0).w(box.w).h(box.h));
    decorations.push(window.paint_path(head, c).absolute().left(0).top(0).w(box.w).h(box.h));
  }
  return laneShell(lane, size, t, {
    id: `lane-${p.id}`,
    headId: `lane-head-${p.id}`,
    selected: ed.sel.kind === "phase" && ed.sel.id === p.id,
    onHead: cx => ed.select(cx, { kind: "phase", id: p.id }),
    gap: 5,
    pt: 12,
    indexColor: t.accent,
    behind: decorations,
    trail: [
      p.loop.enabled && badge(t, `≤${p.loop.max}`, t.ansi5 ?? t.accent, { icon: "repeat", mono: true }),
      badge(t, mode.label, p.mode === "fanout" ? t.accent : t.muted, { icon: MODE_ICON[p.mode] }),
    ].filter(Boolean),
    rows: [
      div()
        .truncate()
        .when(p.mode === "fanout" && !p.loop.enabled, el => el.font_family(mono()))
        .text_size(10.5)
        .text_color(
          (p.mode === "fanout" && !p.source) || (p.loop.enabled && !p.steps.some(s => s.id === p.loop.until.step))
            ? t.blocked
            : p.loop.enabled
              ? (t.ansi5 ?? t.accent)
              : t.dim,
        )
        .child(
          [
            p.loop.enabled ? `↻ ${stopText(p)}` : null,
            p.mode === "fanout" ? (p.source ? `${p.loop.enabled ? "each of" : "for each in"} ${p.source}` : "choose a list to iterate") : p.loop.enabled ? null : p.detail || mode.hint,
          ]
            .filter(Boolean)
            .join("  ·  "),
        ),
    ],
  });
}

/** On a designed script edited by hand: fold the edits into the design, or drop them. */
export function strayBar(ed, t) {
  const busy = Boolean(ed.ai.job);
  return h_flex()
    .flex_none()
    .mx(16)
    .mt(12)
    .px(12)
    .py(9)
    .gap(10)
    .items_center()
    .rounded(10)
    .bg(alpha(t.ansi3 ?? t.working, 0.1))
    .border(1)
    .border_color(alpha(t.ansi3 ?? t.working, 0.35))
    .child(icon("square-pen", 13, t.ansi3 ?? t.working))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().text_size(12).font_medium().text_color(t.foreground).child("Edited by hand since it was designed"))
        .child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .child("It opens as code so the edits stay. Fold them into the design to keep editing it visually."),
        ),
    )
    .child(
      btn(t, "stray-restore", "Restore the design", cx => ed.restoreDesign(cx), {
        size: "sm",
        kind: "ghost",
        tooltip: "Drops the hand edits (Undo brings them back)",
      }),
    )
    .child(
      btn(t, "stray-fold", busy ? "Folding…" : "Fold edits into the design", cx => ed.foldEdits(cx), {
        icon: "sparkles",
        size: "sm",
        kind: "primary",
        disabled: busy,
        tooltip: "Claude updates the design to match the script; what the design can't express becomes code blocks",
      }),
    );
}

export function codePane(ed, t) {
  if (!ed.codeState) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(10)
      .child(btn(t, "code-open", "Show the code", cx => ed.setView(cx, "code"), { icon: "code" }));
  }
  return v_flex()
    .flex_1()
    .min_h(0)
    .p(16)
    .pb(110)
    .gap(10)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon(ed.model ? "eye" : "square-pen", 12, t.dim))
        .child(
          div()
            .text_size(11.5)
            .text_color(t.muted)
            .child(
              ed.model
                ? "Generated from the design. Edit in Design; this view follows every change."
                : "A hand-written script: edit it here, or ask Claude below to turn it into an editable design.",
            ),
        )
        .when(!!ed.model, el =>
          el.child(div().flex_1()).child(
            btn(t, "to-code", "Edit as code instead", cx => ed.toCode(cx), {
              icon: "square-pen",
              size: "sm",
              tooltip: "Makes this a hand-written script and drops the design (Undo brings it back)",
            }),
          ),
        ),
    )
    .child(
      div()
        .flex_1()
        .min_h(0)
        .rounded(10)
        .overflow_hidden()
        .border(1)
        .border_color(t.border)
        .bg(t.background)
        .child(CodeView.new(ed.codeState).size_full()),
    );
}

export function issueList(ed, t) {
  return v_flex()
    .absolute()
    .top(12)
    .right(12)
    .w(380)
    .max_h(320)
    .p(12)
    .gap(6)
    .rounded(12)
    .bg(t.popover ?? t.background)
    .border(1)
    .border_color(t.border)
    .shadow_lg()
    .child(
      h_flex()
        .items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child("ISSUES"))
        .child(iconBtn(t, "iss-x", "x", cx => ((ed.showIssues = false), cx.notify()))),
    )
    .children(
      ed.issues.slice(0, 12).map((i, k) =>
        h_flex()
          .id(`iss-${k}`)
          .gap(8)
          .px(6)
          .py(5)
          .rounded(7)
          .items_start()
          .cursor_pointer()
          .hover(s => s.bg(alpha(t.foreground, 0.05)))
          .on_click((_e, cx) =>
            ed.select(
              cx,
              i.target?.step
                ? { kind: "step", id: i.target.step }
                : i.target?.phase
                  ? { kind: "phase", id: i.target.phase }
                  : { kind: "workflow" },
            ),
          )
          .child(icon("alert", 12, i.level === "error" ? t.blocked : t.working))
          .child(div().flex_1().text_size(12).text_color(t.foreground).child(i.msg)),
      ),
    );
}

export function runCard(ed, t) {
  const m = ed.model;
  return div()
    .absolute()
    .top(0)
    .left(0)
    .right(0)
    .bottom(0)
    .bg(alpha(t.background, 0.55))
    .flex()
    .items_center()
    .justify_center()
    .child(
      v_flex()
        .w(520)
        .p(20)
        .gap(16)
        .rounded(16)
        .bg(t.popover ?? t.background)
        .border(1)
        .border_color(t.border)
        .shadow_lg()
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(icon("play", 16, t.accent))
            .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Run ${m.name}`))
            .child(iconBtn(t, "run-x", "x", cx => ((ed.runSheet = false), cx.notify()))),
        )
        .child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(
              `The master spawns an owner session in ${tildify(cwd(ed), home())} that runs it with these arguments and reports back.`,
            ),
        )
        .children(m.args.map(a => field(t, a.name, ed.input(t, `run:${a.name}`), { hint: a.description })))
        .child(
          h_flex()
            .gap(8)
            .justify_end()
            .child(btn(t, "run-cancel", "Cancel", cx => ((ed.runSheet = false), cx.notify()), { kind: "ghost" }))
            .child(
              btn(
                t,
                "run-go",
                ed.dirty() ? "Save and run" : "Run",
                cx => {
                  const args = {};
                  for (const a of m.args) args[a.name] = ed.f.get(`run:${a.name}`)?.value() ?? "";
                  ed.launch(cx, args);
                },
                { kind: "primary", icon: "play" },
              ),
            ),
        ),
    );
}
