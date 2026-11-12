// An epic's plan in words and colours, shared by Roadmap and Home's Epics panel so they never
// disagree about what a state looks like or where an epic stands.

import { h_flex } from "gpui-base";
import { div } from "gpui-kit";

import { alpha, ok, tone } from "./ui.js";

const EPIC_TONE = { "on track": "ok", "at risk": "warn", blocked: "alert", paused: "muted", done: "info" };

/** An epic's status colour; `fallback` when it has no plan (so no status). */
export function epicColor(t, status, fallback = t.muted) {
  return status ? (tone(t)[EPIC_TONE[status]] ?? t.muted) : fallback;
}

export function phaseColor(t, status) {
  const quiet = alpha(t.foreground, 0.1);
  return { done: ok(t), doing: t.accent, blocked: t.blocked, next: alpha(t.foreground, 0.22), later: quiet }[status] ?? quiet;
}

export const doneCount = phases => phases.filter(p => p.status === "done").length;

/** The one line that says where an epic is: what's stuck, else what's moving, else what's next. */
export function where(t, phases) {
  const stuck = phases.filter(p => p.status === "blocked");
  if (stuck.length) return { text: `Stuck on ${stuck.map(p => p.title).join(", ")}`, color: t.blocked };
  const now = phases.filter(p => p.status === "doing");
  if (now.length) return { text: `Now: ${now.map(p => p.title).join(" · ")}`, color: t.foreground };
  if (phases.length && doneCount(phases) === phases.length) return { text: "All phases done", color: ok(t) };
  const next = phases.find(p => p.status === "next") ?? phases.find(p => p.status !== "done");
  return next ? { text: `Next: ${next.title}`, color: t.muted } : { text: "Nothing in progress", color: t.muted };
}

/** One slim segment per phase, coloured by its state: progress at a glance. `id` adds tooltips. */
export function rail(t, phases, h, id = null) {
  return h_flex()
    .w_full()
    .h(h)
    .gap(3)
    .children(
      phases.map(p => {
        const seg = div().flex_1().h_full().rounded_full().bg(phaseColor(t, p.status));
        return id ? seg.id(`${id}-${p.id}`).tooltip(`${p.title} · ${p.status}`) : seg;
      }),
    );
}
