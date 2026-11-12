// Generated from mods/workflows/editor/ai.js by shared/sync.sh: edit it there.

// AI-assisted authoring: an agent (`claude -p` or another) writes a workflow model (not code)
// against a schema, so whatever it returns opens in the same editor the person uses by hand.
// The jobs, the agent and model pickers, the hero card for a new workflow, and the composer.

import { h_flex, v_flex } from "gpui-base";
import { div, image } from "gpui-kit";
import { home, readTextFile, writeTextFile } from "herdr";
import { collect, jobDir } from "../io.js";
import { blankModel, FIELD_TYPES, normalize } from "../model.js";
import { btn, iconBtn, kbd } from "../ui.js";
import { alpha, clip, icon, mono, scrollArea, store, tildify } from "../util.js";
import { absPath, addFiles, cwd, filesBox } from "./files.js";

const STR = { type: "string" };

const MODEL_SCHEMA = {
  type: "object",
  required: ["name", "description", "phases"],
  properties: {
    name: { type: "string", description: "kebab-case, e.g. review-and-fix" },
    description: { type: "string", description: "one line, shown when the workflow asks to run" },
    whenToUse: STR,
    args: {
      type: "array",
      items: { type: "object", required: ["name"], properties: { name: STR, description: STR, example: STR } },
    },
    defaults: { type: "object", properties: { model: STR, effort: STR } },
    result: {
      type: "string",
      description: "id of the step whose output the workflow returns; empty returns every result",
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "mode", "steps"],
        properties: {
          title: STR,
          detail: STR,
          mode: { type: "string", enum: ["parallel", "sequential", "fanout", "code"] },
          code: { type: "string", description: "code mode only: JavaScript that runs as the whole phase (no steps)" },
          source: { type: "string", description: "fanout only: steps.<id>.<arrayField> or args.<name>" },
          itemKey: { type: "string", description: "fanout only: item field used in labels, e.g. id" },
          loop: {
            type: "object",
            description: "repeat the phase's steps until a condition holds (implement → review → fix cycles)",
            properties: {
              enabled: { type: "boolean" },
              max: { type: "integer", minimum: 1, maximum: 20, description: "most rounds" },
              until: {
                type: "object",
                properties: {
                  step: { type: "string", description: "id of the step in this phase whose result decides" },
                  field: { type: "string", description: "field of that step's output, e.g. clean; empty for the whole result" },
                  op: { type: "string", enum: ["truthy", "falsy", "equals", "contains"] },
                  value: { type: "string", description: "for equals/contains" },
                },
              },
            },
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "label", "prompt"],
              properties: {
                id: { type: "string", description: "identifier, unique across the workflow" },
                label: { type: "string", description: "short kind, e.g. impl, review, fix" },
                kind: { type: "string", enum: ["agent", "code"], description: "agent (default) or code" },
                code: { type: "string", description: "code steps only: JavaScript body run where an agent would; it returns the step's result" },
                prompt: STR,
                model: { type: "string", description: "empty to inherit; opus, sonnet, haiku" },
                effort: { type: "string", enum: ["", "low", "medium", "high", "xhigh", "max"] },
                agentType: STR,
                isolation: { type: "boolean" },
                repeat: { type: "integer", minimum: 1, maximum: 32 },
                when: { type: "string", enum: ["always", "first", "later"], description: "in a loop: every round, first round only, later rounds only" },
                files: { type: "array", items: { type: "string" }, description: "repo-relative paths this agent must read first" },
                output: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["text", "schema"] },
                    fields: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["name", "type"],
                        properties: {
                          name: STR,
                          type: { type: "string", enum: FIELD_TYPES },
                          description: STR,
                          required: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You design Claude Code dynamic workflows. You never write code: you return a workflow
MODEL that a compiler turns into a Workflow script. Read the repository (Read, Grep, Glob) only when the
request depends on it; keep scouting short.

How the model runs
- Phases run in order. Each phase is one progress group.
- mode "parallel": its steps run at the same time. "sequential": one after another, and a later step can
  use an earlier step of the same phase. "fanout": every item of a list (source) flows through the steps
  as pipeline stages with no barrier between stages (item A can be in stage 2 while B is in stage 1).
- A step is one subagent. Its prompt is the whole brief: the subagent sees nothing else except the
  repository's CLAUDE.md files. Write prompts as self-contained instructions: goal, scope, constraints,
  what to return. Do not tell it to re-read CLAUDE.md.
- References inside prompts are replaced at run time:
  {{args.NAME}} an argument; {{steps.ID}} or {{steps.ID.field}} an earlier step's result (a fanout step's
  result is the list of per-item results); in a fanout: {{item}}, {{item.field}}, {{index}}, and {{prev}}
  (the previous stage's result for the same item).
- output kind "schema" forces structured output with the listed fields; use it whenever a later phase
  reads fields (a fanout source must be an array field such as steps.plan.units of type object[]).
  Otherwise "text".
- repeat N runs N independent copies (judge panels, independent attempts); its result is a list.
- files: repo-relative paths a step's agent must read before working (specs, plans, the module it
  changes). Keep the user's attached files on the steps that need them.
- isolation true gives each agent its own git worktree: only for steps that edit files in parallel.
- LOOPS: a phase with loop.enabled repeats its steps, round after round, until loop.until holds (a step of
  that phase, a field of its output, an op) or loop.max rounds ran. Each step has when: "always" (every
  round), "first" (round 1 only) or "later" (round 2 on). In a loop, {{steps.x}} is x's LATEST result and
  {{round}} the round number; a looping fanout loops per item ({{prev}} carries across rounds).
  The implement → review → fix cycle is ONE loop phase, in sequential or fanout mode:
    impl (when first) → fix (when later, prompt uses {{steps.review.problems}}) → review (always, schema
    with a boolean field such as clean), loop.until = { step: review, field: clean, op: truthy }, max 3.
  Never unroll rounds into separate steps like review1, fix1, review2: that is what loops are for.
- CODE BLOCKS hold what the model can't say. A step with kind "code" is a JavaScript function body that
  runs where an agent would; it sees steps, args (and item, index, prev, round where they exist), may call
  agent(), parallel(), pipeline() and log(), and what it returns is the step's result (give it a prompt of
  ""). A phase with mode "code" is JavaScript that runs as the whole phase, with no steps: R holds earlier
  results (R.<step id>), A the args, and it sets R.<name> for later phases ({{steps.<name>}}). Helpers in
  scope: fill(text, scope), get(obj, path), list(v), keyOf(item, index, field).
  Use them sparingly, for what has no model shape: custom concurrency limits, a loop per item inside a
  fan-out stage, options computed from data, reshaping results between phases. Everything else stays in
  steps. When converting a hand-written script, copy such parts into code blocks verbatim instead of
  approximating them, so the workflow still does exactly what the script did.
- model: leave empty to inherit unless a tier clearly fits (haiku/sonnet for cheap mechanical stages,
  opus for planning and judging). effort: empty, or low for mechanical, high/xhigh for hard verification.

Good shapes
- Plan with structured units, then fanout over units through implement → review stages.
- Find in parallel (several lenses), then verify adversarially (repeat 3 skeptics prompted to refute).
- A final synthesis or gate step that reads the earlier results.
- Prefer fanout pipelines to a parallel phase followed by another parallel phase over the same items.
- Keep it as small as the request needs. Labels are short kinds (plan, impl, review, verify, gate).
- Arguments (args) parameterize the workflow: the goal, a path, a branch. Reference them; never hardcode
  what should vary between runs.`;

const INLINE_LIMIT = 40000;

/** The files the person attached: small ones inline, so any agent sees them; the rest by path. */
async function attachments(paths) {
  if (!paths?.length) return "";
  const parts = [];
  for (const p of paths) {
    const text = await readTextFile(p).catch(() => null);
    if (text != null && text.length <= INLINE_LIMIT) parts.push(`--- ${p}\n${text}`);
    else parts.push(`--- ${p}\n(${text == null ? "unreadable here" : `${Math.round(text.length / 1000)} KB`}: read it from disk)`);
  }
  return `\n\nThe user attached these files. Use them to design the workflow, and list the ones a step needs in that step's files:\n\n${parts.join("\n\n")}`;
}

/** Starts a generation; `current` is the model being edited, or null for a new workflow. */
async function startJob(request, current, cwd, agent, model, files = []) {
  const dir = await jobDir();
  const attached = await attachments(files);
  const prompt = (current
    ? `Here is the current workflow model:\n\n${JSON.stringify(current, null, 2)}\n\nChange it as follows, and return the complete updated model (keep ids that still apply):\n\n${request}`
    : `Design a workflow for this request:\n\n${request}`) + attached;
  await writeTextFile(`${dir}/prompt.txt`, prompt, null);
  await writeTextFile(`${dir}/schema.json`, JSON.stringify(MODEL_SCHEMA), null);
  await writeTextFile(`${dir}/system.md`, SYSTEM, null);
  await collect(["gen-start", dir, cwd || "", agent || "claude", model || ""]);
  return dir;
}

const pollJob = dir => collect(["gen-poll", dir]);
const cancelJob = dir => collect(["gen-cancel", dir]);

const EXAMPLES = [
  "Review my current diff: three reviewers with different lenses, then verify each finding with skeptics",
  "Plan a feature into units, implement each unit in its own worktree, review and fix, then a final gate",
  "Research a question across the repo, docs and git history, then synthesize an answer with sources",
  "Find flaky tests from CI logs and propose a fix for each one",
];

// ---- the editor's side

export function generate(ed, cx, from = "ai") {
  const st = ed.f.get(from);
  const request = st?.value().trim();
  if (!request || ed.ai.job) return;
  const current = ed.model && !ed.hero ? ed.model : null;
  const text =
    !ed.model && !ed.hero
      ? `Convert this hand-written Workflow script into the model, keeping its behaviour. Parts the model can't express become code steps or code phases, copied from the script:\n\n${ed.code()}\n\n${request}`
      : request;
  startAI(ed, cx, text, current, request, from);
}

export function startAI(ed, cx, text, current, request, from) {
  if (ed.ai.job) return;
  ed.ai = { ...ed.ai, open: true, job: "starting", events: [], error: null, applied: false, request, from };
  cx.notify();
  cx.spawn(async cx => {
    try {
      const model = ed.f.get("ai-model")?.value().trim() ?? "";
      store.set(`agent-model:${ed.ai.agent}`, model);
      const dir = await startJob(text, current, cwd(ed), ed.ai.agent, model, ed.ai.files.map(f => absPath(ed, f)));
      ed.ai.job = dir;
    } catch (e) {
      ed.ai = { ...ed.ai, job: null, error: String(e?.message ?? e) };
    }
    cx.notify();
  });
}

/** Called by the host's timer. */
export function poll(ed, cx) {
  const dir = ed.ai?.job;
  if (!dir || dir === "starting" || ed.ai.polling) return;
  ed.ai.polling = true;
  cx.spawn(async cx => {
    try {
      const r = await pollJob(dir);
      ed.ai.events = r.events;
      if (!r.running && r.result) {
        ed.ai.job = null;
        if (r.result.ok) applyAI(ed, r.result.model, cx);
        else ed.ai.error = r.result.error || "Generation failed";
      }
    } catch (e) {
      ed.ai.error = String(e?.message ?? e);
      ed.ai.job = null;
    }
    ed.ai.polling = false;
    cx.notify();
  });
}

function applyAI(ed, raw, cx) {
  const next = normalize(raw);
  if (!ed.hero) ed.snapshot();
  else ed.history = [];
  ed.model = next;
  ed.raw = null;
  ed.design = null;
  ed.call = null;
  // A script's editable code view would keep taking edits that go nowhere: rebuild it.
  ed.codeState?.release();
  ed.codeState = null;
  ed.hero = false;
  ed.view = "design";
  ed.sel = { kind: "workflow" };
  ed.ai = { ...ed.ai, applied: true, open: true, events: [] };
  for (const k of ["ai", "hero"]) {
    ed.f.get(k)?.release();
    ed.f.delete(k);
  }
  ed.rebind();
  ed.touch(cx);
  const steps = next.phases.reduce((n, p) => n + p.steps.length, 0);
  ed.notice = {
    level: "ok",
    text: `Claude drafted ${next.phases.length} phases and ${steps} steps. Review, then save.`,
  };
}

function cancelAI(ed, cx) {
  const dir = ed.ai.job;
  ed.ai = { ...ed.ai, job: null, events: [] };
  if (dir && dir !== "starting") cx.spawn(async () => cancelJob(dir));
  cx.notify();
}

function installedAgents(ed) {
  return (ed.agents ?? [{ id: "claude", label: "Claude Code", icon: "icons/claude.svg", installed: true, models: [] }]).filter(a => a.installed);
}

export function pickAgent(ed) {
  const saved = store.get("agent");
  if (!ed.agents) return saved ?? "claude";
  const list = installedAgents(ed);
  return list.find(a => a.id === saved)?.id ?? list[0]?.id ?? "claude";
}

function agentLabel(ed) {
  return installedAgents(ed).find(a => a.id === ed.ai?.agent)?.label ?? "The agent";
}

function setAgent(ed, id, cx) {
  ed.ai.agent = id;
  store.set("agent", id);
  ed.f.get("ai-model")?.set_value(store.get(`agent-model:${id}`) ?? "");
  cx.notify();
}

/** Which agent writes the workflow. Compact shows icons, plus the chosen one's name. */
function agentSwitch(ed, t, prefix, compact) {
  const agents = installedAgents(ed);
  return h_flex()
    .flex_none()
    .p(3)
    .gap(2)
    .rounded(9)
    .bg(alpha(t.foreground, 0.055))
    .children(
      agents.map(a => {
        const on = a.id === ed.ai.agent;
        const mark = a.tint ? icon(null, 14, on ? t.foreground : t.muted, a.icon) : image(a.icon).flex_none().w(14).h(14);
        return h_flex()
          .id(`${prefix}-agent-${a.id}`)
          .h(compact ? 22 : 26)
          .px(compact ? 6 : 9)
          .gap(6)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .tooltip(a.schema ? `${a.label}: output checked against the schema` : `${a.label}: JSON read from its answer, then validated`)
          .when(on, el => el.bg(t.background).shadow_sm())
          .when(!on, el => el.hover(s => s.bg(alpha(t.foreground, 0.06))))
          .on_click((_e, cx) => setAgent(ed, a.id, cx))
          .child(mark)
          .when(!compact || on, el => el.child(div().text_size(compact ? 11 : 12).text_color(on ? t.foreground : t.muted).child(a.label)));
      }),
    );
}

/** The model the agent runs with; empty means its own default. */
function modelField(ed, t, prefix, compact) {
  const current = installedAgents(ed).find(a => a.id === ed.ai.agent);
  return h_flex()
    .flex_none()
    .gap(6)
    .items_center()
    .child(div().flex_none().w(compact ? 120 : 150).child(ed.input(t, "ai-model", { h: compact ? 26 : 28, size: 11.5, mono: true })))
    .when(!compact, el =>
      el.children(
        (current?.models ?? []).map(m =>
          h_flex()
            .id(`${prefix}-m-${m}`)
            .flex_none()
            .h(22)
            .px(7)
            .rounded(6)
            .items_center()
            .cursor_pointer()
            .bg(alpha(t.foreground, 0.05))
            .hover(s => s.bg(alpha(t.accent, 0.15)))
            .on_click((_e, cx) => {
              ed.f.get("ai-model")?.set_value(m);
              store.set(`agent-model:${ed.ai.agent}`, m);
              cx.notify();
            })
            .child(div().font_family(mono()).text_size(10.5).text_color(t.muted).child(m)),
        ),
      ),
    );
}

export function heroCard(ed, t) {
  const busy = Boolean(ed.ai.job);
  // Anchored at the top and scrollable: attachments and search results can outgrow the pane.
  return scrollArea(
    "hero-scroll",
    "y",
    v_flex()
    .items_center()
    .px(32)
    .pt(56)
    .pb(48)
    .child(
      v_flex()
        .w(720)
        .max_w("100%")
        .gap(18)
        .child(
          h_flex()
            .gap(12)
            .items_center()
            .child(
              div()
                .w(40)
                .h(40)
                .rounded(12)
                .bg(alpha(t.accent, 0.14))
                .flex()
                .items_center()
                .justify_center()
                .child(icon("sparkles", 20, t.accent)),
            )
            .child(
              v_flex()
                .gap(2)
                .child(div().text_size(20).font_semibold().text_color(t.foreground).child("Describe your workflow"))
                .child(
                  div()
                    .text_size(12.5)
                    .text_color(t.muted)
                    .child(
                      "Your agent drafts the phases, prompts and schemas. You review and tune every part before saving.",
                    ),
                ),
            ),
        )
        .child(
          v_flex()
            .p(4)
            .rounded(14)
            .bg(t.background)
            .border(1)
            .border_color(ed.focus === "hero" ? t.accent : t.border)
            .shadow_lg()
            .on_drop((ev, cx) => addFiles(ed, "ai", ev.paths, cx))
            .child(ed.input(t, "hero", { multiline: true, size: 14, px: 14, py: 12 }).border(0))
            .child(div().px(10).pb(4).child(filesBox(ed, t, "ai")))
            .child(
              h_flex()
                .px(10)
                .pt(4)
                .gap(10)
                .items_center()
                .child(div().w(42).text_size(11).text_color(t.dim).child("Agent"))
                .child(agentSwitch(ed, t, "hero", false)),
            )
            .child(
              h_flex()
                .px(10)
                .pb(8)
                .pt(6)
                .gap(10)
                .items_center()
                .child(div().w(42).text_size(11).text_color(t.dim).child("Model"))
                .child(modelField(ed, t, "hero", false))
                // Takes what's left and truncates: a long worktree path ran over the model chips.
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .justify_end()
                    .child(
                      div()
                        .min_w(0)
                        .truncate()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(`reads ${tildify(cwd(ed), home())}`),
                    ),
                )
                .child(
                  busy
                    ? btn(t, "hero-cancel", "Cancel", cx => cancelAI(ed, cx), { size: "md", kind: "ghost" })
                    : btn(t, "hero-go", "Generate", cx => generate(ed, cx, "hero"), {
                        icon: "sparkles",
                        kind: "primary",
                        kbd: "⌘↵",
                      }),
                ),
            ),
        )
        .when(busy, el => el.child(progress(ed, t)))
        .when(!!ed.ai.error, el => el.child(aiError(ed, t)))
        .when(!busy, el =>
          el.child(
            v_flex()
              .gap(8)
              .child(div().text_size(11).font_semibold().text_color(t.dim).child("TRY"))
              .children(
                EXAMPLES.map((ex, i) =>
                  h_flex()
                    .id(`ex-${i}`)
                    .px(12)
                    .py(9)
                    .gap(10)
                    .items_center()
                    .rounded(10)
                    .border(1)
                    .border_color(t.border)
                    .bg(t.background)
                    .cursor_pointer()
                    .hover(s => s.border_color(alpha(t.accent, 0.5)))
                    .on_click((_e, cx) => {
                      ed.f.get("hero")?.set_value(ex);
                      ed.f.get("hero")?.focus();
                      cx.notify();
                    })
                    .child(icon("arrow-right", 12, t.accent))
                    .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(ex)),
                ),
              )
              .child(
                h_flex()
                  .pt(6)
                  .gap(6)
                  .items_center()
                  .child(div().text_size(12).text_color(t.dim).child("Rather set every parameter yourself?"))
                  .child(
                    btn(
                      t,
                      "hero-manual",
                      "Build it manually",
                      cx => {
                        ed.open(cx, { model: blankModel(), scope: ed.scope, root: ed.root });
                        cx.notify();
                      },
                      { kind: "ghost", size: "sm", icon: "square-pen" },
                    ),
                  ),
              ),
          ),
        ),
    ));
}

function progress(ed, t) {
  const ev = ed.ai.events.slice(-6);
  return v_flex()
    .p(14)
    .gap(8)
    .rounded(12)
    .bg(alpha(t.accent, 0.06))
    .border(1)
    .border_color(alpha(t.accent, 0.3))
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon("spinner", 14, t.accent).spin(900))
        .child(
          div()
            .text_size(12.5)
            .font_medium()
            .text_color(t.accent)
            .child(ev.length ? `${agentLabel(ed)} is designing the workflow…` : `Starting ${agentLabel(ed)}…`),
        )
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).frames(["·  ", "·· ", "···"], 400)),
    )
    .children(
      ev.map((e, i) =>
        h_flex()
          .gap(8)
          .items_center()
          .opacity(0.45 + (0.55 * (i + 1)) / ev.length)
          .child(icon(e.kind === "tool" ? "search" : e.kind === "thinking" ? "brain" : "sparkles", 11, t.dim))
          .when(e.kind === "tool", el =>
            el.child(div().flex_none().text_size(11).font_semibold().text_color(t.foreground).child(e.name)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .when(e.kind === "tool", el2 => el2.font_family(mono()))
              .text_size(11)
              .text_color(t.muted)
              .child(e.text),
          ),
      ),
    );
}

function aiError(ed, t) {
  return h_flex()
    .p(10)
    .gap(8)
    .rounded(10)
    .items_start()
    .bg(alpha(t.blocked, 0.08))
    .border(1)
    .border_color(alpha(t.blocked, 0.35))
    .child(icon("alert", 13, t.blocked))
    .child(div().flex_1().min_w(0).text_size(12).line_height(1.5).text_color(t.blocked).child(ed.ai.error))
    .child(iconBtn(t, "ai-err-x", "x", cx => ((ed.ai.error = null), cx.notify())));
}

export function composer(ed, t) {
  const busy = Boolean(ed.ai.job);
  const open = ed.ai.open || busy;
  const shell = v_flex().absolute().bottom(18).left(24).right(24).items_center();
  if (!open)
    return shell.child(
      h_flex()
        .id("ai-pill")
        .h(40)
        .px(16)
        .gap(10)
        .items_center()
        .rounded(20)
        .bg(t.background)
        .border(1)
        .border_color(alpha(t.accent, 0.45))
        .shadow_lg()
        .cursor_pointer()
        .hover(s => s.border_color(t.accent))
        .on_click((_e, cx) => {
          ed.ai.open = true;
          ed.f.get("ai")?.focus();
          cx.notify();
        })
        .child(icon("sparkles", 14, t.accent))
        .child(
          div()
            .text_size(12.5)
            .text_color(t.muted)
            .child(
              ed.model ? `Ask ${agentLabel(ed)} to change this workflow` : `Ask ${agentLabel(ed)} to turn this script into a design`,
            ),
        )
        .child(kbd(t, "⌘↵")),
    );
  return shell.child(
    v_flex()
      .w(720)
      .max_w("100%")
      .p(8)
      .gap(8)
      .rounded(16)
      .bg(t.background)
      .border(1)
      .border_color(busy || ed.focus === "ai" ? t.accent : t.border)
      .shadow_lg()
      .on_drop((ev, cx) => addFiles(ed, "ai", ev.paths, cx))
      .when(busy, el => el.child(progress(ed, t)))
      .when(!!ed.ai.error, el => el.child(aiError(ed, t)))
      .when(ed.ai.applied && !busy && !!ed.ai.request, el =>
        el.child(
          h_flex()
            .px(8)
            .gap(8)
            .items_center()
            .child(icon("circle-check", 12, t.ansi2))
            .child(
              div()
                .flex_1()
                .text_size(11.5)
                .text_color(t.muted)
                .child(`Applied: “${clip(ed.ai.request, 80)}”`),
            )
            .when(ed.history.length > 0, el2 =>
              el2.child(btn(t, "ai-undo", "Undo", cx => ed.undo(cx), { size: "sm", kind: "ghost", icon: "undo" })),
            ),
        ),
      )
      .when(!busy, el => el.child(div().px(6).child(filesBox(ed, t, "ai", { compact: true }))))
      .child(
        h_flex()
          .gap(8)
          .items_end()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .child(ed.input(t, "ai", { multiline: true, size: 13, px: 10, py: 8 }).border(0)),
          )
          .child(
            v_flex()
              .gap(6)
              .pb(2)
              .child(
                busy
                  ? btn(t, "ai-cancel", "Cancel", cx => cancelAI(ed, cx), { kind: "ghost", size: "sm" })
                  : btn(t, "ai-go", "", cx => generate(ed, cx), {
                      icon: "send",
                      kind: "primary",
                      tooltip: "Send (⌘↵)",
                    }),
              ),
          ),
      )
      .child(
        h_flex()
          .px(6)
          .gap(8)
          .items_center()
          .child(icon("sparkles", 11, t.accent))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Undo restores the design"))
          .child(div().flex_1())
          .child(agentSwitch(ed, t, "ai", true))
          .child(modelField(ed, t, "ai", true))
          .child(
            iconBtn(t, "ai-min", "chevron-down", cx => ((ed.ai.open = false), cx.notify()), "Hide", {
              disabled: busy,
            }),
          ),
      ),
  );
}
