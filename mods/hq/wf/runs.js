// Generated from mods/workflows/runs.js by shared/sync.sh: edit it there.

// A run as the views read it: whether it's live or can resume, and its agents as a graph of
// lanes (phases) and nodes (units of work).

import { look, shortModel } from "./util.js";

export const isLive = status => status === "running";
export const RESUMABLE = ["stalled", "killed", "failed"];

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
