// Workflows: one list of the repository's workflow runs on the left, the picked run on the right.
// The list mixes the runs the person asked for (each owned by its own Claude session: the master
// spawns the owner with `hq workflow-launch`, the owner starts the run, resumes it when it stalls
// and reports back with `hq workflow-report`), the runs the master and managers started, and the
// repository's other runs, grouped by what they need: attention, in progress, done, earlier.
// The right side is the embedded Workflows view (graph, terminals, output, the saved workflows and
// their editor); a run with an owner gets the owner's line, report and brief under its header
// (`host.runExtra`). An owner whose run hasn't started yet gets a page of its own here.
// That view is the Workflows mod, mirrored into ./wf by shared/sync.sh: edit it in
// mods/workflows, then run the script.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home as homeDir, layout, run, theme } from "herdr";
import { openViewer } from "./shared/viewer-link.js";
import {
  ago,
  alpha,
  btn,
  chip,
  clip,
  facts,
  geist,
  icon,
  mdBlock,
  mono,
  row,
  SP,
  scrollY,
  sectionHead,
  statusGlyph,
  TYPE,
  tildify,
  tone,
} from "./ui.js";
import Workflows from "./wf/main.js";
import { visibleRuns } from "./wf/repos.js";
import { isLive } from "./wf/runs.js";
import { host } from "./wf/util.js";

const LIST_W = 320;

const GROUPS = [
  { id: "attention", title: "Needs attention" },
  { id: "active", title: "In progress" },
  { id: "done", title: "Done" },
  { id: "earlier", title: "Earlier", fold: true },
];

const WORD = {
  requested: "Requested",
  launched: "Starting",
  starting: "Starting",
  running: "Running",
  stalled: "Stalled",
  completed: "Completed",
  failed: "Failed",
  killed: "Stopped",
  gone: "Owner gone",
  closed: "Closed",
  unreadable: "Unreadable",
};

const ACTIVE = ["requested", "launched", "starting", "running"];
const TROUBLE = ["stalled", "failed", "gone", "unreadable"];

/** A run's status as a glyph: the agent glyphs where they fit, so HQ reads one way. */
function glyph(t, status, size = 13) {
  const tn = tone(t);
  if (status === "running" || status === "starting" || status === "launched") return statusGlyph("working", t, size);
  if (status === "completed") return statusGlyph("done", t, size);
  if (status === "stalled") return icon("alert", size, tn.warn);
  if (status === "failed" || status === "gone" || status === "unreadable") return icon("x", size, tn.alert);
  if (status === "killed") return icon("square", size, t.muted);
  if (status === "requested") return icon("clock", size, t.muted);
  return statusGlyph("idle", t, size);
}

function statusColor(t, status, w) {
  const tn = tone(t);
  if (w?.reportStatus === "failed" || status === "failed" || status === "gone") return tn.alert;
  if (w?.reportStatus === "partial" || status === "stalled") return tn.warn;
  if (status === "completed") return tn.ok;
  if (status === "running" || status === "starting") return tn.info;
  return t.muted;
}

function progress(r) {
  if (!r) return null;
  const n = r.agents ?? 0;
  return n ? `${r.done ?? 0} of ${n} agents` : null;
}

/** Why a run stopped moving, in two or three words. */
function why(r) {
  const reason = r?.liveness?.reason;
  if (reason === "gone") return "session gone";
  if (reason === "quiet") return "no progress";
  if (reason === "waiting") return `waiting on ${r.liveness.waiting?.[0]?.tool ?? "a tool"}`;
  return null;
}

function argsLine(args) {
  const keys = Object.keys(args ?? {});
  if (!keys.length) return null;
  return keys.map(k => `${k}: ${typeof args[k] === "string" ? args[k] : JSON.stringify(args[k])}`).join(" · ");
}

/** Out of HQ, back to the workspace (before the embedded view focuses a terminal). */
function leaveHq() {
  if (findNode(layout(), "center")?.active === "hq") run("layout.select", { stack: "center", child: "workspace" });
}

export class WorkflowsView {
  constructor(app) {
    this.app = app;
    this.sel = null; // an item's key: an owner's id, `run:<runId>`, or "library"
    this.open = { earlier: false, brief: false, report: true };
    this.confirm = null;
    this.panel = null; // the embedded Workflows view (an Entity), made on first show
    this.select = null; // the last run handed to it: {run, at}
    this.ask = null; // the last thing asked of it: {do: "library" | "archived", at}
    host.runExtra = (_t, r) => this.runExtra(r);
  }

  data() {
    return this.app.data?.workflows ?? { owners: [], others: [], counts: {} };
  }

  /** HQ's plain keys stay out of the embedded editor's fields. */
  typing() {
    return host.typing();
  }

  props(active = true) {
    return { embedded: true, leave: leaveHq, active, ...(this.select ? { select: this.select } : {}), ...(this.ask ? { ask: this.ask } : {}) };
  }

  onShow(cx, arg) {
    if (!this.panel) this.panel = cx.new(Workflows, this.props());
    else this.panel.set_props(this.props());
    if (arg?.id) this.pick(arg.id, cx);
    else if (!this.sel && host.app?.view === "library") this.sel = "library";
    else this.pickFirst(cx);
  }

  /** Nothing picked yet: the top of the list, the run most likely to need a look. */
  pickFirst(cx) {
    if (this.sel) return;
    const first = this.order()[1];
    if (first) this.pick(first, cx);
  }

  onHide() {
    this.panel?.set_props(this.props(false));
  }

  /** New data: an owner whose run just started shows it; the owner lines under the header redraw. */
  onData(_d, cx) {
    if (this.app.view === "workflows") this.pickFirst(cx);
    const it = this.items().find(i => i.key === this.sel);
    if (it?.runId && it.runId !== this.select?.run) this.showRun(it.runId);
    else if (this.panel && this.app.view === "workflows") cx.notify(this.panel);
  }

  /** Asks the embedded view to do something in its own context (it takes it on its next tick). */
  tell(what) {
    this.ask = { do: what, at: Date.now() };
    this.panel?.set_props(this.props());
  }

  /** The run the embedded view shows. */
  showRun(runId) {
    if (!runId) return;
    this.select = { run: runId, at: Date.now() };
    this.panel?.set_props(this.props());
  }

  pick(key, cx) {
    this.sel = key;
    this.confirm = null;
    if (key === "library") this.tell("library");
    else {
      const it = this.items().find(i => i.key === key);
      this.showRun(it?.runId ?? (key.startsWith("run:") ? key.slice(4) : null));
    }
    cx.notify();
  }

  /** Every run in one list: owners (asked for by the person), the org's own runs, and the
   *  repository's other runs (sessions outside the org), each with the group it belongs in. */
  items() {
    const d = this.data();
    const out = [];
    const seen = new Set();
    for (const w of d.owners ?? []) {
      for (const r of w.runs ?? []) seen.add(r.id);
      if (w.run) seen.add(w.run.id);
      const blocked = w.owner?.live && w.owner.state === "blocked";
      const group =
        w.status === "closed"
          ? "earlier"
          : blocked || TROUBLE.includes(w.status)
            ? "attention"
            : ACTIVE.includes(w.status) && !w.reportedAt
              ? "active"
              : "done";
      out.push({
        key: w.id,
        kind: "owner",
        w,
        r: w.run,
        runId: w.run?.id ?? null,
        name: w.name,
        status: w.status,
        group,
        blocked,
      });
    }
    for (const r of d.others ?? []) {
      seen.add(r.id);
      const group = TROUBLE.includes(r.status) ? "attention" : isLive(r.status) ? "active" : "done";
      out.push({
        key: `run:${r.id}`,
        kind: "run",
        r,
        runId: r.id,
        name: r.name ?? r.id,
        status: r.status,
        by: r.by,
        group,
      });
    }
    // Runs from sessions outside the org: only live ones come forward; the rest wait in Earlier.
    for (const r of host.app?.runs ? visibleRuns(host.app) : []) {
      if (seen.has(r.id)) continue;
      out.push({
        key: `run:${r.id}`,
        kind: "run",
        r,
        runId: r.id,
        name: r.name ?? r.id,
        status: r.status,
        group: isLive(r.status) ? "active" : "earlier",
      });
    }
    return out;
  }

  /** The key of the row shown on the right: the pick, else the run the embedded view shows. */
  current(items) {
    if (this.sel === "library") return "library";
    if (this.sel && items.some(i => i.key === this.sel)) return this.sel;
    const runId = host.app?.runId;
    return items.find(i => i.runId && i.runId === runId)?.key ?? null;
  }

  order() {
    const items = this.items();
    return [
      "library",
      ...GROUPS.filter(g => !g.fold || this.open[g.id]).flatMap(g =>
        items.filter(i => i.group === g.id).map(i => i.key),
      ),
    ];
  }

  onKey(e, cx) {
    const list = this.order();
    const i = list.indexOf(this.current(this.items()) ?? this.sel);
    if (e.key === "j" || e.key === "down") return list[i + 1] && this.pick(list[i + 1], cx), true;
    if (e.key === "k" || e.key === "up") return i > 0 && this.pick(list[i - 1], cx), true;
    if (e.key === "escape" && this.confirm) return (this.confirm = null), cx.notify(), true;
    return false;
  }

  render(t, cx) {
    const items = this.items();
    const cur = this.current(items);
    const it = items.find(i => i.key === cur);
    // An owner whose run hasn't started has nothing for the run view to show: its own page.
    const own = it?.kind === "owner" && !it.runId ? this.ownerPage(t, it.w) : null;
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.list(t, items, cur))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .min_h(0)
          .overflow_hidden()
          .when(!!own, el => el.child(own))
          .when(!own && !!this.panel, el => el.child(this.panel))
          .when(!own && !this.panel, el =>
            el
              .items_center()
              .justify_center()
              .child(div().text_size(TYPE.ui).text_color(t.muted).child("Opening the Workflows view…")),
          ),
      );
  }

  list(t, items, cur) {
    const now = this.app.data.now;
    const saved = host.app?.lib?.workflows?.length;
    const body = v_flex()
      .w_full()
      .px(SP.sm)
      .py(SP.md)
      .gap(SP.lg)
      .child(
        this.rowFrame(t, "wf-library", cur === "library", cx => this.pick("library", cx))
          .child(
            div()
              .flex_none()
              .w(16)
              .flex()
              .justify_center()
              .child(icon("layers", 13, t.muted)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(TYPE.ui)
              .font_medium()
              .text_color(t.foreground)
              .child("Saved workflows"),
          )
          .when(saved != null, el =>
            el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(String(saved))),
          ),
      );
    if (!items.length)
      body.child(
        div()
          .px(SP.sm)
          .text_size(TYPE.ui)
          .line_height(1.5)
          .text_color(t.muted)
          .child("No runs yet. Open Saved workflows, pick one and press Run."),
      );
    for (const g of GROUPS) {
      const rows = items.filter(i => i.group === g.id);
      if (!rows.length) continue;
      const open = !g.fold || this.open[g.id];
      const archived =
        g.id === "earlier" && host.app
          ? (host.app.runs ?? []).filter(r => r.archivedAt && r.repo?.key === host.app.here?.key).length
          : 0;
      body.child(
        v_flex()
          .gap(2)
          .child(
            div()
              .px(SP.sm)
              .pb(2)
              .child(
                sectionHead(t, {
                  id: `wf-group-${g.id}`,
                  title: g.title,
                  count: rows.length,
                  level: "label",
                  ...(g.fold ? { open, onToggle: cx => ((this.open[g.id] = !open), cx.notify()) } : {}),
                }),
              ),
          )
          .when(open, el => el.children(rows.slice(0, 60).map(i => this.itemRow(t, i, cur === i.key, now))))
          .when(open && archived > 0, el =>
            el.child(
              div()
                .id("wf-archived")
                .px(SP.sm)
                .py(6)
                .text_size(TYPE.meta)
                .text_color(t.muted)
                .cursor_pointer()
                .hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.tell("archived");
                  cx.notify();
                })
                .child(host.app.showArchived ? "Hide archived runs" : `Show ${archived} archived`),
            ),
          ),
      );
    }
    return v_flex()
      .flex_none()
      .w(LIST_W)
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .bg(t.background)
      .child(scrollY("wf-list", body));
  }

  rowFrame(t, id, on, onClick) {
    return row()
      .id(id)
      .px(SP.sm)
      .py(7)
      .gap(SP.sm)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(on, el => el.bg(t.selected ?? alpha(t.foreground, 0.08)))
      .when(!on, el => el.hover(s => s.bg(t.hover ?? alpha(t.foreground, 0.05))))
      .on_click((_e, cx) => onClick(cx));
  }

  /** One run: its glyph, name and age, and one line saying where it stands. */
  itemRow(t, i, on, now) {
    const w = i.w;
    const r = i.r;
    const at = w
      ? (w.reportedAt ?? r?.endedAt ?? r?.startedAt ?? w.launchedAt ?? w.createdAt)
      : (r.endedAt ?? r.startedAt);
    const word =
      w?.reportStatus && w.status !== "closed"
        ? { completed: "Completed", partial: "Partial", failed: "Failed" }[w.reportStatus]
        : (WORD[i.status] ?? i.status);
    const by = i.by ? (i.by === "master" ? "by the master" : `by ${i.by}`) : null;
    const sub = i.blocked
      ? "Its owner is waiting on a question"
      : i.status === "requested"
        ? "Waiting for the master to start it"
        : w?.headline && w.reportedAt
          ? `${word} · ${w.headline}`
          : [word, why(r), progress(r), i.status === "running" ? r?.live : null, by].filter(Boolean).join(" · ");
    return this.rowFrame(t, `wf-${i.key}`, on, cx => this.pick(i.key, cx))
      .items_start()
      .child(
        div()
          .flex_none()
          .w(16)
          .pt(2)
          .flex()
          .justify_center()
          .child(i.blocked ? icon("alert", 13, tone(t).alert) : glyph(t, i.status)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .min_w(0)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(TYPE.ui)
                  .font_medium()
                  .text_color(t.foreground)
                  .child(i.name),
              )
              .child(div().flex_none().text_size(10.5).text_color(t.muted).child(ago(at, now))),
          )
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_size(TYPE.meta)
              .text_color(i.group === "attention" ? statusColor(t, i.status, w) : t.muted)
              .child(clip(sub, 140)),
          ),
      );
  }

  // ---- the owner, under the run's header (host.runExtra) or on its own page

  /** The owner of the run the embedded view shows, if the person asked for that run. */
  runExtra(r) {
    const w = (this.data().owners ?? []).find(o => o.run?.id === r.id || (o.runs ?? []).some(x => x.id === r.id));
    if (!w) return null;
    const t = geist(theme());
    return v_flex()
      .max_w(880)
      .gap(SP.sm)
      .pt(SP.xs)
      .child(this.ownerLine(t, w))
      .when(!!w.report, el => el.child(this.reportBlock(t, w)))
      .child(this.briefBlock(t, w));
  }

  /** "Owner t152 · working · sonnet" and what can be done with it. */
  ownerLine(t, w) {
    const app = this.app;
    const o = w.owner ?? {};
    const live = o.live && w.status !== "closed";
    const running = ACTIVE.includes(w.status);
    const state = live ? (o.state ?? "idle") : w.status === "closed" ? "closed" : "gone";
    return h_flex()
      .gap(SP.sm)
      .items_center()
      .min_w(0)
      .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child("Owner"))
      .when(!!w.terminal, el =>
        el.child(div().flex_none().font_family(mono()).text_size(TYPE.meta).text_color(t.foreground).child(w.terminal)),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(4)
          .items_center()
          .child(statusGlyph(live ? state : "gone", t, 9))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(state)),
      )
      .when(!!w.model, el => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(w.model)))
      .child(div().flex_1())
      .when(live, el =>
        el
          .child(
            btn(t, "wf-chat", "Talk to it", cx => app.chatWith(w.terminal, cx), {
              size: "sm",
              kind: "ghost",
              icon: "send",
              tooltip: `Chat with the owner (${w.terminal})`,
            }),
          )
          .child(
            btn(t, "wf-focus", null, () => app.focusTerminal(w.terminal), {
              size: "sm",
              kind: "ghost",
              icon: "terminal",
              tooltip: "Its terminal",
            }),
          ),
      )
      .when(w.status !== "closed", el =>
        el.child(
          btn(
            t,
            "wf-close",
            this.confirm === "close" ? (running ? "Close anyway" : "Confirm close") : "Close",
            cx => {
              if (this.confirm !== "close") return (this.confirm = "close"), cx.notify();
              app.act(
                cx,
                `wf-close-${w.id}`,
                ["workflow-close", w.id, "--json", ...(running || o.state === "working" ? ["--force"] : [])],
                {
                  done: `Closed the owner of ${w.name}`,
                  then: (_r, cx) => ((this.confirm = null), cx.notify()),
                },
              );
            },
            {
              size: "sm",
              kind: this.confirm === "close" ? "danger" : "ghost",
              icon: "x",
              disabled: app.isBusy(`wf-close-${w.id}`),
              tooltip: running
                ? "Close the owner. The run is still going, and its owner is what resumes it."
                : "Close the owner. The master normally does this once it has relayed the result.",
            },
          ),
        ),
      );
  }

  reportBlock(t, w) {
    const open = this.open.report;
    return v_flex()
      .gap(6)
      .child(
        sectionHead(t, {
          id: "wf-report-head",
          title: "Report",
          hint:
            [
              w.reportStatus && w.reportStatus !== "completed" ? w.reportStatus : null,
              w.reportedAt ? ago(w.reportedAt, this.app.data.now) : null,
            ]
              .filter(Boolean)
              .join(" · ") || null,
          open,
          onToggle: cx => ((this.open.report = !open), cx.notify()),
        }),
      )
      .when(open, el =>
        el.child(
          v_flex()
            .max_h(320)
            .min_h(0)
            .rounded(6)
            .bg(alpha(t.foreground, 0.035))
            .child(
              scrollY(
                "wf-report-scroll",
                div()
                  .p(SP.md)
                  .child(mdBlock(t, `wf-report-${w.id}`, w.report, { maxW: 820, size: TYPE.ui, cwd: w.folder })),
              ),
            ),
        ),
      );
  }

  /** What the run was asked to do: folded to one line until opened. */
  briefBlock(t, w) {
    const open = this.open.brief;
    const home = homeDir();
    const r = w.run;
    return v_flex()
      .gap(SP.sm)
      .child(
        sectionHead(t, {
          id: "wf-brief-head",
          title: "Brief",
          hint: open ? null : clip(argsLine(w.args) ?? w.note ?? "", 160) || null,
          open,
          onToggle: cx => ((this.open.brief = !open), cx.notify()),
        }),
      )
      .when(open, el =>
        el.child(
          v_flex()
            .gap(SP.md)
            .pl(SP.lg)
            .child(
              facts(t, [
                ["Arguments", argsLine(w.args), { w: 84 }],
                ["Note", w.note || null, { w: 84 }],
                ["Folder", tildify(w.folder ?? "", home), { mono: true, w: 84 }],
                ["Asked by", w.requestedBy === "person" ? "You" : w.requestedBy, { w: 84 }],
                ["Restarts", (w.runs?.length ?? 0) > 1 ? String(w.runs.length - 1) : null, { w: 84 }],
                ["Error", r?.error ?? null, { w: 84 }],
              ]),
            )
            .when(!!w.brief, e2 =>
              e2.child(
                h_flex()
                  .gap(6)
                  .child(
                    btn(t, "wf-brief", "Open the brief", () => openViewer(w.brief), {
                      size: "sm",
                      kind: "ghost",
                      icon: "file-text",
                      tooltip: tildify(w.brief, home),
                    }),
                  )
                  .child(
                    btn(t, "wf-template", "Owner template", cx => this.app.go("prompts", cx, { id: "owner" }), {
                      size: "sm",
                      kind: "ghost",
                      icon: "square-pen",
                    }),
                  ),
              ),
            ),
        ),
      );
  }

  /** An owner without a run yet: asked for and waiting on the master, or its owner starting it. */
  ownerPage(t, w) {
    const app = this.app;
    const asked = w.status === "requested";
    const o = w.owner ?? {};
    const sentence = asked
      ? `Asked ${ago(w.createdAt, app.data.now)}. The master spawns its owner, which starts the run.`
      : o.live
        ? "Its owner is starting the run."
        : "Its owner session ended before the run started. Ask the master to launch it again, or close it.";
    return scrollY(
      "wf-owner-page",
      v_flex()
        .px(28)
        .pt(20)
        .pb(SP.xl)
        .gap(SP.md)
        .max_w(936)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .min_w(0)
            .child(div().min_w(0).truncate().text_size(18).font_semibold().text_color(t.foreground).child(w.name))
            .child(chip(t, WORD[w.status] ?? w.status, statusColor(t, w.status, w))),
        )
        .child(div().max_w(720).text_size(TYPE.ui).line_height(1.5).text_color(t.muted).child(sentence))
        .when(asked, el =>
          el.child(
            h_flex().child(
              btn(
                t,
                "wf-drop",
                this.confirm === "drop" ? "Confirm drop" : "Drop request",
                cx => {
                  if (this.confirm !== "drop") return (this.confirm = "drop"), cx.notify();
                  app.act(cx, `wf-drop-${w.id}`, ["workflow-drop", w.id], {
                    done: `Dropped ${w.name}`,
                    then: (_r, cx) => ((this.sel = null), (this.confirm = null), cx.notify()),
                  });
                },
                {
                  size: "sm",
                  kind: this.confirm === "drop" ? "danger" : "secondary",
                  icon: "trash",
                  disabled: app.isBusy(`wf-drop-${w.id}`),
                },
              ),
            ),
          ),
        )
        .when(!asked, el => el.child(this.ownerLine(t, w)))
        .child(
          facts(t, [
            ["Arguments", argsLine(w.args), { w: 84 }],
            ["Note", w.note || null, { w: 84 }],
            ["Folder", tildify(w.folder ?? "", homeDir()), { mono: true, w: 84 }],
            ["Asked by", w.requestedBy === "person" ? "You" : w.requestedBy, { w: 84 }],
          ]),
        ),
    );
  }
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}
