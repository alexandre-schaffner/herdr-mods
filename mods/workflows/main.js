// Claude Code dynamic workflows as a live graph: phases are lanes, units are nodes,
// and a node's drawer lists every agent session that worked on it. Images, videos,
// Markdown and PDFs in a transcript or attached to a step open in the `viewer` mod (viewer.js).

import { h_flex, v_flex, VirtualListScrollHandle } from "gpui-base";
import { div, View } from "gpui-kit";
import { closeOverlay, exec, home, layout, nextCommand, notify, panes, props, readTextFile, run, spaces, theme } from "herdr";
import { DRAWER_W, drawer, sessionBody } from "./drawer.js";
import { WorkflowEditor } from "./editor.js";
import { generate, pickAgent, poll } from "./editor/ai.js";
import { graph } from "./graph.js";
import { runHeader, runStrip, topBar } from "./header.js";
import { collect } from "./io.js";
import { library } from "./library.js";
import { hasOutput, outputView } from "./output.js";
import { hereCwd, repoPanelView, shownRepo, visibleRuns } from "./repos.js";
import { armResume, confirmResume, goToOwner } from "./resume.js";
import { buildGraph, isLive } from "./runs.js";
import { openLink, openViewer, stage, viewable } from "./shared/viewer-link.js";
import { openSessionWindow, sessionBar, shellText, terminalsView } from "./terminals.js";
import { blankModel, designOf } from "./model.js";
import { btn, seg as segmented } from "./ui.js";
import { scrollArea, alpha, icon, look, mix, mono } from "./util.js";

/** A saved script as the editor opens it: its design, or its code, with the design it
 * strayed from when it was edited by hand. */
function opened(script) {
  const { model, edited } = designOf(script);
  return edited ? { model: null, script, design: model } : { model, script: model ? null : script };
}

const POLL_MS = 2500;
const LIST_EVERY = 6;

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
        if (this.editor.isOpen()) this.editor.ai.agent = pickAgent(this.editor);
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
        if (c === "generate" && this.editor.isOpen()) generate(this.editor, cx, this.editor.hero ? "hero" : "ai");
        // The Resume button by key: the first press arms it, the second sends.
        if (c === "resume") this.resume?.phase === "armed" ? confirmResume(this, cx) : armResume(this, cx);
        if (c === "next-run" || c === "prev-run") {
          const runs = visibleRuns(this);
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
    const out = [hereCwd(this), ...panes().map(p => p.cwd), ...spaces().map(s => s.folder)].filter(Boolean);
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
      cwd: () => hereCwd(this) ?? home(),
      // The checkout the person is in (a worktree's own root), else the repository's main checkout.
      repoRoot: () => {
        const cwd = hereCwd(this) ?? "";
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
    return opened(script);
  }

  libraryUi() {
    return {
      ...this.lib,
      here: this.here,
      hereCwd: hereCwd(this),
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
            const doc = await this.readWorkflow(w);
            this.openEditor(cx, { ...doc, path: w.path, scope: w.scope, root: w.root });
          } catch (e) {
            this.lib.error = String(e?.message ?? e);
          }
          cx.notify();
        }),
      onRun: (w, cx) =>
        cx.spawn(async cx => {
          try {
            const doc = await this.readWorkflow(w);
            this.openEditor(cx, { ...doc, path: w.path, scope: w.scope, root: w.root });
            this.editor.openRun(cx);
          } catch (e) {
            this.lib.error = String(e?.message ?? e);
          }
          cx.notify();
        }),
      onDuplicate: (w, cx) =>
        cx.spawn(async cx => {
          try {
            const { script, model } = await this.readWorkflow(w);
            if (model) model.name = `${model.name}-copy`;
            const copy = model ? null : script.replace(/(\bname\s*:\s*['"`])([^'"`]+)/, "$1$2-copy");
            this.openEditor(cx, { model, script: copy, scope: w.scope, root: w.root });
          } catch (e) {
            this.lib.error = String(e?.message ?? e);
          }
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
        this.openEditor(cx, { ...opened(script), scope: "user" });
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
    const moved = hereCwd(this) !== this.listedFor;
    if (live || moved || this.tick % LIST_EVERY === 0) this.refreshList(cx);
    if (this.editor.isOpen()) poll(this.editor, cx);
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
      const cwd = hereCwd(this);
      const { runs, here } = await collect(cwd ? ["list", cwd] : ["list"]);
      this.runs = runs;
      this.listedFor = cwd;
      if (here) this.here = here;
      const visible = visibleRuns(this);
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
      onReopenOwner: cx => goToOwner(this, cx),
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
      this.reader = false;
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

  graphLanes() {
    if (!this.run) return null;
    if (this._graphFor !== this.run) {
      this._graphFor = this.run;
      this._lanes = buildGraph(this.run, theme());
    }
    return this._lanes;
  }

  // ---- render

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
    const runs = visibleRuns(this);
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
        shownRepo(this) ? `No workflow runs in ${shownRepo(this).name}` : "No workflow runs yet",
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
            .when(!this.reader || !this.pickedSession() || tab === "terminals", el => el.child(runHeader(this, t, this.run, lanes, now)))
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
      .size_full()
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .child(topBar(this, t, live))
      .when(this.view === "runs" && this.runs !== null, el => el.child(runStrip(this, t, runs, now)))
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
      .when(this.view === "runs" && !!this.repoPanel, el => el.child(repoPanelView(this, t, now)));
  }
}
