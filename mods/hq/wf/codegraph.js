// Generated from mods/workflows/codegraph.js by shared/sync.sh: edit it there.

// The graph of a hand-written workflow, as read by scriptgraph.js: phases as lanes, agent()
// call sites as cards. Read-only; a card opens a panel with what that call sets.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { cardRows, cardShell, fanStacks, G, graph, graphDir, laneShell, placeholder } from "./graph.js";
import { EFFORTS, MODELS } from "./model.js";
import { badge, btn, chips, field } from "./ui.js";
import { alpha, clip, kindColor, mono, scrollArea } from "./util.js";

const PANEL_W = 360;

/** The parsed lanes as graph() lanes. */
function codeLanes(parsed, t) {
  return parsed.lanes.map((l, i) => ({
    index: i + 1,
    title: l.title,
    look: { key: "done", color: t.accent },
    done: 0,
    live: 0,
    failed: 0,
    nodes: l.steps.map(s => ({ id: s.id, step: s, look: { key: "done", color: t.accent }, portColor: alpha(t.accent, 0.7) })),
  }));
}

/** How a call runs; `all` adds what only the panel has room for (its schema). */
function flags(t, s, all = false) {
  return [
    s.each && badge(t, "each", t.accent, { icon: "split" }),
    s.loop && badge(t, "loop", t.ansi5 ?? t.accent, { icon: "repeat" }),
    s.cond && badge(t, "if", t.ansi3 ?? t.muted, { mono: true }),
    all && s.schema && badge(t, "schema", t.ansi6 ?? t.accent, { icon: "braces" }),
    s.isolation && badge(t, s.isolation, t.ansi3 ?? t.accent, { icon: "git-branch" }),
  ].filter(Boolean);
}

export function callCard(n, t, selected, onSelect) {
  const s = n.step;
  // By the node's id: in a design's code phase that's `<phase>:call-N`, unique on the canvas.
  return cardShell(n, t, {
    id: `cg-${n.id}`,
    selected,
    onSelect,
    bar: { color: kindColor(s.title, t) },
    body: cardRows(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().flex_shrink_0().max_w(150).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(s.title))
        .child(div().flex_1())
        .children(flags(t, s))
        .when(!!s.model, el => el.child(badge(t, s.model, t.muted))),
      div()
        .truncate()
        .text_size(11.5)
        .text_color(s.prompt ? t.muted : t.dim)
        .child(s.prompt ? clip(s.prompt.split("\n")[0], 80) : `line ${s.line}`),
    ),
  });
}

function laneFrame(lane, size, t) {
  const v = size.dir === "v";
  const box = lane.box;
  const steps = lane.nodes.map(n => n.step);
  const hint = [
    steps.some(s => s.each) && "fans out",
    steps.some(s => s.loop) && "loops",
    `${steps.length} agent${steps.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  return laneShell(lane, size, t, {
    gap: 6,
    pt: 14,
    indexColor: t.accent,
    // A fanned-out call is one card standing for many.
    behind: fanStacks(lane.nodes.filter(n => n.step.each), box, t),
    rows: [div().truncate().text_size(10.5).text_color(t.dim).child(hint)],
    empty: lane.nodes.length
      ? null
      : placeholder(t, G.laneW - 40, 40, 12, "No agent() call names this phase")
          .absolute()
          .left(v ? G.headW + 20 : 20)
          .top(v ? (box.h - 40) / 2 : G.head + 8),
  });
}

/** The scrollable canvas, or an empty state when the script has no agent() calls. */
export function codeCanvas(t, parsed, selectedId, onSelect, showCode) {
  const lanes = codeLanes(parsed, t);
  if (!lanes.some(l => l.nodes.length))
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(10)
      .child(div().text_size(12.5).text_color(t.muted).child("No agent() calls to draw in this script."))
      .child(btn(t, "cg-code", "Show the code", showCode, { icon: "code" }));
  return scrollArea(
    "cg-canvas",
    "both",
    div()
      .pb(160)
      .child(graph(lanes, t, selectedId, onSelect, { card: callCard, lane: laneFrame, palette: { done: alpha(t.accent, 0.45) }, dir: graphDir() })),
  );
}

function row(t, name, value) {
  return h_flex()
    .gap(10)
    .items_start()
    .child(div().w(84).flex_none().text_size(11.5).text_color(t.dim).child(name))
    .child(div().flex_1().min_w(0).font_family(mono()).text_size(11.5).text_color(t.foreground).child(value));
}

/** A value computed in code: shown as written, changed in the code. */
function computed(t, expr) {
  return h_flex()
    .gap(6)
    .items_center()
    .child(div().min_w(0).truncate().font_family(mono()).text_size(11.5).text_color(t.foreground).child(expr))
    .child(div().flex_none().text_size(10.5).text_color(t.dim).child("computed: edit in code"));
}

/**
 * The selected call, editable where the script writes plain values. `o`: `onClose(cx)`,
 * `showCode(cx)`, `set(key, value, cx)`, `can(key)` (editable in place), `input(key)` (the
 * label or prompt field), `phases` (the script's phase titles).
 */
export function callPanel(t, s, o) {
  const pick = (key, options, empty) =>
    o.can(key)
      ? chips(t, `cg-${key}`, options, s[key] || "", (id, cx) => o.set(key, id === s[key] ? empty : id, cx))
      : computed(t, s.written[key]);
  return v_flex()
    .flex_none()
    .w(PANEL_W)
    .min_h(0)
    .border_l(1)
    .border_color(alpha(t.border, 0.8))
    .bg(t.chrome ?? t.surface)
    .child(
      scrollArea(
        "cg-panel",
        "y",
        v_flex()
          .p(18)
          .pb(40)
          .gap(16)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(3)
                  .child(div().font_family(mono()).text_size(10).text_color(t.dim).child(`AGENT · LINE ${s.line}`))
                  .child(div().truncate().text_size(17).font_semibold().text_color(t.foreground).child(s.title)),
              )
              .child(btn(t, "cg-show", "", o.showCode, { icon: "code", kind: "ghost", size: "sm", tooltip: "Show the code" }))
              .child(btn(t, "cg-close", "", o.onClose, { icon: "x", kind: "ghost", size: "sm" })),
          )
          .when(flags(t, s, true).length > 0, el => el.child(h_flex().gap(6).flex_wrap().children(flags(t, s, true))))
          .when(s.each || s.loop || s.cond, el =>
            el.child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .child(
                  [
                    s.each && "Runs once per item (inside a pipeline or a map).",
                    s.loop && "Runs again each round of a loop.",
                    s.cond && "Runs only when its condition holds.",
                  ]
                    .filter(Boolean)
                    .join(" "),
                ),
            ),
          )
          .child(field(t, "Label", o.can("label") ? o.input("label") : computed(t, s.written.label)))
          .child(field(t, "Model", pick("model", MODELS.filter(m => m.id), ""), { hint: s.model ? null : "inherits the session's" }))
          .child(field(t, "Effort", pick("effort", EFFORTS.filter(Boolean).map(e => ({ id: e, label: e })), "")))
          .child(
            field(
              t,
              "Phase",
              pick(
                "phase",
                o.phases.map(p => ({ id: p, label: p })),
                "",
              ),
            ),
          )
          .child(
            v_flex()
              .gap(6)
              .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Prompt"))
              .child(
                o.can("prompt")
                  ? o.input("prompt")
                  : div()
                      .p(10)
                      .rounded(8)
                      .bg(t.background)
                      .border(1)
                      .border_color(t.border)
                      .font_family(mono())
                      .text_size(11)
                      .text_color(s.prompt ? t.foreground : t.dim)
                      .child(s.prompt ? clip(s.prompt, 700) : "Built at run time"),
              )
              .when(!o.can("prompt") && !!s.prompt, el =>
                el.child(div().text_size(11).text_color(t.dim).child("Built from code (… marks what's filled in at run time): edit it in the code.")),
              ),
          )
          .when(!!s.agentType || !!s.schema || !!s.isolation, el =>
            el.child(
              v_flex()
                .gap(8)
                .when(!!s.agentType, e => e.child(row(t, "Agent type", s.agentType)))
                .when(!!s.schema, e => e.child(row(t, "Schema", s.schema === "inline" ? "written inline" : s.schema)))
                .when(!!s.isolation, e => e.child(row(t, "Isolation", s.isolation))),
            ),
          ),
      ),
    );
}
