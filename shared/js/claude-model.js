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
export function absorb(state, events) {
  for (const e of events) {
    if (e.k === "res") state.results.set(e.id, e);
    else {
      if (e.k === "tool") state.tools.set(e.id, e);
      state.events.push(e);
    }
  }
  return state;
}

export const emptyState = () => ({ events: [], tools: new Map(), results: new Map() });

/** The text a row stands for, for search and copy. */
export function rowText(row, state) {
  switch (row.type) {
    case "prompt":
    case "text":
    case "think":
    case "note":
      return row.ev.text ?? "";
    case "cmd":
      return `${row.ev.name} ${row.ev.args ?? ""}`.trim();
    case "bash":
      return `! ${row.ev.cmd}`;
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

/**
 * Builds rows. `opt`: { mode: "clean" | "normal" | "verbose", query, cwd }.
 * Each row has a stable `key`. Tool calls and thoughts between two messages become one
 * "group" row (a card of steps); which steps are open is the renderer's business.
 */
export function buildRows(state, opt) {
  const { mode } = opt;
  const q = (opt.query ?? "").trim().toLowerCase();
  const rows = [];
  let pending = [];
  let afterPrompt = true;
  let turn = 0;

  const flush = () => {
    if (!pending.length) return;
    if (mode !== "clean" || q) {
      const tools = pending.filter((e) => e.k === "tool");
      const key = `g:${pending[0].id}`;
      rows.push({ type: "group", key, items: pending, tools, turn });
    }
    pending = [];
  };

  for (const e of state.events) {
    switch (e.k) {
      case "tool":
      case "think":
        pending.push(e);
        break;
      case "text":
        flush();
        rows.push({ type: "text", key: `x:${e.id}`, ev: e, first: afterPrompt, turn });
        afterPrompt = false;
        break;
      case "user":
        flush();
        turn += 1;
        rows.push({ type: "prompt", key: `u:${e.id}`, ev: e, turn });
        afterPrompt = true;
        break;
      case "cmd":
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
        if (mode !== "clean" || q) rows.push({ type: "dur", key: `d:${e.id}`, ev: e, turn });
        break;
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
