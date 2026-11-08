// The workflow editor: outline, live graph, inspector, and an AI composer that edits the same
// model. This file keeps the editor's state (lifecycle, fields, undo, model changes, save and
// launch) and its frame (header, outline); the parts it draws live in editor/.

import { Editor as CodeView, EditorState, h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home, notify, settings, spaces } from "herdr";
import { codeCanvas } from "./codegraph.js";
import { dirSwitch } from "./graph.js";
import { collect, master, tempFile } from "./io.js";
import {
  asCode,
  CODE_PHASE_STARTER,
  CODE_STEP_STARTER,
  clone,
  compile,
  findStep,
  metaOf,
  newCodeStep,
  newPhase,
  newStep,
  normalize,
  phaseCode,
  slug,
  sourceChoices,
  validate,
} from "./model.js";
import { badge, btn, frame, iconBtn, seg } from "./ui.js";
import { alpha, clip, icon, kindColor, mix, mono, scrollArea, tildify } from "./util.js";
import { composer, generate, heroCard, pickAgent, startAI } from "./editor/ai.js";
import { canvas, codePane, issueList, MODE_ICON, runCard, strayBar } from "./editor/canvas.js";
import { addFiles, checkFiles, cwd, repoRoot, search } from "./editor/files.js";
import { inspector } from "./editor/inspector.js";
import { bindCall, callInspector, parsed, pickCall } from "./editor/script.js";

const OUTLINE_W = 250;
const RAW = "\u0000raw\u0000"; // marks an undo entry that is a hand-written script

function syntax(t) {
  return {
    keyword: t.ansi5,
    string: t.ansi2,
    comment: t.dim,
    function: t.ansi4,
    type: t.ansi6,
    number: t.ansi3,
    constant: t.ansi3,
    boolean: t.ansi3,
    operator: t.muted,
    punctuation: t.muted,
    variable: t.foreground,
  };
}

const identifier = v => v.replace(/[^\w]/g, "_");
const trim = v => v.trim();

// The text fields of each part of a design: `key` is the model property (or `path` to it),
// `clean` tidies what's typed, the rest is how the input looks.
const WORKFLOW_FIELDS = [
  { key: "name", placeholder: "kebab-case-name", blur: (ed, v, cx) => ed.renameWorkflow(v, cx) },
  { key: "description", multiline: true, grow: [2, 5], placeholder: "One line, shown when the workflow asks to run" },
  { key: "whenToUse", multiline: true, grow: [2, 5], placeholder: "When should Claude reach for this workflow? (optional)" },
];
const ARG_FIELDS = [
  { key: "name", placeholder: "name", clean: identifier },
  { key: "description", placeholder: "What it is" },
  { key: "example", placeholder: "Example value" },
];
const PHASE_FIELDS = [
  { key: "title", placeholder: "Phase title" },
  { key: "detail", placeholder: "What happens here (optional)" },
  { key: "source", placeholder: "steps.plan.units", clean: trim },
  { key: "itemKey", placeholder: "id", clean: trim },
  { key: "untilValue", path: ["loop", "until", "value"], placeholder: "APPROVED" },
];
const STEP_FIELDS = [
  { key: "label", placeholder: "impl, review, gate…" },
  {
    key: "prompt",
    multiline: true,
    grow: [8, 22],
    placeholder: "The whole brief for this agent: goal, scope, constraints, and what to return.",
  },
  { key: "agentType", placeholder: "default workflow agent", clean: trim },
  {
    key: "raw",
    path: ["output", "raw"],
    multiline: true,
    grow: [6, 18],
    placeholder: '{ "type": "object", "properties": { … }, "required": [ … ] }',
  },
];
const OUTPUT_FIELDS = [
  { key: "name", placeholder: "field", clean: identifier },
  { key: "description", placeholder: "What the agent puts here" },
];

export class WorkflowEditor {
  constructor() {
    this.model = null;
    this.raw = null;
    this.issues = [];
    this.f = new Map();
    this.focus = null;
  }

  // ---- lifecycle

  /** `doc`: { model?, script?, path?, scope, root?, hero? }. */
  open(cx, doc) {
    this.release();
    this.model = doc.model ? normalize(doc.model) : null;
    this.raw = this.model ? null : (doc.script ?? "");
    // The design a hand-edited script strayed from: it can be restored, or the edits folded in.
    this.design = !this.model && doc.design ? normalize(doc.design) : null;
    this.path = doc.path ?? null;
    this.scope = doc.scope ?? "user";
    this.root = doc.root ?? null;
    this.saved = doc.path ? (this.model ? compile(this.model) : this.raw) : null;
    this.sel = { kind: "workflow" };
    this.view = "design";
    this.call = null;
    this.hero = Boolean(doc.hero);
    this.history = [];
    this.future = [];
    this.notice = null;
    this.confirm = null;
    this.runSheet = false;
    this.ai = { open: Boolean(doc.hero), job: null, events: [], error: null, applied: false, agent: pickAgent(this), files: [] };
    this.fs = null;
    this.missing = new Set();
    this.issues = this.model ? validate(this.model) : [];
    this.bind();
  }

  isOpen() {
    return this.model !== null || this.raw !== null;
  }

  close() {
    this.release();
    this.model = null;
    this.raw = null;
  }

  release() {
    for (const s of this.f.values()) s.release();
    this.f.clear();
    this.codeState?.release();
    this.codeState = null;
  }

  code() {
    return this.model ? compile(this.model) : (this.codeState?.value() ?? this.raw ?? "");
  }

  dirty() {
    return this.saved === null || this.code() !== this.saved;
  }

  name() {
    if (!this.model && this.hero) return "New workflow";
    return this.model?.name ?? (metaOf(this.code()).name || "workflow");
  }

  // ---- fields: retained input state is made here, in handlers, never in render

  /** Wires a field's state: focus marks it (and arms one snapshot for its next edit), blur
   * clears it; with `o.set`, each change snapshots once per focus, applies, and refreshes. */
  track(key, st, o = {}) {
    st.on("focus", (_e, cx) => {
      this.focus = key;
      if (o.arm !== false) this.armed = true;
      cx.notify();
    });
    st.on("blur", (_e, cx) => {
      if (this.focus === key) this.focus = null;
      o.blur?.(st.value(), cx);
      cx.notify();
    });
    if (o.set)
      st.on("change", (_e, cx) => {
        if (this.armed) {
          this.snapshot();
          this.armed = false;
        }
        o.set(st.value());
        this.touch(cx);
      });
  }

  text(key, get, set, o = {}) {
    if (this.f.has(key)) return;
    const st = o.multiline
      ? TextareaState.new({ placeholder: o.placeholder ?? "", value: get() ?? "", rows: o.rows ?? 3 })
      : InputState.new({ placeholder: o.placeholder ?? "", value: get() ?? "" });
    if (o.multiline && o.grow) st.set_auto_grow(o.grow[0], o.grow[1]);
    this.track(key, st, { set, blur: o.blur });
    if (o.submit) st.on("submit", (_e, cx) => o.submit(cx));
    this.f.set(key, st);
  }

  /** A code editor field, made like text(): edits snapshot once per focus, then apply live. */
  codeField(key, get, set) {
    if (this.f.has(key)) return;
    const st = EditorState.new({
      language: "javascript",
      value: get() ?? "",
      font_family: settings()?.font_family || "JetBrains Mono",
      font_size: 12,
      syntax: syntax(this.t ?? {}),
    });
    this.track(key, st, { set });
    this.f.set(key, st);
  }

  codeBox(t, key, h = 340) {
    const st = this.f.get(key);
    return div()
      .h(h)
      .rounded(10)
      .overflow_hidden()
      .border(1)
      .border_color(this.focus === key ? t.accent : t.border)
      .bg(t.background)
      .child(st ? CodeView.new(st).size_full() : div());
  }

  /** One text field per row of `table`, keyed `${prefix}:${key}`, editing `target()`'s value
   * at the row's `path` (default: its key), through `clean` if it has one. */
  fields(prefix, table, target) {
    for (const d of table) {
      const path = d.path ?? [d.key];
      this.text(
        `${prefix}:${d.key}`,
        () => path.reduce((o, k) => o?.[k], target()),
        v => {
          const o = path.slice(0, -1).reduce((x, k) => x[k], target());
          o[path[path.length - 1]] = d.clean ? d.clean(v) : v;
        },
        { ...d, blur: d.blur && ((v, cx) => d.blur(this, v, cx)) },
      );
    }
  }

  /** Makes every field the current selection shows. */
  bind() {
    if (!this.f.has("fs:query")) {
      const st = InputState.new({ placeholder: "Search files in the repository…" });
      st.on("change", (_e, cx) => search(this, cx));
      st.on("submit", (_e, cx) => {
        const first = this.fs?.results?.[0];
        if (first) addFiles(this, this.fs.target, [`${repoRoot(this)}/${first}`], cx);
      });
      this.track("fs:query", st, { arm: false });
      this.f.set("fs:query", st);
    }
    this.text("ai-model", () => localStorage.getItem(`agent-model:${this.ai?.agent}`) ?? "", null, {
      placeholder: "default model",
      blur: v => localStorage.setItem(`agent-model:${this.ai.agent}`, v.trim()),
    });
    // No placeholder setter: an empty composer made for the other mode is made again.
    const aiHint = this.model ? "Ask Claude to change this workflow…" : "Convert this script into an editable workflow, or describe one…";
    const ai = this.f.get("ai");
    if (ai && this.aiHint !== aiHint && !ai.value().trim()) {
      ai.release();
      this.f.delete("ai");
    }
    if (!this.f.has("ai")) this.aiHint = aiHint;
    this.text("ai", () => "", null, {
      multiline: true,
      grow: [2, 8],
      placeholder: aiHint,
      submit: cx => generate(this, cx),
    });
    this.text("hero", () => "", null, {
      multiline: true,
      grow: [5, 14],
      placeholder: "Describe the workflow: what it should accomplish, how work splits, how results get checked…",
      submit: cx => generate(this, cx, "hero"),
    });
    if (!this.model) return bindCall(this);
    const m = () => this.model;
    this.fields("wf", WORKFLOW_FIELDS, m);
    m().args.forEach((_a, i) => this.fields(`arg:${i}`, ARG_FIELDS, () => m().args[i]));
    const sel = this.sel;
    if (sel.kind === "phase") {
      const p = m().phases.find(x => x.id === sel.id);
      if (!p) return;
      const ph = () => m().phases.find(x => x.id === sel.id);
      this.fields(`phase:${p.id}`, PHASE_FIELDS, ph);
      if (p.mode === "code") this.codeField(`phase:${p.id}:code`, () => p.code, v => (ph().code = v));
    }
    if (sel.kind === "step") {
      const where = findStep(m(), sel.id);
      if (!where) return;
      const s = where.step;
      const st = () => findStep(m(), sel.id)?.step;
      const k = `step:${s.id}`;
      if (s.kind === "code") this.codeField(`${k}:code`, () => s.code, v => (st().code = v));
      this.fields(k, STEP_FIELDS, st);
      // The id applies on blur: renaming rewrites every reference to it.
      this.text(`${k}:id`, () => s.id, null, {
        placeholder: "identifier",
        blur: (v, cx) => this.renameStep(s.id, v, cx),
      });
      s.output.fields.forEach((_fd, i) => this.fields(`${k}:f:${i}`, OUTPUT_FIELDS, () => st().output.fields[i]));
    }
    if (this.runSheet)
      for (const a of m().args)
        this.text(`run:${a.name}`, () => a.example, null, { placeholder: a.description || a.name });
  }

  /** Rebuilds every field from the model (after undo, AI apply, or a rename). */
  rebind() {
    for (const [key, s] of this.f) {
      if (key === "ai" || key === "hero" || key === "ai-model" || key === "fs:query" || key.startsWith("run:")) continue;
      s.release();
      this.f.delete(key);
    }
    this.bind();
  }

  input(t, key, o = {}) {
    const st = this.f.get(key);
    if (!st) return frame(t, div().text_color(t.dim).child("…"), false, o);
    const inner = o.multiline
      ? Textarea.new(st)
          .w_full()
          .text_size(o.size ?? 12.5)
          .when(!!o.mono, el => el.font_family(mono()))
      : Input.new(st)
          .w_full()
          .text_size(o.size ?? 12.5)
          .when(!!o.mono, el => el.font_family(mono()));
    return frame(t, inner, this.focus === key, o);
  }

  // ---- changes

  /** The undoable state: the model as JSON, or behind RAW a hand-written script and the
   * design it strayed from. */
  state() {
    return this.model ? JSON.stringify(this.model) : RAW + JSON.stringify({ raw: this.code(), design: this.design });
  }

  restore(entry) {
    const wasModel = Boolean(this.model);
    if (entry.startsWith(RAW)) {
      const { raw, design } = JSON.parse(entry.slice(RAW.length));
      this.model = null;
      this.raw = raw;
      this.design = design;
      this.issues = [];
    } else {
      this.model = JSON.parse(entry);
      this.raw = null;
      this.design = null;
      this.issues = validate(this.model);
    }
    // The code view is read-only for a design and editable for a script: rebuild it on a switch.
    if (wasModel !== Boolean(this.model)) {
      this.call = null;
      this.codeState?.release();
      this.codeState = null;
      if (this.view === "code") this.ensureCode();
    } else this.codeState?.set_value(this.model ? compile(this.model) : (this.raw ?? ""));
  }

  snapshot() {
    this.history.push(this.state());
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }

  touch(cx) {
    if (!this.model) {
      this.notice = null;
      cx.notify();
      return;
    }
    this.issues = validate(this.model);
    if (this.view === "code" && this.codeState) this.codeState.set_value(compile(this.model));
    this.notice = null;
    cx.notify();
  }

  commit(cx, fn) {
    this.snapshot();
    fn(this.model);
    this.rebind();
    this.touch(cx);
  }

  undo(cx) {
    if (!this.history.length) return;
    this.future.push(this.state());
    this.restore(this.history.pop());
    this.fixSelection();
    this.rebind();
    this.touch(cx);
  }

  redo(cx) {
    if (!this.future.length) return;
    this.history.push(this.state());
    this.restore(this.future.pop());
    this.fixSelection();
    this.rebind();
    this.touch(cx);
  }

  // ---- between designs and code

  /** The design becomes a hand-written script: the same code, no longer tied to a design. */
  toCode(cx) {
    this.snapshot();
    this.raw = asCode(this.model);
    this.model = null;
    this.design = null;
    this.issues = [];
    this.sel = { kind: "workflow" };
    this.call = null;
    this.codeState?.release();
    this.codeState = null;
    this.setView(cx, "code");
    this.rebind();
  }

  /** Drops the hand edits and goes back to the design they strayed from. */
  restoreDesign(cx) {
    if (!this.design) return;
    this.snapshot();
    this.model = this.design;
    this.raw = null;
    this.design = null;
    this.call = null;
    this.codeState?.release();
    this.codeState = null;
    this.view = "design";
    this.sel = { kind: "workflow" };
    this.rebind();
    this.touch(cx);
  }

  /** Asks Claude to change the design so it does what the hand-edited script does. */
  foldEdits(cx) {
    if (!this.design) return;
    const request = "Fold my hand edits into the design";
    startAI(this, 
      cx,
      `The script below was compiled from this design, then edited by hand. Update the design so it does what the edited script does. Keep ids that still apply. Anything the model can't express goes into a code step or a code phase, copied from the script, rather than approximated.\n\n${this.code()}`,
      this.design,
      request,
      "ai",
    );
  }

  fixSelection() {
    const s = this.sel;
    if (!this.model) {
      this.sel = { kind: "workflow" };
      return;
    }
    if (s.kind === "step" && !findStep(this.model, s.id)) this.sel = { kind: "workflow" };
    if (s.kind === "phase" && !this.model.phases.some(p => p.id === s.id)) this.sel = { kind: "workflow" };
  }

  select(cx, sel) {
    this.sel = sel;
    this.focus = null;
    if (this.fs?.target === "step") this.fs = null;
    this.bind();
    if (sel.kind === "step") checkFiles(this, cx);
    cx.notify();
  }

  renameWorkflow(v, cx) {
    const clean = slug(v) || "untitled-workflow";
    if (clean !== v) {
      this.model.name = clean;
      this.f.get("wf:name")?.set_value(clean);
      this.touch(cx);
    }
  }

  /** Renames a step id and rewrites every reference to it. */
  renameStep(oldId, v, cx) {
    const id = v.replace(/[^\w]/g, "_").replace(/^(\d)/, "_$1");
    if (!id || id === oldId) {
      this.f.get(`step:${oldId}:id`)?.set_value(oldId);
      return;
    }
    if (findStep(this.model, id)) {
      this.notice = { level: "error", text: `Another step is already called ${id}` };
      this.f.get(`step:${oldId}:id`)?.set_value(oldId);
      cx.notify();
      return;
    }
    const re = new RegExp(`\\{\\{(\\s*)steps\\.${oldId}(?=[.\\s}])`, "g");
    this.commit(cx, m => {
      findStep(m, oldId).step.id = id;
      for (const p of m.phases) {
        for (const s of p.steps) s.prompt = s.prompt.replace(re, `{{$1steps.${id}`);
        if (p.source === `steps.${oldId}` || p.source.startsWith(`steps.${oldId}.`))
          p.source = `steps.${id}${p.source.slice(6 + oldId.length)}`;
      }
      if (m.result === oldId) m.result = id;
    });
    this.sel = { kind: "step", id };
    this.rebind();
  }

  addPhase(cx, mode = "parallel") {
    let p;
    this.commit(cx, m => {
      p = newPhase(`Phase ${m.phases.length + 1}`);
      p.mode = mode;
      const s = newStep(mode === "fanout" ? "impl" : "step");
      p.steps.push(s);
      if (mode === "fanout") p.source = sourceChoices(m, p.id)[0] ?? "";
      m.phases.push(p);
    });
    this.select(cx, { kind: "phase", id: p.id });
  }

  addStep(cx, phaseId, code = false) {
    let s;
    this.commit(cx, m => {
      const p = m.phases.find(x => x.id === phaseId);
      s = code ? newCodeStep() : newStep(p.mode === "fanout" && p.steps.length ? "review" : "step");
      p.steps.push(s);
    });
    this.select(cx, { kind: "step", id: s.id });
    if (!code) this.f.get(`step:${s.id}:prompt`)?.focus();
  }

  /** A phase becomes a code phase (seeded with what it compiled to), or back to steps. */
  setMode(cx, phaseId, mode) {
    this.commit(cx, mm => {
      const ph = mm.phases.find(x => x.id === phaseId);
      if (ph.mode === mode) return;
      if (mode === "code") {
        ph.code = ph.steps.length ? phaseCode(mm, ph) : CODE_PHASE_STARTER;
        ph.steps = [];
        ph.loop.enabled = false;
      } else if (ph.mode === "code") {
        ph.steps = [newStep("step")];
        ph.code = "";
      }
      ph.mode = mode;
      if (mode === "fanout" && !ph.source) ph.source = sourceChoices(mm, ph.id)[0] ?? "";
    });
  }

  /** A step switches between an agent and code; the other side's fields are kept. */
  setKind(cx, id, kind) {
    this.setStep(cx, id, x => {
      x.kind = kind;
      if (kind === "code" && !x.code.trim()) x.code = CODE_STEP_STARTER;
    });
  }

  moveStep(cx, id, dir) {
    this.commit(cx, m => {
      const { phase } = findStep(m, id);
      const i = phase.steps.findIndex(s => s.id === id);
      const j = i + dir;
      if (j < 0 || j >= phase.steps.length) return;
      [phase.steps[i], phase.steps[j]] = [phase.steps[j], phase.steps[i]];
    });
  }

  moveStepTo(cx, id, phaseId) {
    this.commit(cx, m => {
      const { phase, step } = findStep(m, id);
      phase.steps = phase.steps.filter(s => s.id !== id);
      m.phases.find(p => p.id === phaseId).steps.push(step);
    });
  }

  movePhase(cx, id, dir) {
    this.commit(cx, m => {
      const i = m.phases.findIndex(p => p.id === id);
      const j = i + dir;
      if (j < 0 || j >= m.phases.length) return;
      [m.phases[i], m.phases[j]] = [m.phases[j], m.phases[i]];
    });
  }

  deletePhase(cx, id) {
    this.commit(cx, m => {
      m.phases = m.phases.filter(p => p.id !== id);
    });
    this.select(cx, { kind: "workflow" });
  }

  deleteStep(cx, id) {
    this.commit(cx, m => {
      const { phase } = findStep(m, id);
      phase.steps = phase.steps.filter(s => s.id !== id);
      if (m.result === id) m.result = "";
    });
    this.select(cx, { kind: "workflow" });
  }

  duplicateStep(cx, id) {
    let copy;
    this.commit(cx, m => {
      const { phase, step } = findStep(m, id);
      copy = clone(step);
      copy.id = newStep(step.label).id;
      phase.steps.splice(phase.steps.indexOf(step) + 1, 0, copy);
    });
    this.select(cx, { kind: "step", id: copy.id });
  }

  setStep(cx, id, fn) {
    this.commit(cx, m => fn(findStep(m, id).step));
  }

  insertRef(ref, cx) {
    const st = this.f.get(`step:${this.sel.id}:prompt`);
    if (!st) return;
    st.focus();
    st.replace(`{{${ref}}}`);
    this.snapshot();
    findStep(this.model, this.sel.id).step.prompt = st.value();
    this.touch(cx);
  }

  // ---- AI

  // ---- files attached to prompts: repo-relative when inside the repository, so worktrees share them


  // ---- save and run

  target() {
    const dir =
      this.scope === "project" && this.root ? `${this.root}/.claude/workflows` : `${home()}/.claude/workflows`;
    return `${dir}/${this.name()}.js`;
  }

  save(cx, then, replace = false) {
    if (this.model && this.issues.some(i => i.level === "error")) {
      this.notice = { level: "error", text: "Fix the issues first: the workflow wouldn't run." };
      this.showIssues = true;
      cx.notify();
      return;
    }
    const dest = this.target();
    const code = this.code();
    this.saving = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const tmp = await tempFile(`${this.name()}.js`, code);
        const moving = this.path && this.path !== dest;
        const r = await collect(["save", tmp, dest, replace || dest === this.path ? "replace" : ""]);
        if (r.error === "exists") {
          this.confirm = { kind: "overwrite", path: dest, then };
        } else {
          if (moving) await collect(["delete", this.path]).catch(() => null);
          this.path = dest;
          this.saved = code;
          this.confirm = null;
          this.notice = { level: "ok", text: `Saved. Run it as /${this.name()} in Claude Code.` };
          this.host?.librarySaved?.(cx);
          then?.(cx);
        }
      } catch (e) {
        this.notice = { level: "error", text: String(e?.message ?? e) };
      }
      this.saving = false;
      cx.notify();
    });
  }

  openRun(cx) {
    if (this.model?.args.length) {
      this.runSheet = true;
      this.bind();
      cx.notify();
      return;
    }
    this.launch(cx, {});
  }

  /** Hands the saved workflow to the repo's master chat, which runs and owns it. */
  launch(cx, args) {
    const go = cx2 => {
      const name = this.name();
      const folder = this.host?.cwd?.() ?? cwd(this);
      const withArgs = Object.keys(args).length ? `, args: ${JSON.stringify(args)}` : "";
      // By name: Workflow refuses a scriptPath outside the session's folder, and the master
      // works in the main checkout. A draft saved in a worktree isn't found by name there.
      const task =
        `Run the saved workflow "${name}" with Workflow({name: ${JSON.stringify(name)}${withArgs}}), working in ${folder}. ` +
        `Its script is ${this.path}; if the name doesn't resolve, pass that file's contents as \`script\`.`;
      const space = spaces().find(s => s.active)?.id ?? "";
      this.runSheet = false;
      this.notice = { level: "ok", text: "Sending it to the master chat…" };
      cx2.notify();
      cx2.spawn(async cx3 => {
        try {
          const out = await master(["open", folder, space, task]);
          this.notice = null;
          notify({
            title: out.started ? `Started the master chat for ${out.repo.name}` : `Sent to the master chat (${out.address})`,
            body: `It runs and owns "${name}".`,
            level: "success",
            timeout: 4000,
          });
        } catch (e) {
          this.notice = { level: "error", text: `The master chat didn't get it: ${e?.message ?? e}` };
        }
        cx3.notify();
      });
    };
    if (this.dirty()) this.save(cx, go);
    else go(cx);
  }

  setView(cx, v) {
    this.view = v;
    if (v === "code") this.ensureCode();
    cx.notify();
  }

  ensureCode() {
    if (!this.codeState) {
      this.codeState = EditorState.new({
        language: "javascript",
        value: this.code(),
        readonly: Boolean(this.model),
        font_family: settings()?.font_family || "JetBrains Mono",
        font_size: 12,
        syntax: syntax(this.t ?? {}),
      });
    } else if (this.model) this.codeState.set_value(compile(this.model));
  }

  // ---- render

  render(t, host) {
    this.t = t;
    this.host = host;
    const errors = this.issues.filter(i => i.level === "error");
    return v_flex()
      .size_full()
      .min_h(0)
      .child(this.header(t, errors))
      .when(!!this.confirm, el => el.child(this.confirmBar(t)))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .items_stretch()
          .when(!!this.model && !this.hero, el => el.child(this.outline(t)))
          .child(this.center(t))
          .when(!!this.model && !this.hero && this.view === "design", el => el.child(inspector(this, t)))
          .when(!this.model && !this.hero && this.view === "design", el => {
            const panel = callInspector(this, t);
            return panel ? el.child(panel) : el;
          }),
      );
  }

  header(t, errors) {
    const dirty = this.dirty();
    const scopeLabel =
      this.scope === "project" && this.root ? `Project · ${tildify(this.root, home())}` : "User · ~/.claude/workflows";
    return h_flex()
      .flex_none()
      .h(56)
      .px(16)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .child(
        btn(t, "ed-back", "Library", cx => this.host.closeEditor(cx), {
          icon: "arrow-left",
          kind: "ghost",
          size: "sm",
        }),
      )
      .child(div().w(1).h(22).bg(t.border))
      .child(
        v_flex()
          .gap(2)
          .min_w(0)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(15).font_semibold().text_color(t.foreground).truncate().child(this.name()))
              .when(dirty, el => el.child(div().w(7).h(7).rounded_full().bg(t.working).tooltip("Unsaved changes")))
              .when(!this.model && !this.hero, el => el.child(badge(t, "code", t.muted, { icon: "code" }))),
          )
          .child(
            h_flex()
              .id("ed-scope")
              .gap(5)
              .items_center()
              .cursor_pointer()
              .tooltip("Where it's saved: click to switch")
              .on_click((_e, cx) => {
                const roots = this.host.roots();
                if (this.scope === "user" && roots.length) {
                  this.scope = "project";
                  this.root = roots[0];
                } else if (this.scope === "project") {
                  const i = roots.indexOf(this.root);
                  if (i >= 0 && i + 1 < roots.length) this.root = roots[i + 1];
                  else this.scope = "user";
                }
                cx.notify();
              })
              .child(icon(this.scope === "project" ? "folder" : "user", 11, t.dim))
              .child(div().text_size(11).text_color(t.dim).child(scopeLabel))
              .child(icon("chevron-down", 10, t.dim)),
          ),
      )
      .child(div().flex_1())
      .when(!!this.notice, el =>
        el.child(
          badge(
            t,
            clip(this.notice.text, 90),
            this.notice.level === "error" ? t.blocked : this.notice.level === "ok" ? t.ansi2 : t.muted,
            {
              h: 24,
              icon: this.notice.level === "error" ? "alert" : "circle-check",
            },
          ),
        ),
      )
      .when(!this.hero, el =>
        el
          .when(!!this.model, e =>
            e.child(
              h_flex()
                .id("ed-issues")
                .h(26)
                .px(9)
                .gap(6)
                .items_center()
                .rounded(13)
                .cursor_pointer()
                .bg(errors.length ? alpha(t.blocked, 0.1) : alpha(t.ansi2 ?? t.done, 0.1))
                .on_click((_e, cx) => {
                  this.showIssues = !this.showIssues;
                  cx.notify();
                })
                .child(icon(errors.length ? "alert" : "circle-check", 12, errors.length ? t.blocked : t.ansi2))
                .child(
                  div()
                    .text_size(11.5)
                    .font_medium()
                    .text_color(errors.length ? t.blocked : t.ansi2)
                    .child(errors.length ? `${errors.length} issue${errors.length > 1 ? "s" : ""}` : "Ready to run"),
                ),
            ),
          )
          .child(iconBtn(t, "ed-undo", "undo", cx => this.undo(cx), "Undo", { disabled: !this.history.length }))
          .child(iconBtn(t, "ed-redo", "redo", cx => this.redo(cx), "Redo", { disabled: !this.future.length }))
          .when(this.view === "design", e => e.child(dirSwitch(t, "ed-dir")))
          .child(
            seg(
              t,
              "ed-view",
              [
                // A script's graph is read from its code; a design's is what the code is made from.
                { id: "design", label: this.model ? "Design" : "Graph", icon: "flow" },
                { id: "code", label: "Code", icon: "code" },
              ],
              this.view,
              (v, cx) => this.setView(cx, v),
              { size: "sm" },
            ),
          )
          .child(btn(t, "ed-run", "Run", cx => this.openRun(cx), { icon: "play", size: "sm" }))
          .child(
            btn(t, "ed-save", this.saving ? "Saving…" : "Save", cx => this.save(cx), {
              icon: "save",
              kind: "primary",
              size: "sm",
              kbd: "⌘S",
              disabled: this.saving,
            }),
          ),
      );
  }

  confirmBar(t) {
    return h_flex()
      .flex_none()
      .px(16)
      .py(8)
      .gap(10)
      .items_center()
      .bg(alpha(t.working, 0.1))
      .child(icon("alert", 13, t.working))
      .child(
        div()
          .flex_1()
          .text_size(12)
          .text_color(t.foreground)
          .child(`${tildify(this.confirm.path, home())} already exists.`),
      )
      .child(btn(t, "cf-no", "Keep it", cx => ((this.confirm = null), cx.notify()), { size: "sm", kind: "ghost" }))
      .child(
        btn(t, "cf-yes", "Overwrite", cx => this.save(cx, this.confirm.then, true), { size: "sm", kind: "danger" }),
      );
  }

  // ---- outline

  outline(t) {
    const m = this.model;
    const sel = this.sel;
    const row = (id, depth, label, o) =>
      h_flex()
        .id(id)
        .h(depth ? 28 : 30)
        .pl(8 + depth * 16)
        .pr(8)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(o.selected, el => el.bg(alpha(t.accent, 0.12)))
        .when(!o.selected, el => el.hover(s => s.bg(alpha(t.foreground, 0.05))))
        .on_click((_e, cx) => o.onClick(cx))
        .child(o.lead)
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(depth ? 12 : 12.5)
            .when(!depth, el => el.font_medium())
            .text_color(o.selected ? t.accent : t.foreground)
            .child(label),
        )
        .when(!!o.trail, el => el.child(o.trail));
    const bad = target =>
      this.issues.some(
        i => i.level === "error" && i.target && Object.entries(target).every(([k, v]) => i.target[k] === v),
      );
    const errDot = () => div().w(6).h(6).rounded_full().bg(t.blocked);
    return v_flex()
      .flex_none()
      .w(OUTLINE_W)
      .min_h(0)
      .border_r(1)
      .border_color(alpha(t.border, 0.8))
      .bg(t.chrome ?? t.surface)
      .child(
        scrollArea(
          "ed-outline",
          "y",
          v_flex()
            .p(10)
            .gap(2)
            .child(
              row("ol-wf", 0, "Workflow", {
                selected: sel.kind === "workflow",
                onClick: cx => this.select(cx, { kind: "workflow" }),
                lead: icon("settings", 13, t.dim),
                trail: this.issues.some(i => i.level === "error" && !i.target) ? errDot() : null,
              }),
            )
            .child(div().h(10))
            .child(div().px(8).pb(4).text_size(10).font_semibold().text_color(t.dim).child("PHASES"))
            .children(
              m.phases.flatMap((p, i) => [
                row(`ol-p-${p.id}`, 0, p.title, {
                  selected: sel.kind === "phase" && sel.id === p.id,
                  onClick: cx => this.select(cx, { kind: "phase", id: p.id }),
                  lead: div()
                    .w(18)
                    .font_family(mono())
                    .text_size(10.5)
                    .text_color(t.accent)
                    .child(String(i + 1).padStart(2, "0")),
                  trail:
                    bad({ phase: p.id }) && !p.steps.some(s => bad({ step: s.id }))
                      ? errDot()
                      : icon(p.loop.enabled ? "repeat" : MODE_ICON[p.mode], 12, p.loop.enabled ? (t.ansi5 ?? t.accent) : t.dim),
                }),
                ...p.steps.map(s =>
                  row(`ol-s-${s.id}`, 1, s.label, {
                    selected: sel.kind === "step" && sel.id === s.id,
                    onClick: cx => this.select(cx, { kind: "step", id: s.id }),
                    lead:
                      s.kind === "code"
                        ? icon("code", 10, t.dim)
                        : div().w(7).h(7).rounded_full().bg(kindColor(s.label, t)),
                    trail: bad({ step: s.id })
                      ? errDot()
                      : s.repeat > 1
                        ? badge(t, `×${s.repeat}`, t.muted, { mono: true })
                        : null,
                  }),
                ),
                // A code phase has no steps: its code is the phase.
                p.mode === "code"
                  ? null
                  : h_flex()
                      .id(`ol-add-${p.id}`)
                      .h(26)
                      .pl(24)
                      .gap(6)
                      .items_center()
                      .rounded(7)
                      .cursor_pointer()
                      .hover(s => s.bg(alpha(t.foreground, 0.04)))
                      .on_click((_e, cx) => this.addStep(cx, p.id))
                      .child(icon("plus", 11, t.dim))
                      .child(div().text_size(11.5).text_color(t.dim).child("Add step")),
              ].filter(Boolean)),
            )
            .child(div().h(8))
            .child(
              h_flex()
                .gap(6)
                .px(4)
                .child(btn(t, "ol-addp", "Phase", cx => this.addPhase(cx), { icon: "plus", size: "sm" }))
                .child(
                  btn(t, "ol-addf", "Fan-out", cx => this.addPhase(cx, "fanout"), {
                    icon: "split",
                    size: "sm",
                    kind: "ghost",
                  }),
                ),
            ),
        ),
      );
  }

  // ---- center: graph or code, the composer, the run sheet

  center(t) {
    let body;
    if (this.hero) body = heroCard(this, t);
    else if (this.view === "code") body = codePane(this, t);
    else if (!this.model)
      body = codeCanvas(t, parsed(this), this.call, (id, cx) => pickCall(this, cx, id), cx => this.setView(cx, "code"));
    else body = canvas(this, t);
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .relative()
      .bg(t.canvas ?? mix(t.background, t.foreground, 0.02))
      .when(!!this.design && !this.model && !this.hero, el => el.child(strayBar(this, t)))
      .child(body)
      .when(!this.hero && this.showIssues && this.issues.length > 0, el => el.child(issueList(this, t)))
      .when(!this.hero, el => el.child(composer(this, t)))
      .when(this.runSheet, el => el.child(runCard(this, t)));
  }

  // ---- inspector

}
