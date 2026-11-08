// The inspector beside a design: the workflow, the selected phase, or the selected step.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import {
  AGENT_TYPES,
  EFFORTS,
  FIELD_TYPES,
  findStep,
  MAX_ROUNDS,
  MODELS,
  MODES,
  refChoices,
  refsIn,
  sourceChoices,
  stopText,
  UNTIL_OPS,
  WHENS,
} from "../model.js";
import { btn, chips, field, iconBtn, section, seg, stepper, toggle } from "../ui.js";
import { alpha, icon, kindColor, mono, scrollArea } from "../util.js";
import { MODE_ICON } from "./canvas.js";
import { filesBox } from "./files.js";

const INSPECTOR_W = 400;

export function inspector(ed, t) {
  const sel = ed.sel;
  let body;
  if (sel.kind === "phase")
    body = phasePanel(ed, 
      t,
      ed.model.phases.find(p => p.id === sel.id),
    );
  else if (sel.kind === "step") body = stepPanel(ed, t, findStep(ed.model, sel.id));
  else body = workflowPanel(ed, t);
  return v_flex()
    .flex_none()
    .w(INSPECTOR_W)
    .min_h(0)
    .border_l(1)
    .border_color(alpha(t.border, 0.8))
    .bg(t.chrome ?? t.surface)
    .child(
      scrollArea(
        "ed-inspector",
        "y",
        v_flex()
          .p(18)
          .pb(40)
          .child(body ?? div()),
      ),
    );
}

function title(ed, t, kicker, text, actions = []) {
  return v_flex()
    .gap(3)
    .mb(18)
    .child(div().font_family(mono()).text_size(10).text_color(t.dim).child(kicker))
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(17).font_semibold().text_color(t.foreground).child(text))
        .children(actions),
    );
}

function workflowPanel(ed, t) {
  const m = ed.model;
  const allSteps = m.phases.flatMap(p => p.steps);
  return v_flex()
    .child(title(ed, t, "WORKFLOW", m.name))
    .child(
      section(t, "Identity", [
        field(t, "Name", ed.input(t, "wf:name", { mono: true }), { hint: `run as /${m.name}` }),
        field(t, "Description", ed.input(t, "wf:description", { multiline: true })),
        field(t, "When to use", ed.input(t, "wf:whenToUse", { multiline: true }), { hint: "helps Claude pick it" }),
      ]),
    )
    .child(
      section(t, "Arguments", [
        m.args.length
          ? v_flex()
              .gap(10)
              .children(
                m.args.map((a, i) =>
                  v_flex()
                    .gap(6)
                    .p(10)
                    .rounded(10)
                    .bg(t.background)
                    .border(1)
                    .border_color(t.border)
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(
                          div()
                            .flex_1()
                            .child(ed.input(t, `arg:${i}:name`, { mono: true, h: 28 })),
                        )
                        .child(
                          iconBtn(
                            t,
                            `arg-del-${i}`,
                            "trash",
                            cx => ed.commit(cx, mm => mm.args.splice(i, 1)),
                            "Remove",
                            { danger: true },
                          ),
                        ),
                    )
                    .child(ed.input(t, `arg:${i}:description`, { h: 28 }))
                    .child(ed.input(t, `arg:${i}:example`, { h: 28, mono: true }))
                    .child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(`{{args.${a.name}}}`)),
                ),
              )
          : div()
              .text_size(12)
              .text_color(t.dim)
              .child("No arguments. Add one to vary a run: a goal, a path, a branch."),
        btn(
          t,
          "arg-add",
          "Add argument",
          cx =>
            ed.commit(cx, mm => mm.args.push({ name: `arg${mm.args.length + 1}`, description: "", example: "" })),
          {
            icon: "plus",
            size: "sm",
          },
        ),
      ]),
    )
    .child(
      section(t, "Defaults for every step", [
        field(
          t,
          "Model",
          chips(t, "def-model", MODELS, m.defaults.model, (id, cx) =>
            ed.commit(cx, mm => (mm.defaults.model = id)),
          ),
          { hint: "a step can override it" },
        ),
        field(
          t,
          "Effort",
          chips(
            t,
            "def-effort",
            EFFORTS.map(e => ({ id: e, label: e || "Inherit" })),
            m.defaults.effort,
            (id, cx) => ed.commit(cx, mm => (mm.defaults.effort = id)),
          ),
        ),
      ]),
    )
    .child(
      section(
        t,
        "Returns",
        [
          chips(
            t,
            "result",
            [
              { id: "", label: "Every result" },
              ...allSteps.map(s => ({ id: s.id, label: s.label, dot: kindColor(s.label, t) })),
            ],
            m.result,
            (id, cx) => ed.commit(cx, mm => (mm.result = id)),
          ),
          div()
            .text_size(11)
            .text_color(t.dim)
            .child("What the Workflow tool hands back to the session that ran it."),
        ],
        { last: true },
      ),
    );
}

function phasePanel(ed, t, p) {
  if (!p) return null;
  const i = ed.model.phases.indexOf(p);
  const sources = sourceChoices(ed.model, p.id);
  return v_flex()
    .child(
      title(ed, t, `PHASE ${String(i + 1).padStart(2, "0")}`, p.title, [
        iconBtn(t, "ph-left", "arrow-left", cx => ed.movePhase(cx, p.id, -1), "Move earlier", {
          disabled: i === 0,
        }),
        iconBtn(t, "ph-right", "arrow-right", cx => ed.movePhase(cx, p.id, 1), "Move later", {
          disabled: i === ed.model.phases.length - 1,
        }),
        iconBtn(t, "ph-del", "trash", cx => ed.deletePhase(cx, p.id), "Delete phase", { danger: true }),
      ]),
    )
    .child(
      section(t, "Phase", [
        field(t, "Title", ed.input(t, `phase:${p.id}:title`)),
        field(t, "Detail", ed.input(t, `phase:${p.id}:detail`), { hint: "shown under the title while it runs" }),
      ]),
    )
    .child(
      section(t, "How its steps run", [
        v_flex()
          .gap(8)
          .children(
            MODES.map(md => {
              const on = p.mode === md.id;
              return h_flex()
                .id(`mode-${md.id}`)
                .p(10)
                .gap(10)
                .items_center()
                .rounded(10)
                .border(on ? 1.5 : 1)
                .border_color(on ? t.accent : t.border)
                .bg(on ? alpha(t.accent, 0.07) : t.background)
                .cursor_pointer()
                .hover(s => s.border_color(on ? t.accent : alpha(t.accent, 0.45)))
                .on_click((_e, cx) => ed.setMode(cx, p.id, md.id))
                .child(icon(MODE_ICON[md.id], 15, on ? t.accent : t.dim))
                .child(
                  v_flex()
                    .gap(1)
                    .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(md.label))
                    .child(div().text_size(11).text_color(t.dim).child(md.hint)),
                );
            }),
          ),
      ]),
    )
    .when(p.mode === "code", el =>
      el.child(
        section(
          t,
          "Code",
          [
            ed.codeBox(t, `phase:${p.id}:code`, 420),
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(
                "Runs as the whole phase, in the script's scope: R holds earlier results, A the args. Set R.<name> for later steps to read as {{steps.<name>}}. Switching to another mode drops this code (Undo brings it back).",
              ),
          ],
          { last: true },
        ),
      ),
    )
    .when(p.mode !== "code", el => el.child(loopSection(ed, t, p)))
    .when(p.mode === "fanout", el =>
      el.child(
        section(
          t,
          "Iterate over",
          [
            field(t, "List", ed.input(t, `phase:${p.id}:source`, { mono: true }), {
              hint: "an array from an earlier step, or an arg",
            }),
            sources.length
              ? chips(
                  t,
                  `src-${p.id}`,
                  sources.map(s => ({ id: s, label: s })),
                  p.source,
                  (id, cx) => {
                    ed.commit(cx, mm => (mm.phases.find(x => x.id === p.id).source = id));
                  },
                )
              : div()
                  .text_size(11)
                  .text_color(t.dim)
                  .child("Give an earlier step structured output with a list field (object[] or string[])."),
            field(t, "Item key", ed.input(t, `phase:${p.id}:itemKey`, { mono: true }), {
              hint: "field used in labels: impl:<key>",
            }),
          ],
          { last: true },
        ),
      ),
    );
}

function loopSection(ed, t, p) {
  const L = p.loop;
  const set = fn => cx => ed.commit(cx, mm => fn(mm.phases.find(x => x.id === p.id).loop));
  const decider = p.steps.find(s => s.id === L.until.step);
  const fields = decider?.output.kind === "schema" ? decider.output.fields : [];
  const body = [
    toggle(
      t,
      `loop-${p.id}`,
      L.enabled,
      (on, cx) =>
        set(loop => {
          loop.enabled = on;
          if (on && !loop.until.step) {
            // Default: the last step with a boolean field decides, e.g. review.clean.
            const s =
              [...p.steps].reverse().find(x => x.output.kind === "schema" && x.output.fields.some(f => f.type === "boolean")) ??
              p.steps[p.steps.length - 1];
            loop.until.step = s?.id ?? "";
            loop.until.field = s?.output.fields.find(f => f.type === "boolean")?.name ?? "";
          }
        })(cx),
      "Repeat until a condition holds",
      p.mode === "fanout" ? "Each item loops on its own: implement → review → fix → review…" : "The steps run again, round after round",
    ),
  ];
  if (L.enabled) {
    body.push(
      h_flex()
        .gap(12)
        .items_center()
        .child(
          v_flex()
            .flex_1()
            .gap(2)
            .child(div().text_size(12).text_color(t.foreground).child("At most"))
            .child(div().text_size(11).text_color(t.dim).child("Then it stops and logs what didn't converge")),
        )
        .child(stepper(t, `loop-max-${p.id}`, L.max, 1, MAX_ROUNDS, (v, cx) => set(loop => (loop.max = v))(cx), " rounds")),
      field(
        t,
        "Stop when",
        chips(
          t,
          `loop-step-${p.id}`,
          p.steps.map(s => ({ id: s.id, label: s.label, dot: kindColor(s.label, t) })),
          L.until.step,
          (id, cx) =>
            set(loop => {
              loop.until.step = id;
              const s = p.steps.find(x => x.id === id);
              loop.until.field = s?.output.fields?.find(f => f.type === "boolean")?.name ?? "";
            })(cx),
        ),
        { hint: "the step whose result decides" },
      ),
    );
    if (decider)
      body.push(
        field(
          t,
          "Field",
          fields.length
            ? chips(
                t,
                `loop-field-${p.id}`,
                [{ id: "", label: "whole result" }, ...fields.map(f => ({ id: f.name, label: `${f.name} · ${f.type}` }))],
                L.until.field,
                (id, cx) => set(loop => (loop.until.field = id))(cx),
              )
            : div()
                .text_size(11)
                .text_color(t.dim)
                .child(`${decider.label} returns text: test it with “contains”, or give it a boolean field such as clean.`),
        ),
        field(
          t,
          "Condition",
          seg(t, `loop-op-${p.id}`, UNTIL_OPS, L.until.op, (id, cx) => set(loop => (loop.until.op = id))(cx), { size: "sm" }),
        ),
      );
    if (["equals", "contains"].includes(L.until.op))
      body.push(field(t, "Value", ed.input(t, `phase:${p.id}:untilValue`, { mono: true })));
    body.push(
      h_flex()
        .gap(8)
        .p(10)
        .rounded(10)
        .items_center()
        .bg(alpha(t.accent, 0.07))
        .child(icon("repeat", 13, t.accent))
        .child(div().flex_1().text_size(12).text_color(t.foreground).child(`Repeats ${stopText(p)}, at most ${L.max} rounds`)),
      div()
        .text_size(11)
        .line_height(1.5)
        .text_color(t.dim)
        .child(
          "In a loop, {{steps.x}} is x's latest result and {{round}} the round number. Set each step to run every round, only the first, or only later rounds.",
        ),
    );
  }
  return section(t, "Loop", body);
}

function stepPanel(ed, t, where) {
  if (!where) return null;
  const { step: s, phase: p } = where;
  const k = `step:${s.id}`;
  const i = p.steps.indexOf(s);
  const refs = refChoices(ed.model, s.id);
  const used = new Set(refsIn(s.prompt));
  const fanout = p.mode === "fanout";
  const code = s.kind === "code";
  return v_flex()
    .child(
      title(ed, t, `${p.title.toUpperCase()} · ${fanout ? `STAGE ${i + 1}` : `STEP ${i + 1}`}`, s.label, [
        iconBtn(t, "st-up", "arrow-up", cx => ed.moveStep(cx, s.id, -1), "Move up", { disabled: i === 0 }),
        iconBtn(t, "st-down", "arrow-down", cx => ed.moveStep(cx, s.id, 1), "Move down", {
          disabled: i === p.steps.length - 1,
        }),
        iconBtn(t, "st-dup", "copy", cx => ed.duplicateStep(cx, s.id), "Duplicate"),
        iconBtn(t, "st-del", "trash", cx => ed.deleteStep(cx, s.id), "Delete step", { danger: true }),
      ]),
    )
    .child(
      h_flex()
        .mb(16)
        .child(
          seg(
            t,
            "st-kind",
            [
              { id: "agent", label: "Agent", icon: "sparkles" },
              { id: "code", label: "Code", icon: "code" },
            ],
            s.kind,
            (id, cx) => ed.setKind(cx, s.id, id),
            { size: "sm" },
          ),
        ),
    )
    .when(p.loop.enabled, el =>
      el.child(
        section(t, "Runs in", [
          seg(t, "st-when", WHENS, s.when, (id, cx) => ed.setStep(cx, s.id, x => (x.when = id)), { size: "sm" }),
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(
              s.when === "first"
                ? "Only in round 1: the initial work (implement)."
                : s.when === "later"
                  ? "From round 2 on: react to the last round (fix what review found)."
                  : "Every round (review, test).",
            ),
        ]),
      ),
    )
    .child(
      section(t, "Step", [
        h_flex()
          .gap(10)
          .child(
            div()
              .flex_1()
              .child(field(t, "Label", ed.input(t, `${k}:label`), { hint: fanout ? `${s.label}:<key>` : null })),
          )
          .child(
            div()
              .w(140)
              .child(field(t, "Id", ed.input(t, `${k}:id`, { mono: true }))),
          ),
      ]),
    )
    .when(code, el =>
      el.child(
        section(t, "Code", [
          ed.codeBox(t, `${k}:code`),
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(
              `Runs where an agent would; what it returns is ${s.id}'s result. In scope: steps, args${fanout ? ", item, index, prev" : ""}${p.loop.enabled ? ", round" : ""}, and agent(), parallel(), pipeline(), log().`,
            ),
        ]),
      ),
    )
    .when(!code, el => el.child(agentSections(ed, t, s, p, k, refs, used)))
    .when(ed.model.phases.filter(x => x.mode !== "code").length > 1, el =>
      el.child(
        section(
          t,
          "Phase",
          [
            chips(
              t,
              "st-phase",
              ed.model.phases.filter(x => x.mode !== "code").map(x => ({ id: x.id, label: x.title })),
              p.id,
              (id, cx) => id !== p.id && ed.moveStepTo(cx, s.id, id),
            ),
          ],
          { last: true },
        ),
      ),
    );
}

/** An agent step's prompt, files, agent options and output. */
function agentSections(ed, t, s, p, k, refs, used) {
  return v_flex()
    .child(
      section(t, "Prompt", [
        ed.input(t, `${k}:prompt`, { multiline: true, size: 12.5 }),
        refs.length
          ? v_flex()
              .gap(6)
              .child(div().text_size(11).text_color(t.dim).child("Insert a reference at the cursor"))
              .child(
                h_flex()
                  .flex_wrap()
                  .gap(5)
                  .children(
                    refs.map((r, n) =>
                      h_flex()
                        .id(`ref-${n}`)
                        .h(22)
                        .px(7)
                        .gap(5)
                        .items_center()
                        .rounded(6)
                        .bg(used.has(r.ref) ? alpha(t.accent, 0.16) : alpha(t.foreground, 0.05))
                        .cursor_pointer()
                        .tooltip(r.hint)
                        .hover(st => st.bg(alpha(t.accent, 0.2)))
                        .on_click((_e, cx) => ed.insertRef(r.ref, cx))
                        .child(
                          div()
                            .font_family(mono())
                            .text_size(10.5)
                            .text_color(used.has(r.ref) ? t.accent : t.foreground)
                            .child(`{{${r.ref}}}`),
                        ),
                    ),
                  ),
              )
          : div().text_size(11).text_color(t.dim).child("Earlier steps' results become insertable here."),
      ]),
    )
    .child(
      section(t, "Files", [
        filesBox(ed, t, "step"),
        div().text_size(11).text_color(t.dim).child("Listed under the prompt as files to read first; repo files are stored relative to the repository, so every worktree finds them."),
      ]),
    )
    .child(
      section(t, "Agent", [
        field(
          t,
          "Model",
          chips(t, "st-model", MODELS, s.model, (id, cx) => ed.setStep(cx, s.id, x => (x.model = id))),
          {
            hint: ed.model.defaults.model ? `default: ${ed.model.defaults.model}` : "inherits the session's",
          },
        ),
        field(
          t,
          "Effort",
          chips(
            t,
            "st-effort",
            EFFORTS.map(e => ({ id: e, label: e || "Inherit" })),
            s.effort,
            (id, cx) => ed.setStep(cx, s.id, x => (x.effort = id)),
          ),
        ),
        field(t, "Agent type", ed.input(t, `${k}:agentType`, { mono: true }), {
          right: chips(
            t,
            "st-atype",
            AGENT_TYPES.filter(Boolean).map(a => ({ id: a, label: a })),
            s.agentType,
            (id, cx) => {
              ed.setStep(cx, s.id, x => (x.agentType = x.agentType === id ? "" : id));
            },
          ),
        }),
        toggle(
          t,
          "st-iso",
          s.isolation,
          (v, cx) => ed.setStep(cx, s.id, x => (x.isolation = v)),
          "Own git worktree",
          "Only for agents that edit files at the same time",
        ),
        h_flex()
          .gap(12)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .gap(2)
              .child(div().text_size(12).text_color(t.foreground).child("Independent copies"))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(s.repeat > 1 ? `${s.repeat} agents, result is a list` : "Judge panels, parallel attempts"),
              ),
          )
          .child(
            stepper(t, "st-repeat", s.repeat, 1, 32, (v, cx) => ed.setStep(cx, s.id, x => (x.repeat = v)), "×"),
          ),
      ]),
    )
    .child(outputSection(ed, t, s, k));
}

function outputSection(ed, t, s, k) {
  const kinds = [
    { id: "text", label: "Text" },
    { id: "schema", label: "Fields" },
    { id: "raw", label: "JSON schema" },
  ];
  const body = [
    seg(
      t,
      "st-out",
      kinds,
      s.output.kind,
      (id, cx) =>
        ed.setStep(cx, s.id, x => {
          x.output.kind = id;
          if (id === "schema" && !x.output.fields.length)
            x.output.fields.push({ name: "summary", type: "string", description: "", required: true });
        }),
      { size: "sm" },
    ),
  ];
  if (s.output.kind === "text")
    body.push(div().text_size(11).text_color(t.dim).child("The agent's final message, as a string."));
  if (s.output.kind === "raw") body.push(ed.input(t, `${k}:raw`, { multiline: true, mono: true, size: 11.5 }));
  if (s.output.kind === "schema") {
    body.push(
      v_flex()
        .gap(8)
        .children(
          s.output.fields.map((fd, i) =>
            v_flex()
              .gap(6)
              .p(10)
              .rounded(10)
              .bg(t.background)
              .border(1)
              .border_color(t.border)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .flex_1()
                      .child(ed.input(t, `${k}:f:${i}:name`, { mono: true, h: 28 })),
                  )
                  .child(
                    h_flex()
                      .id(`fd-req-${i}`)
                      .h(28)
                      .px(8)
                      .rounded(7)
                      .items_center()
                      .cursor_pointer()
                      .bg(fd.required ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.05))
                      .on_click((_e, cx) =>
                        ed.setStep(cx, s.id, x => (x.output.fields[i].required = !x.output.fields[i].required)),
                      )
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(fd.required ? t.accent : t.dim)
                          .child(fd.required ? "required" : "optional"),
                      ),
                  )
                  .child(
                    iconBtn(
                      t,
                      `fd-del-${i}`,
                      "trash",
                      cx => ed.setStep(cx, s.id, x => x.output.fields.splice(i, 1)),
                      "Remove",
                      { danger: true },
                    ),
                  ),
              )
              .child(
                chips(
                  t,
                  `fd-type-${i}`,
                  FIELD_TYPES.map(ty => ({ id: ty, label: ty })),
                  fd.type,
                  (id, cx) => ed.setStep(cx, s.id, x => (x.output.fields[i].type = id)),
                ),
              )
              .child(ed.input(t, `${k}:f:${i}:description`, { h: 28 })),
          ),
        ),
    );
    body.push(
      btn(
        t,
        "fd-add",
        "Add field",
        cx =>
          ed.setStep(cx, s.id, x =>
            x.output.fields.push({
              name: `field${x.output.fields.length + 1}`,
              type: "string",
              description: "",
              required: true,
            }),
          ),
        {
          icon: "plus",
          size: "sm",
        },
      ),
    );
  }
  return section(t, "Returns", body);
}
