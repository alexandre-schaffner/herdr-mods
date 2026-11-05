// AI-assisted authoring: `claude -p` writes a workflow model (not code) against a schema,
// so whatever it returns opens in the same editor the person uses by hand.

import { readTextFile, writeTextFile } from "herdr";
import { collect, jobDir } from "./io.js";
import { FIELD_TYPES } from "./model.js";

const STR = { type: "string" };

export const MODEL_SCHEMA = {
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
          mode: { type: "string", enum: ["parallel", "sequential", "fanout"] },
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

export const SYSTEM = `You design Claude Code dynamic workflows. You never write code: you return a workflow
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

/** Starts a generation; `current` is the model being edited, or null for a new workflow. */
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

export async function startJob(request, current, cwd, agent, model, files = []) {
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

export const pollJob = dir => collect(["gen-poll", dir]);
export const cancelJob = dir => collect(["gen-cancel", dir]);

export const EXAMPLES = [
  "Review my current diff: three reviewers with different lenses, then verify each finding with skeptics",
  "Plan a feature into units, implement each unit in its own worktree, review and fix, then a final gate",
  "Research a question across the repo, docs and git history, then synthesize an answer with sources",
  "Find flaky tests from CI logs and propose a fix for each one",
];
