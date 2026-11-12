// Generated from shared/js/claude-model.js by shared/sync.sh: edit it there.

// Transcript events (from claude-reader/read.py) → the rows a Claude chat shows, plus the
// live facts beside them (todo list, background work).

const HOME_RE = /^\/(?:Users|home)\/[^/]+/;

export function shortPath(p, cwd) {
  if (!p) return "";
  const s = String(p);
  if (cwd && s.startsWith(cwd + "/")) return s.slice(cwd.length + 1);
  return s.replace(HOME_RE, "~");
}

const firstLine = (s, n = 140) => {
  const line = String(s ?? "").trim().split("\n")[0] ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

const host = (url) => {
  const m = String(url ?? "").match(/^https?:\/\/([^/?#]+)([^?#]*)/);
  return m ? m[1] + (m[2] && m[2] !== "/" ? m[2] : "") : String(url ?? "");
};

/** A tool's family: drives its icon, color and how a group of them is summed up. */
export function family(name) {
  if (name === "Bash" || name === "BashOutput" || name === "KillShell" || name === "Monitor") return "shell";
  if (name === "Read" || name === "NotebookRead") return "read";
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return "edit";
  if (name === "Grep" || name === "Glob" || name === "ToolSearch") return "search";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Agent" || name === "Task" || name === "SendMessage") return "agent";
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "todo";
  if (name === "Skill") return "skill";
  return "tool";
}

/** Pretty name: `mcp__grafana__query` → `grafana · query`. */
export function toolName(name) {
  const m = String(name).match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1].replace(/^plugin_[^_]+_/, "")} · ${m[2]}` : name;
}

/** One line saying what a call did. */
export function toolLine(name, inp, cwd) {
  const i = inp ?? {};
  switch (family(name)) {
    case "shell":
      return i.description || firstLine(i.command) || firstLine(i.bash_id ?? "");
    case "read":
      return shortPath(i.file_path ?? i.notebook_path, cwd) + (i.offset ? `  :${i.offset}${i.limit ? `–${i.offset + i.limit}` : ""}` : "");
    case "edit":
      return shortPath(i.file_path ?? i.notebook_path, cwd);
    case "search":
      if (name === "ToolSearch") return firstLine(i.query);
      return `${i.pattern ?? ""}${i.path ? `  in ${shortPath(i.path, cwd)}` : ""}${i.glob ? `  (${i.glob})` : ""}`;
    case "web":
      return name === "WebSearch" ? firstLine(i.query) : host(i.url);
    case "agent":
      return i.description || firstLine(i.prompt ?? i.message);
    case "todo":
      return Array.isArray(i.todos) ? `${i.todos.length} items` : firstLine(i.subject ?? i.description ?? "");
    case "skill":
      return i.skill ?? i.command ?? "";
  }
  for (const v of Object.values(i)) if (typeof v === "string" && v.trim()) return firstLine(v);
  return "";
}

const PLURAL = {
  shell: ["ran", "command", "commands"],
  read: ["read", "file", "files"],
  edit: ["edited", "file", "files"],
  search: ["searched", "time", "times"],
  web: ["fetched", "page", "pages"],
  agent: ["ran", "agent", "agents"],
  todo: ["updated", "todo list", "todo lists"],
  skill: ["used", "skill", "skills"],
  tool: ["used", "tool", "tools"],
};

/** "Ran 3 commands, read 2 files, edited 1 file". */
export function groupLine(tools) {
  const counts = new Map();
  const files = new Map();
  for (const t of tools) {
    const f = family(t.name);
    if (f === "read" || f === "edit") {
      const set = files.get(f) ?? new Set();
      set.add(t.input?.file_path ?? t.input?.notebook_path ?? t.id);
      files.set(f, set);
    }
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const parts = [];
  for (const [f, n0] of counts) {
    const n = files.has(f) ? files.get(f).size : n0;
    const [verb, one, many] = PLURAL[f];
    parts.push(`${verb} ${n} ${n === 1 ? one : many}`);
  }
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Merges new events into `state` ({ events, tools: Map, results: Map }) and returns it.
 * Results are kept apart and joined by id when rows are built, so a result can arrive
 * in a later read than its call.
 */
/** Events a chat keeps. Herdr's mods share one small script memory, and a long session's
 *  transcript grows without end: past this, the oldest go (with their tool results). */
export const MAX_EVENTS = 2500;

export function absorb(state, events) {
  for (const e of events) {
    if (e.k === "res") state.results.set(e.id, e);
    else {
      if (e.k === "tool") {
        state.tools.set(e.id, e);
        state.lastTool = e.id;
      }
      state.events.push(e);
    }
  }
  if (state.events.length > MAX_EVENTS) {
    const old = state.events.splice(0, state.events.length - Math.floor(MAX_EVENTS * 0.8));
    for (const e of old) {
      if (e.k === "tool") {
        state.tools.delete(e.id);
        state.results.delete(e.id);
      }
    }
    state.trimmed = (state.trimmed ?? 0) + old.length;
  }
  return state;
}

export const emptyState = () => ({ events: [], tools: new Map(), results: new Map(), trimmed: 0 });

/** The text a row stands for, for search and copy. */
export function rowText(row, state) {
  switch (row.type) {
    case "prompt":
    case "text":
    case "think":
      return row.ev.text ?? "";
    case "note":
      return [row.ev.text, row.ev.report].filter(Boolean).join("\n\n");
    case "cmd":
      return `${row.ev.name} ${row.ev.args ?? ""}`.trim();
    case "bash":
      return `! ${row.ev.cmd}`;
    case "fold":
      return `Org work: ${foldLine(row.turns)}`;
    case "group":
      return row.items
        .map((e) => {
          if (e.k === "think") return e.text;
          const res = state.results.get(e.id);
          return [`${toolName(e.name)}: ${e.input?.command ?? toolLine(e.name, e.input)}`, res?.text ?? ""].filter(Boolean).join("\n");
        })
        .join("\n\n");
  }
  return "";
}

// ─── org work: turns the person didn't start ─────────────────────────────

// A message another terminal sent with `hc send` arrives wrapped in <hc from="t7">…</hc> (plain
// <hc> when Herdr itself sends it), and, when it lands while Claude works, inside a
// <pasted_content> block as well.
const RELAYED = /^\s*(?:<pasted_content[^>]*>\s*)?<hc(?: from="([^"]+)")?>([\s\S]*?)(?:<\/hc>)?\s*(?:<\/pasted_content[^>]*>)?\s*$/;

/** `{ from, text }` for a message another terminal (or Herdr: `from` null) sent, else null. */
export function relayed(text) {
  const m = RELAYED.exec(text ?? "");
  return m ? { from: m[1] ?? null, text: m[2].trim() } : null;
}

// Lines HQ, its autopilot and master.py type in on their own (hq.py, workflow_owners.py,
// master.py, the Workflows panel). Matched at the start of the message only.
const ORG_LINES = [
  [/^HQ TICK\b/, "tick"],
  [/^HQ MAIL\b/, "mail"],
  [/^(?:FYI )?HQ DECISION\b/, "decision"],
  [/^HQ WORKFLOW REQUEST\b/, "workflow"],
  [/^WORKFLOW REPORT\b/, "workflow"],
  [/^Resume workflow run\b/, "workflow"],
  [/^HQ:/, "hq"],
  [/^\/compact\s*$/, "compact"], // typed in by HQ's autopilot, so it lands as a plain message
  [/^You are this repository's master chat\b/, "start"],
  [/^You were restarted\. Read your handoff\b/, "start"],
];

/** What started a turn when the person didn't: `{ kind, from }`, else null (theirs). */
export function orgTrigger(e) {
  if (e.k === "cmd") {
    if (e.name === "/loop") return { kind: "tick", from: null };
    if (e.name === "/compact") return { kind: "compact", from: null };
    return null;
  }
  if (e.k !== "user") return null;
  const r = relayed(e.text);
  const text = (r ? r.text : e.text ?? "").trimStart();
  const hit = ORG_LINES.find(([re]) => re.test(text));
  if (hit) return { kind: hit[1], from: r?.from ?? null };
  return r ? { kind: "message", from: r.from } : null;
}

const ORG_WORDS = {
  tick: ["tick", "ticks"],
  mail: ["mail check", "mail checks"],
  decision: ["decision", "decisions"],
  message: ["message", "messages"],
  workflow: ["workflow note", "workflow notes"],
  hq: ["HQ note", "HQ notes"],
  start: ["restart", "restarts"],
  compact: ["compaction", "compactions"],
  schedule: ["scheduled task", "scheduled tasks"],
  background: ["background result", "background results"],
  other: ["unprompted turn", "unprompted turns"],
};

/** "3 ticks · 2 messages from t7s, t49 · 1 decision", for a fold's turns (and messages). */
export function foldLine(turns) {
  const by = new Map();
  for (const x of turns) {
    const g = by.get(x.kind) ?? { n: 0, from: new Set() };
    g.n += 1;
    if (x.from) g.from.add(x.from);
    by.set(x.kind, g);
  }
  return [...by]
    .map(([k, g]) => {
      const [one, many] = ORG_WORDS[k] ?? [k, k];
      const from = g.from.size ? ` from ${[...g.from].slice(0, 3).join(", ")}${g.from.size > 3 ? "…" : ""}` : "";
      return `${g.n} ${g.n === 1 ? one : many}${from}`;
    })
    .join(" · ");
}

const rowTs = (r) => r.ev?.ts ?? r.items?.[0]?.ts ?? null;

/**
 * Folds each run of org-work rows (from buildRows with `foldOrg`) into one "fold" row: its
 * turns, their kinds and times. An open fold keeps its rows after it, then a "foldend" row.
 * `isOpen(key, byDefault)` says which are open. The last run, when nothing of the person's
 * follows it, is open unless folded: it is what the agent is doing now, as its terminal shows.
 */
export function foldOrg(rows, isOpen) {
  const out = [];
  for (let i = 0; i < rows.length; ) {
    if (!rows[i].org) {
      out.push(rows[i++]);
      continue;
    }
    const turns = new Map();
    let j = i;
    for (; j < rows.length && rows[j].org; j++) turns.set(rows[j].org.id, rows[j].org);
    const run = rows.slice(i, j);
    const key = `o:${run[0].key}`;
    const latest = j === rows.length;
    const open = isOpen(key, latest);
    const list = [...turns.values()];
    out.push({ type: "fold", key, turns: list, from: list[0].ts ?? rowTs(run[0]), to: rowTs(run[run.length - 1]), open });
    if (open) out.push(...run);
    if (open && !latest) out.push({ type: "foldend", key: `oe:${run[0].key}`, of: key });
    i = j;
  }
  return out;
}

/**
 * Builds rows. `opt`: { mode: "clean" | "normal" | "verbose", query, cwd, foldOrg }.
 * Each row has a stable `key`. Tool calls and thoughts between two messages become one
 * "group" row (a card of steps); which steps are open is the renderer's business.
 * `foldOrg`: each row also gets `org`, the org turn it belongs to (`{ id, kind, from, ts }`) or
 * null for the person's own; foldOrg() then folds them. Not while searching.
 */
export function buildRows(state, opt) {
  const { mode } = opt;
  const q = (opt.query ?? "").trim().toLowerCase();
  const rows = [];
  let pending = [];
  let afterPrompt = true;
  let turn = 0;
  const fold = !!opt.foldOrg && !q;
  // The turn events belong to: an org turn, or null for the person's. `ended`: the last turn
  // finished, so output that follows with no prompt was started by something unseen (a
  // scheduled prompt or another session's message, which the transcript keeps hidden).
  let cur = null;
  let ended = false;
  let pendingOrg = null;
  let aside = null; // an org message queued into the person's turn: folds alone (see classify)
  // Whose turn started each tool call (null: the person's), so background work reporting back
  // belongs with the turn that started it. A background agent is named by its id in its
  // launch result ("agentId: …").
  const toolOwner = new Map();
  const agentTool = new Map();
  if (fold)
    for (const [id, r] of state.results) {
      const m = /agentId: (\w+)/.exec(r.text ?? "");
      if (m) agentTool.set(m[1], id);
    }
  const ownerOf = (e) => {
    const tool = e.tool ?? (e.agent ? agentTool.get(e.agent) : null);
    return tool && toolOwner.has(tool) ? { owner: toolOwner.get(tool) } : null;
  };
  // A turn can end with no reply written: the model answers in its thinking, then ends the turn
  // with a tool call (a heartbeat's ScheduleWakeup). Its last thought then stands in for the
  // reply, marked as a thought (in every mode: folded in a step group, nobody finds it).
  let said = false;
  let thought = null;
  const start = (trig, e) => {
    cur = trig ? { id: e.id, kind: trig.kind, from: trig.from ?? null, ts: e.ts } : null;
    ended = false;
  };
  const classify = (e) => {
    switch (e.k) {
      case "user": {
        const trig = orgTrigger(e);
        // Another agent's message queued mid-way through the person's turn doesn't end it (what
        // follows answers the person too): only the message itself folds.
        if (trig && e.queued && !cur && !ended) {
          aside = { id: e.id, kind: trig.kind, from: trig.from ?? null, ts: e.ts };
          break;
        }
        start(trig, e);
        break;
      }
      case "cmd":
        start(orgTrigger(e), e);
        break;
      case "bash":
        start(null, e);
        break;
      case "note":
        if (e.kind === "info" && /^Running scheduled task\b/.test(e.text ?? "")) start({ kind: "schedule" }, e);
        // Background work reporting back belongs with the turn that started it (else the one before).
        else if (e.kind === "task" && ended) {
          const o = ownerOf(e);
          start((o ? o.owner : cur) ? { kind: "background" } : null, e);
        }
        else if (e.kind === "interrupt") start(null, e);
        break;
      case "dur":
        ended = true;
        break;
      case "text":
      case "tool":
      case "think":
        // A turn nothing visible started. After the person's own it stays theirs: hiding an answer
        // to them costs more than showing an unprompted turn.
        if (ended) start(cur ? { kind: "other" } : null, e);
        if (e.k === "tool") toolOwner.set(e.id, cur);
        break;
    }
  };

  const flush = () => {
    if (!pending.length) return;
    if (mode !== "clean" || q) {
      const tools = pending.filter((e) => e.k === "tool");
      const key = `g:${pending[0].id}`;
      rows.push({ type: "group", key, items: pending, tools, turn, ...(fold ? { org: pendingOrg } : {}) });
    }
    pending = [];
  };

  for (const e of state.events) {
    const before = rows.length;
    aside = null;
    if (fold) classify(e);
    switch (e.k) {
      case "tool":
      case "think":
        if (!pending.length) pendingOrg = cur;
        pending.push(e);
        if (e.k === "think" && e.text) thought = e;
        break;
      case "text":
        said = true;
        flush();
        rows.push({ type: "text", key: `x:${e.id}`, ev: e, first: afterPrompt, turn });
        afterPrompt = false;
        break;
      case "user":
        if (!e.queued) (said = false), (thought = null);
        flush();
        turn += 1;
        rows.push({ type: "prompt", key: `u:${e.id}`, ev: e, turn });
        afterPrompt = true;
        break;
      case "cmd":
        said = false;
        thought = null;
        flush();
        rows.push({ type: "cmd", key: `c:${e.id}`, ev: e, turn });
        break;
      case "bash":
        flush();
        rows.push({ type: "bash", key: `b:${e.id}`, ev: e, turn });
        break;
      case "bashout": {
        const last = rows[rows.length - 1];
        if (last?.type === "bash") last.out = e;
        break;
      }
      case "note":
        flush();
        if (mode === "clean" && e.kind === "info" && !q) break;
        rows.push({ type: "note", key: `n:${e.id}`, ev: e, turn });
        break;
      case "dur":
        flush();
        if (!said && thought && !q) rows.push({ type: "text", key: `t:${thought.id}`, ev: thought, first: true, thought: true, turn });
        said = true;
        thought = null;
        if (mode !== "clean" || q) rows.push({ type: "dur", key: `d:${e.id}`, ev: e, turn });
        break;
    }
    if (fold) {
      for (let i = before; i < rows.length; i++) {
        const r = rows[i];
        // A recap is written for the person: never folded away.
        if (!("org" in r)) r.org = r.type === "note" && r.ev.kind === "recap" ? null : (aside ?? cur);
      }
    }
  }
  flush();

  if (!q) return rows;
  return rows.filter((r) => r.type !== "dur" && rowText(r, state).toLowerCase().includes(q));
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

export function fmtTokens(n) {
  if (!n) return "";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function shortModel(model) {
  if (!model) return "";
  const m = model.replace(/\[1m\]/i, "").replace(/^claude-/, "");
  const hit = m.match(/^(opus|sonnet|haiku|fable)-(\d+)-(\d+)/);
  const name = hit ? `${hit[1][0].toUpperCase()}${hit[1].slice(1)} ${hit[2]}.${hit[3]}` : m;
  return /\[1m\]/i.test(model) ? `${name} 1M` : name;
}

/** Whole conversation as Markdown, for copying out. */
export function toMarkdown(state, title, cwd) {
  const out = [`# ${title || "Claude Code conversation"}`, ""];
  let tools = [];
  const flushTools = () => {
    if (!tools.length) return;
    out.push("<details><summary>" + groupLine(tools) + "</summary>", "");
    for (const t of tools) out.push(`- **${toolName(t.name)}** ${toolLine(t.name, t.input, cwd)}`);
    out.push("", "</details>", "");
    tools = [];
  };
  for (const e of state.events) {
    if (e.k === "tool") {
      tools.push(e);
      continue;
    }
    if (e.k === "user") {
      flushTools();
      out.push("---", "", "**You**", "", e.text.split("\n").map((l) => `> ${l}`).join("\n"), "");
    } else if (e.k === "text") {
      flushTools();
      out.push(e.text, "");
    } else if (e.k === "cmd") {
      flushTools();
      out.push(`\`${e.name}${e.args ? " " + e.args : ""}\``, "");
    }
  }
  flushTools();
  return out.join("\n");
}

/**
 * The session's todo list, as Claude Code keeps it: the latest TodoWrite's list, or the tasks
 * TaskCreate made and TaskUpdate moved since. `[{ id, text, status }]`, status one of
 * pending | in_progress | completed. Empty when the session never kept one.
 */
export function todosOf(state) {
  let list = [];
  const tasks = new Map();
  let created = 0;
  for (const e of state.events) {
    if (e.k !== "tool") continue;
    const i = e.input ?? {};
    if (e.name === "TodoWrite" && Array.isArray(i.todos)) {
      list = i.todos.map((x, n) => ({ id: String(n), text: x.status === "in_progress" ? (x.activeForm || x.content) : x.content, status: x.status }));
      tasks.clear();
    } else if (e.name === "TaskCreate") {
      const res = state.results.get(e.id);
      const id = res?.text?.match(/#?(\d+)/)?.[1] ?? String(++created);
      tasks.set(id, { id, text: i.subject ?? i.description ?? "Task", status: "pending" });
    } else if (e.name === "TaskUpdate") {
      const id = String(i.taskId ?? i.id ?? "");
      const cur = tasks.get(id);
      if (cur) tasks.set(id, { ...cur, status: i.status ?? cur.status, text: i.subject ?? cur.text });
    }
  }
  return tasks.size ? [...tasks.values()].filter((x) => x.status !== "deleted") : list;
}

/**
 * Work the session started in the background (Bash or Agent with run_in_background) and
 * whether it has reported back: a task notification naming it, or a result that says it ended.
 */
export function backgroundOf(state) {
  const notes = state.events.filter((e) => e.k === "note" && e.kind === "task");
  const out = [];
  for (const e of state.tools.values()) {
    const i = e.input ?? {};
    if (!i.run_in_background) continue;
    const label = i.description || firstLine(i.command ?? i.prompt ?? e.name, 80);
    const done = notes.some((n) => n.ts >= e.ts && label && n.text.includes(label.slice(0, 40)));
    out.push({ id: e.id, kind: e.name === "Bash" ? "shell" : "agent", label, ts: e.ts, done });
  }
  return out.slice(-12);
}
