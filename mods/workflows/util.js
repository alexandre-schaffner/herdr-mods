// Formatting, state colors and the run → graph model.

import { Scrollbar, v_flex } from "gpui-base";
import { svg } from "gpui-kit";
import { settings } from "herdr";

export const ICON = name => `mods/workflows/icons/${name}.svg`;
/** A one-color icon tinted `color`: one of ours by name, or any home-relative `path`. */
export const icon = (name, size, color, path) => svg(path ?? ICON(name)).flex_none().w(size).h(size).text_color(color);

export const mono = () => settings()?.font_family || settings()?.font || "JetBrains Mono";

/** A theme color at `a` times its own opacity (`#rrggbb` or `#rrggbbaa` in, `#rrggbbaa` out). */
export function alpha(hex, a) {
  const c = hex ?? "#888888";
  const own = c.length >= 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
  const v = Math.round(Math.max(0, Math.min(1, a * own)) * 255);
  return `${c.slice(0, 7)}${v.toString(16).padStart(2, "0")}`;
}

/** Linear mix of two `#rrggbb` colors. */
export function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a ?? "#000000"), p(b ?? "#ffffff")];
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Success green: the theme's `done` means "finished unseen", which many themes draw blue. */
export const ok = (t) => t.ansi2 ?? t.done;

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

// ---- the graph model

/** "impl:U6" → kind impl, key U6; "review#2" → review, review. */
export function splitLabel(label) {
  const base = (label ?? "agent").replace(/#\d+$/, "");
  const i = base.indexOf(":");
  if (i < 0) return { kind: base, key: base };
  return { kind: base.slice(0, i), key: base.slice(i + 1) };
}

const RANK = { running: 5, failed: 4, stalled: 3, killed: 2, done: 1, queued: 0 };

/** Lanes of nodes; a node is one unit of work and holds every session (agent) for it. */
export function buildGraph(run, t) {
  const titles = run.phases?.length ? [...run.phases] : [];
  const lanes = titles.map((title, i) => ({ index: i + 1, title, nodes: [] }));
  const laneOf = a => {
    const i = (a.phaseIndex ?? 0) - 1;
    if (i >= 0 && lanes[i]) return lanes[i];
    const title = a.phaseTitle || (titles.length ? "Other" : "Agents");
    let lane = lanes.find(l => l.title === title);
    if (!lane) lanes.push((lane = { index: lanes.length + 1, title, nodes: [] }));
    return lane;
  };
  for (const a of run.agentList ?? []) {
    const lane = laneOf(a);
    const { kind, key } = splitLabel(a.label);
    let node = lane.nodes.find(n => n.key === key);
    if (!node) {
      node = { id: `${lane.index}:${key}`, key, lane: lane.index, phase: lane.title, sessions: [] };
      lane.nodes.push(node);
    }
    node.sessions.push({ ...a, kind });
  }
  for (const lane of lanes) {
    for (const node of lane.nodes) {
      node.sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const looks = node.sessions.map(s => look(s.state, t));
      const live = looks.find(l => l.key === "running");
      node.look = live ?? looks[looks.length - 1];
      node.title =
        /^\d+$/.test(node.key) && node.sessions[0]?.kind !== node.key
          ? `${node.sessions[0].kind} ${node.key}`
          : node.key;
      node.kinds = node.sessions.map((s, i) => ({ kind: s.kind, look: looks[i] }));
      node.models = [...new Set(node.sessions.map(s => shortModel(s.model)?.split(" ")[0]).filter(Boolean))];
      node.tokens = node.sessions.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
      node.tools = node.sessions.reduce((sum, s) => sum + (s.toolCalls ?? 0), 0);
      node.cached = node.sessions.every(s => s.cached);
    }
    lane.done = lane.nodes.filter(n => n.look.key === "done").length;
    lane.live = lane.nodes.filter(n => n.look.key === "running").length;
    lane.failed = lane.nodes.filter(n => n.look.key === "failed").length;
    lane.look = lane.live
      ? look("running", t)
      : lane.nodes.length && lane.done === lane.nodes.length
        ? look("done", t)
        : lane.failed
          ? look("failed", t)
          : lane.nodes.reduce((best, n) => (RANK[n.look.key] > RANK[best.key] ? n.look : best), look("queued", t));
  }
  return lanes;
}

export function sessionSpan(s, now = Date.now()) {
  if (s.durationMs != null) return s.durationMs;
  if (!s.startedAt) return null;
  const live = look(s.state, {}).key === "running";
  return (live ? now : (s.lastProgressAt ?? now)) - s.startedAt;
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
