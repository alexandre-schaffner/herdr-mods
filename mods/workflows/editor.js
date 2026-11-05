// The workflow editor: outline, live graph, inspector, and an AI composer that edits the same model.

import { Editor as CodeView, EditorState, h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { div, image, PathBuilder } from "gpui-kit";
import { appHome, closeOverlay, exec, home, props, run, settings } from "herdr";
import { cancelJob, EXAMPLES, pollJob, startJob } from "./assist.js";
import { dirSwitch, G, graph, graphDir } from "./graph.js";
import { collect, tempFile } from "./io.js";
import {
  AGENT_TYPES,
  blankModel,
  clone,
  compile,
  EFFORTS,
  FIELD_TYPES,
  findStep,
  MODELS,
  MODES,
  metaOf,
  newPhase,
  newStep,
  normalize,
  refChoices,
  refsIn,
  slug,
  sourceChoices,
  validate,
  MAX_ROUNDS,
  UNTIL_OPS,
  WHENS,
} from "./model.js";
import { badge, btn, chips, field, frame, iconBtn, kbd, section, seg, stepper, toggle } from "./ui.js";
import { alpha, clip, icon, kindColor, mix, mono, scrollArea, tildify } from "./util.js";
import { openViewer, viewable } from "./viewer.js";

const OUTLINE_W = 250;
const INSPECTOR_W = 400;
const MODE_ICON = { parallel: "layers", sequential: "list", fanout: "split" };

/** "review.clean is true", for a phase's loop. */
function stopText(p) {
  const u = p.loop.until;
  const step = p.steps.find(s => s.id === u.step);
  if (!step) return "no stop condition yet";
  const op = UNTIL_OPS.find(o => o.id === u.op)?.label ?? u.op;
  const value = ["equals", "contains"].includes(u.op) ? ` "${u.value}"` : "";
  return `until ${step.label}${u.field ? `.${u.field}` : ""} ${op}${value}`;
}

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
    this.path = doc.path ?? null;
    this.scope = doc.scope ?? "user";
    this.root = doc.root ?? null;
    this.saved = doc.path ? (this.model ? compile(this.model) : this.raw) : null;
    this.sel = { kind: "workflow" };
    this.view = this.model ? "design" : "code";
    this.hero = Boolean(doc.hero);
    this.history = [];
    this.future = [];
    this.notice = null;
    this.confirm = null;
    this.runSheet = false;
    this.ai = { open: Boolean(doc.hero), job: null, events: [], error: null, applied: false, agent: this.pickAgent(), files: [] };
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
    return this.model?.name ?? (metaOf(this.raw).name || "workflow");
  }

  // ---- fields: retained input state is made here, in handlers, never in render

  text(key, get, set, o = {}) {
    if (this.f.has(key)) return;
    const st = o.multiline
      ? TextareaState.new({ placeholder: o.placeholder ?? "", value: get() ?? "", rows: o.rows ?? 3 })
      : InputState.new({ placeholder: o.placeholder ?? "", value: get() ?? "" });
    if (o.multiline && o.grow) st.set_auto_grow(o.grow[0], o.grow[1]);
    st.on("focus", (_e, cx) => {
      this.focus = key;
      this.armed = true;
      cx.notify();
    });
    st.on("blur", (_e, cx) => {
      if (this.focus === key) this.focus = null;
      o.blur?.(st.value(), cx);
      cx.notify();
    });
    st.on("change", (_e, cx) => {
      if (!set) return;
      if (this.armed) {
        this.snapshot();
        this.armed = false;
      }
      set(st.value());
      this.touch(cx);
    });
    if (o.submit) st.on("submit", (_e, cx) => o.submit(cx));
    this.f.set(key, st);
  }

  /** Makes every field the current selection shows. */
  bind() {
    if (!this.f.has("fs:query")) {
      const st = InputState.new({ placeholder: "Search files in the repository…" });
      st.on("change", (_e, cx) => this.search(cx));
      st.on("submit", (_e, cx) => {
        const first = this.fs?.results?.[0];
        if (first) this.addFiles(this.fs.target, [`${this.repoRoot()}/${first}`], cx);
      });
      st.on("focus", (_e, cx) => ((this.focus = "fs:query"), cx.notify()));
      st.on("blur", (_e, cx) => (this.focus === "fs:query" && (this.focus = null), cx.notify()));
      this.f.set("fs:query", st);
    }
    this.text("ai-model", () => localStorage.getItem(`agent-model:${this.ai?.agent}`) ?? "", null, {
      placeholder: "default model",
      blur: v => localStorage.setItem(`agent-model:${this.ai.agent}`, v.trim()),
    });
    this.text("ai", () => "", null, {
      multiline: true,
      grow: [2, 8],
      placeholder: this.model
        ? "Ask Claude to change this workflow…"
        : "Convert this script into an editable workflow, or describe one…",
      submit: cx => this.generate(cx),
    });
    this.text("hero", () => "", null, {
      multiline: true,
      grow: [5, 14],
      placeholder: "Describe the workflow: what it should accomplish, how work splits, how results get checked…",
      submit: cx => this.generate(cx, "hero"),
    });
    if (!this.model) return;
    const m = () => this.model;
    this.text(
      "wf:name",
      () => m().name,
      v => (m().name = v),
      { placeholder: "kebab-case-name", blur: (v, cx) => this.renameWorkflow(v, cx) },
    );
    this.text(
      "wf:description",
      () => m().description,
      v => (m().description = v),
      {
        multiline: true,
        grow: [2, 5],
        placeholder: "One line, shown when the workflow asks to run",
      },
    );
    this.text(
      "wf:whenToUse",
      () => m().whenToUse,
      v => (m().whenToUse = v),
      {
        multiline: true,
        grow: [2, 5],
        placeholder: "When should Claude reach for this workflow? (optional)",
      },
    );
    m().args.forEach((a, i) => {
      const arg = () => m().args[i];
      this.text(
        `arg:${i}:name`,
        () => a.name,
        v => (arg().name = v.replace(/[^\w]/g, "_")),
        { placeholder: "name" },
      );
      this.text(
        `arg:${i}:description`,
        () => a.description,
        v => (arg().description = v),
        { placeholder: "What it is" },
      );
      this.text(
        `arg:${i}:example`,
        () => a.example,
        v => (arg().example = v),
        { placeholder: "Example value" },
      );
    });
    const sel = this.sel;
    if (sel.kind === "phase") {
      const p = m().phases.find(x => x.id === sel.id);
      if (!p) return;
      const ph = () => m().phases.find(x => x.id === sel.id);
      this.text(
        `phase:${p.id}:title`,
        () => p.title,
        v => (ph().title = v),
        { placeholder: "Phase title" },
      );
      this.text(
        `phase:${p.id}:detail`,
        () => p.detail,
        v => (ph().detail = v),
        { placeholder: "What happens here (optional)" },
      );
      this.text(
        `phase:${p.id}:source`,
        () => p.source,
        v => (ph().source = v.trim()),
        { placeholder: "steps.plan.units" },
      );
      this.text(
        `phase:${p.id}:itemKey`,
        () => p.itemKey,
        v => (ph().itemKey = v.trim()),
        { placeholder: "id" },
      );
      this.text(`phase:${p.id}:untilValue`, () => p.loop.until.value, v => (ph().loop.until.value = v), {
        placeholder: "APPROVED",
      });
    }
    if (sel.kind === "step") {
      const where = findStep(m(), sel.id);
      if (!where) return;
      const s = where.step;
      const st = () => findStep(m(), sel.id)?.step;
      const k = `step:${s.id}`;
      this.text(
        `${k}:label`,
        () => s.label,
        v => (st().label = v),
        { placeholder: "impl, review, gate…" },
      );
      this.text(`${k}:id`, () => s.id, null, {
        placeholder: "identifier",
        blur: (v, cx) => this.renameStep(s.id, v, cx),
      });
      this.text(
        `${k}:prompt`,
        () => s.prompt,
        v => (st().prompt = v),
        {
          multiline: true,
          grow: [8, 22],
          placeholder: "The whole brief for this agent: goal, scope, constraints, and what to return.",
        },
      );
      this.text(
        `${k}:agentType`,
        () => s.agentType,
        v => (st().agentType = v.trim()),
        { placeholder: "default workflow agent" },
      );
      this.text(
        `${k}:raw`,
        () => s.output.raw,
        v => (st().output.raw = v),
        {
          multiline: true,
          grow: [6, 18],
          placeholder: '{ "type": "object", "properties": { … }, "required": [ … ] }',
        },
      );
      s.output.fields.forEach((fd, i) => {
        const fl = () => st().output.fields[i];
        this.text(
          `${k}:f:${i}:name`,
          () => fd.name,
          v => (fl().name = v.replace(/[^\w]/g, "_")),
          { placeholder: "field" },
        );
        this.text(
          `${k}:f:${i}:description`,
          () => fd.description,
          v => (fl().description = v),
          { placeholder: "What the agent puts here" },
        );
      });
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

  snapshot() {
    if (!this.model) return;
    this.history.push(JSON.stringify(this.model));
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }

  touch(cx) {
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
    this.future.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.history.pop());
    this.fixSelection();
    this.rebind();
    this.touch(cx);
  }

  redo(cx) {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.future.pop());
    this.fixSelection();
    this.rebind();
    this.touch(cx);
  }

  fixSelection() {
    const s = this.sel;
    if (s.kind === "step" && !findStep(this.model, s.id)) this.sel = { kind: "workflow" };
    if (s.kind === "phase" && !this.model.phases.some(p => p.id === s.id)) this.sel = { kind: "workflow" };
  }

  select(cx, sel) {
    this.sel = sel;
    this.focus = null;
    if (this.fs?.target === "step") this.fs = null;
    this.bind();
    if (sel.kind === "step") this.checkFiles(cx);
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

  addStep(cx, phaseId) {
    let s;
    this.commit(cx, m => {
      const p = m.phases.find(x => x.id === phaseId);
      s = newStep(p.mode === "fanout" && p.steps.length ? "review" : "step");
      p.steps.push(s);
    });
    this.select(cx, { kind: "step", id: s.id });
    this.f.get(`step:${s.id}:prompt`)?.focus();
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

  generate(cx, from = "ai") {
    const st = this.f.get(from);
    const request = st?.value().trim();
    if (!request || this.ai.job) return;
    const current = this.model && !this.hero ? this.model : null;
    const text =
      this.raw && !this.hero
        ? `Convert this hand-written Workflow script into the model, keeping its behaviour:\n\n${this.raw}\n\n${request}`
        : request;
    this.ai = { ...this.ai, job: "starting", events: [], error: null, applied: false, request, from };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const model = this.f.get("ai-model")?.value().trim() ?? "";
        localStorage.setItem(`agent-model:${this.ai.agent}`, model);
        const dir = await startJob(text, current, this.cwd(), this.ai.agent, model, this.ai.files.map(f => this.absPath(f)));
        this.ai.job = dir;
      } catch (e) {
        this.ai = { ...this.ai, job: null, error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  /** Called by the host's timer. */
  poll(cx) {
    const dir = this.ai?.job;
    if (!dir || dir === "starting" || this.ai.polling) return;
    this.ai.polling = true;
    cx.spawn(async cx => {
      try {
        const r = await pollJob(dir);
        this.ai.events = r.events;
        if (!r.running && r.result) {
          this.ai.job = null;
          if (r.result.ok) this.applyAI(r.result.model, cx);
          else this.ai.error = r.result.error || "Generation failed";
        }
      } catch (e) {
        this.ai.error = String(e?.message ?? e);
        this.ai.job = null;
      }
      this.ai.polling = false;
      cx.notify();
    });
  }

  applyAI(raw, cx) {
    const next = normalize(raw);
    if (this.model) this.snapshot();
    else this.history = [];
    this.model = next;
    this.raw = null;
    this.hero = false;
    this.view = "design";
    this.sel = { kind: "workflow" };
    this.ai = { ...this.ai, applied: true, open: true, events: [] };
    for (const k of ["ai", "hero"]) {
      this.f.get(k)?.release();
      this.f.delete(k);
    }
    this.rebind();
    this.touch(cx);
    const steps = next.phases.reduce((n, p) => n + p.steps.length, 0);
    this.notice = {
      level: "ok",
      text: `Claude drafted ${next.phases.length} phases and ${steps} steps. Review, then save.`,
    };
  }

  cancelAI(cx) {
    const dir = this.ai.job;
    this.ai = { ...this.ai, job: null, events: [] };
    if (dir && dir !== "starting") cx.spawn(async () => cancelJob(dir));
    cx.notify();
  }

  cwd() {
    return this.root ?? this.host?.cwd?.() ?? home();
  }

  // ---- files attached to prompts: repo-relative when inside the repository, so worktrees share them

  repoRoot() {
    return this.root ?? this.host?.repoRoot?.() ?? this.cwd();
  }

  relPath(p) {
    const root = this.repoRoot();
    return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
  }

  absPath(p) {
    if (p.startsWith("/")) return p;
    if (p.startsWith("~/")) return home() + p.slice(1);
    return `${this.repoRoot()}/${p}`;
  }

  filesOf(target) {
    if (target === "ai") return this.ai.files;
    return findStep(this.model, this.sel.id)?.step.files ?? [];
  }

  addFiles(target, paths, cx) {
    const rel = paths.map(p => this.relPath(p.trim())).filter(Boolean);
    if (!rel.length) return;
    if (target === "ai") this.ai.files = [...new Set([...this.ai.files, ...rel])];
    else this.setStep(cx, this.sel.id, s => (s.files = [...new Set([...(s.files ?? []), ...rel])]));
    this.checkFiles(cx);
    cx.notify();
  }

  removeFile(target, path, cx) {
    if (target === "ai") this.ai.files = this.ai.files.filter(f => f !== path);
    else this.setStep(cx, this.sel.id, s => (s.files = s.files.filter(f => f !== path)));
    cx.notify();
  }

  /** Marks attached files that don't exist (moved, renamed, or in another checkout). */
  checkFiles(cx) {
    const all = [...new Set([...this.ai.files, ...(this.model?.phases.flatMap(p => p.steps.flatMap(s => s.files)) ?? [])])];
    if (!all.length) return;
    cx.spawn(async cx => {
      try {
        const r = await collect(["exists", this.repoRoot(), ...all]);
        this.missing = new Set(Object.entries(r.exists).filter(([, ok]) => !ok).map(([f]) => f));
      } catch {
        // a failed check leaves the chips unmarked rather than all red
      }
      cx.notify();
    });
  }

  openSearch(target, cx) {
    this.fs = this.fs?.target === target ? null : { target, results: [], total: null, loading: false };
    if (this.fs) {
      this.f.get("fs:query")?.set_value("");
      this.f.get("fs:query")?.focus();
    }
    cx.notify();
  }

  search(cx) {
    if (!this.fs) return;
    const q = this.f.get("fs:query")?.value() ?? "";
    const token = (this.fsToken = (this.fsToken ?? 0) + 1);
    cx.timer.after(160, cx2 => {
      if (token !== this.fsToken || !this.fs) return;
      this.fs.loading = true;
      cx2.spawn(async cx3 => {
        try {
          const r = await collect(["files", this.repoRoot(), q]);
          if (token === this.fsToken && this.fs) Object.assign(this.fs, { results: r.files, total: r.total, error: null });
        } catch (e) {
          if (this.fs) this.fs.error = String(e?.message ?? e);
        }
        if (this.fs) this.fs.loading = false;
        cx3.notify();
      });
      cx2.notify();
    });
  }

  /** The macOS file picker, run detached; polled until it closes. */
  browse(target, cx) {
    cx.spawn(async cx => {
      const dir = `${appHome()}/data/workflows/tmp`;
      const out = `${dir}/pick-${Date.now().toString(36)}.txt`;
      try {
        await exec("mkdir", ["-p", dir]);
        await collect(["pick-start", out, this.repoRoot()]);
        for (let i = 0; i < 1500; i++) {
          await exec("sleep", ["0.4"]);
          const r = await collect(["pick-poll", out]);
          if (r.done) {
            this.addFiles(target, r.paths, cx);
            break;
          }
        }
      } catch (e) {
        this.notice = { level: "error", text: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  fileChip(t, target, f) {
    const missing = this.missing.has(f);
    const abs = this.absPath(f);
    const view = !missing && viewable(abs);
    const slash = f.lastIndexOf("/");
    const name = f.slice(slash + 1);
    const dir = slash > 0 ? f.slice(0, slash) : "";
    return h_flex()
      .id(`chip-${target}-${f}`)
      .h(26)
      .pl(8)
      .pr(3)
      .gap(6)
      .items_center()
      .rounded(7)
      .bg(missing ? alpha(t.blocked, 0.08) : alpha(t.foreground, 0.05))
      .border(1)
      .border_color(missing ? alpha(t.blocked, 0.5) : alpha(t.border, 1))
      .tooltip(missing ? `${f} doesn't exist in ${tildify(this.repoRoot(), home())}` : view ? `${f} · click to view` : f)
      .child(
        h_flex()
          .id(`chip-open-${target}-${f}`)
          .gap(6)
          .items_center()
          .when(view, el => el.cursor_pointer().hover(s => s.opacity(0.75)).on_click(() => openViewer(abs)))
          .child(icon(missing ? "alert" : view ? "eye" : "file-text", 11, missing ? t.blocked : t.accent))
          .child(div().text_size(11.5).font_medium().text_color(missing ? t.blocked : t.foreground).child(name))
          .when(!!dir, el => el.child(div().max_w(180).truncate().font_family(mono()).text_size(10).text_color(t.dim).child(dir))),
      )
      .child(iconBtn(t, `chip-x-${target}-${f}`, "x", cx => this.removeFile(target, f, cx), "Remove", { size: 20, icon: 10 }));
  }

  searchPanel(t, target) {
    const fs = this.fs;
    const attached = new Set(this.filesOf(target));
    const q = this.f.get("fs:query")?.value() ?? "";
    return v_flex()
      .id(`fs-panel-${target}`)
      .p(8)
      .gap(4)
      .rounded(11)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .shadow_md()
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().flex_1().child(this.input(t, "fs:query", { h: 30, size: 12 })))
          .when(fs.loading, el => el.child(icon("spinner", 12, t.muted).spin(900)))
          .child(iconBtn(t, `fs-close-${target}`, "x", cx => ((this.fs = null), cx.notify()), "Close")),
      )
      .when(!!fs.error, el => el.child(div().px(4).text_size(11).text_color(t.blocked).child(fs.error)))
      .when(!q.trim() && !fs.error, el =>
        el.child(div().px(4).py(4).text_size(11).text_color(t.dim).child(`Type a few letters: “eng readme”, “v3state”. Searches ${tildify(this.repoRoot(), home())}.`)),
      )
      .when(!!q.trim() && !fs.loading && !fs.results.length && !fs.error, el =>
        el.child(div().px(4).py(4).text_size(11).text_color(t.dim).child("No file matches.")),
      )
      .children(
        fs.results.slice(0, 10).map((f, i) => {
          const slash = f.lastIndexOf("/");
          const has = attached.has(f);
          return h_flex()
            .id(`fs-r-${target}-${i}`)
            .h(28)
            .px(6)
            .gap(8)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .when(i === 0, el => el.bg(alpha(t.accent, 0.08)))
            .hover(s => s.bg(alpha(t.accent, 0.12)))
            .on_click((_e, cx) => this.addFiles(target, [`${this.repoRoot()}/${f}`], cx))
            .child(icon(has ? "check" : "file-text", 12, has ? t.ansi2 : t.dim))
            .child(div().flex_none().text_size(12).text_color(t.foreground).child(f.slice(slash + 1)))
            .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(10.5).text_color(t.dim).child(slash > 0 ? f.slice(0, slash) : ""))
            .when(i === 0, el => el.child(kbd(t, "↵")));
        }),
      );
  }

  /** Attached files for a step or for the AI prompt: chips, find-in-repo, browse, and drop. */
  filesBox(t, target, o = {}) {
    const files = this.filesOf(target);
    const searching = this.fs?.target === target;
    return v_flex()
      .id(`files-${target}`)
      .gap(8)
      .on_drop((e, cx) => this.addFiles(target, e.paths, cx))
      .when(files.length > 0, el => el.child(h_flex().flex_wrap().gap(6).children(files.map(f => this.fileChip(t, target, f)))))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(btn(t, `fs-find-${target}`, o.compact ? "" : "Find in repo", cx => this.openSearch(target, cx), { icon: "search", size: "sm", kind: searching ? "secondary" : "ghost", tooltip: "Find a file in the repository" }))
          .child(btn(t, `fs-browse-${target}`, o.compact ? "" : "Browse…", cx => this.browse(target, cx), { icon: "folder", size: "sm", kind: "ghost", tooltip: "Pick files with the macOS picker" }))
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(
                files.length
                  ? target === "ai"
                    ? `${files.length} file${files.length > 1 ? "s" : ""} for the agent to read`
                    : `${files.length} file${files.length > 1 ? "s" : ""}, read before the prompt`
                  : "or drop files here",
              ),
          ),
      )
      .when(searching, el => el.child(this.searchPanel(t, target)));
  }

  installedAgents() {
    return (this.agents ?? [{ id: "claude", label: "Claude Code", icon: "icons/claude.svg", installed: true, models: [] }]).filter(a => a.installed);
  }

  pickAgent() {
    const saved = localStorage.getItem("agent");
    if (!this.agents) return saved ?? "claude";
    const list = this.installedAgents();
    return list.find(a => a.id === saved)?.id ?? list[0]?.id ?? "claude";
  }

  agentLabel() {
    return this.installedAgents().find(a => a.id === this.ai?.agent)?.label ?? "The agent";
  }

  setAgent(id, cx) {
    this.ai.agent = id;
    localStorage.setItem("agent", id);
    this.f.get("ai-model")?.set_value(localStorage.getItem(`agent-model:${id}`) ?? "");
    cx.notify();
  }

  /** Which agent writes the workflow. Compact shows icons, plus the chosen one's name. */
  agentSwitch(t, prefix, compact) {
    const agents = this.installedAgents();
    return h_flex()
      .flex_none()
      .p(3)
      .gap(2)
      .rounded(9)
      .bg(alpha(t.foreground, 0.055))
      .children(
        agents.map(a => {
          const on = a.id === this.ai.agent;
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
            .on_click((_e, cx) => this.setAgent(a.id, cx))
            .child(mark)
            .when(!compact || on, el => el.child(div().text_size(compact ? 11 : 12).text_color(on ? t.foreground : t.muted).child(a.label)));
        }),
      );
  }

  /** The model the agent runs with; empty means its own default. */
  modelField(t, prefix, compact) {
    const current = this.installedAgents().find(a => a.id === this.ai.agent);
    return h_flex()
      .gap(6)
      .items_center()
      .min_w(0)
      .child(div().flex_none().w(compact ? 120 : 150).child(this.input(t, "ai-model", { h: compact ? 26 : 28, size: 11.5, mono: true })))
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
                this.f.get("ai-model")?.set_value(m);
                localStorage.setItem(`agent-model:${this.ai.agent}`, m);
                cx.notify();
              })
              .child(div().font_family(mono()).text_size(10.5).text_color(t.muted).child(m)),
          ),
        ),
      );
  }


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

  launch(cx, args) {
    const go = cx2 => {
      const name = this.name();
      const json = Object.keys(args).length ? ` with args ${JSON.stringify(args)}` : "";
      run("tab.new", {
        name,
        folder: this.cwd(),
        argv: ["claude"],
        task: `Run the saved workflow "${name}" (Workflow tool, name "${name}")${json}.`,
      });
      this.runSheet = false;
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
      cx2.notify();
    };
    if (this.dirty()) this.save(cx, go);
    else go(cx);
  }

  setView(cx, v) {
    this.view = v;
    if (v === "code" && !this.codeState) {
      this.codeState = EditorState.new({
        language: "javascript",
        value: this.code(),
        readonly: Boolean(this.model),
        font_family: settings()?.font_family || "JetBrains Mono",
        font_size: 12,
        syntax: syntax(this.t ?? {}),
      });
    } else if (v === "code" && this.model) this.codeState.set_value(compile(this.model));
    cx.notify();
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
          .when(!!this.model && !this.hero && this.view === "design", el => el.child(this.inspector(t))),
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
      .when(!!this.model && !this.hero, el =>
        el
          .child(
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
          )
          .child(iconBtn(t, "ed-undo", "undo", cx => this.undo(cx), "Undo", { disabled: !this.history.length }))
          .child(iconBtn(t, "ed-redo", "redo", cx => this.redo(cx), "Redo", { disabled: !this.future.length }))
          .when(this.view === "design" && !!this.model, el => el.child(dirSwitch(t, "ed-dir")))
          .child(
            seg(
              t,
              "ed-view",
              [
                { id: "design", label: "Design", icon: "flow" },
                { id: "code", label: "Code", icon: "code" },
              ],
              this.view,
              (v, cx) => this.setView(cx, v),
              { size: "sm" },
            ),
          ),
      )
      .when(!this.hero, el =>
        el.child(btn(t, "ed-run", "Run", cx => this.openRun(cx), { icon: "play", size: "sm" })).child(
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
                    lead: div().w(7).h(7).rounded_full().bg(kindColor(s.label, t)),
                    trail: bad({ step: s.id })
                      ? errDot()
                      : s.repeat > 1
                        ? badge(t, `×${s.repeat}`, t.muted, { mono: true })
                        : null,
                  }),
                ),
                h_flex()
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
              ]),
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
    if (this.hero) body = this.heroCard(t);
    else if (this.view === "code" || !this.model) body = this.codePane(t);
    else body = this.canvas(t);
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .relative()
      .bg(t.canvas ?? mix(t.background, t.foreground, 0.02))
      .child(body)
      .when(!this.hero && this.showIssues && this.issues.length > 0, el => el.child(this.issueList(t)))
      .when(!this.hero, el => el.child(this.composer(t)))
      .when(this.runSheet, el => el.child(this.runCard(t)));
  }

  canvas(t) {
    const m = this.model;
    const lanes = m.phases.map((p, i) => ({
      index: i + 1,
      title: p.title,
      phase: p,
      look: { key: "done", color: t.accent },
      done: 0,
      live: 0,
      failed: 0,
      nodes: [
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
    const selected = this.sel.kind === "step" ? this.sel.id : null;
    return scrollArea(
      "ed-canvas",
      "both",
      div()
        .pb(160)
        .child(
          graph(lanes, t, selected, (id, cx) => this.select(cx, { kind: "step", id }), {
            card: (n, tt, sel, onSelect) => this.card(n, tt, sel, onSelect),
            lane: (l, size, tt) => this.laneFrame(l, size, tt),
            palette: { done: alpha(t.accent, 0.45) },
          }),
        ),
    );
  }

  card(n, t, selected, onSelect) {
    if (n.ghost)
      return h_flex()
        .id(`ghost-${n.id}`)
        .absolute()
        .left(n.x)
        .top(graphDir() === "v" ? n.y + (G.nodeH - 44) / 2 : n.y)
        .w(G.laneW)
        .h(44)
        .rounded(12)
        .border(1)
        .border_dashed()
        .border_color(alpha(t.muted, 0.4))
        .justify_center()
        .items_center()
        .gap(6)
        .cursor_pointer()
        .hover(s => s.border_color(t.accent).bg(alpha(t.accent, 0.05)))
        .on_click((_e, cx) => this.addStep(cx, n.phase.id))
        .child(icon("plus", 12, t.muted))
        .child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(n.phase.mode === "fanout" ? "Add stage" : "Add step"),
        );
    const s = n.step;
    const kc = kindColor(s.label, t);
    const err = this.issues.find(i => i.level === "error" && i.target?.step === s.id);
    const first = s.prompt.trim().split("\n")[0];
    return div()
      .id(`card-${s.id}`)
      .absolute()
      .left(n.x)
      .top(n.y)
      .w(G.laneW)
      .h(G.nodeH)
      .rounded(13)
      .bg(selected ? mix(t.background, t.accent, 0.08) : t.background)
      .border(selected ? 1.5 : 1)
      .border_color(selected ? t.accent : err ? alpha(t.blocked, 0.6) : t.border)
      .when(selected, el => el.shadow_lg())
      .when(!selected, el => el.shadow_sm())
      .cursor_pointer()
      .hover(st => st.border_color(selected ? t.accent : alpha(t.accent, 0.55)))
      .on_click((_e, cx) => onSelect(s.id, cx))
      .child(
        div()
          .absolute()
          .left(0)
          .top(12)
          .w(3)
          .h(G.nodeH - 24)
          .rounded_full()
          .bg(kc),
      )
      .child(
        v_flex()
          .size_full()
          .pl(14)
          .pr(12)
          .py(10)
          .gap(6)
          .child(
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
              .when(!!(s.model || this.model.defaults.model), el =>
                el.child(badge(t, s.model || this.model.defaults.model, t.muted)),
              ),
          )
          .child(
            div()
              .truncate()
              .text_size(11.5)
              .text_color(err ? t.blocked : first ? t.muted : t.dim)
              .child(err ? err.msg : first ? clip(first, 80) : "Empty prompt: click to write it"),
          ),
      );
  }

  laneFrame(lane, size, t) {
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
            .child(btn(t, "lane-add-p", "Steps", cx => this.addPhase(cx), { icon: "layers", size: "sm" }))
            .child(btn(t, "lane-add-f", "Fan-out", cx => this.addPhase(cx, "fanout"), { icon: "split", size: "sm" })),
        );
    const p = lane.phase;
    const selected = this.sel.kind === "phase" && this.sel.id === p.id;
    const mode = MODES.find(x => x.id === p.mode);
    const decorations = [];
    if (p.mode === "fanout")
      for (const n of lane.nodes.filter(x => !x.ghost))
        for (const off of [8, 4])
          decorations.push(
            div()
              .absolute()
              .left(n.x - box.x + off)
              .top(n.y - box.y + off)
              .w(G.laneW)
              .h(G.nodeH)
              .rounded(13)
              .border(1)
              .border_color(alpha(t.accent, off === 8 ? 0.18 : 0.3))
              .bg(t.background),
          );
    if (p.mode === "sequential") {
      const real = lane.nodes.filter(x => !x.ghost);
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
    if (p.loop.enabled) {
      // A dashed arc from the last step back to the first: down the lane's left edge, or
      // under the row when top to bottom. `a` is the depth into the frame's edge, `p` the
      // distance along the steps.
      const real = lane.nodes.filter(x => !x.ghost);
      if (real.length) {
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
    }
    return div()
      .id(`lane-${p.id}`)
      .absolute()
      .left(box.x)
      .top(box.y)
      .w(box.w)
      .h(box.h)
      .rounded(18)
      .bg(alpha(t.foreground, 0.022))
      .border(selected ? 1.5 : 1)
      .border_color(selected ? t.accent : alpha(t.border, 0.55))
      .children(decorations)
      .child(
        v_flex()
          .id(`lane-head-${p.id}`)
          .px(14)
          .gap(5)
          .when(!v, el => el.pt(12))
          .when(v, el =>
            el
              .absolute()
              .left(0)
              .top(0)
              .w(G.headW)
              .h(box.h)
              .justify_center()
              .border_r(1)
              .border_color(alpha(t.border, 0.4)),
          )
          .cursor_pointer()
          .on_click((_e, cx) => this.select(cx, { kind: "phase", id: p.id }))
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(
                div()
                  .font_family(mono())
                  .text_size(10.5)
                  .text_color(t.accent)
                  .child(String(lane.index).padStart(2, "0")),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(13)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(p.title),
              )
              .when(p.loop.enabled, el => el.child(badge(t, `≤${p.loop.max}`, t.ansi5 ?? t.accent, { icon: "repeat", mono: true })))
              .child(badge(t, mode.label, p.mode === "fanout" ? t.accent : t.muted, { icon: MODE_ICON[p.mode] })),
          )
          .child(
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
          ),
      );
  }

  codePane(t) {
    if (!this.codeState) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(10)
        .child(btn(t, "code-open", "Show the code", cx => this.setView(cx, "code"), { icon: "code" }));
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
          .child(icon(this.model ? "eye" : "square-pen", 12, t.dim))
          .child(
            div()
              .text_size(11.5)
              .text_color(t.muted)
              .child(
                this.model
                  ? "Generated from the design. Edit in Design; this view follows every change."
                  : "A hand-written script: edit it here, or ask Claude below to turn it into an editable design.",
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
          .child(CodeView.new(this.codeState).size_full()),
      );
  }

  issueList(t) {
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
          .child(iconBtn(t, "iss-x", "x", cx => ((this.showIssues = false), cx.notify()))),
      )
      .children(
        this.issues.slice(0, 12).map((i, k) =>
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
              this.select(
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

  heroCard(t) {
    const busy = Boolean(this.ai.job);
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
              .border_color(this.focus === "hero" ? t.accent : t.border)
              .shadow_lg()
              .on_drop((ev, cx) => this.addFiles("ai", ev.paths, cx))
              .child(this.input(t, "hero", { multiline: true, size: 14, px: 14, py: 12 }).border(0))
              .child(div().px(10).pb(4).child(this.filesBox(t, "ai")))
              .child(
                h_flex()
                  .px(10)
                  .pt(4)
                  .gap(10)
                  .items_center()
                  .child(div().w(42).text_size(11).text_color(t.dim).child("Agent"))
                  .child(this.agentSwitch(t, "hero", false)),
              )
              .child(
                h_flex()
                  .px(10)
                  .pb(8)
                  .pt(6)
                  .gap(10)
                  .items_center()
                  .child(div().w(42).text_size(11).text_color(t.dim).child("Model"))
                  .child(this.modelField(t, "hero", false))
                  .child(div().flex_1())
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(`reads ${tildify(this.cwd(), home())}`),
                  )
                  .child(
                    busy
                      ? btn(t, "hero-cancel", "Cancel", cx => this.cancelAI(cx), { size: "md", kind: "ghost" })
                      : btn(t, "hero-go", "Generate", cx => this.generate(cx, "hero"), {
                          icon: "sparkles",
                          kind: "primary",
                          kbd: "⌘↵",
                        }),
                  ),
              ),
          )
          .when(busy, el => el.child(this.progress(t)))
          .when(!!this.ai.error, el => el.child(this.aiError(t)))
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
                        this.f.get("hero")?.set_value(ex);
                        this.f.get("hero")?.focus();
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
                          this.open(cx, { model: blankModel(), scope: this.scope, root: this.root });
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

  progress(t) {
    const ev = this.ai.events.slice(-6);
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
              .child(ev.length ? `${this.agentLabel()} is designing the workflow…` : `Starting ${this.agentLabel()}…`),
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

  aiError(t) {
    return h_flex()
      .p(10)
      .gap(8)
      .rounded(10)
      .items_start()
      .bg(alpha(t.blocked, 0.08))
      .border(1)
      .border_color(alpha(t.blocked, 0.35))
      .child(icon("alert", 13, t.blocked))
      .child(div().flex_1().min_w(0).text_size(12).line_height(1.5).text_color(t.blocked).child(this.ai.error))
      .child(iconBtn(t, "ai-err-x", "x", cx => ((this.ai.error = null), cx.notify())));
  }

  composer(t) {
    const busy = Boolean(this.ai.job);
    const open = this.ai.open || busy;
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
            this.ai.open = true;
            this.f.get("ai")?.focus();
            cx.notify();
          })
          .child(icon("sparkles", 14, t.accent))
          .child(
            div()
              .text_size(12.5)
              .text_color(t.muted)
              .child(
                this.model ? `Ask ${this.agentLabel()} to change this workflow` : `Ask ${this.agentLabel()} to turn this script into a design`,
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
        .border_color(busy || this.focus === "ai" ? t.accent : t.border)
        .shadow_lg()
        .on_drop((ev, cx) => this.addFiles("ai", ev.paths, cx))
        .when(busy, el => el.child(this.progress(t)))
        .when(!!this.ai.error, el => el.child(this.aiError(t)))
        .when(this.ai.applied && !busy && !!this.ai.request, el =>
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
                  .child(`Applied: “${clip(this.ai.request, 80)}”`),
              )
              .when(this.history.length > 0, el2 =>
                el2.child(btn(t, "ai-undo", "Undo", cx => this.undo(cx), { size: "sm", kind: "ghost", icon: "undo" })),
              ),
          ),
        )
        .when(!busy, el => el.child(div().px(6).child(this.filesBox(t, "ai", { compact: true }))))
        .child(
          h_flex()
            .gap(8)
            .items_end()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .child(this.input(t, "ai", { multiline: true, size: 13, px: 10, py: 8 }).border(0)),
            )
            .child(
              v_flex()
                .gap(6)
                .pb(2)
                .child(
                  busy
                    ? btn(t, "ai-cancel", "Cancel", cx => this.cancelAI(cx), { kind: "ghost", size: "sm" })
                    : btn(t, "ai-go", "", cx => this.generate(cx), {
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
            .child(this.agentSwitch(t, "ai", true))
            .child(this.modelField(t, "ai", true))
            .child(
              iconBtn(t, "ai-min", "chevron-down", cx => ((this.ai.open = false), cx.notify()), "Hide", {
                disabled: busy,
              }),
            ),
        ),
    );
  }

  runCard(t) {
    const m = this.model;
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
              .child(iconBtn(t, "run-x", "x", cx => ((this.runSheet = false), cx.notify()))),
          )
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(
                `Opens a Claude Code tab in ${tildify(this.cwd(), home())} and starts the workflow with these arguments.`,
              ),
          )
          .children(m.args.map(a => field(t, a.name, this.input(t, `run:${a.name}`), { hint: a.description })))
          .child(
            h_flex()
              .gap(8)
              .justify_end()
              .child(btn(t, "run-cancel", "Cancel", cx => ((this.runSheet = false), cx.notify()), { kind: "ghost" }))
              .child(
                btn(
                  t,
                  "run-go",
                  this.dirty() ? "Save and run" : "Run",
                  cx => {
                    const args = {};
                    for (const a of m.args) args[a.name] = this.f.get(`run:${a.name}`)?.value() ?? "";
                    this.launch(cx, args);
                  },
                  { kind: "primary", icon: "play" },
                ),
              ),
          ),
      );
  }

  // ---- inspector

  inspector(t) {
    const sel = this.sel;
    let body;
    if (sel.kind === "phase")
      body = this.phasePanel(
        t,
        this.model.phases.find(p => p.id === sel.id),
      );
    else if (sel.kind === "step") body = this.stepPanel(t, findStep(this.model, sel.id));
    else body = this.workflowPanel(t);
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

  title(t, kicker, text, actions = []) {
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

  workflowPanel(t) {
    const m = this.model;
    const allSteps = m.phases.flatMap(p => p.steps);
    return v_flex()
      .child(this.title(t, "WORKFLOW", m.name))
      .child(
        section(t, "Identity", [
          field(t, "Name", this.input(t, "wf:name", { mono: true }), { hint: `run as /${m.name}` }),
          field(t, "Description", this.input(t, "wf:description", { multiline: true })),
          field(t, "When to use", this.input(t, "wf:whenToUse", { multiline: true }), { hint: "helps Claude pick it" }),
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
                              .child(this.input(t, `arg:${i}:name`, { mono: true, h: 28 })),
                          )
                          .child(
                            iconBtn(
                              t,
                              `arg-del-${i}`,
                              "trash",
                              cx => this.commit(cx, mm => mm.args.splice(i, 1)),
                              "Remove",
                              { danger: true },
                            ),
                          ),
                      )
                      .child(this.input(t, `arg:${i}:description`, { h: 28 }))
                      .child(this.input(t, `arg:${i}:example`, { h: 28, mono: true }))
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
              this.commit(cx, mm => mm.args.push({ name: `arg${mm.args.length + 1}`, description: "", example: "" })),
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
              this.commit(cx, mm => (mm.defaults.model = id)),
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
              (id, cx) => this.commit(cx, mm => (mm.defaults.effort = id)),
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
              (id, cx) => this.commit(cx, mm => (mm.result = id)),
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

  phasePanel(t, p) {
    if (!p) return null;
    const i = this.model.phases.indexOf(p);
    const sources = sourceChoices(this.model, p.id);
    return v_flex()
      .child(
        this.title(t, `PHASE ${String(i + 1).padStart(2, "0")}`, p.title, [
          iconBtn(t, "ph-left", "arrow-left", cx => this.movePhase(cx, p.id, -1), "Move earlier", {
            disabled: i === 0,
          }),
          iconBtn(t, "ph-right", "arrow-right", cx => this.movePhase(cx, p.id, 1), "Move later", {
            disabled: i === this.model.phases.length - 1,
          }),
          iconBtn(t, "ph-del", "trash", cx => this.deletePhase(cx, p.id), "Delete phase", { danger: true }),
        ]),
      )
      .child(
        section(t, "Phase", [
          field(t, "Title", this.input(t, `phase:${p.id}:title`)),
          field(t, "Detail", this.input(t, `phase:${p.id}:detail`), { hint: "shown under the title while it runs" }),
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
                  .on_click((_e, cx) =>
                    this.commit(cx, mm => {
                      const ph = mm.phases.find(x => x.id === p.id);
                      ph.mode = md.id;
                      if (md.id === "fanout" && !ph.source) ph.source = sourceChoices(mm, ph.id)[0] ?? "";
                    }),
                  )
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
      .child(this.loopSection(t, p))
      .when(p.mode === "fanout", el =>
        el.child(
          section(
            t,
            "Iterate over",
            [
              field(t, "List", this.input(t, `phase:${p.id}:source`, { mono: true }), {
                hint: "an array from an earlier step, or an arg",
              }),
              sources.length
                ? chips(
                    t,
                    `src-${p.id}`,
                    sources.map(s => ({ id: s, label: s })),
                    p.source,
                    (id, cx) => {
                      this.commit(cx, mm => (mm.phases.find(x => x.id === p.id).source = id));
                    },
                  )
                : div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child("Give an earlier step structured output with a list field (object[] or string[])."),
              field(t, "Item key", this.input(t, `phase:${p.id}:itemKey`, { mono: true }), {
                hint: "field used in labels: impl:<key>",
              }),
            ],
            { last: true },
          ),
        ),
      );
  }

  loopSection(t, p) {
    const L = p.loop;
    const set = fn => cx => this.commit(cx, mm => fn(mm.phases.find(x => x.id === p.id).loop));
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
        body.push(field(t, "Value", this.input(t, `phase:${p.id}:untilValue`, { mono: true })));
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

  stepPanel(t, where) {
    if (!where) return null;
    const { step: s, phase: p } = where;
    const k = `step:${s.id}`;
    const i = p.steps.indexOf(s);
    const refs = refChoices(this.model, s.id);
    const used = new Set(refsIn(s.prompt));
    const fanout = p.mode === "fanout";
    return v_flex()
      .child(
        this.title(t, `${p.title.toUpperCase()} · ${fanout ? `STAGE ${i + 1}` : `STEP ${i + 1}`}`, s.label, [
          iconBtn(t, "st-up", "arrow-up", cx => this.moveStep(cx, s.id, -1), "Move up", { disabled: i === 0 }),
          iconBtn(t, "st-down", "arrow-down", cx => this.moveStep(cx, s.id, 1), "Move down", {
            disabled: i === p.steps.length - 1,
          }),
          iconBtn(t, "st-dup", "copy", cx => this.duplicateStep(cx, s.id), "Duplicate"),
          iconBtn(t, "st-del", "trash", cx => this.deleteStep(cx, s.id), "Delete step", { danger: true }),
        ]),
      )
      .when(p.loop.enabled, el =>
        el.child(
          section(t, "Runs in", [
            seg(t, "st-when", WHENS, s.when, (id, cx) => this.setStep(cx, s.id, x => (x.when = id)), { size: "sm" }),
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
                .child(field(t, "Label", this.input(t, `${k}:label`), { hint: fanout ? `${s.label}:<key>` : null })),
            )
            .child(
              div()
                .w(140)
                .child(field(t, "Id", this.input(t, `${k}:id`, { mono: true }))),
            ),
        ]),
      )
      .child(
        section(t, "Prompt", [
          this.input(t, `${k}:prompt`, { multiline: true, size: 12.5 }),
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
                          .on_click((_e, cx) => this.insertRef(r.ref, cx))
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
          this.filesBox(t, "step"),
          div().text_size(11).text_color(t.dim).child("Listed under the prompt as files to read first; repo files are stored relative to the repository, so every worktree finds them."),
        ]),
      )
      .child(
        section(t, "Agent", [
          field(
            t,
            "Model",
            chips(t, "st-model", MODELS, s.model, (id, cx) => this.setStep(cx, s.id, x => (x.model = id))),
            {
              hint: this.model.defaults.model ? `default: ${this.model.defaults.model}` : "inherits the session's",
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
              (id, cx) => this.setStep(cx, s.id, x => (x.effort = id)),
            ),
          ),
          field(t, "Agent type", this.input(t, `${k}:agentType`, { mono: true }), {
            right: chips(
              t,
              "st-atype",
              AGENT_TYPES.filter(Boolean).map(a => ({ id: a, label: a })),
              s.agentType,
              (id, cx) => {
                this.setStep(cx, s.id, x => (x.agentType = x.agentType === id ? "" : id));
              },
            ),
          }),
          toggle(
            t,
            "st-iso",
            s.isolation,
            (v, cx) => this.setStep(cx, s.id, x => (x.isolation = v)),
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
              stepper(t, "st-repeat", s.repeat, 1, 32, (v, cx) => this.setStep(cx, s.id, x => (x.repeat = v)), "×"),
            ),
        ]),
      )
      .child(this.outputSection(t, s, k))
      .when(this.model.phases.length > 1, el =>
        el.child(
          section(
            t,
            "Phase",
            [
              chips(
                t,
                "st-phase",
                this.model.phases.map(x => ({ id: x.id, label: x.title })),
                p.id,
                (id, cx) => id !== p.id && this.moveStepTo(cx, s.id, id),
              ),
            ],
            { last: true },
          ),
        ),
      );
  }

  outputSection(t, s, k) {
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
          this.setStep(cx, s.id, x => {
            x.output.kind = id;
            if (id === "schema" && !x.output.fields.length)
              x.output.fields.push({ name: "summary", type: "string", description: "", required: true });
          }),
        { size: "sm" },
      ),
    ];
    if (s.output.kind === "text")
      body.push(div().text_size(11).text_color(t.dim).child("The agent's final message, as a string."));
    if (s.output.kind === "raw") body.push(this.input(t, `${k}:raw`, { multiline: true, mono: true, size: 11.5 }));
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
                        .child(this.input(t, `${k}:f:${i}:name`, { mono: true, h: 28 })),
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
                          this.setStep(cx, s.id, x => (x.output.fields[i].required = !x.output.fields[i].required)),
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
                        cx => this.setStep(cx, s.id, x => x.output.fields.splice(i, 1)),
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
                    (id, cx) => this.setStep(cx, s.id, x => (x.output.fields[i].type = id)),
                  ),
                )
                .child(this.input(t, `${k}:f:${i}:description`, { h: 28 })),
            ),
          ),
      );
      body.push(
        btn(
          t,
          "fd-add",
          "Add field",
          cx =>
            this.setStep(cx, s.id, x =>
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
}
