// Formatting, state colors, icons and the scroll area.

import { Scrollbar, v_flex } from "gpui-base";

import { ok } from "./shared/look.js";

export { alpha, ICON, icon, mix, mono, ok } from "./shared/look.js";

// A session's or node's state, as one of five looks.
export function look(state, t) {
  switch (state) {
    case "progress":
    case "start":
    case "running":
      return { key: "running", color: t.working, label: "Running", glyph: "spinner" };
    case "done":
    case "completed":
      return { key: "done", color: ok(t), label: "Done", glyph: "check" };
    case "error":
    case "failed":
      return { key: "failed", color: t.blocked, label: "Failed", glyph: "x" };
    case "killed":
      return { key: "killed", color: t.muted, label: "Killed", glyph: "square" };
    case "stalled":
      return { key: "stalled", color: t.idle ?? t.muted, label: "Stalled", glyph: "clock" };
    default:
      return { key: "queued", color: t.dim, label: "Queued", glyph: "clock" };
  }
}

const KIND_SLOTS = ["ansi4", "ansi5", "ansi6", "ansi3", "ansi2", "ansi12", "ansi13", "ansi14"];
const KNOWN_KIND = { impl: 0, build: 0, review: 1, rereview: 2, fix: 3, gate: 4, plan: 5, brief: 6, sketch: 7 };

/** A stable color per session kind ("impl", "review", "fix2" → "fix"). */
export function kindColor(kind, t) {
  const base = (kind ?? "").replace(/\d+$/, "");
  let slot = KNOWN_KIND[base];
  if (slot === undefined) {
    let h = 0;
    for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    slot = h % KIND_SLOTS.length;
  }
  return t[KIND_SLOTS[slot]] ?? t.accent;
}

export function shortModel(model) {
  if (!model) return null;
  const big = /\[1m\]/i.test(model) ? " 1M" : "";
  const m = model.replace(/\[1m\]/i, "").replace(/^claude-/, "");
  const hit = m.match(/^(opus|sonnet|haiku|fable)(?:-(\d+)-(\d+))?/);
  if (!hit) return m + big;
  return hit[2] ? `${hit[1]} ${hit[2]}.${hit[3]}${big}` : hit[1] + big;
}

export function duration(ms) {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function compact(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

export function tildify(path, home) {
  return path && home && path.startsWith(home) ? "~" + path.slice(home.length) : (path ?? "");
}

export function clip(text, n) {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * A region that fills its flex parent and scrolls `content` on `axis` ("y" or "both"),
 * with a bar that stays visible so there is always something to drag.
 */
export function scrollArea(id, axis, content) {
  const area = content.id(id).size_full();
  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(axis === "y" ? area.overflow_y_scroll() : area.overflow_scroll())
    .child((axis === "y" ? Scrollbar.vertical(id) : Scrollbar.new(id)).mode("always").absolute().inset_0());
}
