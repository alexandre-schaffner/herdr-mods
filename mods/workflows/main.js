// Claude Code dynamic workflows as a live graph: phases are lanes, units are nodes,
// and a node's drawer lists every agent session that worked on it. Images, videos,
// Markdown and PDFs in a transcript or attached to a step open in the `viewer` mod (viewer.js).

import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { div, View } from "gpui-kit";
import { closeOverlay, exec, focused, home, layout, nextCommand, notify, panes, props, readTextFile, run, settings, spaces, theme } from "herdr";
import { DRAWER_W, drawer, sessionBody } from "./drawer.js";
import { WorkflowEditor } from "./editor.js";
import { dirSwitch, graph } from "./graph.js";
import { collect, testRoots } from "./io.js";
import { library } from "./library.js";
import { hasOutput, outputView } from "./output.js";
import { openLink, openViewer, stage, viewable } from "./viewer.js";
import { openSessionWindow, sessionBar, shellText, terminalsView } from "./terminals.js";
import { blankModel, extract, metaOf } from "./model.js";
import { badge, btn, seg as segmented } from "./ui.js";
import { scrollArea, ago, alpha, buildGraph, clip, compact, duration, icon, look, mix, mono, tildify, ok } from "./util.js";

const POLL_MS = 2500;
const OVERLAY = { width: 0.94, height: 0.9 }; // keep in step with mod.json
const LIST_EVERY = 6;

const isLive = status => status === "running";
const RESUMABLE = ["stalled", "killed", "failed"];
const READY_WAIT_MS = 120_000;
const pause = ms => exec("sleep", [String(ms / 1000)]);

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Shows Workflows: the side panel when the layout has one (the same in every space),
 *  else the Workflows tab, making it the first time. The overlay copy only does this. */
function showTab() {
  const root = layout();
  const body = findNode(root, "panel-body");
  if (body?.children?.some(c => c.id === "workflows")) {
    const panel = findNode(root, "panel");
    if (panel && !panel.hidden && body.active === "workflows") run("layout.hide", { id: "panel" });
    else run("my-tabs.workflows");
    return;
  }
  const pane = panes().find(p => p.mod === "workflows");
  if (!pane) {
    run("tab.new", { name: "Workflows", mod: "workflows" });
    return;
  }
  const space = spaces().find(s => s.tabs.some(tab => tab.id === pane.tab));
  if (space && !space.active) run("space.select", { id: space.id });
  run("tab.select", { id: pane.tab });
  run("pane.focus", { pane: pane.pane });
}

export default class Workflows extends View {
  init(_props, cx) {
    // The title bar of a session's terminal window (terminals.js opens it).
    if (props()?.part === "session-bar") {
      this.bar = props();
      return;
    }
    const overlay = props()?.overlay;
    if (overlay) {
      this.launcher = true;
      cx.spawn(async () => {
        showTab();
        closeOverlay(overlay);
      });
      return;
    }
    this.runs = null;
    this.runId = localStorage.getItem("run");
    this.run = null;
    const sel = JSON.parse(localStorage.getItem("selection") ?? "{}");
    this.nodeId = sel.run === this.runId ? (sel.node ?? null) : null;
    this.session = sel.run === this.runId ? (sel.session ?? null) : null;
    this.tab = "transcript";
    this.transcript = null;
    this.error = null;
    this.tick = 0;
    this.busy = {};
    this.queued = {};
    this.view = localStorage.getItem("view") ?? "runs";
    this.editor = new WorkflowEditor();
    this.lib = { workflows: null, roots: [], loading: false, error: null, confirmDelete: null };
    this.tx = { expanded: new Set(), filter: "all", latestFirst: false };
    this.reader = false;
    // Output view: Graph or Output per run (the person's pick wins), staged thumbnails.
    this.runTabs = {};
    this.thumbs = new Map();
    this.thumbQueue = [];
    this.outExpanded = new Set();
    this.outWidth = null;
    // Terminals: the agent picked per run, its shell, the owning session's terminal.
    this.term = { agentByRun: {}, shell: null, session: null, filter: "shell", follow: true, width: null, stick: false, lines: [] };
    this.termHandle = VirtualListScrollHandle.new();
    cx.timer.every(300, cx => this.pumpThumbs(cx));
    this.refreshList(cx);
    if (this.view === "library") this.refreshLibrary(cx);
    cx.spawn(async cx => {
      try {
        this.editor.agents = (await collect(["agents"])).agents;
        if (this.editor.isOpen()) this.editor.ai.agent = this.editor.pickAgent();
      } catch (e) {
        this.error = `Couldn't list agents: ${e?.message ?? e}`;
      }
      cx.notify();
    });
    cx.timer.every(POLL_MS, cx => this.poll(cx));
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save" && this.editor.isOpen() && !this.editor.hero) this.editor.save(cx);
        if (c === "generate" && this.editor.isOpen()) this.editor.generate(cx, this.editor.hero ? "hero" : "ai");
        // The Resume button by key: the first press arms it, the second sends.
        if (c === "resume") this.resume?.phase === "armed" ? this.confirmResume(cx) : this.armResume(cx);
        if (c === "next-run" || c === "prev-run") {
          const runs = this.visibleRuns();
          const i = runs.findIndex(r => r.id === this.runId);
          const next = runs[(i + (c === "next-run" ? 1 : runs.length - 1)) % runs.length];
          if (next) this.selectRun(next.id, cx);
        }
        cx.notify();
      }
    });
  }

  // ---- library and editor

  setView(view, cx) {
    this.view = view;
    localStorage.setItem("view", view);
    if (view === "library" && !this.lib.workflows) this.refreshLibrary(cx);
    cx.notify();
  }

  folders() {
    const out = [this.hereCwd(), ...panes().map(p => p.cwd), ...spaces().map(s => s.folder)].filter(Boolean);
    return [...new Set(out)];
  }

  refreshLibrary(cx) {
    this.lib.loading = true;
    this.once("library", cx, async () => {
      const r = await collect(["library", ...this.folders()]);
      this.lib = { ...this.lib, workflows: r.workflows, roots: r.roots, rootRepos: r.rootRepos, loading: false, error: null };
    });
  }

  editorHost() {
    return {
      closeEditor: cx => {
        this.editor.close();
        this.refreshLibrary(cx);
        cx.notify();
      },
      // The active repository's checkouts first, so "project" scope means this repository.
      roots: () =>
        [...this.lib.roots].sort(
          (a, b) => (this.lib.rootRepos?.[b]?.key === this.here?.key) - (this.lib.rootRepos?.[a]?.key === this.here?.key),
        ),
      cwd: () => this.hereCwd() ?? home(),
      // The checkout the person is in (a worktree's own root), else the repository's main checkout.
      repoRoot: () => {
        const cwd = this.hereCwd() ?? "";
        const roots = (this.lib.roots ?? []).filter(r => cwd === r || cwd.startsWith(`${r}/`)).sort((a, b) => b.length - a.length);
        return roots[0] ?? this.here?.path ?? cwd ?? home();
      },
      librarySaved: cx => this.refreshLibrary(cx),
    };
  }

  openEditor(cx, doc) {
    this.editor.host = this.editorHost();
    this.editor.open(cx, doc);
    this.setView("library", cx);
  }

  async readWorkflow(w) {
    const script = await readTextFile(w.path);
    if (script == null) throw new Error(`Can't read ${w.path}`);
    return { script, model: extract(script) };
  }

  libraryUi() {
    return {
      ...this.lib,
      here: this.here,
      hereCwd: this.hereCwd(),
      othersOpen: this.othersOpen,
      toggleOthers: cx => {
        this.othersOpen = !this.othersOpen;
        cx.notify();
      },
      setConfirm: (path, cx) => {
        this.lib.confirmDelete = path;
        cx.notify();
      },
      onNewAI: cx => this.openEditor(cx, { hero: true, script: "", scope: "user" }),
      onNewManual: cx => this.openEditor(cx, { model: blankModel(), scope: "user" }),
      onOpen: (w, cx) =>
        cx.spawn(async cx => {
          try {
            const { script, model } = await this.readWorkflow(w);
            this.openEditor(cx, { model, script: model ? null : script, path: w.path, scope: w.scope, root: w.root });
          } catch (e) {
            this.lib.error = String(e?.message ?? e);
          }
          cx.notify();
        }),
      onRun: (w, cx) =>
        cx.spawn(async cx => {
          const { script, model } = await this.readWorkflow(w);
          this.openEditor(cx, { model, script: model ? null : script, path: w.path, scope: w.scope, root: w.root });
          this.editor.openRun(cx);
          cx.notify();
        }),
      onDuplicate: (w, cx) =>
        cx.spawn(async cx => {
          const { script, model } = await this.readWorkflow(w);
          if (model) model.name = `${model.name}-copy`;
          const copy = model ? null : script.replace(/(\bname\s*:\s*['"`])([^'"`]+)/, "$1$2-copy");
          this.openEditor(cx, { model, script: copy, scope: w.scope, root: w.root });
          cx.notify();
        }),
      onDelete: (w, cx) =>
        cx.spawn(async cx => {
          try {
            await collect(["delete", w.path]);
          } catch (e) {
            this.lib.error = String(e?.message ?? e);
          }
          this.lib.confirmDelete = null;
          this.refreshLibrary(cx);
          cx.notify();
        }),
    };
  }

  /** Opens a past run's script in the editor, as code it can save or convert. */
  editRun(cx) {
    const id = this.runId;
    cx.spawn(async cx => {
      try {
        const { script } = await collect(["script", id]);
        if (!script) throw new Error("This run kept no script");
        this.openEditor(cx, { script, model: extract(script), scope: "user" });
        if (!this.lib.workflows) this.refreshLibrary(cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  txUi() {
    return {
      ...this.tx,
      toggle: (key, cx) => {
        if (this.tx.expanded.has(key)) this.tx.expanded.delete(key);
        else this.tx.expanded.add(key);
        cx.notify();
      },
      setFilter: (id, cx) => {
        this.tx.filter = id;
        cx.notify();
      },
      setOrder: (latest, cx) => {
        this.tx.latestFirst = latest;
        cx.notify();
      },
      setExpandAll: (on, cx) => {
        this.tx.expandAll = on;
        this.tx.expanded.clear();
        cx.notify();
      },
    };
  }

  poll(cx) {
    this.tick += 1;
    const live = isLive(this.run?.status);
    if (live) {
      this.refreshRun(cx);
      const s = this.pickedSession();
      if (s && look(s.state, {}).key === "running") this.refreshTranscript(cx);
    }
    if (this.view === "runs" && this.run && this.runTab(this.run) === "terminals") {
      const a = this.termAgent();
      if (live && a && (look(a.state, {}).key === "running" || this.term.shell?.agentId !== a.agentId)) this.refreshShell(cx);
      if (this.tick % 4 === 0) this.refreshSessionTerm(cx);
    }
    const moved = this.hereCwd() !== this.listedFor;
    if (live || moved || this.tick % LIST_EVERY === 0) this.refreshList(cx);
    if (this.editor.isOpen()) this.editor.poll(cx);
  }

  // One fetch per key at a time; a request made meanwhile runs once the current one ends,
  // so the latest selection always loads.
  once(key, cx, work) {
    if (this.busy[key]) {
      this.queued[key] = work;
      return;
    }
    this.busy[key] = true;
    cx.spawn(async cx => {
      let next = work;
      while (next) {
        this.queued[key] = null;
        try {
          await next();
          this.error = null;
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        next = this.queued[key];
        cx.notify();
      }
      this.busy[key] = false;
    });
  }


  refreshList(cx) {
    this.once("list", cx, async () => {
      const cwd = this.hereCwd();
      const { runs, here } = await collect(cwd ? ["list", cwd] : ["list"]);
      this.runs = runs;
      this.listedFor = cwd;
      if (here) this.here = here;
      const visible = this.visibleRuns();
      if (!this.runId || !visible.some(r => r.id === this.runId)) {
        const pick = visible.find(r => isLive(r.status)) ?? visible[0];
        if (pick) this.selectRun(pick.id, cx);
      } else if (!this.run) {
        this.refreshRun(cx);
      } else {
        // A run finishing while shown: reload it once so its final states land.
        const now = runs.find(r => r.id === this.runId);
        if (now && now.status !== this.run.status) this.refreshRun(cx);
      }
    });
  }

  refreshRun(cx) {
    const id = this.runId;
    if (!id) return;
    this.once("run", cx, async () => {
      const run = await collect(["run", id]);
      if (this.runId !== id) return;
      this.run = run;
      if (this.session && !this.transcript) this.refreshTranscript(cx);
      if (this.runTab(run) === "terminals" && this.term.shell?.agentId !== this.termAgent()?.agentId) this.openTerminals(cx);
    });
  }

  refreshTranscript(cx) {
    const s = this.pickedSession();
    if (!s) return;
    const runId = this.runId;
    this.once("transcript", cx, async () => {
      try {
        const data = await collect(["agent", runId, s.agentId]);
        if (this.session === s.agentId) this.transcript = { agentId: s.agentId, data };
      } catch (e) {
        if (this.session === s.agentId) this.transcript = { agentId: s.agentId, error: String(e?.message ?? e) };
      }
    });
  }

  // ---- output

  /** "graph" or "output": a finished run that made viewable files opens on its output. */
  runTab(run) {
    const pick = this.runTabs[run.id];
    if (pick && (pick !== "output" || hasOutput(run))) return pick;
    if (!hasOutput(run)) return "graph";
    const media = run.output.files.some(f => f.exists && ["video", "image", "audio", "pdf", "web"].includes(f.kind));
    return media && !isLive(run.status) ? "output" : "graph";
  }

  setRunTab(tab, cx) {
    if (!this.run) return;
    this.runTabs[this.run.id] = tab;
    if (tab === "terminals") this.openTerminals(cx);
    cx.notify();
  }

  // ---- terminals

  /** The agent the Terminals tab shows: the picked one, else a running one, else the latest. */
  termAgent() {
    const list = this.run?.agentList ?? [];
    const picked = list.find(a => a.agentId === this.term.agentByRun[this.run?.id]);
    if (picked) return picked;
    const byStart = [...list].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return byStart.filter(a => look(a.state, {}).key === "running").pop() ?? byStart.pop() ?? null;
  }

  openTerminals(cx) {
    if (this.term.session?.runId !== this.runId) this.term.session = { runId: this.runId, loading: true };
    this.refreshSessionTerm(cx);
    this.refreshShell(cx);
  }

  refreshShell(cx) {
    const runId = this.runId;
    const a = this.termAgent();
    if (!runId || !a) return;
    this.once("shell", cx, async () => {
      try {
        const data = await collect(["shell", runId, a.agentId]);
        if (this.runId !== runId) return;
        this.term.shell = { agentId: a.agentId, data };
      } catch (e) {
        this.term.shell = { agentId: a.agentId, error: String(e?.message ?? e) };
      }
      if (this.term.follow) this.term.stick = true;
    });
  }

  refreshSessionTerm(cx) {
    const runId = this.runId;
    if (!runId) return;
    this.once("session-term", cx, async () => {
      try {
        const plan = await collect(["resume-plan", runId]);
        if (this.runId === runId) this.term.session = { runId, plan };
      } catch (e) {
        if (this.runId === runId) this.term.session = { runId, error: String(e?.message ?? e) };
      }
    });
  }

  pickTermAgent(agentId, cx) {
    if (!this.run) return;
    this.term.agentByRun[this.run.id] = agentId;
    if (this.term.shell?.agentId !== agentId) this.term.shell = null;
    this.term.follow = true;
    this.term.stick = true;
    this.refreshShell(cx);
    cx.notify();
  }

  /** From an agent's terminal to its transcript: the graph, its node, read wide. */
  showTranscript(agentId, cx) {
    const node = this.graphLanes()
      ?.flatMap(l => l.nodes)
      .find(n => n.sessions.some(s => s.agentId === agentId));
    if (!node) return;
    this.runTabs[this.run.id] = "graph";
    this.nodeId = node.id;
    this.tab = "transcript";
    this.reader = true;
    this.pickSession(agentId, cx);
  }

  /** From a session in the drawer to its terminal. */
  showTerminal(agentId, cx) {
    this.reader = false;
    this.setRunTab("terminals", cx);
    this.pickTermAgent(agentId, cx);
  }

  termUi() {
    const sess = this.term.session?.runId === this.runId ? this.term.session : { loading: true };
    return {
      agent: this.termAgent(),
      shell: this.term.shell,
      session: sess,
      filter: this.term.filter,
      follow: this.term.follow,
      width: this.term.width,
      handle: this.termHandle,
      lines: [],
      onPick: (id, cx) => this.pickTermAgent(id, cx),
      onFilter: (id, cx) => {
        this.term.filter = id;
        if (this.term.follow) this.term.stick = true;
        cx.notify();
      },
      onFollow: (on, cx) => {
        this.term.follow = on;
        if (on) this.term.stick = true;
        cx.notify();
      },
      onCopy: cx => {
        cx.write_to_clipboard(shellText(this.term.lines));
        notify({ title: "Terminal copied", body: `${this.term.lines.length} lines`, level: "success", timeout: 2000 });
      },
      onWidth: (w, cx) => {
        if (Math.abs((this.term.width ?? 0) - w) > 1) {
          this.term.width = w;
          if (this.term.follow) this.term.stick = true;
          cx.notify();
        }
      },
      onOpenSession: () => {
        const plan = sess.plan;
        if (plan?.terminal) openSessionWindow(plan, this.run?.name);
      },
      onTranscript: (id, cx) => this.showTranscript(id, cx),
    };
  }

  /** A staged thumbnail; undefined while it's being made, null when there is none. */
  thumb(f) {
    const key = `${f.path}|${f.mtime}`;
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    if (!this.thumbQueue.some(q => q.key === key)) this.thumbQueue.push({ key, kind: f.kind, path: f.path });
    return undefined;
  }

  pumpThumbs(cx) {
    if (this.thumbBusy || !this.thumbQueue.length) return;
    this.thumbBusy = true;
    const job = this.thumbQueue.shift();
    cx.spawn(async cx => {
      let out = null;
      try {
        out = await stage(job.kind, job.path);
      } catch {
        out = null;
      }
      this.thumbs.set(job.key, out);
      this.thumbBusy = false;
      cx.notify();
    });
  }

  outputUi() {
    return {
      home: home(),
      now: Date.now(),
      width: this.outWidth,
      thumb: f => this.thumb(f),
      open: (f, files) => {
        if (viewable(f.path)) openViewer(f.path, files.map(x => x.path).filter(viewable));
        else exec("open", [f.path]).catch(() => {});
      },
      reveal: f => exec("open", ["-R", f.path]).catch(() => {}),
      system: f => exec("open", [f.path]).catch(() => {}),
      copy: (text, cx) => {
        cx.write_to_clipboard(text);
        notify({ title: "Path copied", body: text, level: "success", timeout: 1600 });
      },
      link: (url, cwd) => openLink(url, cwd),
      expanded: this.outExpanded,
      toggle: (key, cx) => {
        if (this.outExpanded.has(key)) this.outExpanded.delete(key);
        else this.outExpanded.add(key);
        cx.notify();
      },
    };
  }

  selectRun(id, cx) {
    if (this.runId !== id) {
      this.run = null;
      this.nodeId = null;
      this.session = null;
      this.transcript = null;
    }
    this.runId = id;
    localStorage.setItem("run", id);
    this.refreshRun(cx);
    cx.notify();
  }

  selectNode(id, cx) {
    if (this.nodeId === id) {
      this.nodeId = null;
      this.session = null;
      this.remember();
    } else {
      this.nodeId = id;
      const node = this.graphLanes()
        ?.flatMap(l => l.nodes)
        .find(n => n.id === id);
      const last = node?.sessions[node.sessions.length - 1];
      this.pickSession(last?.agentId ?? null, cx);
    }
    cx.notify();
  }

  pickSession(agentId, cx) {
    this.session = agentId;
    this.remember();
    if (this.transcript?.agentId !== agentId) this.transcript = null;
    if (agentId) this.refreshTranscript(cx);
    cx.notify();
  }

  remember() {
    localStorage.setItem("selection", JSON.stringify({ run: this.runId, node: this.nodeId, session: this.session }));
  }

  pickedSession() {
    if (!this.session || !this.run) return null;
    return this.run.agentList?.find(a => a.agentId === this.session) ?? null;
  }

  /** Where the person is working: the focused terminal, else the active space's terminals. */
  hereCwd() {
    const f = focused();
    if (f?.cwd) return (this.lastHere = f.cwd);
    const space = spaces().find(s => s.active);
    const tabs = new Map((space?.tabs ?? []).map(tab => [tab.id, tab.active]));
    const terms = panes().filter(p => p.terminal && p.cwd && tabs.has(p.tab));
    const pick = terms.find(p => tabs.get(p.tab) && p.focused) ?? terms.find(p => tabs.get(p.tab)) ?? terms[0];
    return pick?.cwd ?? this.lastHere ?? null;
  }

  /** The repository the strip shows: one picked in the panel, else the active one. */
  shownRepo() {
    const runs = this.runs ?? [];
    if (this.pinned) return runs.find(r => r.repo?.key === this.pinned)?.repo ?? this.here ?? null;
    return this.here ?? null;
  }

  visibleRuns() {
    const runs = this.runs ?? [];
    const repo = this.shownRepo();
    return repo ? runs.filter(r => r.repo?.key === repo.key) : runs;
  }

  /** Every repository with runs, active first, then by latest activity. */
  repoGroups() {
    const groups = new Map();
    for (const r of this.runs ?? []) {
      if (!r.repo) continue;
      const g = groups.get(r.repo.key) ?? { repo: r.repo, runs: [], latest: 0, live: 0 };
      g.runs.push(r);
      g.latest = Math.max(g.latest, r.endedAt ?? r.startedAt ?? 0);
      if (isLive(r.status)) g.live += 1;
      groups.set(r.repo.key, g);
    }
    return [...groups.values()].sort((a, b) => (b.repo.key === this.here?.key) - (a.repo.key === this.here?.key) || b.latest - a.latest);
  }

  pinRepo(key, cx, runId) {
    this.pinned = key && key !== this.here?.key ? key : null;
    this.repoPanel = false;
    const runs = this.visibleRuns();
    const pick = runId ?? (runs.some(r => r.id === this.runId) ? this.runId : (runs.find(r => isLive(r.status)) ?? runs[0])?.id);
    if (pick) this.selectRun(pick, cx);
    cx.notify();
  }

  graphLanes() {
    if (!this.run) return null;
    if (this._graphFor !== this.run) {
      this._graphFor = this.run;
      this._lanes = buildGraph(this.run, theme());
    }
    return this._lanes;
  }

  // ---- resume

  /** First click: look up who owns the run and where its session is, then ask. */
  armResume(cx) {
    const run = this.run;
    if (!run || !RESUMABLE.includes(run.status)) return;
    this.resume = { runId: run.id, phase: "checking" };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const plan = await collect(["resume-plan", run.id]);
        if (this.resume?.runId !== run.id) return;
        if (!plan.resumable) {
          this.resume = null;
          notify({ title: "Nothing to resume", body: `${run.name} is ${plan.status}.`, level: "info", timeout: 3000 });
        } else this.resume = { runId: run.id, phase: "armed", plan };
      } catch (e) {
        this.resume = null;
        notify({ title: "Couldn't check the run", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  cancelResume(cx) {
    this.resume = null;
    cx.notify();
  }

  /** Second click: type the request into the session's terminal, or open the session first. */
  confirmResume(cx) {
    const r = this.resume;
    if (r?.phase !== "armed") return;
    const { plan } = r;
    r.phase = plan.session.alive ? "sending" : "opening";
    cx.notify();
    cx.spawn(async cx => {
      try {
        if (plan.session.alive) {
          if (!plan.terminal) throw new Error(`No Herdr terminal shows session ${plan.session.name ?? plan.sessionId.slice(0, 8)}`);
          const out = await collect(["resume", plan.runId]);
          notify({ title: `Resume sent to ${out.terminal.where ?? out.terminal.address}`, body: out.text, level: "success", timeout: 5000 });
        } else {
          const space = spaces().find(s => s.active)?.id ?? "";
          const opened = await collect(["resume-open", plan.runId, space]);
          const addr = opened.terminal.address;
          r.opened = addr;
          cx.notify();
          const sent = await this.sendWhenReady(plan, addr);
          if (sent) notify({ title: `Resumed in a new terminal (${addr})`, body: sent.text, level: "success", timeout: 5000 });
          else {
            cx.write_to_clipboard(plan.text);
            notify({ title: `Opened ${addr}, but it never reported ready`, body: "The resume request is on the clipboard; paste it there.", level: "warning" });
          }
        }
        this.refreshRun(cx);
        this.refreshList(cx);
      } catch (e) {
        notify({ title: "Resume not sent", body: String(e?.message ?? e), level: "error" });
      }
      this.resume = null;
      cx.notify();
    });
  }

  /** Waits for the terminal resume-open started to run an idle Claude Code, then sends.
   *  A program that never reports a status (a test stand-in) counts as ready after 20 s. */
  async sendWhenReady(plan, addr) {
    const started = Date.now();
    const bin = (testRoots?.claude ?? "claude").split("/").pop();
    while (Date.now() - started < READY_WAIT_MS) {
      await pause(1500);
      const now = await collect(["resume-plan", plan.runId]);
      const t = now.opened?.address === addr ? now.opened : null;
      if (!t) continue;
      const runsBin = (t.foreground ?? []).some(arg => arg.split("/").pop() === bin);
      const ready = (t.app === "claude-code" && ["idle", "done"].includes(t.state)) || (!t.app && runsBin && Date.now() - started > 20_000);
      if (ready) return collect(["resume", plan.runId, addr]);
    }
    return null;
  }

  resumeButton(t, run) {
    const r = this.resume?.runId === run.id ? this.resume : null;
    const busy = r && r.phase !== "armed";
    return btn(t, "resume-run", busy ? (r.phase === "checking" ? "Checking…" : r.phase === "opening" ? "Opening session…" : "Sending…") : "Resume", cx => (r ? null : this.armResume(cx)), {
      icon: busy ? "spinner" : "play",
      size: "sm",
      kind: r ? "secondary" : "primary",
      disabled: !!r,
      tooltip: "Ask the run's own Claude Code session to resume it (Workflow resumeFromRunId)",
    });
  }

  /** The confirm row under the header: what will be typed, and where. */
  resumeConfirm(t, run) {
    const r = this.resume;
    if (r?.runId !== run.id || r.phase !== "armed") return null;
    const p = r.plan;
    const who = p.session.name ?? p.sessionId.slice(0, 8);
    const where = p.session.alive
      ? p.terminal
        ? `Type this into ${p.terminal.where ? `${p.terminal.where} (${p.terminal.address}` : `${p.terminal.address} (`}session ${who})?`
        : `Session ${who} is alive (pid ${p.session.pid}) but no Herdr terminal shows it. Copy the request and paste it there.`
      : `Session gone. Open \`${p.openCommand}\` in a new tab in ${tildify(p.cwd, home())}, then type this into it? (Inferred: a resumed session keeps its id.)`;
    const canSend = !p.session.alive || !!p.terminal;
    return v_flex()
      .max_w(880)
      .gap(8)
      .px(12)
      .py(10)
      .rounded(9)
      .bg(alpha(t.accent, 0.07))
      .border(1)
      .border_color(alpha(t.accent, 0.4))
      .child(div().text_size(12).text_color(t.foreground).child(where))
      .child(div().font_family(mono()).text_size(10.5).text_color(t.muted).child(clip(p.text, 400)))
      .child(
        h_flex()
          .gap(8)
          .child(
            canSend
              ? btn(t, "resume-send", p.session.alive ? "Send resume" : "Open and resume", cx => this.confirmResume(cx), { icon: "play", kind: "primary", size: "sm" })
              : btn(t, "resume-copy", "Copy request", cx => {
                  cx.write_to_clipboard(p.text);
                  notify({ title: "Resume request copied", body: p.text, level: "success", timeout: 2500 });
                  this.cancelResume(cx);
                }, { icon: "copy", kind: "primary", size: "sm" }),
          )
          .child(btn(t, "resume-cancel", "Cancel", cx => this.cancelResume(cx), { kind: "ghost", size: "sm" })),
      );
  }

  /** Why a run without a current record counts as running or stalled. */
  livenessLine(t, run) {
    const lv = run.liveness;
    if (!lv?.text) return null;
    const color = lv.status === "running" ? t.working : lv.reason === "gone" ? t.blocked : (t.idle ?? t.muted);
    const name = lv.reason === "waiting" ? "wrench" : lv.reason === "gone" ? "x" : lv.reason === "quiet" ? "clock" : "bolt";
    return h_flex()
      .gap(8)
      .items_center()
      .max_w(880)
      .child(icon(name, 12, color))
      .when(!!run.resumed, el => el.child(badge(t, "resumed", t.accent)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(color).child(lv.text));
  }

  // ---- render

  topBar(t, live) {
    const overlay = props()?.overlay;
    return h_flex()
      .flex_none()
      .h(52)
      .px(18)
      .gap(12)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .child(
        div()
          .w(30)
          .h(30)
          .rounded(9)
          .bg(alpha(t.accent, 0.14))
          .border(1)
          .border_color(alpha(t.accent, 0.35))
          .flex()
          .items_center()
          .justify_center()
          .child(icon("flow", 16, t.accent)),
      )
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Workflows"))
      .child(
        segmented(
          t,
          "view",
          [
            { id: "runs", label: "Runs", icon: "flow" },
            { id: "library", label: "Library", icon: "layers" },
          ],
          this.view,
          (id, cx) => this.setView(id, cx),
        ),
      )
      .child(div().flex_1())
      .when(live > 0, el =>
        el.child(
          h_flex()
            .gap(7)
            .px(10)
            .h(24)
            .rounded_full()
            .items_center()
            .bg(alpha(t.working, 0.12))
            .child(div().w(7).h(7).rounded_full().bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1000 }))
            .child(div().text_size(11.5).font_medium().text_color(t.working).child(`${live} live`)),
        ),
      )

      .when(!!overlay, el =>
        el.child(
          div()
            .id("close")
            .w(28)
            .h(28)
            .rounded(8)
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(s => s.bg(alpha(t.foreground, 0.08)))
            .on_click(() => closeOverlay(overlay))
            .child(icon("x", 14, t.muted)),
        ),
      );
  }

  repoChip(t) {
    const repo = this.shownRepo();
    const others = this.repoGroups().filter(g => g.repo.key !== repo?.key);
    const otherLive = others.reduce((n, g) => n + g.live, 0);
    return h_flex()
      .flex_none()
      .h_full()
      .pl(18)
      .pr(14)
      .gap(10)
      .items_center()
      .border_r(1)
      .border_color(alpha(t.border, 0.8))
      .child(
        v_flex()
          .id("repo-chip")
          .w(210)
          .px(12)
          .py(8)
          .gap(4)
          .rounded(11)
          .border(1)
          .border_color(this.repoPanel ? t.accent : t.border)
          .bg(this.repoPanel ? alpha(t.accent, 0.06) : t.background)
          .cursor_pointer()
          .hover(s => s.border_color(alpha(t.accent, 0.5)))
          .on_click((_e, cx) => {
            this.repoPanel = !this.repoPanel;
            cx.notify();
          })
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(icon("folder", 12, this.pinned ? t.muted : t.accent))
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(repo?.name ?? "All repositories"))
              .child(icon("chevron-down", 11, t.dim)),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(10.5).text_color(this.pinned ? t.working : t.dim).child(this.pinned ? "other repository" : "active repository"))
              .child(div().flex_1())
              .when(others.length > 0, el =>
                el.child(
                  h_flex()
                    .gap(4)
                    .items_center()
                    .when(otherLive > 0, el2 => el2.child(div().w(6).h(6).rounded_full().bg(t.working).loop("opacity", { from: 0.3, to: 1, period: 1000 })))
                    .child(div().text_size(10.5).text_color(t.dim).child(`+${others.length} repo${others.length > 1 ? "s" : ""}`)),
                ),
              ),
          ),
      )
      .when(!!this.pinned, el =>
        el.child(btn(t, "repo-back", "", cx => this.pinRepo(null, cx), { icon: "arrow-left", kind: "ghost", size: "sm", tooltip: `Back to ${this.here?.name ?? "the active repository"}` })),
      );
  }

  /** Other repositories, tidy: each with its count and latest runs; picking one shows it. */
  repoPanelView(t, now) {
    const groups = this.repoGroups();
    const shown = this.shownRepo()?.key;
    const card = g => {
      const active = g.repo.key === this.here?.key;
      return v_flex()
        .id(`rp-${g.repo.key}`)
        .p(10)
        .gap(6)
        .rounded(11)
        .border(1)
        .border_color(g.repo.key === shown ? t.accent : t.border)
        .bg(t.background)
        .child(
          h_flex()
            .id(`rp-head-${g.repo.key}`)
            .gap(8)
            .items_center()
            .cursor_pointer()
            .on_click((_e, cx) => this.pinRepo(g.repo.key, cx))
            .child(icon("folder", 13, active ? t.accent : t.dim))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(g.repo.name))
                .child(div().truncate().font_family(mono()).text_size(10).text_color(t.dim).child(tildify(g.repo.path, home()))),
            )
            .when(g.live > 0, el => el.child(badge(t, `${g.live} live`, t.working)))
            .child(div().text_size(11).text_color(t.dim).child(`${g.runs.length} run${g.runs.length > 1 ? "s" : ""} · ${ago(g.latest, now)}`)),
        )
        .children(
          g.runs.slice(0, 3).map(r => {
            const lk = look(r.status, t);
            return h_flex()
              .id(`rp-run-${r.id}`)
              .h(26)
              .pl(21)
              .pr(6)
              .gap(8)
              .items_center()
              .rounded(7)
              .cursor_pointer()
              .hover(s => s.bg(alpha(t.foreground, 0.05)))
              .on_click((_e, cx) => this.pinRepo(g.repo.key, cx, r.id))
              .child(div().w(6).h(6).rounded_full().bg(lk.color))
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(r.name))
              .child(div().text_size(10.5).text_color(t.dim).child(isLive(r.status) ? "live" : ago(r.endedAt ?? r.startedAt, now)));
          }),
        )
        .when(g.runs.length > 3, el =>
          el.child(
            h_flex()
              .id(`rp-more-${g.repo.key}`)
              .pl(21)
              .cursor_pointer()
              .on_click((_e, cx) => this.pinRepo(g.repo.key, cx))
              .child(div().text_size(11).text_color(t.accent).child(`Show all ${g.runs.length} runs`)),
          ),
        );
    };
    const active = groups.filter(g => g.repo.key === this.here?.key);
    const others = groups.filter(g => g.repo.key !== this.here?.key);
    return div()
      .absolute()
      .top(0)
      .left(0)
      .right(0)
      .bottom(0)
      .child(div().id("rp-backdrop").absolute().top(0).left(0).right(0).bottom(0).on_click((_e, cx) => ((this.repoPanel = false), cx.notify())))
      .child(
        v_flex()
          .absolute()
          .top(52 + 74)
          .left(18)
          .w(440)
          .max_h(560)
          .rounded(14)
          .bg(t.popover ?? t.background)
          .border(1)
          .border_color(t.border)
          .shadow_lg()
          .child(
            scrollArea(
              "rp-scroll",
              "y",
              v_flex()
                .p(12)
                .gap(8)
                .child(div().px(2).text_size(10.5).font_semibold().text_color(t.dim).child("ACTIVE REPOSITORY"))
                .children(active.length ? active.map(card) : [div().px(2).pb(4).text_size(11.5).text_color(t.dim).child(this.here ? `No runs in ${this.here.name} yet.` : "No repository in focus.")])
                .when(others.length > 0, el =>
                  el.child(div().px(2).pt(8).text_size(10.5).font_semibold().text_color(t.dim).child("OTHER REPOSITORIES")).children(others.map(card)),
                ),
            ),
          ),
      );
  }

  runStrip(t, runs, now) {
    return h_flex()
      .flex_none()
      .h(78)
      .min_w(0)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .bg(alpha(t.foreground, 0.015))
      .child(this.repoChip(t))
      .child(
        h_flex()
          .id("runs")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .overflow_x_scroll()
          .px(14)
          .gap(10)
          .when(!runs.length, el => el.child(div().text_size(12).text_color(t.dim).child(`No workflow runs in ${this.shownRepo()?.name ?? "this repository"} yet.`)))
          .children(
        runs.map(r => {
          const lk = look(r.status, t);
          const sel = r.id === this.runId;
          const when = isLive(r.status) ? `started ${ago(r.startedAt, now)}` : ago(r.endedAt ?? r.startedAt, now);
          return v_flex()
            .id(`run-${r.id}`)
            .flex_none()
            .w(228)
            .px(12)
            .py(9)
            .gap(5)
            .rounded(11)
            .bg(sel ? mix(t.background, t.accent, 0.08) : t.background)
            .border(1)
            .border_color(sel ? t.accent : t.border)
            .cursor_pointer()
            .hover(s => s.border_color(sel ? t.accent : alpha(t.accent, 0.5)))
            .on_click((_e, cx) => this.selectRun(r.id, cx))
            .child(
              h_flex()
                .gap(7)
                .items_center()
                .child(
                  div()
                    .flex_none()
                    .w(7)
                    .h(7)
                    .rounded_full()
                    .bg(lk.color)
                    .when(lk.key === "running", el => el.loop("opacity", { from: 0.25, to: 1, period: 1000 })),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12.5)
                    .font_semibold()
                    .text_color(t.foreground)
                    .child(r.name),
                ),
            )
            .child(
              div()
                .truncate()
                .text_size(10.5)
                .text_color(t.dim)
                .child(
                  [
                    when,
                    `${r.agents ?? 0} agents`,
                    r.failed ? `${r.failed} failed` : null,
                    r.resumed && isLive(r.status) ? "resumed" : null,
                    r.liveness?.reason === "gone" ? "session gone" : r.liveness?.reason === "quiet" ? "quiet" : null,
                    r.liveness?.reason === "waiting" ? `waiting on ${r.liveness.waiting[0]?.tool}` : null,
                  ]
                    .filter(Boolean)
                    .join("  ·  "),
                ),
            );
        }),
      ),
      );
  }

  runHeader(t, run, lanes, now) {
    const lk = look(run.status, t);
    const span = (run.endedAt ?? now) - (run.startedAt ?? now);
    const total = lanes.reduce((n, l) => n + l.nodes.length, 0) || 1;
    const pill = (text, color) =>
      h_flex()
        .gap(6)
        .px(9)
        .h(22)
        .rounded_full()
        .items_center()
        .bg(alpha(color, 0.13))
        .child(div().w(6).h(6).rounded_full().bg(color))
        .child(div().text_size(11).font_medium().text_color(color).child(text));
    const fact = (name, value) =>
      h_flex()
        .gap(5)
        .items_center()
        .child(icon(name, 12, t.dim))
        .child(div().font_family(mono()).text_size(11.5).text_color(t.muted).child(value));
    const lastLog = run.logs?.[run.logs.length - 1];
    return v_flex()
      .flex_none()
      .px(28)
      .pt(22)
      .pb(18)
      .gap(10)
      .child(
        div()
          .font_family(mono())
          .text_size(10.5)
          .text_color(t.dim)
          .truncate()
          .child([run.id, tildify(run.cwd, home())].filter(Boolean).join("  ·  ")),
      )
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(div().text_size(23).font_semibold().text_color(t.foreground).child(run.name))
          .child(pill(lk.label, lk.color))
          .child(div().flex_1())
          .when(this.runTab(run) === "graph", el => el.child(dirSwitch(t, "run-dir")))
          .child(
            segmented(t, "run-tab", [
              { id: "graph", label: "Graph", icon: "flow" },
              { id: "terminals", label: "Terminals", icon: "terminal" },
              ...(hasOutput(run)
                ? [{ id: "output", label: run.output.files.filter(f => f.exists).length ? `Output · ${run.output.files.filter(f => f.exists).length}` : "Output", icon: "sparkles" }]
                : []),
            ], this.runTab(run), (id, cx) => this.setRunTab(id, cx), { size: "sm" }),
          )
          .when(RESUMABLE.includes(run.status), el => el.child(this.resumeButton(t, run)))
          .child(btn(t, "edit-run", "Edit as workflow", cx => this.editRun(cx), { icon: "square-pen", size: "sm", tooltip: "Open this run's script in the editor" })),
      )
      .when(!!run.liveness?.text, el => el.child(this.livenessLine(t, run)))
      .when(this.resume?.runId === run.id && this.resume.phase === "armed", el => el.child(this.resumeConfirm(t, run)))
      .when(!!run.description, el =>
        el.child(
          div().max_w(880).text_size(12.5).line_height(1.5).text_color(t.muted).child(clip(run.description, 260)),
        ),
      )
      .child(
        h_flex()
          .gap(18)
          .items_center()
          .child(fact("clock", duration(span)))
          .child(fact("layers", `${run.done ?? 0}/${run.agentList?.length ?? run.agents ?? 0} agents`))
          .when(run.tokens != null, el => el.child(fact("bolt", `${compact(run.tokens)} tokens`)))
          .when(run.toolCalls != null, el => el.child(fact("wrench", `${run.toolCalls} tool calls`)))
          .child(
            div()
              .text_size(11.5)
              .text_color(t.dim)
              .child(isLive(run.status) ? `started ${ago(run.startedAt, now)}` : `finished ${ago(run.endedAt, now)}`),
          ),
      )
      .child(
        h_flex()
          .mt(4)
          .gap(4)
          .w_full()
          .max_w(880)
          .children(
            lanes.map(l => {
              const n = l.nodes.length || 1;
              return v_flex()
                .w(`${Math.max(6, (l.nodes.length / total) * 100)}%`)
                .gap(5)
                .child(
                  h_flex()
                    .h(5)
                    .rounded_full()
                    .overflow_hidden()
                    .bg(alpha(t.foreground, 0.08))
                    .child(
                      div()
                        .h_full()
                        .w(`${(l.done / n) * 100}%`)
                        .bg(ok(t)),
                    )
                    .child(
                      div()
                        .h_full()
                        .w(`${(l.failed / n) * 100}%`)
                        .bg(t.blocked),
                    )
                    .child(
                      div()
                        .h_full()
                        .w(`${(l.live / n) * 100}%`)
                        .bg(t.working)
                        .loop("opacity", { from: 0.4, to: 1, period: 1200 }),
                    ),
                )
                .child(
                  div()
                    .truncate()
                    .text_size(10)
                    .text_color(l.live ? t.working : t.dim)
                    .child(l.title),
                );
            }),
          ),
      )
      .when(!!run.error, el =>
        el.child(
          h_flex()
            .gap(8)
            .px(12)
            .py(8)
            .rounded(9)
            .max_w(880)
            .bg(alpha(t.blocked, 0.1))
            .border(1)
            .border_color(alpha(t.blocked, 0.35))
            .child(icon("x", 13, t.blocked))
            .child(
              div()
                .flex_1()
                .text_size(11.5)
                .text_color(t.blocked)
                .child(clip(String(run.error), 300)),
            ),
        ),
      )
      .when(!!lastLog && !run.error, el =>
        el.child(
          h_flex()
            .gap(7)
            .items_center()
            .child(icon("terminal", 12, t.dim))
            .child(
              div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.dim).child(lastLog),
            ),
        ),
      );
  }

  // An overlay is as tall as its content, so a dialog copy takes mod.json's share of the
  // window explicitly; scroll regions inside then have a bounded height to overflow.
  sized(el) {
    if (!props()?.overlay) return el.size_full();
    const vp = window.viewport_size();
    const zoom = Number(settings()?.zoom) || 1;
    return el.w(Math.floor((vp.width * OVERLAY.width) / zoom)).h(Math.floor((vp.height * OVERLAY.height) / zoom));
  }

  empty(t, title, body, spinning) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(10)
      .child(spinning ? icon("spinner", 22, t.muted).spin(900) : icon("flow", 28, t.dim))
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .when(!!body, el => el.child(div().max_w(420).text_center().text_size(12).text_color(t.muted).child(body)));
  }

  terminals(t, lanes, now) {
    const ui = this.termUi();
    const el = terminalsView(t, this.run, lanes, ui, now);
    this.term.lines = ui.lines ?? [];
    if (this.term.stick && this.term.lines.length) {
      this.termHandle.scroll_to_bottom();
      this.term.stick = false;
    }
    return el;
  }

  /** One session's transcript, wide: the graph steps aside while reading. */
  readerPane(t, node) {
    const s = this.pickedSession();
    const state = this.transcript?.agentId === s.agentId ? this.transcript : null;
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .flex_none()
          .h(52)
          .px(24)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(alpha(t.border, 0.8))
          .child(btn(t, "reader-back", "Graph", cx => ((this.reader = false), cx.notify()), { icon: "arrow-left", kind: "ghost", size: "sm" }))
          .child(div().w(1).h(20).bg(t.border))
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child(s.label))
          .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(`${node?.phase ?? ""} · ${s.agentId}`))
          .child(div().flex_1())
          .child(btn(t, "reader-term", "Terminal", cx => this.showTerminal(s.agentId, cx), { icon: "terminal", kind: "ghost", size: "sm", tooltip: "This agent's commands and output, as a terminal" }))
          .child(
            segmented(t, "reader-tab", [
              { id: "transcript", label: "Transcript" },
              { id: "prompt", label: "Prompt" },
              { id: "result", label: "Result" },
            ], this.tab, (id, cx) => ((this.tab = id), cx.notify()), { size: "sm" }),
          ),
      )
      .child(
        scrollArea(
          "reader-scroll",
          "y",
          v_flex()
            .items_center()
            .child(div().w_full().max_w(880).px(28).py(22).child(sessionBody(s, state, this.tab, t, this.txUi()))),
        ),
      );
  }

  render(_cx) {
    if (this.bar) return sessionBar(theme(), this.bar);
    if (this.launcher) return div();
    const t = theme();
    const now = Date.now();
    const runs = this.visibleRuns();
    const live = (this.runs ?? []).filter(r => isLive(r.status)).length;
    const lanes = this.graphLanes();
    const tab = this.run ? this.runTab(this.run) : "graph";
    const node = tab === "terminals" ? null : (lanes?.flatMap(l => l.nodes).find(n => n.id === this.nodeId) ?? null);

    let main;
    if (this.view === "library")
      main = this.editor.isOpen()
        ? div().flex_1().min_h(0).child(this.editor.render(t, this.editorHost()))
        : v_flex().flex_1().min_h(0).bg(t.canvas ?? mix(t.background, t.foreground, 0.02)).child(library(t, this.libraryUi()));
    else if (this.runs === null) main = this.empty(t, "Reading workflow runs…", null, true);
    else if (!runs.length)
      main = this.empty(
        t,
        this.shownRepo() ? `No workflow runs in ${this.shownRepo().name}` : "No workflow runs yet",
        (this.runs ?? []).length
          ? "Runs from your other repositories are one click away in the repository menu on the left."
          : "Runs appear when a Claude Code session starts a dynamic workflow.",
      );
    else if (!this.run || !lanes) main = this.empty(t, "Loading run…", null, true);
    else
      main = h_flex()
        .flex_1()
        .min_h(0)
        .min_w(0)
        .overflow_hidden()
        .items_stretch()
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .min_h(0)
            .overflow_hidden()
            .when(!this.reader || !this.pickedSession() || tab === "terminals", el => el.child(this.runHeader(t, this.run, lanes, now)))
            .when(this.reader && !!this.pickedSession() && tab !== "terminals", el => el.child(this.readerPane(t, node)))
            .when((!this.reader || !this.pickedSession()) && tab === "terminals", el => el.child(this.terminals(t, lanes, now)))
            .when((!this.reader || !this.pickedSession()) && tab === "output", el => el.child(
              scrollArea(
                "output-scroll",
                "y",
                div()
                  .border_t(1)
                  .border_color(alpha(t.border, 0.6))
                  .bg(t.canvas ?? mix(t.background, t.foreground, 0.02))
                  .on_size_change((size, cx) => {
                    if (Math.abs((this.outWidth ?? 0) - size.width) > 1) {
                      this.outWidth = size.width;
                      cx.notify();
                    }
                  })
                  .child(outputView(t, this.run, this.outputUi())),
              ),
            ))
            .when((!this.reader || !this.pickedSession()) && tab === "graph", el => el.child(
              scrollArea(
                "graph-scroll",
                "both",
                div()
                  .border_t(1)
                  .border_color(alpha(t.border, 0.6))
                  .bg(t.canvas ?? mix(t.background, t.foreground, 0.02))
                  .child(
                    lanes.some(l => l.nodes.length)
                      ? graph(lanes, t, this.nodeId, (id, cx) => this.selectNode(id, cx))
                      : this.empty(t, "Waiting for the first agent…", null, isLive(this.run.status)),
                  ),
              ),
            )),
        )
        .child(
          v_flex()
            .id("drawer-slot")
            .flex_none()
            .min_h(0)
            .overflow_hidden()
            .w(node ? DRAWER_W : 0)
            .transition("width", { duration: 220, easing: "ease-out" })
            .child(
              drawer(
                node,
                t,
                {
                  session: this.session,
                  tab: this.tab,
                  transcript: this.transcript,
                  onClose: cx => {
                    this.nodeId = null;
                    this.session = null;
                    this.remember();
                    cx.notify();
                  },
                  onPick: (id, cx) => this.pickSession(id, cx),
                  onTab: (id, cx) => {
                    this.tab = id;
                    cx.notify();
                  },
                  tx: this.txUi(),
                  reader: this.reader,
                  onReader: cx => {
                    this.reader = true;
                    cx.notify();
                  },
                  onTerminal: (id, cx) => this.showTerminal(id, cx),
                },
                now,
              ),
            ),
        );

    return v_flex()
      .id("root")
      .relative()
      .map(el => this.sized(el))
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .child(this.topBar(t, live))
      .when(this.view === "runs" && this.runs !== null, el => el.child(this.runStrip(t, runs, now)))
      .when(!!testRoots, el =>
        el.child(
          div()
            .flex_none()
            .px(18)
            .py(5)
            .bg(alpha(t.working, 0.12))
            .text_size(11)
            .text_color(t.working)
            .child(`Test data: ${testRoots.projects ?? ""} · delete data/workflows/test-roots.json for real runs`),
        ),
      )
      .when(!!this.error, el =>
        el.child(
          h_flex()
            .flex_none()
            .px(18)
            .py(7)
            .gap(8)
            .bg(alpha(t.blocked, 0.1))
            .child(icon("x", 12, t.blocked))
            .child(div().flex_1().truncate().text_size(11.5).text_color(t.blocked).child(this.error)),
        ),
      )
      .child(main)
      .when(this.view === "runs" && !!this.repoPanel, el => el.child(this.repoPanelView(t, now)));
  }
}
