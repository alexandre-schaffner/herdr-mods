// Loops (Org > Loops): each agent's loop, live and editable. The master always loops; a manager
// loops once it's armed here. Left, every agent with its loop's state; right, the selected one's
// loop: what it's doing now, its steps (a stepper that is also the editor), its heartbeat, what
// wakes it, and what its recent ticks cost. Edits save themselves and apply from the next tick.
// The machine side is `hq loops` / `hq loop …` (hq.py).

import { h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { agentMark, ago, alpha, btn, chip, clip, clock, compact, empty, frame, icon, inkOn, inTime, kbd, lines, linkBtn, mono, ok, onTint, plain, row, scrollY, sectionHead, segmented, SP, stamp, statusBadge, statusGlyph, tint, tone, TYPE } from "./ui.js";

const POLL_MS = 4000;
const SAVE_MS = 800; // typing settles this long before it's saved
const UNDO_MS = 8000;
const LIST_W = 272;
const HOLD_MS = 3000; // after a loop command lands, its buttons stay off this long: no double sends

const CADENCE = [
  { id: "every", label: "Every tick", icon: "repeat" },
  { id: "news", label: "When something changed", icon: "sparkles" },
  { id: "interval", label: "Every N minutes", icon: "clock" },
];
const HEARTBEATS = [
  { id: "900", label: "15m" },
  { id: "1800", label: "30m" },
  { id: "3600", label: "1h" },
  { id: "7200", label: "2h" },
  { id: "custom", label: "Custom" },
];
const TRIGGERS = {
  heartbeat: { icon: "clock", label: "Heartbeat" },
  hq: { icon: "bolt", label: "HQ woke it" },
  person: { icon: "user", label: "You" },
  start: { icon: "play", label: "Start" },
  scheduled: { icon: "repeat", label: "Cron" },
};
// What each loop command reports once it lands, and its headline when it doesn't.
const SENT = { unwatch: "Watch stopped", arm: "Loop started", run: "Tick requested", pause: "Pause requested", resume: "Loop resumed", absorb: "Folded into the loop", reset: "Defaults restored" };
const NOT_SENT = { unwatch: "Watch not stopped", arm: "Loop not started", run: "Tick not started", pause: "Not paused", resume: "Not resumed", absorb: "Not folded in", reset: "Not reset" };
const EVERY = [
  { id: "15", label: "15m" },
  { id: "30", label: "30m" },
  { id: "60", label: "1h" },
  { id: "120", label: "2h" },
];
const WAKES = [
  { key: "mail", title: "Urgent mail", hint: "A manager flags a message, or Jev judges it can't wait for the heartbeat." },
  { key: "steering", title: "Your steering", hint: "You add a note to a next move, or edit the standing orders or the approval policy." },
  { key: "gone", title: "A manager's session is gone", hint: "So the master can relaunch it or hand its work to someone else." },
  { key: "waiting", title: "A manager stopped to wait", hint: "Jev reads an idle manager's last message and spots a question, a block or a hand-off." },
];

const cadenceOf = s => CADENCE.find(c => c.id === s.when) ?? CADENCE[1];
const cadenceShort = s => (s.when === "every" ? "every tick" : s.when === "interval" ? `every ${s.everyMin ?? 30}m` : "on news");
const clone = x => JSON.parse(JSON.stringify(x));
const slug = s => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "step";
const isTyping = key => key === "title" || key === "body" || key === "every" || key === "hb";

/** A span of time with seconds where they matter: "42s", "2m 10s", "1h 5m". */
function span(ms) {
  if (ms == null || ms < 0) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Minutes as the person would say them: "45 min", "1 h", "1 h 30". */
function minutes(sec) {
  const m = Math.round((sec ?? 0) / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`;
}

/** A loop's state as a glyph, a word and its color: never the color alone. */
function loopLook(state, t, size = 13, still = false) {
  const tn = tone(t);
  switch (state) {
    case "running":
      return { label: "Ticking", color: t.working, glyph: statusGlyph("working", t, size, { still }) };
    case "waiting":
      return { label: "Waiting", color: t.muted, glyph: icon("repeat", size, t.muted) };
    case "overdue":
      return { label: "Overdue", color: tn.warn, glyph: icon("alert", size, tn.warn) };
    case "paused":
      return { label: "Paused", color: t.muted, glyph: icon("pause", size, t.muted) };
    case "watching":
      return { label: "Watching", color: t.accent, glyph: icon("eye", size, t.accent) };
    case "stopped":
      return { label: "Stopped", color: t.dim, glyph: icon("square", size, t.dim) };
    case "gone":
      return { label: "Gone", color: t.blocked, glyph: icon("x", size, t.blocked) };
    default:
      return { label: "Off", color: t.dim, glyph: div().flex_none().w(size).h(size).rounded_full().border(1.5).border_dashed().border_color(t.dim) };
  }
}

/** The small switch the Prompts view uses, sized for a row. */
function toggle(t, id, on, onChange, o = {}) {
  return div()
    .id(id)
    .flex_none()
    .w(28)
    .h(16)
    .rounded_full()
    .relative()
    .bg(on ? t.accent : alpha(t.foreground, 0.15))
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .when(!!o.disabled, el => el.opacity(0.4))
    .when(!o.disabled, el =>
      el
        .cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => onChange(!on, cx)),
    )
    .child(div().absolute().top(2).left(on ? 14 : 2).transition("left", { duration: 140, easing: "ease-out" }).w(12).h(12).rounded_full().bg("#ffffff").shadow_sm());
}

export class LoopsView {
  constructor(app) {
    this.app = app;
    this.data = null; // `hq loops`
    this.error = null;
    this.loadingNow = false;
    this.timer = false;
    this.sel = localStorage.getItem("loops.sel") || "master";
    this.zone = "agents"; // where ↑/↓ move: "agents" | "steps"
    this.cursor = null; // the step the keyboard is on
    this.hover = null; // the step under the pointer (shows its row controls)
    this.open = null; // { agent, step } being edited in place
    this.drafts = new Map(); // agent -> { def, dirty, saving, error, conflict }
    this.savedAt = {};
    this.saveTask = null;
    this.undo = null; // { agent, step, index, at }
    this.drag = null; // { agent, id, over, after }
    this.histOpen = null;
    this.confirmReset = null;
    this.customHb = false;
    this.inflight = {}; // agent -> { verb, sending, until, note }: one loop command at a time
    this.absorbEvery = {}; // job key -> minutes picked for "Fold into loop"
    this.focusKey = null;
    this.syncing = false;

    this.titleIn = InputState.new({ placeholder: "What this step does, in a few words" });
    this.bodyIn = TextareaState.new({ placeholder: "The instruction the agent follows at this step. Markdown is fine.", rows: 3 });
    this.bodyIn.set_auto_grow(3, 14);
    this.everyIn = InputState.new({ placeholder: "30" });
    this.hbIn = InputState.new({ placeholder: "60" });
    for (const [key, st] of [["title", this.titleIn], ["body", this.bodyIn], ["every", this.everyIn], ["hb", this.hbIn]]) {
      st.on("focus", (_e, cx) => ((this.focusKey = key), cx.notify()));
      st.on("blur", (_e, cx) => {
        if (this.focusKey === key) this.focusKey = null;
        cx.notify();
      });
      st.on("change", (_e, cx) => this.onField(key, cx));
    }
    this.titleIn.on("submit", () => this.bodyIn.focus());
    this.bodyIn.on("submit", (e, cx) => e.secondary && this.closeEditor(cx));
    this.everyIn.on("submit", (_e, cx) => this.closeEditor(cx));
    this.hbIn.on("submit", () => this.app.h.focus());
  }

  // ---- the host's hooks

  typing() {
    return !!this.focusKey;
  }

  onShow(cx, arg) {
    if (arg?.agent) this.select(arg.agent, cx);
    this.ensureTimer(cx);
    this.load(cx);
  }

  onHide(cx) {
    this.flush(cx);
  }

  ensureTimer(cx) {
    if (this.timer) return;
    this.timer = true;
    cx.timer.every(POLL_MS, cx => {
      if (this.app.view === "loops") this.load(cx);
    });
  }

  load(cx) {
    if (this.loadingNow) return;
    this.loadingNow = true;
    cx.spawn(async cx => {
      try {
        const r = await this.app.hq(["loops"]);
        this.data = r;
        this.error = null;
        // A draft that's saved and quiet gives way to what the agent's loop now is.
        for (const [id, d] of this.drafts) if (!d.dirty && !d.saving && !d.conflict) this.drafts.delete(id);
        const list = this.agents();
        if (list.length && !list.some(a => a.agent === this.sel)) this.sel = list[0].agent;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loadingNow = false;
      cx.notify();
    });
  }

  // ---- reading

  /** The master, then agents whose loop runs, then the rest. */
  agents() {
    const all = this.data?.agents ?? [];
    const on = a => !["unarmed", "stopped", "gone"].includes(a.live?.state);
    return [...all.filter(a => a.agent === "master"), ...all.filter(a => a.agent !== "master" && on(a)), ...all.filter(a => a.agent !== "master" && !on(a))];
  }

  agent(id = this.sel) {
    return (this.data?.agents ?? []).find(a => a.agent === id) ?? null;
  }

  def(a) {
    return this.drafts.get(a.agent)?.def ?? a.loop ?? { steps: [], heartbeatSec: 3600, rev: 0 };
  }

  step(a, id) {
    return this.def(a).steps.find(s => s.id === id) ?? null;
  }

  /** The indices a step may move between: not past a locked first or last step. */
  bounds(steps) {
    return { lo: steps[0]?.locked ? 1 : 0, hi: steps.at(-1)?.locked ? steps.length - 2 : steps.length - 1 };
  }

  running(a) {
    return a.live?.state === "running" && !!a.live?.tick && !a.live.tick.endedAt;
  }

  /** "step 2/6": the current step's place among the steps this tick runs. */
  progress(a) {
    const tick = a.live?.tick;
    if (!tick) return null;
    const ran = this.def(a).steps.filter(s => s.on !== false && (tick.steps?.[s.id] ?? "pending") !== "skipped");
    const i = ran.findIndex(s => s.id === tick.current);
    return i < 0 ? null : { n: i + 1, of: ran.length, step: ran[i] };
  }

  // ---- editing: every change lands in a draft that saves itself

  edit(a, fn, cx, ms = SAVE_MS) {
    let d = this.drafts.get(a.agent);
    if (!d) {
      d = { def: clone(a.loop ?? { agent: a.agent, steps: [], heartbeatSec: 3600, rev: 0 }), dirty: false, saving: false, error: null, conflict: false };
      this.drafts.set(a.agent, d);
    }
    fn(d.def);
    d.dirty = true;
    d.error = null;
    this.scheduleSave(cx, ms);
    cx.notify();
  }

  scheduleSave(cx, ms) {
    this.saveTask?.cancel();
    this.saveTask = cx.timer.after(ms, cx => this.flush(cx));
  }

  flush(cx) {
    this.saveTask?.cancel();
    this.saveTask = null;
    for (const [id, d] of this.drafts) if (d.dirty && !d.saving && !d.conflict) this.save(id, cx);
  }

  /** What's sent: empty new steps dropped, an untitled one named. */
  clean(def) {
    return {
      ...def,
      steps: def.steps
        .filter(s => s.locked || (s.title ?? "").trim() || (s.body ?? "").trim())
        .map(s => ({ ...s, title: (s.title ?? "").trim() || "Untitled step" })),
    };
  }

  save(agentId, cx) {
    const d = this.drafts.get(agentId);
    if (!d) return;
    const payload = this.clean(d.def);
    d.saving = true;
    d.dirty = false;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await this.app.hq(["loop", "save", agentId, "--json", JSON.stringify(payload)]);
        const rev = r.loop?.rev ?? r.rev ?? (payload.rev ?? 0) + 1;
        d.saving = false;
        this.savedAt[agentId] = Date.now();
        const a = this.agent(agentId);
        if (a) a.loop = { ...(r.loop ?? payload), rev, updatedAt: r.loop?.updatedAt ?? Date.now() };
        if (d.dirty) d.def.rev = rev; // edited while it saved: the next save carries on from here
        else this.drafts.delete(agentId);
      } catch (e) {
        const msg = String(e?.message ?? e);
        d.saving = false;
        d.dirty = true;
        if (/^stale/i.test(msg)) d.conflict = true;
        else d.error = msg;
        this.load(cx);
      }
      cx.notify();
    });
  }

  /** After a conflict: save the person's version over the newer one. */
  keepMine(a, cx) {
    const d = this.drafts.get(a.agent);
    if (!d) return;
    d.def.rev = a.loop?.rev ?? d.def.rev;
    d.conflict = false;
    this.save(a.agent, cx);
  }

  useTheirs(a, cx) {
    this.drafts.delete(a.agent);
    this.open = null;
    cx.notify();
  }

  toggleStep(a, id, cx) {
    const s = this.step(a, id);
    if (!s || s.locked) return;
    this.edit(a, def => (def.steps.find(x => x.id === id).on = s.on === false), cx, 150);
  }

  setCadence(a, id, when, cx) {
    this.edit(a, def => {
      const s = def.steps.find(x => x.id === id);
      s.when = when;
      if (when === "interval") s.everyMin = s.everyMin ?? 30;
    }, cx, 150);
    if (this.open?.step === id) this.syncInputs(a);
  }

  cycleCadence(a, id, cx) {
    const s = this.step(a, id);
    if (!s || s.locked) return;
    const i = CADENCE.findIndex(c => c.id === (s.when ?? "news"));
    this.setCadence(a, id, CADENCE[(i + 1) % CADENCE.length].id, cx);
  }

  move(a, id, delta, cx) {
    const steps = this.def(a).steps;
    const i = steps.findIndex(s => s.id === id);
    const { lo, hi } = this.bounds(steps);
    const j = i + delta;
    if (i < 0 || steps[i].locked || j < lo || j > hi) return;
    this.edit(a, def => {
      const [s] = def.steps.splice(i, 1);
      def.steps.splice(j, 0, s);
    }, cx, 150);
  }

  /** A drop: `id` goes before or after `target`, inside the movable range. */
  moveTo(a, id, target, after, cx) {
    if (id === target) return;
    this.edit(a, def => {
      const from = def.steps.findIndex(s => s.id === id);
      if (from < 0 || def.steps[from].locked) return;
      const [s] = def.steps.splice(from, 1);
      let to = def.steps.findIndex(x => x.id === target) + (after ? 1 : 0);
      const { lo, hi } = this.bounds(def.steps);
      to = Math.max(lo, Math.min(hi + 1, to));
      def.steps.splice(to, 0, s);
    }, cx, 150);
  }

  remove(a, id, cx) {
    const steps = this.def(a).steps;
    const index = steps.findIndex(s => s.id === id);
    if (index < 0 || steps[index].locked) return;
    const s = steps[index];
    if (this.open?.step === id) this.open = null;
    this.edit(a, def => def.steps.splice(index, 1), cx, 150);
    const fresh = !(s.title ?? "").trim() && !(s.body ?? "").trim();
    if (fresh) return; // an empty new step just goes
    const at = Date.now();
    this.undo = { agent: a.agent, step: s, index, at };
    const left = this.def(a).steps;
    this.cursor = left[Math.min(index, left.length - 1)]?.id ?? null;
    cx.timer.after(UNDO_MS, cx => {
      if (this.undo?.at === at) {
        this.undo = null;
        cx.notify();
      }
    });
  }

  undoRemove(cx) {
    const u = this.undo;
    const a = u && this.agent(u.agent);
    if (!a) return;
    this.undo = null;
    this.edit(a, def => def.steps.splice(Math.min(u.index, def.steps.length), 0, u.step), cx, 150);
    this.cursor = u.step.id;
  }

  /** A new step after `afterId` (or before the locked last one), open for typing. */
  add(a, afterId, cx) {
    const steps = this.def(a).steps;
    const { lo, hi } = this.bounds(steps);
    const at = steps.findIndex(s => s.id === afterId);
    const index = Math.max(lo, Math.min(hi + 1, at < 0 ? hi + 1 : at + 1));
    const s = { id: `${slug("step")}-${Math.random().toString(36).slice(2, 7)}`, title: "", body: "", when: "news", everyMin: null, on: true, locked: false };
    this.edit(a, def => def.steps.splice(index, 0, s), cx, SAVE_MS * 4);
    this.zone = "steps";
    this.cursor = s.id;
    this.openEditor(a, s.id, cx);
  }

  openEditor(a, id, cx) {
    const s = this.step(a, id);
    if (!s) return;
    this.open = { agent: a.agent, step: id };
    this.cursor = id;
    this.zone = "steps";
    this.syncInputs(a);
    if (s.locked) this.bodyIn.focus();
    else this.titleIn.focus();
    cx.notify();
  }

  syncInputs(a) {
    const s = this.open && this.step(a, this.open.step);
    if (!s) return;
    this.syncing = true;
    try {
      if (this.titleIn.value() !== (s.title ?? "")) this.titleIn.set_value(s.title ?? "");
      if (this.bodyIn.value() !== (s.body ?? "")) this.bodyIn.set_value(s.body ?? "");
      this.everyIn.set_value(String(s.everyMin ?? 30));
    } finally {
      this.syncing = false;
    }
  }

  closeEditor(cx) {
    const o = this.open;
    this.open = null;
    const a = o && this.agent(o.agent);
    const s = a && this.step(a, o.step);
    if (s && !s.locked && !(s.title ?? "").trim() && !(s.body ?? "").trim()) this.remove(a, s.id, cx);
    this.app.h.focus();
    this.flush(cx);
    cx.notify();
  }

  onField(key, cx) {
    if (this.syncing) return;
    const a = this.agent();
    if (!a) return;
    if (key === "hb") {
      const m = Number.parseInt(this.hbIn.value(), 10);
      if (m >= 1 && m <= 1440) this.edit(a, def => (def.heartbeatSec = m * 60), cx);
      return;
    }
    const id = this.open?.agent === a.agent ? this.open.step : null;
    if (!id) return;
    if (key === "every") {
      const m = Number.parseInt(this.everyIn.value(), 10);
      if (m >= 1 && m <= 1440) this.edit(a, def => (def.steps.find(s => s.id === id).everyMin = m), cx);
      return;
    }
    const value = key === "title" ? this.titleIn.value() : this.bodyIn.value();
    const s = this.step(a, id);
    if (!s || (key === "title" && s.locked) || (s[key] ?? "") === value) return;
    this.edit(a, def => (def.steps.find(x => x.id === id)[key] = value), cx);
  }

  setHeartbeat(a, id, cx) {
    if (id === "custom") {
      this.customHb = true;
      this.syncing = true;
      this.hbIn.set_value(String(Math.round((this.def(a).heartbeatSec ?? 3600) / 60)));
      this.syncing = false;
      this.hbIn.focus();
      cx.notify();
      return;
    }
    this.customHb = false;
    this.edit(a, def => (def.heartbeatSec = Number(id)), cx, 150);
  }

  setWake(a, key, on, cx) {
    this.edit(a, def => (def.wake = { ...(def.wake ?? {}), [key]: on }), cx, 150);
  }

  // ---- acting on the agent

  /** One loop command for an agent, never two at once: while one is on its way, and for a few
   *  seconds after it lands, every loop action of that agent is off (buttons and keys). What
   *  the backend declines (already looping, sent moments ago, mid-tick) is a calm notice. */
  act(a, verb, cx, extra = []) {
    if (this.locked(a)) return;
    if (verb === "reset") {
      this.drafts.delete(a.agent);
      this.open = null;
    }
    this.inflight[a.agent] = { verb, sending: true, until: 0, note: "Sending…" };
    cx.notify();
    cx.spawn(async cx => {
      let note = SENT[verb];
      let failed = false;
      try {
        const r = await this.app.hq(["loop", verb, a.agent, ...extra]);
        if ((verb === "arm" || verb === "resume") && r.typed === false) {
          note = verb === "resume" ? "Pause cleared" : "Already looping";
          if (r.why) this.app.say({ title: note, body: r.why, level: "info", timeout: 5000 });
        } else if (verb === "absorb" && r.sent === false) {
          note = "Step added";
          this.app.say({ title: "Step added; the job wasn't removed", body: r.why ?? "Ask the agent to delete the job.", level: "info", timeout: 6000 });
        }
      } catch (e) {
        failed = true;
        note = NOT_SENT[verb];
        this.app.say({ title: NOT_SENT[verb], body: String(e?.message ?? e), level: "warning", timeout: 6000 });
      }
      this.inflight[a.agent] = { verb, sending: false, until: Date.now() + HOLD_MS, note, failed };
      cx.timer.after(HOLD_MS + 100, cx => cx.notify());
      this.load(cx);
      this.app.refresh(cx);
      cx.notify();
    });
  }

  /** Whether a loop command for this agent is on its way, or landed moments ago. */
  locked(a) {
    const f = this.inflight[a.agent];
    return !!f && (f.sending || Date.now() < f.until);
  }

  armReset(a, cx) {
    if (this.confirmReset === a.agent) {
      this.confirmReset = null;
      this.act(a, "reset", cx);
      return;
    }
    this.confirmReset = a.agent;
    cx.timer.after(4000, cx => {
      if (this.confirmReset === a.agent) {
        this.confirmReset = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  /** The one action the agent's state calls for: arm, resume or run. */
  primary(a, cx) {
    const st = a.live?.state;
    if (st === "unarmed" || st === "stopped" || st === "overdue" || st === "watching") return this.act(a, "arm", cx);
    if (st === "paused") return this.act(a, "resume", cx);
    if (st === "waiting") return this.act(a, "run", cx);
  }

  // ---- keys

  select(id, cx) {
    if (id === this.sel) return;
    this.flush(cx);
    this.sel = id;
    localStorage.setItem("loops.sel", id);
    this.open = null;
    this.cursor = null;
    this.customHb = false;
    this.confirmReset = null;
    this.histOpen = null;
    cx.notify();
  }

  /** Keys the host would otherwise keep from a view: with modifiers, or while a field types. */
  onKeyFirst(e, cx) {
    const m = e.modifiers ?? {};
    const a = this.agent();
    if (this.drag && e.key === "escape") return (this.drag = null), cx.notify(), true;
    if (m.platform && e.key === "s") return this.flush(cx), cx.notify(), true;
    if (isTyping(this.focusKey)) {
      if (e.key === "escape" || (m.platform && e.key === "enter")) {
        if (this.focusKey === "hb") return this.app.h.focus(), (this.customHb = false), cx.notify(), true;
        return this.closeEditor(cx), true;
      }
      return false;
    }
    if (m.alt && !m.platform && !m.control && a && this.zone === "steps" && this.cursor) {
      if (e.key === "up") return this.move(a, this.cursor, -1, cx), true;
      if (e.key === "down") return this.move(a, this.cursor, 1, cx), true;
    }
    return false;
  }

  onKey(e, cx) {
    const a = this.agent();
    const k = e.key;
    if (k === "escape" && this.open) return this.closeEditor(cx), true;
    if (this.zone === "agents") {
      const list = this.agents();
      const i = list.findIndex(x => x.agent === this.sel);
      if (k === "down" || k === "j") return this.select(list[Math.min(list.length - 1, i + 1)]?.agent ?? this.sel, cx), true;
      if (k === "up" || k === "k") return this.select(list[Math.max(0, i - 1)]?.agent ?? this.sel, cx), true;
      if ((k === "right" || k === "enter") && a) {
        this.zone = "steps";
        this.cursor = this.cursor ?? this.def(a).steps[0]?.id ?? null;
        cx.notify();
        return true;
      }
    } else if (a) {
      const steps = this.def(a).steps;
      const i = steps.findIndex(s => s.id === this.cursor);
      if (k === "down" || k === "j") return (this.cursor = steps[Math.min(steps.length - 1, i + 1)]?.id ?? this.cursor), cx.notify(), true;
      if (k === "up" || k === "k") return (this.cursor = steps[Math.max(0, i - 1)]?.id ?? this.cursor), cx.notify(), true;
      if (k === "left" || k === "escape") return (this.zone = "agents"), cx.notify(), true;
      const s = steps[i];
      if (k === "enter" && s) return this.openEditor(a, s.id, cx), true;
      if ((k === "space" || k === " ") && s) return this.toggleStep(a, s.id, cx), true;
      if (k === "s" && s) return this.cycleCadence(a, s.id, cx), true;
      if (k === "n") return this.add(a, s?.id, cx), true;
      if ((k === "backspace" || k === "delete" || k === "x") && s) return this.remove(a, s.id, cx), true;
    }
    if (k === "u" && this.undo) return this.undoRemove(cx), true;
    if (!a) return false;
    if (k === "r" || k === "p") {
      // A held key repeats: loop commands go once per press, and never while one is on its way.
      if (e.is_held || this.locked(a)) return true;
      const st = a.live?.state;
      if (k === "r" && (st === "waiting" || st === "paused")) this.act(a, "run", cx);
      if (k === "p" && st === "paused") this.act(a, "resume", cx);
      else if (k === "p" && (st === "unarmed" || st === "stopped" || st === "overdue" || st === "watching")) this.act(a, "arm", cx);
      else if (k === "p" && (st === "waiting" || st === "running")) this.act(a, "pause", cx);
      return true;
    }
    return false;
  }

  // ---- drawing

  render(t, cx) {
    if (!this.data && !this.error) return this.skeleton(t);
    const list = this.agents();
    const a = this.agent();
    return row()
      .id("loops-root")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) {
          this.drag = null;
          cx.notify();
        }
      })
      .child(this.list(t, list))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .min_h(0)
          .when(!!this.error, el =>
            el.child(
              h_flex()
                .flex_none()
                .mx(SP.lg)
                .mt(SP.md)
                .px(SP.md)
                .py(SP.sm)
                .gap(SP.sm)
                .items_center()
                .rounded(8)
                .bg(alpha(t.blocked, 0.08))
                .border(1)
                .border_color(alpha(t.blocked, 0.3))
                .child(icon("alert", 13, t.blocked))
                .child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(t.foreground).child(`Couldn't read the loops: ${this.error}`))
                .child(btn(t, "lp-retry", "Try again", cx => this.load(cx), { size: "sm" })),
            ),
          )
          .child(
            a
              ? this.detail(t, a, cx)
              : empty(t, "No agents yet", "Start the master from the status strip. Its loop shows here, and so does every manager you give one.", { icon: "repeat" }),
          ),
      );
  }

  skeleton(t) {
    const bar = (w, h = 10) => div().w(w).h(h).rounded(4).bg(alpha(t.foreground, 0.06));
    return row()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_none()
          .w(LIST_W)
          .p(SP.md)
          .gap(SP.lg)
          .border_r(1)
          .border_color(t.border)
          .children([0, 1, 2, 3].map(i => h_flex().gap(SP.sm).items_center().child(div().w(14).h(14).rounded_full().bg(alpha(t.foreground, 0.06))).child(v_flex().gap(5).child(bar(110 - i * 12)).child(bar(150 - i * 8, 8))))),
      )
      .child(
        v_flex()
          .flex_1()
          .p(SP.xl)
          .gap(SP.lg)
          .child(bar(180, 18))
          .child(bar(320))
          .child(div().h(SP.lg))
          .children([0, 1, 2, 3, 4].map(i => h_flex().gap(SP.md).items_center().child(div().w(22).h(22).rounded_full().bg(alpha(t.foreground, 0.06))).child(bar(260 - i * 20, 12)))),
      );
  }

  // ---- the agents

  list(t, list) {
    const looping = list.filter(a => a.agent === "master" || !["unarmed", "stopped", "gone"].includes(a.live?.state));
    const idle = list.filter(a => !looping.includes(a));
    const running = list.filter(a => this.running(a)).length;
    const focus = this.zone === "agents";
    return v_flex()
      .flex_none()
      .w(LIST_W)
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .flex_none()
          .h(44)
          .px(SP.lg)
          .gap(SP.sm)
          .items_center()
          .border_b(1)
          .border_color(alpha(t.border, 0.7))
          .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Loops"))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(running ? `${running} ticking` : `${looping.length} looping`)),
      )
      .child(
        scrollY(
          "lp-agents",
          v_flex()
            .py(SP.sm)
            .gap(1)
            .children(looping.map(a => this.agentRow(t, a, focus)))
            .when(idle.length > 0, el =>
              el
                .child(div().px(SP.lg).pt(SP.md).pb(4).text_size(TYPE.meta).font_medium().text_color(t.muted).child("No loop yet"))
                .children(idle.map(a => this.agentRow(t, a, focus))),
            ),
        ),
      );
  }

  agentHint(a) {
    const live = a.live ?? {};
    const now = this.data?.now ?? Date.now();
    switch (live.state) {
      case "running": {
        const p = this.progress(a);
        return p ? `Step ${p.n}/${p.of} · ${clip(p.step.title, 30)}` : "Ticking now";
      }
      case "waiting":
        return live.wakeAt ? `${live.busy ? "Busy · " : ""}Wakes ${inTime(live.wakeAt, now)}` : "Waiting";
      case "overdue":
        return live.wakeAt ? `Tick ${inTime(live.wakeAt, now)}` : "Tick overdue";
      case "paused":
        return "Paused";
      case "watching":
        return `Watching · ${clip(live.watchers?.[0]?.label ?? "a background task", 30)}`;
      case "stopped":
        return "Stopped by the agent";
      case "gone":
        return "Session gone";
      default:
        return "Off · press P to arm";
    }
  }

  agentRow(t, a, focus) {
    const on = a.agent === this.sel;
    const st = a.live?.state ?? "unarmed";
    const look = loopLook(st, t, 13, this.app.palette?.open);
    const dim = a.agent !== "master" && (st === "unarmed" || st === "stopped" || st === "gone");
    const mark = agentMark(t, { kind: a.kind, size: 11, color: on ? t.accent : t.muted });
    const dirty = this.drafts.get(a.agent)?.dirty;
    return row()
      .id(`lp-a-${a.agent}`)
      .mx(6)
      .px(10)
      .py(8)
      .gap(10)
      .items_start()
      .rounded(8)
      .border(1)
      .border_color(on && focus ? alpha(t.accent, 0.6) : alpha(t.border, 0))
      .cursor_pointer()
      .when(on, el => el.bg(t.selected))
      .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
      .tooltip(`${a.label ?? a.agent}${a.terminal ? ` · ${a.terminal}` : ""} · loop ${look.label.toLowerCase()}`)
      .on_click((_e, cx) => {
        this.zone = "agents";
        this.select(a.agent, cx);
      })
      .child(div().flex_none().pt(2).w(14).child(look.glyph))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .when(dim, el => el.opacity(0.62))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(!!mark, el => el.child(mark))
              .child(div().min_w(0).truncate().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(a.label ?? a.agent))
              .when(!!dirty, el => el.child(div().w(5).h(5).rounded_full().bg(t.accent).tooltip("Unsaved edits"))),
          )
          .child(div().min_w(0).truncate().text_size(TYPE.meta).text_color(st === "overdue" ? onTint(t, tone(t).warn) : st === "gone" ? onTint(t, t.blocked) : t.muted).child(this.agentHint(a))),
      );
  }

  // ---- one agent's loop

  detail(t, a, cx) {
    const def = this.def(a);
    return scrollY(
      `lp-detail-${a.agent}`,
      v_flex()
        .w_full()
        .px(SP.xl)
        .py(20)
        .child(
          v_flex()
            .w_full()
            .max_w(880)
            .gap(28)
            .child(this.header(t, a, def))
            .child(this.heartbeat(t, a, def))
            .when(!!a.live?.tick, el => el.child(this.liveStrip(t, a)))
            .when((a.live?.watchers ?? []).length > 0, el => el.child(this.watchers(t, a)))
            .when((a.live?.others ?? []).length > 0, el => el.child(this.others(t, a)))
            .child(this.steps(t, a, def, cx))
            .when(a.agent === "master" || !!def.wake, el => el.child(this.wakes(t, a, def)))
            .child(this.history(t, a, def))
            .child(this.keyHints(t)),
        ),
    );
  }

  sentence(a) {
    const live = a.live ?? {};
    const now = this.data?.now ?? Date.now();
    const last = (a.history ?? [])[0];
    const lastBit = last ? `last tick ${span((last.endedAt ?? now) - last.startedAt)}, ${compact(last.newTokens ?? 0)} new tokens` : null;
    const join = (...xs) => xs.filter(Boolean).join(" · ");
    switch (live.state) {
      case "running": {
        const p = this.progress(a);
        return join(p ? `Ticking now, step ${p.n} of ${p.of}` : "Ticking now", live.tick?.startedAt ? `started ${span(now - live.tick.startedAt)} ago` : null);
      }
      case "waiting":
        return join(live.wakeAt ? `${live.busy ? "Between ticks, busy with other work" : "Waiting"} · wakes ${inTime(live.wakeAt, now).replace(/m$/, " min").replace(/h$/, " h")} (${clock(live.wakeAt)})` : "Waiting", lastBit);
      case "overdue":
        return join(`Overdue: its tick was due at ${live.wakeAt ? clock(live.wakeAt) : "—"}, so its loop has lapsed`, a.agent === "master" ? "HQ re-arms the master by itself, or re-arm it now" : "Re-arm it to start again", lastBit);
      case "paused":
        return join("Paused: it finishes the tick it's in, then schedules nothing", lastBit);
      case "watching": {
        const n = live.watchers?.length ?? 0;
        return `No loop, but it is watching ${n > 1 ? `${n} things` : "something"} (below) and wakes when ${n > 1 ? "one fires or ends" : "it fires or ends"}. Arm the loop to also run these steps on a heartbeat.`;
      }
      case "stopped":
        return "Stopped: the agent ended its own loop. Arm it to start again.";
      case "gone":
        return "Its session is gone. Relaunch it from the Roster, then arm its loop.";
      default:
        return a.agent === "master"
          ? "Off: the master only acts when spoken to. Arm the loop to run these steps every heartbeat."
          : "Off: this manager works only when spoken to. Arm a loop and it runs these steps on its heartbeat, and HQ wakes it when something can't wait.";
    }
  }

  header(t, a, def) {
    const st = a.live?.state ?? "unarmed";
    const look = loopLook(st, t, 12, this.app.palette?.open);
    const held = this.locked(a);
    const f = this.inflight[a.agent];
    const actions = [];
    // One way to start it, by state: Arm when no loop runs, else Run now and Pause. Never Arm and Run together.
    if (st === "gone") {
      actions.push(btn(t, "lp-roster", "Open in Roster", cx => this.app.go("org", cx, { id: a.agent === "master" ? "master" : a.agent }), { kind: "primary", icon: "layers" }));
    } else if (st === "unarmed" || st === "stopped" || st === "overdue" || st === "watching") {
      actions.push(
        btn(t, "lp-arm", st === "overdue" ? "Re-arm loop" : "Arm loop", cx => this.act(a, "arm", cx), {
          kind: "primary",
          icon: "play",
          kbd: held ? null : "P",
          disabled: held || !a.terminal,
          tooltip: `Types the loop prompt into ${a.terminal ?? "its terminal"}${a.status === "working" ? " once it's idle" : ""}`,
        }),
      );
    } else if (st === "paused") {
      actions.push(btn(t, "lp-resume", "Resume", cx => this.act(a, "resume", cx), { kind: "primary", icon: "play", kbd: held ? null : "P", disabled: held }));
      actions.push(btn(t, "lp-run", "Run once", cx => this.act(a, "run", cx), { icon: "redo", kbd: held ? null : "R", disabled: held }));
    } else {
      const ticking = st === "running";
      actions.push(
        btn(t, "lp-run", ticking ? "Ticking…" : "Run now", cx => this.act(a, "run", cx), {
          kind: "primary",
          icon: "redo",
          kbd: ticking || held ? null : "R",
          disabled: held || ticking,
          tooltip: ticking ? "A tick is running" : "Start a tick now instead of waiting for the heartbeat",
        }),
      );
      actions.push(btn(t, "lp-pause", "Pause", cx => this.act(a, "pause", cx), { icon: "pause", kbd: held ? null : "P", disabled: held, tooltip: "It finishes the current tick, then stops scheduling" }));
    }
    if (f && held)
      actions.push(
        h_flex()
          .gap(5)
          .items_center()
          .child(f.sending ? statusGlyph("working", t, 11, { still: true }) : icon(f.failed ? "minus" : "check", 11, f.failed ? t.muted : ok(t)))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(f.note)),
      );
    if (a.terminal) {
      actions.push(div().w(SP.sm));
      actions.push(btn(t, "lp-chat", "Chat", cx => this.app.chatWith(a.terminal, cx), { kind: "ghost", icon: "send" }));
      actions.push(btn(t, "lp-term", "Terminal", () => this.app.focusTerminal(a.terminal), { kind: "ghost", icon: "terminal" }));
    }
    return v_flex()
      .gap(SP.sm)
      .child(
        h_flex()
          .gap(SP.sm)
          .items_center()
          .flex_wrap()
          .child(agentMark(t, { kind: a.kind, id: a.agent, label: a.label, size: 22, avatar: true, status: a.status, still: this.app.palette?.open }) ?? div())
          .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child(a.agent === "master" ? "Master" : (a.label ?? a.agent)))
          .child(
            h_flex()
              .h(22)
              .px(8)
              .gap(6)
              .items_center()
              .rounded_full()
              .bg(alpha(look.color, 0.12))
              .child(look.glyph)
              .child(div().text_size(TYPE.meta).font_medium().text_color(onTint(t, look.color)).child(`Loop ${look.label.toLowerCase()}`)),
          )
          .child(statusBadge(t, a.status ?? "gone", { size: 11, text: TYPE.meta, glyph: false }))
          .when(!!a.terminal, el => el.child(div().text_size(TYPE.meta).font_family(mono()).text_color(t.dim).child(a.terminal))),
      )
      .child(div().max_w(680).text_size(TYPE.ui).line_height(1.5).text_color(st === "overdue" ? onTint(t, tone(t).warn) : t.muted).child(this.sentence(a)))
      .child(h_flex().pt(SP.xs).gap(SP.sm).items_center().flex_wrap().children(actions));
  }

  heartbeat(t, a, def) {
    const sec = def.heartbeatSec ?? 3600;
    const preset = HEARTBEATS.find(h => h.id === String(sec));
    const value = this.customHb || !preset ? "custom" : preset.id;
    return row()
      .gap(SP.lg)
      .items_center()
      .flex_wrap()
      .child(
        v_flex()
          .w(150)
          .gap(2)
          .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child("Heartbeat"))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(this.customHb || preset ? "Its tick when nothing wakes it" : `Every ${minutes(sec)}`)),
      )
      .child(segmented(t, `lp-hb-${a.agent}`, HEARTBEATS, value, (id, cx) => this.setHeartbeat(a, id, cx)))
      .when(this.customHb, el =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().w(64).child(frame(t, Input.new(this.hbIn), this.focusKey === "hb", { mono: true, h: 28 })))
            .child(div().text_size(TYPE.meta).text_color(t.muted).child("minutes, ↵ to set")),
        ),
      )
      .child(
        div()
          .flex_1()
          .min_w(200)
          .text_size(TYPE.meta)
          .line_height(1.45)
          .text_color(t.muted)
          .child(a.agent === "master" ? "HQ wakes it sooner for what can't wait (below), so a long heartbeat costs nothing in speed." : "HQ wakes an armed manager sooner when the master writes to it or its team stops."),
      );
  }

  liveStrip(t, a) {
    const tick = a.live.tick;
    const now = this.data?.now ?? Date.now();
    const going = !tick.endedAt;
    const trig = TRIGGERS[tick.trigger] ?? { icon: "repeat", label: tick.trigger ?? "Tick" };
    const last = (a.history ?? [])[0];
    const head = going
      ? `Ticking now · ${span(now - tick.startedAt)}`
      : `Last tick ${clock(tick.startedAt)} · took ${span(tick.endedAt - tick.startedAt)}${last && last.startedAt === tick.startedAt ? ` · ${compact(last.newTokens ?? 0)} new tokens` : ""}`;
    return h_flex()
      .id("lp-live")
      .px(SP.md)
      .py(10)
      .gap(SP.md)
      .items_start()
      .rounded(10)
      .border(1)
      .border_color(going ? alpha(t.working, 0.35) : alpha(t.border, 0.9))
      .bg(going ? alpha(t.working, 0.05) : alpha(t.foreground, 0.02))
      .child(div().flex_none().pt(1).child(going ? statusGlyph("working", t, 14, { still: this.app.palette?.open }) : icon("circle-check", 14, t.muted)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .flex_wrap()
              .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(head))
              .child(chip(t, trig.label, tick.trigger === "hq" ? t.accent : t.muted, { icon: trig.icon })),
          )
          .when(!!tick.triggerText, el => el.child(div().text_size(TYPE.meta).line_height(1.45).text_color(t.muted).child(plain(tick.triggerText))))
          .when(going && !!tick.lastAction, el =>
            el.child(
              h_flex()
                .gap(6)
                .items_center()
                .child(icon("terminal", 11, t.dim))
                .child(div().min_w(0).truncate().text_size(TYPE.meta).font_family(mono()).text_color(t.dim).child(tick.lastAction)),
            ),
          )
          .when(going && this.data?.jev === false, el => el.child(div().text_size(TYPE.meta).text_color(t.dim).child("Steps are tracked by the commands they run (Jev is unavailable for the rest)."))),
      );
  }

  // ---- watches: HQ's (hq watch add) and its own background commands and Monitors; each wakes it

  watchMeta(w, now) {
    const every = s => (s >= 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 60)}m`);
    if (w.kind === "hq")
      return [
        `HQ checks every ${every(w.everySec ?? 600)}`,
        w.lastCheckAt ? `last ${ago(w.lastCheckAt, now)}${w.lastLine ? `: ${clip(w.lastLine, 80)}` : ""}` : null,
        w.errors ? `${w.errors} failed check${w.errors === 1 ? "" : "s"}` : null,
        w.state === "fired" ? "fired, telling it" : null,
      ];
    return [w.kind === "monitor" ? "Its own Monitor" : "Its own background command", w.createdAt ? `started ${ago(w.createdAt, now)}` : null, w.expiresAt ? `expires ${inTime(w.expiresAt, now)}` : null];
  }

  watchers(t, a) {
    const now = this.data?.now ?? Date.now();
    const ws = a.live.watchers;
    const held = this.locked(a);
    return v_flex()
      .id("lp-watchers")
      .px(SP.md)
      .py(SP.md)
      .gap(SP.sm)
      .rounded(10)
      .bg(alpha(t.accent, 0.05))
      .border(1)
      .border_color(alpha(t.accent, 0.3))
      .child(
        h_flex()
          .gap(SP.sm)
          .items_center()
          .child(icon("eye", 13, t.accent))
          .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(ws.length > 1 ? `Watching ${ws.length} things` : "Watching"))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child("each wakes it when it fires or ends")),
      )
      .children(
        ws.map(w =>
          h_flex()
            .id(`lp-watch-${w.id}`)
            .ml(21)
            .gap(SP.sm)
            .items_start()
            .child(div().flex_none().pt(2).child(icon(w.kind === "hq" ? "clock" : w.kind === "monitor" ? "eye" : "terminal", 11, t.dim)))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(2)
                .tooltip(w.command ?? w.label ?? "")
                .child(div().text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child(w.label ?? ""))
                .child(div().text_size(TYPE.meta).text_color(t.muted).child(this.watchMeta(w, now).filter(Boolean).join(" · "))),
            )
            .when(w.kind === "hq" && w.state === "watching", el =>
              el.child(btn(t, `lp-unwatch-${w.id}`, "Stop", cx => this.act(a, "unwatch", cx, [w.id]), { kind: "ghost", size: "sm", icon: "square", disabled: held, tooltip: "Stop this watch and tell the agent" })),
            ),
        ),
      );
  }

  // ---- a second loop: recurring jobs (crons, scheduled tasks) that tick it beside its loop

  others(t, a) {
    const warn = tone(t).warn;
    const held = this.locked(a);
    const jobs = a.live.others;
    return v_flex()
      .id("lp-others")
      .px(SP.md)
      .py(SP.md)
      .gap(SP.md)
      .rounded(10)
      .bg(alpha(warn, 0.07))
      .border(1)
      .border_color(alpha(warn, 0.3))
      .child(
        h_flex()
          .gap(SP.sm)
          .items_start()
          .child(div().pt(1).child(icon("repeat", 13, warn)))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(jobs.length > 1 ? `Also ticked by ${jobs.length} recurring jobs: more loops` : "Also ticked by a recurring job: a second loop"))
              .child(
                div()
                  .text_size(TYPE.meta)
                  .line_height(1.45)
                  .text_color(t.muted)
                  .child("Each firing is a turn of its own beside the loop, at full cost. Fold it in: it becomes a step on the cadence you pick, and HQ asks the agent to delete the job."),
              ),
          ),
      )
      .children(
        jobs.map(j => {
          const every = this.absorbEvery[j.key] ?? "60";
          return v_flex()
            .id(`lp-job-${j.key}`)
            .ml(21)
            .px(SP.md)
            .py(SP.sm)
            .gap(6)
            .rounded(8)
            .bg(t.background)
            .border(1)
            .border_color(alpha(t.border, 0.9))
            .child(div().id(`lp-job-text-${j.key}`).text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).tooltip(j.prompt ?? j.text ?? "").child(j.text ?? ""))
            .child(
              div()
                .text_size(TYPE.meta)
                .text_color(t.muted)
                .child(
                  [`Fired ${j.count ?? 0} time${j.count === 1 ? "" : "s"}`, j.lastAt ? `last ${ago(j.lastAt, this.data?.now)}` : null, j.newTokens != null ? `${compact(j.newTokens)} new tokens` : null]
                    .filter(Boolean)
                    .join(" · "),
                ),
            )
            .child(
              h_flex()
                .pt(2)
                .gap(SP.sm)
                .items_center()
                .flex_wrap()
                .child(div().text_size(TYPE.meta).text_color(t.muted).child("As a step, every"))
                .child(segmented(t, `lp-job-every-${j.key}`, EVERY, every, (id, cx) => ((this.absorbEvery[j.key] = id), cx.notify())))
                .child(btn(t, `lp-absorb-${j.key}`, "Fold into loop", cx => this.act(a, "absorb", cx, [j.key, "--every", every]), { kind: "primary", size: "sm", icon: "layers", disabled: held })),
            );
        }),
      );
  }

  // ---- the steps: a stepper that is also the editor

  saveState(t, a) {
    const d = this.drafts.get(a.agent);
    const quiet = text => div().text_size(TYPE.meta).text_color(t.muted).child(text);
    if (d?.saving) return h_flex().gap(5).items_center().child(statusGlyph("working", t, 10, { still: true })).child(quiet("Saving…"));
    if (d?.error)
      return h_flex()
        .gap(SP.sm)
        .items_center()
        .child(icon("alert", 11, t.blocked))
        .child(div().max_w(300).truncate().text_size(TYPE.meta).text_color(onTint(t, t.blocked)).tooltip(d.error).child("Not saved"))
        .child(linkBtn(t, "lp-save-retry", "Retry", cx => this.save(a.agent, cx)));
    if (d?.dirty && !d.conflict) return quiet("Edited · saves in a moment");
    const at = this.savedAt[a.agent] ?? a.loop?.updatedAt;
    return h_flex().gap(5).items_center().child(icon("check", 11, ok(t))).child(quiet(at ? `Saved ${clock(at)}` : "Saved")).tooltip(at ? `Saved ${stamp(at)}${a.loop?.rev != null ? ` · revision ${a.loop.rev}` : ""}` : "");
  }

  steps(t, a, def, cx) {
    const d = this.drafts.get(a.agent);
    const steps = def.steps ?? [];
    const tick = a.live?.tick;
    const going = this.running(a);
    const lastIdx = steps.length - 1;
    const undoHere = this.undo?.agent === a.agent ? this.undo : null;
    const rows = [];
    steps.forEach((s, i) => {
      if (undoHere && undoHere.index === i) rows.push(this.undoRow(t, undoHere));
      // "Add a step" sits before a locked last step.
      if (i === lastIdx && s.locked) rows.push(this.addRow(t, a, steps));
      rows.push(this.stepRow(t, a, def, s, i, tick, going));
    });
    if (undoHere && undoHere.index >= steps.length) rows.push(this.undoRow(t, undoHere));
    if (!steps.at(-1)?.locked) rows.push(this.addRow(t, a, steps));
    return v_flex()
      .gap(SP.md)
      .child(
        sectionHead(t, {
          level: "title",
          title: "Steps",
          count: steps.filter(s => s.on !== false).length,
          hint: going ? "edits apply from the next tick" : "in order, each tick",
          right: h_flex()
            .gap(SP.md)
            .items_center()
            .child(this.saveState(t, a))
            .child(
              btn(t, "lp-reset", this.confirmReset === a.agent ? "Confirm reset" : "Reset to defaults", cx => this.armReset(a, cx), {
                kind: this.confirmReset === a.agent ? "danger" : "ghost",
                size: "sm",
                icon: "undo",
                disabled: this.locked(a),
                tooltip: "Replace these steps with HQ's defaults for this agent",
              }),
            ),
        }),
      )
      .when(!!d?.conflict, el =>
        el.child(
          h_flex()
            .px(SP.md)
            .py(SP.sm)
            .gap(SP.sm)
            .items_center()
            .rounded(8)
            .bg(alpha(tone(t).warn, 0.1))
            .border(1)
            .border_color(alpha(tone(t).warn, 0.35))
            .child(icon("alert", 13, tone(t).warn))
            .child(div().flex_1().min_w(0).text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child("These steps changed elsewhere while you edited (the master, or HQ in another window). Your edit isn't saved yet."))
            .child(btn(t, "lp-keep", "Keep mine", cx => this.keepMine(a, cx), { size: "sm", kind: "primary" }))
            .child(btn(t, "lp-theirs", "Use theirs", cx => this.useTheirs(a, cx), { size: "sm" })),
        ),
      )
      .child(
        v_flex()
          .id("lp-steps")
          .on_mouse_up("left", (_e, cx) => {
            const g = this.drag;
            if (g && g.over && g.agent === a.agent) this.moveTo(a, g.id, g.over, g.after, cx);
            this.drag = null;
            cx.notify();
          })
          .children(rows),
      );
  }

  /** A step's node on the rail: its number, a check once done, a spinner while current. */
  node(t, s, i, state) {
    const n = div().text_size(10.5).font_semibold();
    const ring = (border, child, o = {}) =>
      div()
        .flex_none()
        .w(22)
        .h(22)
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .border(1.5)
        .border_color(border)
        .when(!!o.dashed, el => el.border_dashed())
        .when(!!o.bg, el => el.bg(o.bg))
        .child(child);
    if (s.on === false) return ring(alpha(t.dim, 0.6), icon("minus", 10, t.dim), { dashed: true });
    if (state === "done") return ring(ok(t), icon("check", 12, inkOn(t, ok(t))), { bg: ok(t) });
    if (state === "current") return ring(t.working, statusGlyph("working", t, 12, { still: this.app.palette?.open }), { bg: alpha(t.working, 0.12) });
    if (state === "skipped") return ring(alpha(t.dim, 0.5), n.text_color(t.dim).child(String(i + 1)), { dashed: true });
    return ring(state === "pending" ? t.input ?? t.border : alpha(t.foreground, 0.22), n.text_color(t.muted).child(String(i + 1)));
  }

  stepRow(t, a, def, s, i, tick, going) {
    const steps = def.steps;
    const last = i === steps.length - 1;
    const state = tick ? (tick.steps?.[s.id] ?? (going ? "pending" : null)) : null;
    // A finished tick's marks stay as a quiet record until the next one starts.
    const live = going ? state : state === "done" ? "done" : null;
    const editing = this.open?.agent === a.agent && this.open.step === s.id;
    const cursor = this.zone === "steps" && this.cursor === s.id;
    const hovered = this.hover === s.id;
    const due = !going && (a.live?.due ?? []).includes(s.id) && s.on !== false;
    const current = going && tick.current === s.id;
    const dragging = this.drag?.id === s.id;
    const over = this.drag && this.drag.over === s.id && this.drag.id !== s.id ? this.drag : null;
    const doneSeg = live === "done" && (going ? ["done", "current"].includes(tick.steps?.[steps[i + 1]?.id]) : tick?.steps?.[steps[i + 1]?.id] === "done");
    const cad = cadenceOf(s);
    const off = s.on === false;
    return row()
      .id(`lp-s-${s.id}`)
      .relative()
      .items_stretch()
      .when(dragging, el => el.opacity(0.4))
      .on_hover((h, cx) => {
        if (h && this.hover !== s.id) this.hover = s.id;
        else if (!h && this.hover === s.id) this.hover = null;
        else return;
        cx.notify();
      })
      .when(!!this.drag && this.drag.agent === a.agent, el =>
        el.on_mouse_move((e, cx) => {
          const g = this.drag;
          if (!g) return;
          let after = e.local_position.y > (e.bounds?.height ?? 40) / 2;
          if (s.locked && i === 0) after = true;
          if (s.locked && last) after = false;
          if (g.over !== s.id || g.after !== after) {
            g.over = s.id;
            g.after = after;
            cx.notify();
          }
        }),
      )
      // The rail: this step's node, then the line down to the next.
      .child(
        v_flex()
          .flex_none()
          .w(30)
          .items_center()
          .child(div().pt(editing ? 12 : 9).child(this.node(t, s, i, live)))
          .when(!last, el => el.child(div().flex_1().min_h(10).w(2).rounded_full().bg(doneSeg ? alpha(ok(t), 0.55) : alpha(t.foreground, 0.1)))),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .pb(last ? 0 : 6)
          .child(
            editing
              ? this.editor(t, a, def, s, i)
              : v_flex()
                  .id(`lp-sc-${s.id}`)
                  .px(SP.md)
                  .py(9)
                  .gap(4)
                  .rounded(9)
                  .border(1)
                  .border_color(cursor ? alpha(t.accent, 0.6) : current ? alpha(t.working, 0.35) : alpha(t.border, 0))
                  .when(current, el => el.bg(alpha(t.working, 0.05)))
                  .when(!current && cursor, el => el.bg(tint(t).hover))
                  .when(!current && !cursor, el => el.hover(st => st.bg(tint(t).hover)))
                  .cursor_pointer()
                  .on_click((_e, cx) => this.openEditor(a, s.id, cx))
                  .child(
                    h_flex()
                      .gap(SP.sm)
                      .items_center()
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .text_size(TYPE.body)
                          .font_medium()
                          .line_height(1.4)
                          .text_color(off ? t.muted : t.foreground)
                          .when(off, el => el.line_through())
                          .child(s.title || "Untitled step"),
                      )
                      .when(current && a.live.tick.currentBy === "jev", el =>
                        el.child(div().id(`lp-inf-${s.id}`).text_size(TYPE.meta).italic().text_color(t.dim).tooltip("Jev inferred this step from the agent's last action").child("inferred")),
                      )
                      .when(due, el => el.child(chip(t, "next tick", t.accent, { id: `lp-due-${s.id}`, tooltip: "Due on the next tick" })))
                      .when(live === "skipped" && going, el => el.child(div().text_size(TYPE.meta).text_color(t.dim).child("not due")))
                      .when(s.locked, el => el.child(chip(t, i === 0 ? "always first" : "always last", t.muted, { id: `lp-lock-${s.id}`, tooltip: "Reword it freely; it can't move or switch off" })))
                      .when(!s.locked, el =>
                        el.child(
                          h_flex()
                            .id(`lp-cad-${s.id}`)
                            .flex_none()
                            .h(20)
                            .px(7)
                            .gap(4)
                            .items_center()
                            .rounded_full()
                            .border(1)
                            .border_color(alpha(t.border, 0.9))
                            .cursor_pointer()
                            .hover(st => st.border_color(t.accent))
                            .tooltip(`${cad.label}. Click (or S) to change.`)
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .on_click((_e, cx) => this.cycleCadence(a, s.id, cx))
                            .child(icon(cad.icon, 10, t.muted))
                            .child(div().text_size(TYPE.meta).text_color(t.muted).child(cadenceShort(s))),
                        ),
                      )
                      .when(!s.locked, el =>
                        el.child(
                          h_flex()
                            .flex_none()
                            .gap(4)
                            .items_center()
                            .when(!(hovered || cursor), r => r.opacity(0))
                            .child(
                              div()
                                .id(`lp-grip-${s.id}`)
                                .flex_none()
                                .p(2)
                                .rounded(4)
                                .cursor_grab()
                                .hover(st => st.bg(alpha(t.foreground, 0.07)))
                                .tooltip("Drag to reorder (⌥↑ ⌥↓)")
                                .on_mouse_down("left", (_e, cx) => {
                                  cx.stop_propagation();
                                  this.drag = { agent: a.agent, id: s.id, over: null, after: false };
                                  cx.notify();
                                })
                                .on_click((_e, cx) => cx.stop_propagation())
                                .child(icon("grip-vertical", 13, t.muted)),
                            )
                            .child(btn(t, `lp-del-${s.id}`, null, cx => this.remove(a, s.id, cx), { kind: "ghost", size: "sm", icon: "trash", tooltip: "Delete step (⌫)" })),
                        ),
                      )
                      .when(!s.locked, el => el.child(toggle(t, `lp-on-${s.id}`, !off, (_v, cx) => this.toggleStep(a, s.id, cx), { tooltip: off ? "Off: skipped every tick (Space)" : "On (Space to switch off)" }))),
                  )
                  .when(!!(s.body ?? "").trim(), el => el.child(lines(s.body, TYPE.ui, 2, 120, 1.45).text_color(off ? t.dim : t.muted)))
                  .when(current && !!a.live.tick.lastAction, el =>
                    el.child(
                      h_flex()
                        .pt(2)
                        .gap(6)
                        .items_center()
                        .child(icon("terminal", 10, t.dim))
                        .child(div().min_w(0).truncate().text_size(TYPE.meta).font_family(mono()).text_color(t.dim).child(a.live.tick.lastAction)),
                    ),
                  ),
          ),
      )
      // Where a dragged step would land.
      .when(!!over, el =>
        el.child(
          div()
            .absolute()
            .left(30)
            .right(0)
            .h(2)
            .rounded_full()
            .bg(t.accent)
            .when(over.after, d => d.bottom(1))
            .when(!over.after, d => d.top(-1)),
        ),
      );
  }

  editor(t, a, def, s, i) {
    const steps = def.steps;
    const { lo, hi } = this.bounds(steps);
    const off = s.on === false;
    return v_flex()
      .id(`lp-ed-${s.id}`)
      .p(SP.md)
      .gap(SP.md)
      .rounded(10)
      .bg(t.raised)
      .border(1)
      .border_color(alpha(t.accent, 0.5))
      .child(
        s.locked
          ? v_flex()
              .gap(4)
              .child(div().text_size(TYPE.body).font_medium().text_color(t.foreground).child(s.title))
              .child(div().text_size(TYPE.meta).text_color(t.muted).child(i === 0 ? "Always runs first: it's how the agent learns what changed. Reword the instruction; it can't move or switch off." : "Always runs last: it schedules the next tick. Reword the instruction; it can't move or switch off."))
          : frame(t, Input.new(this.titleIn).w_full(), this.focusKey === "title", { h: 32, size: TYPE.body }),
      )
      .child(frame(t, Textarea.new(this.bodyIn).w_full(), this.focusKey === "body", { multiline: true, size: TYPE.ui }))
      .when(!s.locked, el =>
        el.child(
          h_flex()
            .gap(SP.md)
            .items_center()
            .flex_wrap()
            .child(div().text_size(TYPE.meta).text_color(t.muted).child("Runs"))
            .child(segmented(t, `lp-cadseg-${s.id}`, CADENCE.map(c => ({ id: c.id, label: c.label })), s.when ?? "news", (id, cx) => this.setCadence(a, s.id, id, cx)))
            .when(s.when === "interval", r =>
              r
                .child(div().w(60).child(frame(t, Input.new(this.everyIn), this.focusKey === "every", { mono: true, h: 28 })))
                .child(div().text_size(TYPE.meta).text_color(t.muted).child("minutes apart")),
            ),
        ),
      )
      .when(!s.locked && s.when === "news", el => el.child(div().text_size(TYPE.meta).text_color(t.dim).child("Skipped on ticks where `hq tick` reports nothing new, so quiet ticks stay cheap.")))
      .child(
        h_flex()
          .gap(SP.sm)
          .items_center()
          .when(!s.locked, r =>
            r
              .child(toggle(t, `lp-ed-on-${s.id}`, !off, (_v, cx) => this.toggleStep(a, s.id, cx)))
              .child(div().text_size(TYPE.ui).text_color(t.muted).child(off ? "Off" : "On"))
              .child(div().w(SP.sm))
              .child(btn(t, `lp-ed-up-${s.id}`, null, cx => this.move(a, s.id, -1, cx), { kind: "ghost", size: "sm", icon: "arrow-up", tooltip: "Earlier (⌥↑)", disabled: i <= lo }))
              .child(btn(t, `lp-ed-down-${s.id}`, null, cx => this.move(a, s.id, 1, cx), { kind: "ghost", size: "sm", icon: "arrow-down", tooltip: "Later (⌥↓)", disabled: i >= hi }))
              .child(btn(t, `lp-ed-del-${s.id}`, "Delete", cx => this.remove(a, s.id, cx), { kind: "ghost", size: "sm", icon: "trash" })),
          )
          .child(div().flex_1())
          .child(div().text_size(TYPE.meta).text_color(t.dim).child("Saves as you type"))
          .child(btn(t, `lp-ed-done-${s.id}`, "Done", cx => this.closeEditor(cx), { size: "sm", kbd: "esc" })),
      );
  }

  addRow(t, a, steps) {
    return row()
      .id("lp-add")
      .items_stretch()
      .child(v_flex().flex_none().w(30).items_center().child(div().flex_1().w(2).bg(alpha(t.foreground, 0.1))))
      .child(
        h_flex()
          .id("lp-add-btn")
          .flex_1()
          .mb(6)
          .px(SP.md)
          .h(34)
          .gap(SP.sm)
          .items_center()
          .rounded(9)
          .border(1)
          .border_dashed()
          .border_color(alpha(t.foreground, 0.18))
          .cursor_pointer()
          .hover(s => s.bg(tint(t).hover).border_color(t.accent))
          .on_click((_e, cx) => {
            const { hi } = this.bounds(steps);
            this.add(a, steps[hi]?.id, cx);
          })
          .child(icon("plus", 12, t.muted))
          .child(div().text_size(TYPE.ui).text_color(t.muted).child("Add a step"))
          .child(div().flex_1())
          .child(kbd(t, "N")),
      );
  }

  undoRow(t, u) {
    return row()
      .id("lp-undo")
      .items_center()
      .child(div().flex_none().w(30))
      .child(
        h_flex()
          .flex_1()
          .mb(6)
          .px(SP.md)
          .h(32)
          .gap(SP.sm)
          .items_center()
          .rounded(9)
          .bg(alpha(t.foreground, 0.04))
          .child(icon("trash", 11, t.muted))
          .child(div().min_w(0).truncate().text_size(TYPE.ui).text_color(t.muted).child(`Deleted “${clip(u.step.title || "Untitled step", 50)}”`))
          .child(div().flex_1())
          .child(linkBtn(t, "lp-undo-btn", "Undo", cx => this.undoRemove(cx)))
          .child(kbd(t, "U")),
      );
  }

  // ---- what wakes it

  wakes(t, a, def) {
    const w = def.wake ?? {};
    return v_flex()
      .gap(SP.md)
      .child(sectionHead(t, { level: "title", title: "Wakes early for", hint: "HQ checks once a minute and spends no tokens doing it" }))
      .child(
        v_flex()
          .gap(SP.md)
          .children(
            WAKES.map(x =>
              h_flex()
                .id(`lp-wake-${x.key}`)
                .gap(SP.md)
                .items_start()
                .cursor_pointer()
                .on_click((_e, cx) => this.setWake(a, x.key, w[x.key] === false, cx))
                .child(div().pt(1).child(toggle(t, `lp-wake-t-${x.key}`, w[x.key] !== false, (v, cx) => this.setWake(a, x.key, v, cx))))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(2)
                    .child(div().text_size(TYPE.ui).font_medium().text_color(w[x.key] === false ? t.muted : t.foreground).child(x.title))
                    .child(div().text_size(TYPE.meta).line_height(1.45).text_color(t.muted).child(x.hint)),
                ),
            ),
          ),
      );
  }

  // ---- what its ticks cost

  history(t, a, def) {
    const hist = a.history ?? [];
    const max = Math.max(1, ...hist.map(h => h.newTokens ?? 0));
    const total = hist.reduce((n, h) => n + (h.newTokens ?? 0), 0);
    const quiet = hist.filter(h => h.quiet).length;
    const pos = Object.fromEntries((def.steps ?? []).map((s, i) => [s.id, i + 1]));
    return v_flex()
      .gap(SP.sm)
      .child(
        sectionHead(t, {
          level: "title",
          title: "Recent ticks",
          count: hist.length || null,
          hint: hist.length ? `about ${compact(Math.round(total / hist.length))} new tokens a tick${quiet ? ` · ${quiet} quiet` : ""}` : null,
        }),
      )
      .when(hist.length === 0, el =>
        el.child(div().py(SP.sm).text_size(TYPE.ui).text_color(t.muted).child(a.live?.state === "unarmed" ? "No ticks yet. Arm the loop and each tick shows here with what woke it and what it cost." : "No ticks recorded yet.")),
      )
      .children(hist.map((h, i) => this.tickRow(t, h, i, max, pos)));
  }

  tickRow(t, h, i, max, pos) {
    const open = this.histOpen === i;
    const trig = TRIGGERS[h.trigger] ?? { icon: "repeat", label: h.trigger ?? "Tick" };
    const tokens = h.newTokens ?? 0;
    const w = Math.max(2, Math.round(110 * (tokens / max)));
    const ran = (h.steps ?? []).map(id => pos[id]).filter(Boolean).sort((x, y) => x - y);
    return v_flex()
      .id(`lp-h-${i}`)
      .px(SP.sm)
      .py(6)
      .gap(6)
      .rounded(7)
      .cursor_pointer()
      .when(open, el => el.bg(tint(t).hover))
      .when(!open, el => el.hover(s => s.bg(tint(t).hover)))
      .on_click((_e, cx) => ((this.histOpen = open ? null : i), cx.notify()))
      .child(
        h_flex()
          .gap(SP.md)
          .items_center()
          .when(!!h.quiet && !open, el => el.opacity(0.55))
          .child(div().flex_none().w(40).text_size(TYPE.meta).font_family(mono()).text_color(t.foreground).tooltip(stamp(h.startedAt)).child(clock(h.startedAt)))
          .child(h_flex().flex_none().w(108).gap(5).items_center().child(icon(trig.icon, 11, h.trigger === "hq" ? t.accent : t.muted)).child(div().text_size(TYPE.meta).text_color(t.muted).child(trig.label)))
          .child(div().flex_none().w(58).text_size(TYPE.meta).font_family(mono()).text_color(t.muted).child(h.endedAt ? span(h.endedAt - h.startedAt) : "running"))
          .child(
            h_flex()
              .flex_none()
              .w(170)
              .gap(SP.sm)
              .items_center()
              .tooltip(`${tokens.toLocaleString()} new tokens (input, cache writes and output) · ${(h.cachedTokens ?? 0).toLocaleString()} read from cache`)
              .child(div().w(110).h(4).rounded_full().bg(alpha(t.foreground, 0.08)).child(div().h(4).w(w).rounded_full().bg(h.quiet ? t.dim : t.accent)))
              .child(div().text_size(TYPE.meta).font_family(mono()).text_color(t.muted).child(compact(tokens))),
          )
          .child(
            h.quiet
              ? div().text_size(TYPE.meta).text_color(t.dim).child("nothing new")
              : h_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(3)
                  .flex_wrap()
                  .children(
                    ran.length
                      ? ran.map(n => div().w(16).h(16).rounded_full().flex().items_center().justify_center().bg(alpha(ok(t), 0.14)).text_size(9.5).font_semibold().text_color(onTint(t, ok(t))).child(String(n)))
                      : [div().text_size(TYPE.meta).text_color(t.dim).child("no steps matched")],
                  ),
          ),
      )
      .when(open, el =>
        el.child(
          v_flex()
            .pl(52)
            .gap(3)
            .child(div().text_size(TYPE.meta).line_height(1.45).text_color(t.foreground).child(h.triggerText ? plain(h.triggerText) : `${trig.label} tick`))
            .child(div().text_size(TYPE.meta).text_color(t.muted).child(`${h.calls ?? 0} tool calls · ${compact(h.cachedTokens ?? 0)} tokens read from cache · ${stamp(h.startedAt)}`)),
        ),
      );
  }

  keyHints(t) {
    const pair = (k, text) => h_flex().gap(4).items_center().child(kbd(t, k)).child(div().text_size(TYPE.meta).text_color(t.muted).child(text));
    return h_flex()
      .pt(SP.sm)
      .gap(SP.md)
      .flex_wrap()
      .border_t(1)
      .border_color(alpha(t.border, 0.6))
      .child(pair("↑↓", "move"))
      .child(pair("←→", "agents / steps"))
      .child(pair("↵", "edit"))
      .child(pair("Space", "on/off"))
      .child(pair("S", "cadence"))
      .child(pair("N", "new step"))
      .child(pair("⌫", "delete"))
      .child(pair("⌥↑↓", "reorder"))
      .child(pair("R", "run now"))
      .child(pair("P", "pause / arm"));
  }
}
