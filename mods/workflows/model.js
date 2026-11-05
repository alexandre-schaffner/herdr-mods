// The editable workflow model, its validation, and the Workflow script it compiles to.
//
// A model is plain data (`version: 1`). Phases run in order. A phase's steps run in
// parallel or in sequence, or the phase fans out: every item of a list flows through
// the steps as pipeline stages. Prompts reference earlier results with {{steps.id.path}},
// {{args.name}}, and inside a fan-out {{item}}, {{item.field}}, {{index}} and {{prev}}.
// The compiled script carries the model on its last line so the editor can reopen it.

export const MODEL_MARK = "// @herdr-workflow ";

export const MODELS = [
  { id: "", label: "Inherit" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];
export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
export const MODES = [
  { id: "parallel", label: "Parallel", hint: "Steps run at the same time" },
  { id: "sequential", label: "Sequence", hint: "Steps run one after another" },
  { id: "fanout", label: "Fan-out", hint: "Each item of a list flows through the steps" },
];
export const FIELD_TYPES = ["string", "number", "boolean", "string[]", "object[]", "object"];
export const AGENT_TYPES = ["", "general-purpose", "Explore", "Plan"];
export const WHENS = [
  { id: "always", label: "Every round" },
  { id: "first", label: "First round" },
  { id: "later", label: "Later rounds" },
];
export const UNTIL_OPS = [
  { id: "truthy", label: "is true" },
  { id: "falsy", label: "is false" },
  { id: "equals", label: "equals" },
  { id: "contains", label: "contains" },
];
export const MAX_ROUNDS = 20;

/** A phase's loop: off by default; when on, its steps repeat until `until` holds or `max` rounds ran. */
export const noLoop = () => ({ enabled: false, max: 3, until: { step: "", field: "", op: "truthy", value: "" } });

let seq = 0;
export const uid = prefix => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const slug = s =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const ident = s => {
  const v = String(s ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1");
  return v || "step";
};

export function newStep(label = "step") {
  return {
    id: ident(slug(label).replace(/-/g, "_")) + "_" + uid("").slice(-3),
    label,
    prompt: "",
    model: "",
    effort: "",
    agentType: "",
    isolation: false,
    repeat: 1,
    when: "always",
    files: [],
    output: { kind: "text", fields: [], raw: "" },
  };
}

export function newPhase(title = "Phase") {
  return { id: uid("p"), title, detail: "", mode: "parallel", source: "", itemKey: "id", loop: noLoop(), steps: [] };
}

export function blankModel() {
  const plan = newStep("plan");
  plan.id = "plan";
  return {
    version: 1,
    name: "untitled-workflow",
    description: "",
    whenToUse: "",
    args: [],
    defaults: { model: "", effort: "" },
    result: "",
    phases: [{ ...newPhase("Plan"), steps: [plan] }],
  };
}

/** Fills every field a hand-made or AI-made model may omit; never throws. */
export function normalize(input) {
  const m = input && typeof input === "object" ? input : {};
  const ids = new Set();
  const renamed = new Map(); // original id → identifier, so references can follow
  const phases = (Array.isArray(m.phases) ? m.phases : []).map((p, i) => ({
    id: p?.id || uid("p"),
    title: String(p?.title || `Phase ${i + 1}`),
    detail: String(p?.detail || ""),
    mode: MODES.some(x => x.id === p?.mode) ? p.mode : p?.mode === "pipeline" ? "fanout" : "parallel",
    source: String(p?.source || ""),
    itemKey: String(p?.itemKey ?? "id"),
    loop: {
      enabled: Boolean(p?.loop?.enabled),
      max: Math.max(1, Math.min(MAX_ROUNDS, Math.round(Number(p?.loop?.max) || 3))),
      until: {
        step: String(p?.loop?.until?.step || ""),
        field: String(p?.loop?.until?.field || ""),
        op: UNTIL_OPS.some(o => o.id === p?.loop?.until?.op) ? p.loop.until.op : "truthy",
        value: String(p?.loop?.until?.value ?? ""),
      },
    },
    steps: (Array.isArray(p?.steps) ? p.steps : []).map(s => {
      let id = ident(s?.id || slug(s?.label || "step").replace(/-/g, "_"));
      while (ids.has(id)) id = `${id}_2`;
      ids.add(id);
      if (s?.id && s.id !== id && !renamed.has(s.id)) renamed.set(s.id, id);
      const out = s?.output ?? {};
      return {
        id,
        label: String(s?.label || id),
        prompt: String(s?.prompt || ""),
        model: String(s?.model || ""),
        effort: EFFORTS.includes(s?.effort) ? s.effort : "",
        agentType: String(s?.agentType || ""),
        isolation: Boolean(s?.isolation),
        repeat: Math.max(1, Math.min(32, Math.round(Number(s?.repeat) || 1))),
        when: WHENS.some(w => w.id === s?.when) ? s.when : "always",
        files: [...new Set((Array.isArray(s?.files) ? s.files : []).map(f => String(f).trim()).filter(Boolean))],
        output: {
          kind: ["text", "schema", "raw"].includes(out.kind) ? out.kind : out.fields?.length ? "schema" : "text",
          fields: (Array.isArray(out.fields) ? out.fields : []).map(f => ({
            name: String(f?.name || "field"),
            type: FIELD_TYPES.includes(f?.type) ? f.type : "string",
            description: String(f?.description || ""),
            required: f?.required !== false,
          })),
          raw: typeof out.raw === "string" ? out.raw : out.raw ? JSON.stringify(out.raw, null, 2) : "",
        },
      };
    }),
  }));
  return {
    version: 1,
    name: slug(m.name) || "untitled-workflow",
    description: String(m.description || ""),
    whenToUse: String(m.whenToUse || ""),
    args: (Array.isArray(m.args) ? m.args : []).map(a => ({
      name: ident(a?.name || "arg"),
      description: String(a?.description || ""),
      example: String(a?.example || ""),
    })),
    defaults: {
      model: String(m.defaults?.model || ""),
      effort: EFFORTS.includes(m.defaults?.effort) ? m.defaults.effort : "",
    },
    result: renamed.get(m.result) ?? String(m.result || ""),
    phases: retarget(phases, renamed),
  };
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Points `{{steps.old…}}` references and fan-out sources at renamed step ids. */
function retarget(phases, renamed) {
  if (!renamed.size) return phases;
  const rules = [...renamed].map(([from, to]) => [new RegExp(`(\\{\\{\\s*steps\\.)${escapeRe(from)}(?=[.\\s}])`, "g"), `$1${to}`]);
  const fix = text => rules.reduce((t, [re, to]) => t.replace(re, to), text);
  for (const p of phases) {
    for (const s of p.steps) s.prompt = fix(s.prompt);
    for (const [from, to] of renamed) {
      if (p.source === `steps.${from}` || p.source.startsWith(`steps.${from}.`)) p.source = `steps.${to}${p.source.slice(6 + from.length)}`;
      if (p.loop.until.step === from) p.loop.until.step = to;
    }
  }
  return phases;
}

export const clone = m => JSON.parse(JSON.stringify(m));

export function findStep(m, id) {
  for (const p of m.phases) {
    const s = p.steps.find(x => x.id === id);
    if (s) return { phase: p, step: s };
  }
  return null;
}

// ---- references ------------------------------------------------------------

const REF = /\{\{\s*([\w.$-]+)\s*\}\}/g;

export function refsIn(text) {
  return [...String(text ?? "").matchAll(REF)].map(x => x[1]);
}

/** Steps whose results exist when `stepId` starts (earlier phases, earlier steps of a sequence). */
export function visibleSteps(m, stepId) {
  const out = [];
  for (const p of m.phases) {
    const i = p.steps.findIndex(s => s.id === stepId);
    if (i >= 0) {
      // In a loop, every step of the phase has a latest result (from this round or the last).
      if (p.loop?.enabled) out.push(...p.steps.map(s => ({ step: s, phase: p })));
      else if (p.mode === "sequential") out.push(...p.steps.slice(0, i).map(s => ({ step: s, phase: p })));
      return out;
    }
    out.push(...p.steps.map(s => ({ step: s, phase: p })));
  }
  return out;
}

/** Steps visible before a whole phase starts (what a fan-out may iterate). */
export function stepsBefore(m, phaseId) {
  const out = [];
  for (const p of m.phases) {
    if (p.id === phaseId) break;
    out.push(...p.steps.map(s => ({ step: s, phase: p })));
  }
  return out;
}

/** Insertable references for a step's prompt, most useful first. */
export function refChoices(m, stepId) {
  const where = findStep(m, stepId);
  const out = [];
  const looped = where?.phase.loop?.enabled;
  if (where?.phase.mode === "fanout") {
    out.push({ ref: "item", hint: "the current item" });
    const i = where.phase.steps.findIndex(s => s.id === stepId);
    if (i > 0 || looped)
      out.push({ ref: "prev", hint: i > 0 ? `${where.phase.steps[i - 1].label}'s result for this item` : "the last step's result from the previous round" });
    out.push({ ref: "index", hint: "item number, from 0" });
  }
  if (looped) out.push({ ref: "round", hint: "round number, from 1" });
  for (const { step } of visibleSteps(m, stepId)) {
    out.push({ ref: `steps.${step.id}`, hint: step.label });
    if (step.output.kind === "schema") {
      for (const f of step.output.fields)
        out.push({ ref: `steps.${step.id}.${f.name}`, hint: `${step.label} · ${f.type}` });
    }
  }
  for (const a of m.args) out.push({ ref: `args.${a.name}`, hint: a.description || "argument" });
  return out;
}

/** Lists a fan-out phase can iterate: array fields of earlier structured steps, and args. */
export function sourceChoices(m, phaseId) {
  const out = [];
  for (const { step } of stepsBefore(m, phaseId)) {
    if (step.output.kind === "schema") {
      for (const f of step.output.fields) if (f.type.endsWith("[]")) out.push(`steps.${step.id}.${f.name}`);
    }
    if (step.repeat > 1 || step.output.kind === "text") out.push(`steps.${step.id}`);
  }
  for (const a of m.args) out.push(`args.${a.name}`);
  return out;
}

// ---- validation ------------------------------------------------------------

/** Problems as `{ level: "error" | "warn", target: { phase?, step? } | null, msg }`. */
export function validate(m) {
  const issues = [];
  const err = (target, msg) => issues.push({ level: "error", target, msg });
  const warn = (target, msg) => issues.push({ level: "warn", target, msg });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.name)) err(null, "Name must be lowercase letters, digits and dashes");
  if (!m.description.trim()) err(null, "Add a one-line description (shown when the workflow asks to run)");
  if (!m.phases.length) err(null, "Add at least one phase");
  const titles = new Set();
  const ids = new Set();
  for (const p of m.phases) {
    if (titles.has(p.title)) err({ phase: p.id }, `Two phases are called "${p.title}"`);
    titles.add(p.title);
    if (!p.steps.length) err({ phase: p.id }, `${p.title} has no steps`);
    if (p.mode === "fanout") {
      if (!p.source.trim()) err({ phase: p.id }, `${p.title} fans out but has no list to iterate`);
      else {
        const [root, id] = p.source.split(".");
        if (root === "steps" && !stepsBefore(m, p.id).some(x => x.step.id === id))
          err({ phase: p.id }, `${p.title} iterates ${p.source}, which isn't a step from an earlier phase`);
        if (root === "args" && !m.args.some(a => a.name === id))
          err({ phase: p.id }, `${p.title} iterates unknown arg ${id}`);
        if (root !== "steps" && root !== "args")
          err({ phase: p.id }, `${p.title}: a list comes from steps.… or args.…`);
      }
    }
    p.steps.forEach((s, i) => {
      const t = { phase: p.id, step: s.id };
      if (ids.has(s.id)) err(t, `Step id ${s.id} is used twice`);
      ids.add(s.id);
      if (!s.prompt.trim()) err(t, `${s.label} has an empty prompt`);
      const visible = new Set(visibleSteps(m, s.id).map(x => x.step.id));
      for (const r of refsIn(s.prompt)) {
        const [root, name] = r.split(".");
        if (root === "steps" && !visible.has(name)) err(t, `${s.label} uses {{${r}}} before that step has run`);
        else if (root === "args" && !m.args.some(a => a.name === name)) err(t, `${s.label} uses unknown arg {{${r}}}`);
        else if (["item", "index"].includes(root) && p.mode !== "fanout")
          err(t, `{{${root}}} only exists inside a fan-out phase`);
        else if (root === "prev" && (p.mode !== "fanout" || (i === 0 && !p.loop.enabled)))
          err(t, "{{prev}} needs an earlier step in the same fan-out");
        else if (root === "round" && !p.loop.enabled) err(t, "{{round}} only exists inside a loop");
        else if (!["steps", "args", "item", "index", "prev", "round"].includes(root))
          err(t, `${s.label}: unknown reference {{${r}}}`);
      }
      if (s.output.kind === "schema") {
        if (!s.output.fields.length) err(t, `${s.label} returns structured output but has no fields`);
        const names = new Set();
        for (const f of s.output.fields) {
          if (!/^[A-Za-z_][\w]*$/.test(f.name)) err(t, `${s.label}: field "${f.name}" isn't a valid name`);
          if (names.has(f.name)) err(t, `${s.label}: field ${f.name} is listed twice`);
          names.add(f.name);
        }
      }
      if (s.output.kind === "raw") {
        try {
          const j = JSON.parse(s.output.raw || "");
          if (j?.type !== "object" || typeof j.properties !== "object")
            err(t, `${s.label}: a schema needs type "object" and properties`);
        } catch {
          err(t, `${s.label}: the JSON schema doesn't parse`);
        }
      }
      if (s.when !== "always" && !p.loop.enabled)
        warn(t, `${s.label} is set to run in ${s.when === "later" ? "later rounds" : "the first round"}, but ${p.title} doesn't loop, so this has no effect`);
      if (s.isolation && p.mode !== "fanout" && p.steps.length < 2 && s.repeat < 2)
        warn(t, `${s.label} runs alone; a worktree only helps agents that edit files at the same time`);
    });
  }
  for (const p of m.phases) {
    if (!p.loop.enabled) continue;
    const u = p.loop.until;
    const step = p.steps.find(s => s.id === u.step);
    if (p.mode === "parallel" && p.steps.length > 1)
      warn({ phase: p.id }, `${p.title} loops in parallel: each round's check runs at the same time as the work it checks. Use Sequence for implement → review loops`);
    if (!step) err({ phase: p.id }, `${p.title} loops but has no stop condition: pick the step that decides`);
    else {
      if (step.when === "first") warn({ phase: p.id }, `${p.title} stops on ${step.label}, which only runs in the first round`);
      if (u.field && step.output.kind === "schema" && !step.output.fields.some(f => f.name === u.field))
        err({ phase: p.id }, `${p.title} stops on ${step.label}.${u.field}, which that step doesn't return`);
      if (!u.field && step.output.kind !== "text" && ["truthy", "falsy"].includes(u.op))
        warn({ phase: p.id }, `${p.title} tests the whole result of ${step.label}: pick a field such as clean or approved`);
      if (["equals", "contains"].includes(u.op) && !u.value.trim()) err({ phase: p.id }, `${p.title}: say what ${step.label} must ${u.op === "equals" ? "equal" : "contain"}`);
    }
  }
  if (m.result && !ids.has(m.result)) err(null, `The result step ${m.result} doesn't exist`);
  return issues;
}

// ---- compile ---------------------------------------------------------------

const q = s => JSON.stringify(String(s));
const tpl = s => "`" + String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";

function fieldSchema(f) {
  const base =
    f.type === "string[]"
      ? { type: "array", items: { type: "string" } }
      : f.type === "object[]"
        ? { type: "array", items: { type: "object" } }
        : { type: f.type };
  return f.description ? { ...base, description: f.description } : base;
}

export function schemaOf(step) {
  if (step.output.kind === "raw") {
    try {
      return JSON.parse(step.output.raw);
    } catch {
      return null;
    }
  }
  if (step.output.kind !== "schema") return null;
  const properties = {};
  for (const f of step.output.fields) properties[f.name] = fieldSchema(f);
  const required = step.output.fields.filter(f => f.required).map(f => f.name);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function options(m, phase, step, labelExpr) {
  const parts = [`label: ${labelExpr}`, `phase: ${q(phase.title)}`];
  const schema = schemaOf(step);
  if (schema) parts.push(`schema: ${JSON.stringify(schema)}`);
  const model = step.model || m.defaults.model;
  const effort = step.effort || m.defaults.effort;
  if (model) parts.push(`model: ${q(model)}`);
  if (effort) parts.push(`effort: ${q(effort)}`);
  if (step.agentType) parts.push(`agentType: ${q(step.agentType)}`);
  if (step.isolation) parts.push(`isolation: 'worktree'`);
  return `{ ${parts.join(", ")} }`;
}

/** The prompt plus its attached files: paths the agent reads at run time (the script can't read files). */
export function fullPrompt(step) {
  if (!step.files?.length) return step.prompt;
  const list = step.files.map(f => `- ${f}`).join("\n");
  return `${step.prompt.trimEnd()}\n\nRead these files first (paths are relative to the repository root unless absolute):\n${list}`;
}

function call(m, phase, step, scope, labelExpr, indent) {
  const prompt = `fill(${tpl(fullPrompt(step))}, ${scope})`;
  if (step.repeat > 1) {
    const opts = options(m, phase, step, `${labelExpr} + '#' + (k + 1)`);
    return `parallel(Array.from({ length: ${step.repeat} }, (_, k) => () =>\n${indent}  agent(${prompt}, ${opts})))`;
  }
  return `agent(${prompt}, ${options(m, phase, step, labelExpr)})`;
}

const HELPERS = `const get = (o, path) => String(path).split('.').filter(Boolean).reduce((a, k) => (a == null ? undefined : a[k]), o)
const fmt = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const fill = (text, scope) => text.replace(/\\{\\{\\s*([\\w.$-]+)\\s*\\}\\}/g, (_, path) => fmt(get(scope, path)))
const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v == null ? [] : [v])
const keyOf = (item, index, field) => String((item && typeof item === 'object' && field ? item[field] : null) ?? index + 1)`;

// Only scripts with a loop carry it.
const LOOP_HELPER = `const holds = (v, field, op, value) => {
  const x = field ? get(v, field) : v
  if (op === 'falsy') return !x
  if (op === 'equals') return fmt(x).trim() === value
  if (op === 'contains') return fmt(x).includes(value)
  return Boolean(x) && x !== 'false'
}`;

const guard = (step) => (step.when === "first" ? "round === 1" : step.when === "later" ? "round > 1" : "");
const roundLabel = (base) => `${base} + (round > 1 ? '#' + round : '')`;
const stopTest = (p, value) => {
  const u = p.loop.until;
  return `holds(${value}, ${q(u.field)}, ${q(u.op)}, ${q(u.value.trim())})`;
};

/** A looping phase of steps (parallel or sequential): the round loop, then the stop test. */
function loopPhase(m, p, out) {
  const scope = "{ steps: R, args: A, round }";
  out.push("{");
  out.push("  let round = 1");
  out.push(`  for (; round <= ${p.loop.max}; round++) {`);
  if (p.mode === "parallel") {
    out.push("    await parallel([");
    for (const s of p.steps) {
      const run = `() => ${call(m, p, s, scope, roundLabel(q(s.label)), "      ")}.then((r) => (R.${s.id} = r))`;
      out.push(`      ${guard(s) ? `${guard(s)} && ` : ""}(${run}),`);
    }
    out.push("    ].filter(Boolean))");
  } else {
    for (const s of p.steps) {
      const line = `R.${s.id} = await ${call(m, p, s, scope, roundLabel(q(s.label)), "    ")}`;
      out.push(guard(s) ? `    if (${guard(s)}) ${line}` : `    ${line}`);
    }
  }
  out.push(`    if (${stopTest(p, `R.${p.loop.until.step}`)}) break`);
  out.push("  }");
  out.push(`  if (round > ${p.loop.max}) log(${q(`${p.title}: stopped after ${p.loop.max} rounds; the stop condition never held`)})`);
  out.push("}");
}

/** A looping fan-out: each item runs its own rounds; steps see this item's latest results. */
function loopFanout(m, p, out) {
  out.push("{");
  out.push(`  const items = list(get({ steps: R, args: A }, ${q(p.source)}))`);
  out.push(`  log(${tpl(`${p.title}: `)} + items.length + ' items')`);
  out.push(`  const S = ${JSON.stringify(Object.fromEntries(p.steps.map(s => [s.id, []])))}`);
  out.push("  let unfinished = 0");
  out.push("  await pipeline(items, async (_, item, index) => {");
  out.push("    const mine = {}");
  out.push("    let prev");
  out.push("    let round = 1");
  out.push(`    for (; round <= ${p.loop.max}; round++) {`);
  for (const s of p.steps) {
    const scope = "{ steps: { ...R, ...mine }, args: A, item, index, prev, round }";
    const label = roundLabel(`${q(`${s.label}:`)} + keyOf(item, index, ${q(p.itemKey)})`);
    const line = `prev = mine.${s.id} = S.${s.id}[index] = await ${call(m, p, s, scope, label, "      ")}`;
    out.push(guard(s) ? `      if (${guard(s)}) ${line}` : `      ${line}`);
  }
  out.push(`      if (${stopTest(p, `mine.${p.loop.until.step}`)}) break`);
  out.push("    }");
  out.push(`    if (round > ${p.loop.max}) unfinished++`);
  out.push("    return mine");
  out.push("  })");
  p.steps.forEach(s => out.push(`  R.${s.id} = S.${s.id}`));
  out.push(`  if (unfinished) log(${tpl(`${p.title}: `)} + unfinished + ' item(s) stopped after ${p.loop.max} rounds without meeting the stop condition')`);
  out.push("}");
}

/** The Workflow script for a model: `export const meta`, the body, and the model itself. */
export function compile(m) {
  const meta = {
    name: m.name,
    description: m.description,
    ...(m.whenToUse.trim() ? { whenToUse: m.whenToUse.trim() } : {}),
    phases: m.phases.map(p => ({ title: p.title, ...(p.detail.trim() ? { detail: p.detail.trim() } : {}) })),
  };
  const out = [];
  // A pure object literal with bare keys, as hand-written workflow scripts have it.
  const literal = JSON.stringify(meta, null, 2).replace(/^(\s*)"([A-Za-z_]\w*)":/gm, "$1$2:");
  out.push(`export const meta = ${literal}`);
  out.push("");
  out.push(
    "// Built with the Herdr workflow editor. Edit it there, or here by hand (the editor then reopens it as code).",
  );
  if (m.args.length) {
    out.push("//");
    out.push("// args:");
    for (const a of m.args)
      out.push(`//   ${a.name}${a.description ? ` — ${a.description}` : ""}${a.example ? ` (e.g. ${a.example})` : ""}`);
  }
  out.push(HELPERS);
  if (m.phases.some(p => p.loop.enabled)) out.push(LOOP_HELPER);
  out.push("const A = args ?? {}");
  out.push("const R = {}");
  for (const p of m.phases) {
    out.push("");
    out.push(`phase(${q(p.title)})`);
    if (p.loop.enabled) {
      if (p.mode === "fanout") loopFanout(m, p, out);
      else loopPhase(m, p, out);
    } else if (p.mode === "sequential") {
      for (const s of p.steps) out.push(`R.${s.id} = await ${call(m, p, s, "{ steps: R, args: A }", q(s.label), "")}`);
    } else if (p.mode === "parallel") {
      if (p.steps.length === 1) {
        const s = p.steps[0];
        out.push(`R.${s.id} = await ${call(m, p, s, "{ steps: R, args: A }", q(s.label), "")}`);
      } else {
        out.push("{");
        out.push("  const out = await parallel([");
        for (const s of p.steps) out.push(`    () => ${call(m, p, s, "{ steps: R, args: A }", q(s.label), "    ")},`);
        out.push("  ])");
        p.steps.forEach((s, i) => out.push(`  R.${s.id} = out[${i}]`));
        out.push("}");
      }
    } else {
      out.push("{");
      out.push(`  const items = list(get({ steps: R, args: A }, ${q(p.source)}))`);
      out.push(`  log(${tpl(`${p.title}: `)} + items.length + ' items')`);
      out.push(`  const S = ${JSON.stringify(p.steps.map(() => []))}`);
      out.push("  await pipeline(items,");
      p.steps.forEach((s, i) => {
        const scope = "{ steps: R, args: A, item, index, prev }";
        const label = `${q(`${s.label}:`)} + keyOf(item, index, ${q(p.itemKey)})`;
        out.push(
          `    (prev, item, index) => ${call(m, p, s, scope, label, "    ")}.then((r) => ((S[${i}][index] = r), r)),`,
        );
      });
      out.push("  )");
      p.steps.forEach((s, i) => out.push(`  R.${s.id} = S[${i}]`));
      out.push("}");
    }
  }
  out.push("");
  out.push(m.result ? `return R.${m.result}` : "return R");
  out.push("");
  out.push(MODEL_MARK + JSON.stringify(m));
  return out.join("\n") + "\n";
}

/** The model a compiled script carries, or null for a hand-written script. */
export function extract(script) {
  const line = String(script ?? "")
    .split("\n")
    .reverse()
    .find(l => l.startsWith(MODEL_MARK));
  if (!line) return null;
  try {
    return normalize(JSON.parse(line.slice(MODEL_MARK.length)));
  } catch {
    return null;
  }
}

/** Whether a script still matches the model it carries (no hand edits since). */
export function untouched(script, model) {
  return compile(model) === script;
}

/** What a hand-written script's meta says, for the graph of a code-only workflow. */
export function metaOf(script) {
  const s = String(script ?? "");
  const pick = key => s.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`))?.[2] ?? "";
  const phases = [
    ...(s.match(/phases\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g),
  ].map(x => x[2]);
  return { name: pick("name"), description: pick("description"), phases };
}
