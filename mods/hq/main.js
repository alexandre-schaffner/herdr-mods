// HQ: the master chat's desk. What's going on now (the status strip), what waits for the
// person (Review), the org the master runs (Org), its memory (Memory), its prompts (Prompts)
// and what it noticed (Pulse). The machine side is hq.py; every write goes through it.

import { v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { appHome, closeOverlay, exec, focused, home, layout, nextCommand, notify, panes, props, run, shared, spaces, terminals, theme } from "herdr";

import { BriefView } from "./brief.js";
import { ChatView } from "./chat.js";
import { epicOfMaster } from "./epics.js";
import { HomeView } from "./home.js";
import { LibraryView } from "./library.js";
import { LoopsView } from "./loops.js";
import { MapView } from "./map.js";
import { Notices } from "./notices.js";
import { MemoryView } from "./memory.js";
import { OrgView } from "./org.js";
import { Palette } from "./palette.js";
import { Viewer } from "./viewer.js";
import { pumpRich } from "./shared/rich.js";
import { PromptsView } from "./prompts.js";
import { PulseView } from "./pulse.js";
import { QueueView } from "./queue.js";
import { ReviewView } from "./review.js";
import { RoadmapView } from "./roadmap.js";
import { TodoView } from "./todo.js";
import { UsageView } from "./usage.js";
import { WorkflowsView } from "./workflows.js";
import { statusStrip } from "./strip.js";
import { alpha, banner, icon, inkOn, loading, row, segmented, tint, geist, SANS } from "./ui.js";

const REFRESH_MS = 12_000;
const AUTOPILOT_MS = 60_000;
const ESC_MS = 2000; // a second Esc within this leaves HQ
const CHAT_KEEP_MS = 90_000; // a hidden chat is dropped after this (read again when shown)

const CHAT_PANEL_W = 460;
const AWAY_MS = 2 * 3600_000;

// Every view, in the order a day uses them: catch up, decide, talk, steer, then the instruments.
const VIEWS = [
  { id: "home", label: "Home", icon: "sparkles", key: "1" },
  { id: "map", label: "Map", icon: "flow", key: "2" },
  { id: "roadmap", label: "Roadmap", icon: "git-branch", key: "t" },
  { id: "queue", label: "Queue", icon: "list", key: "q" },
  { id: "next", label: "Next", icon: "check", key: "3" },
  { id: "review", label: "Review", icon: "circle-check", key: "4" },
  { id: "chat", label: "Chat", icon: "send", key: "5" },
  { id: "org", label: "Org", icon: "layers", key: "6" },
  { id: "loops", label: "Loops", icon: "repeat", key: "l" },
  { id: "library", label: "Library", icon: "folder", key: "7" },
  { id: "workflows", label: "Workflows", icon: "flow-down", key: "w" },
  { id: "usage", label: "Usage", icon: "bolt", key: "8" },
  { id: "pulse", label: "Pulse", icon: "list", key: "9" },
  { id: "memory", label: "Memory", icon: "brain", key: null },
  { id: "prompts", label: "Prompts", icon: "square-pen", key: null },
  // The stats recap, replaced on the rail by Home (the master's own words); kept for links.
  { id: "brief", label: "Brief", icon: "file-text", key: null, hidden: true },
];

// The rail shows groups: views that are two looks at one thing share a slot, and a tab bar over
// the view switches between them. Clicking a group opens the member last shown in it.
const GROUPS = [
  { id: "home", label: "Home", icon: "sparkles", views: ["home"] },
  { id: "org", label: "Org", icon: "layers", views: ["map", "org", "loops"], tabs: { org: "Roster" } },
  { id: "plan", label: "Plan", icon: "git-branch", views: ["roadmap", "next", "queue"] },
  { id: "review", label: "Review", icon: "circle-check", views: ["review"] },
  { id: "chat", label: "Chat", icon: "send", views: ["chat"] },
  { id: "work", label: "Work", icon: "flow-down", views: ["workflows", "library"] },
  { id: "pulse", label: "Pulse", icon: "bolt", views: ["pulse", "usage"], sep: true },
  { id: "mind", label: "Mind", icon: "brain", views: ["memory", "prompts"] },
];
const groupOf = view => GROUPS.find(g => g.views.includes(view));

export default class HQ extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // Opened by its key (mod.open hq): go to the repo's HQ tab, making it if needed.
    if (p.overlay) {
      this.opener = true;
      cx.spawn(async () => {
        try {
          await openTab();
        } catch (e) {
          notify({ title: "Couldn't open HQ", body: String(e?.message ?? e), level: "error" });
        }
        closeOverlay(p.overlay);
      });
      return;
    }
    // Without a repo prop (HQ as a main view), follow the focused space's repo when it has a
    // master chat, else the most recent master (hq.py resolves `auto:`).
    this.folder = p.repo || `auto:${focused()?.cwd ?? home()}`;
    // The epic HQ shows when the person picked one; null follows the space in focus (hq.py
    // takes the epic of its worktree group when that epic has a master).
    this.epic = localStorage.getItem("hq.epic") || null;
    this.epicMenu = false;
    this.epicSel = 0;
    // Back after a while: open on the Brief, the recap of what happened meanwhile.
    const seen = Number(localStorage.getItem("brief.seen") ?? 0);
    const saved = localStorage.getItem("view");
    this.view = Date.now() - seen > AWAY_MS || !saved || saved === "brief" ? "home" : saved;
    this.data = null;
    this.error = null;
    this.busy = new Set();
    this.h = cx.focus_handle();
    this.epicFocus = cx.focus_handle();
    this.chatPanel = localStorage.getItem("chatPanel") === "1";
    this.views = {
      home: new HomeView(this),
      map: new MapView(this),
      roadmap: new RoadmapView(this),
      queue: new QueueView(this),
      brief: new BriefView(this),
      review: new ReviewView(this),
      chat: new ChatView(this), // made when first shown, dropped when hidden a while
      org: new OrgView(this),
      loops: new LoopsView(this),
      pulse: new PulseView(this),
      memory: new MemoryView(this),
      prompts: new PromptsView(this),
      usage: new UsageView(this),
      next: new TodoView(this),
      library: new LibraryView(this),
      workflows: new WorkflowsView(this),
    };
    this.palette = new Palette(this);
    // Markdown and pictures opened anywhere in HQ show in a right pane (viewer.js).
    this.viewer = new Viewer();
    this.notices = new Notices(this);
    // Agent events for HQ's notification centre (Herdr's live data; cheap).
    cx.timer.every(2000, cx => this.notices.watch(cx));
    this.views.usage.start(cx);
    this.views[this.view]?.onShow?.(cx);
    // Keys and scripts: `hq.<view>` (hq.map, hq.review, ...) shows that view.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (this.views[c]) this.go(c, cx);
        cx.notify();
      }
    });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, cx => this.refresh(cx));
    cx.timer.every(AUTOPILOT_MS, cx => this.autopilot(cx));
    // The chat reads its transcript itself (fast while the agent works), only while it shows.
    this.lastLook = Date.now();
    this.lastFocus = null;
    cx.timer.every(1000, cx => {
      const f = focused();
      const key = `${f?.space}/${f?.tab}/${f?.terminal ?? ""}`;
      if (!p.repo && this.lastFocus && key !== this.lastFocus && f?.terminal) {
        // Follow the repo of the space in focus (agents opening tabs move focus too, so this
        // never leaves HQ; only the person's own actions do).
        const next = `auto:${f?.cwd ?? home()}`;
        // An epic's master runs in the repo's main checkout, so its folder can't say its epic:
        // its terminal label can (herdr.master=<repo key>#<epic>).
        const epicHere = epicOfMaster(this.data, terminals().find(x => x.address === f.terminal)?.labels?.["herdr.master"]);
        if (next !== this.folder || (epicHere && epicHere !== this.epic)) {
          this.folder = next;
          this.views.review?.resetNote(); // a note typed for this org's card stays with it
          // Only a master's terminal says its epic; any other keeps the person's pick (hq.py
          // ignores a pick that isn't this repo's). Another epic's data mustn't stay on screen
          // while actions already go to the new one.
          if (epicHere && epicHere !== this.epic) {
            this.pinEpic(epicHere);
            this.data = null;
          }
          this.refresh(cx);
        }
      }
      this.lastFocus = key;
      const looking = hqShown() || panes().some(p => p.mod === "hq" && p.focused);
      if (looking && !this.looking && Date.now() - this.lastLook > AWAY_MS && this.view !== "home") this.go("home", cx);
      if (looking) this.lastLook = Date.now();
      this.looking = looking;
      pumpRich(cx); // drawings the viewer or the chat asked for
      // Another mod (the sidebar) asked for one of HQ's views: "hq.goto" = { view, at }.
      const goto = shared("hq.goto");
      if (goto?.at && goto.at !== this.gotoAt) {
        this.gotoAt = goto.at;
        if (this.views[goto.view]) this.go(goto.view, cx);
      }
      if (this.data && this.chatShown()) {
        this.chatSeen = Date.now();
        this.views.chat.poll(cx);
      } else {
        // Hidden, a chat still sends what it queued when its agent's turn ends.
        this.views.chat.chat?.flushQueue(cx);
        if (Date.now() - (this.chatSeen ?? 0) > CHAT_KEEP_MS && this.views.chat.release()) cx.notify();
      }
    });
  }

  viewList() {
    return VIEWS.filter(v => this.views[v.id] && !v.hidden);
  }

  chatShown() {
    return this.view === "chat" || this.chatPanel;
  }

  toggleChatPanel(cx) {
    this.chatPanel = !this.chatPanel;
    localStorage.setItem("chatPanel", this.chatPanel ? "1" : "0");
    if (this.chatPanel) this.views.chat.poll(cx);
    cx.notify();
  }

  /** Talk to a terminal (the master when none): the side panel if it's open, else the Chat view. */
  chatWith(addr, cx) {
    if (this.chatPanel && this.view !== "chat") {
      this.views.chat.onShow(cx, { terminal: addr });
      cx.notify();
    } else this.go("chat", cx, { terminal: addr });
  }

  // ---- the machine

  /** Runs hq.py for this repo; resolves with its JSON, throws its error. */
  async hq(args) {
    const r = await exec("python3", ["-I", `${appHome()}/mods/hq/hq.py`, "--repo", this.folder, ...(this.epic ? ["--epic", this.epic] : []), ...args]);
    const crashed = () => new Error((r.stderr ?? "").trim().split("\n").pop() || `hq.py exited ${r.code}`);
    if (!(r.stdout ?? "").trim() && r.code) throw crashed(); // a traceback: no JSON, not an empty answer
    let out;
    try {
      out = JSON.parse(r.stdout || "{}");
    } catch {
      throw crashed();
    }
    if (out.error) throw new Error(out.error);
    return out;
  }

  refresh(cx) {
    // One snapshot at a time; a refresh asked for meanwhile runs right after. A snapshot taken
    // for another folder or epic than the one now shown (the person switched while it ran) is
    // dropped, so one epic's data never lands under another's name.
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    const scope = () => `${this.folder}|${this.epic ?? ""}`;
    const want = scope();
    cx.spawn(async cx => {
      try {
        const d = await this.hq(["snapshot"]);
        if (want === scope()) {
          this.data = d;
          this.notices.onData(this.data);
          this.error = null;
          for (const v of Object.values(this.views)) v.onData?.(this.data, cx);
        } else this.refreshAgain = true;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.refresh(cx);
      }
      cx.notify();
    });
  }

  autopilot(cx) {
    cx.spawn(async cx => {
      try {
        const r = await this.hq(["autopilot"]);
        if (r.did?.length) {
          this.say({ title: "HQ autopilot", body: r.did.join("; "), level: "info", timeout: 4000 });
          this.refresh(cx);
        }
      } catch {
        // the next minute tries again
      }
    });
  }

  /** A labelled action: busy while it runs, a toast on failure, a refresh after. */
  act(cx, key, args, o = {}) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await this.hq(args);
        if (o.done) this.say({ title: o.done, level: "success", timeout: 2500 });
        o.then?.(r, cx);
      } catch (e) {
        this.say({ title: o.fail ?? "HQ", body: String(e?.message ?? e), level: "error" });
        o.catch?.(e, cx);
      }
      this.busy.delete(key);
      this.refresh(cx);
      cx.notify();
    });
  }

  /** A message for the person: HQ's notification centre while HQ is on screen, else a toast. */
  say(n) {
    const shown = !props()?.repo ? hqShown() : panes().some(p => p.mod === "hq" && p.focused);
    this.notices.say(n, shown);
  }

  isBusy(key) {
    return this.busy.has(key);
  }

  go(view, cx, arg) {
    if (view !== this.view) this.views[this.view]?.onHide?.(cx);
    this.view = view;
    localStorage.setItem("view", view);
    const g = groupOf(view);
    if (g && g.views.length > 1) localStorage.setItem(`group.${g.id}`, view);
    this.views[view]?.onShow?.(cx, arg);
    cx.notify();
  }

  pinEpic(name) {
    this.epic = name || null;
    if (name) localStorage.setItem("hq.epic", name);
    else localStorage.removeItem("hq.epic");
  }

  toggleEpicMenu(cx) {
    this.epicMenu = !this.epicMenu;
    cx.notify();
  }

  /** Shows another epic's HQ: its master, org, inbox and queue. One without a master offers to start one. */
  pickEpic(name, cx) {
    this.epicMenu = false;
    if (name === this.data?.epic) return cx.notify();
    this.pinEpic(name);
    this.data = null; // the next snapshot is that epic's; don't show this one's under its name
    this.refresh(cx);
    cx.notify();
  }

  /** Starts (or shows) the master chat of `name`'s epic. */
  startEpicMaster(name, cx) {
    this.epicMenu = false;
    this.pinEpic(name);
    this.data = null;
    this.refresh(cx);
    this.act(cx, `master-open-${name}`, ["master-open"], { done: `Starting the ${name} master`, fail: "Couldn't start the master" });
  }

  focusTerminal(addr) {
    if (!addr) return;
    if (hqShown()) showHq(false);
    run("agent.focus", { terminal: addr });
  }

  peek(addr) {
    if (addr) run("terminal.peek", { terminal: addr });
  }

  /** Shows the master, starting or resuming it first. One at a time: hq.py and master.py
   *  hold a lock, and the busy key keeps a second click from queueing another start. */
  openMaster(cx) {
    this.act(cx, "open-master", ["master-open"], { fail: "No master chat" });
  }

  /** What a signal's or strip's action word does. */
  doAction(action, who, terminal, cx) {
    if (!action) return;
    if (action === "focus") return this.focusTerminal(terminal);
    if (action === "peek") return this.peek(terminal);
    if (action === "open-master") return this.openMaster(cx);
    if (action === "loop-arm") return this.act(cx, "loop", ["loop-arm"], { done: "Armed the master's loop", fail: "Couldn't arm the loop" });
    if (action === "compact")
      return this.act(cx, `compact-${terminal}`, ["compact", terminal], { done: `Compacting ${terminal}`, fail: "Couldn't compact" });
    if (action === "launch") return this.act(cx, `launch-${who}`, ["manager-launch", who], { done: `Launched ${who}`, fail: "Couldn't launch" });
    if (action === "new-manager") return this.go("org", cx, { create: true });
    if (action.startsWith("review:")) return this.go("review", cx, { id: action.slice(7) });
    if (action.startsWith("workflow:")) return this.go("workflows", cx, { id: action.slice(9) });
  }

  // ---- drawing

  render(cx) {
    if (this.opener) return div();
    const t = geist(theme());
    const v = this.views[this.view] ?? this.views.review;
    return v_flex()
      .id("hq-root")
      .font_family(SANS)
      .size_full()
      .bg(t.canvas ?? t.background)
      .text_color(t.foreground)
      .track_focus(this.h)
      .relative()
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(statusStrip(this, t, cx))
      .child(
        row()
          .flex_1()
          .min_h(0)
          .child(this.rail(t))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .min_h(0)
              .when(!!this.error, el => el.child(banner(t, { tone: t.blocked, text: this.error })))
              .children(this.groupTabs(t))
              .child(this.data ? v.render(t, cx) : loading(t, "Reading the org…")),
          )
          .when(this.viewer.shown, el => el.child(this.viewer.render(t, cx)))
          .when(!!this.data && this.chatPanel && this.view !== "chat" && !this.viewer.shown, el =>
            el.child(
              v_flex()
                .flex_none()
                .w(CHAT_PANEL_W)
                .min_h(0)
                .border_l(1)
                .border_color(t.border)
                .bg(t.background)
                .child(this.views.chat.renderPanel(t, cx)),
            ),
          ),
      )
      .when(this.notices.open, el => el.child(this.notices.panel(t, Date.now())))
      .when(this.palette.open, el => el.child(this.palette.render(t)))
      .when(!!this.escAt, el => el.child(this.escHint(t)));
  }

  rail(t) {
    const back = v_flex()
      .id("rail-back")
      .mx(6)
      .mb(4)
      .py(8)
      .gap(4)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover(s => s.bg(tint(t).hover))
      .tooltip("Back to the workspace (⌘⇧H, or Esc twice)")
      .on_click(() => showHq(false))
      .child(icon("terminal", 15, t.muted))
      .child(div().text_size(10.5).text_color(t.muted).child("Panes"));
    const { badge, urgent } = this.badges();
    const items = this.groupList().flatMap(g => {
      const on = groupOf(this.view)?.id === g.id;
      const n = g.members.reduce((s, v) => s + (badge[v.id] ?? 0), 0);
      const hot = g.members.some(v => (badge[v.id] ?? 0) > 0 && urgent[v.id]);
      const keys = g.members.filter(v => v.key).map(v => (g.members.length > 1 ? `${v.key} ${this.tabLabel(g, v)}` : v.key));
      const sep = g.sep ? [div().mx(18).my(6).h(1).bg(alpha(t.border, 0.9))] : [];
      return [...sep, v_flex()
        .id(`rail-${g.id}`)
        .mx(6)
        .py(9)
        .gap(5)
        .items_center()
        .rounded(8)
        .relative()
        .cursor_pointer()
        .when(on, el => el.bg(t.selected))
        .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
        .tooltip(keys.length ? `${g.label}  (${keys.join(", ")})` : g.label)
        .on_click((_e, cx) => this.go(this.groupView(g), cx))
        .child(icon(g.icon, 17, on ? t.foreground : t.muted))
        .child(div().text_size(11).font_medium().text_color(on ? t.foreground : t.muted).child(g.label))
        .when(n > 0 && g.id !== "chat", el =>
          el.child(
            div()
              .absolute()
              .top(4)
              .right(10)
              .min_w(16)
              .h(16)
              .px(4)
              .rounded_full()
              .flex()
              .items_center()
              .justify_center()
              .bg(hot ? t.blocked : alpha(t.foreground, 0.1))
              .text_size(10)
              .font_semibold()
              .text_color(hot ? inkOn(t, t.blocked) : t.foreground)
              .child(String(n)),
          ),
        )];
    });
    return v_flex()
      .flex_none()
      .w(72)
      .min_h(0)
      .bg(t.chrome ?? t.surface)
      .border_r(1)
      .border_color(t.border)
      // The groups scroll when the window is too short for them; Panes stays pinned below.
      .child(v_flex().id("rail-items").flex_1().min_h(0).overflow_y_scroll().py(8).gap(2).children(items))
      .when(!props()?.repo && !!findNode(layout(), "center"), el => el.child(back));
  }

  /** The rail's counts per view, and which of them need the person now. */
  badges() {
    const c = this.data?.counts ?? {};
    const badge = {
      review: (c.approvals ?? 0) + (c.questions ?? 0),
      org: (c.blocked ?? 0) + (c.gone ?? 0),
      pulse: (this.data?.signals ?? []).filter(s => s.level !== "info").length,
      next: (this.data?.todo?.items ?? []).filter(x => x.status === "blocked").length,
      workflows: (this.data?.workflows?.counts?.attention ?? 0) || (this.data?.workflows?.counts?.running ?? 0),
    };
    const urgent = { review: true, org: (c.blocked ?? 0) + (c.gone ?? 0) > 0, workflows: (this.data?.workflows?.counts?.attention ?? 0) > 0 };
    return { badge, urgent };
  }

  /** The rail's groups, each with the views it holds that this HQ has. */
  groupList() {
    const shown = this.viewList();
    return GROUPS.map(g => ({ ...g, members: g.views.map(id => shown.find(v => v.id === id)).filter(Boolean) })).filter(g => g.members.length);
  }

  /** The view a group opens on: the one last shown in it, else its first. */
  groupView(g) {
    const last = localStorage.getItem(`group.${g.id}`);
    return g.members.some(v => v.id === last) ? last : g.members[0].id;
  }

  tabLabel(g, v) {
    return g.tabs?.[v.id] ?? v.label;
  }

  /** Over a grouped view: its group's views as tabs, with their counts and keys. */
  groupTabs(t) {
    const g = this.groupList().find(x => x.members.some(v => v.id === this.view));
    if (!g || g.members.length < 2) return [];
    const { badge } = this.badges();
    const items = g.members.map(v => {
      const n = badge[v.id] ?? 0;
      return { id: v.id, label: `${this.tabLabel(g, v)}${n > 0 ? `  ${n}` : ""}` };
    });
    return [
      row()
        .flex_none()
        .px(12)
        .py(6)
        .gap(10)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(segmented(t, `group-${g.id}`, items, this.view, (id, cx) => this.go(id, cx)))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim ?? t.muted)
            .child(g.members.filter(v => v.key).map(v => `${v.key} ${this.tabLabel(g, v)}`).join(" · ")),
        ),
    ];
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    const chat = this.views.chat;
    if (this.palette.open) return; // the palette handles its own keys
    if (this.viewer.shown && e.key === "escape") {
      this.viewer.close(cx);
      cx.stop_propagation();
      return;
    }
    if (e.key !== "escape" && this.escAt) this.escAt = 0;
    if (e.key === "k" && (m.platform || m.control)) {
      this.palette.show(cx);
      cx.stop_propagation();
      return;
    }
    // The chat owns its keys while it shows and has them (typing, ⌘F, Esc to stop, ⇧Tab...).
    if (this.chatShown() && chat.typing()) return;
    if (this.view === "chat") {
      if (!(this.viewList().some(v => v.key === e.key) && !m.control && !m.platform && !m.alt && !m.shift) && chat.onKey(e, cx)) {
        cx.stop_propagation();
        return;
      }
    }
    // A view that wants keys the rules below keep from it (with modifiers, or Esc while it types).
    if (this.views[this.view]?.onKeyFirst?.(e, cx)) {
      cx.stop_propagation();
      return;
    }
    if (m.control || m.platform || m.alt) return;
    // Typing in a field: the field gets the key.
    if (this.views[this.view]?.typing?.()) return;
    if (e.key === "/") {
      this.palette.show(cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "c" && !m.shift) {
      this.toggleChatPanel(cx);
      cx.stop_propagation();
      return;
    }
    const hit = this.viewList().find(v => v.key === e.key);
    if (hit) {
      this.go(hit.id, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "g" && !m.shift) {
      this.refresh(cx);
      return;
    }
    if (this.views[this.view]?.onKey?.(e, cx)) {
      cx.stop_propagation();
      return;
    }
    if (e.key === "escape" && !props()?.repo && hqShown()) {
      // Leaving HQ takes a second Esc within ESC_MS; the first says so (see escHint).
      const now = Date.now();
      if (this.escAt && now - this.escAt < ESC_MS) {
        this.escAt = 0;
        showHq(false);
      } else {
        this.escAt = now;
        cx.timer.after(ESC_MS, cx => {
          if (this.escAt && Date.now() - this.escAt >= ESC_MS - 20) {
            this.escAt = 0;
            cx.notify();
          }
        });
      }
      cx.notify();
      cx.stop_propagation();
    }
  }

  /** After a first Esc: what a second one does. */
  escHint(t) {
    return div()
      .absolute()
      .bottom(18)
      .left(0)
      .right(0)
      .flex()
      .justify_center()
      .child(
        h_flex()
          .h(30)
          .px(14)
          .gap(8)
          .items_center()
          .rounded_full()
          .bg(t.popover ?? t.surface)
          .border(1)
          .border_color(t.border)
          .shadow_md()
          .child(div().px(5).rounded(4).bg(t.hover ?? t.raised).text_size(10.5).text_color(t.muted).child("esc"))
          .child(div().text_size(12).text_color(t.foreground).child("again to leave HQ")),
      );
  }
}

/** HQ is a main view: the layout's `center` stack shows either the workspace or HQ. The key
 *  toggles it; a layout without that stack gets HQ as a tab instead. */
export function hqShown() {
  return findNode(layout(), "center")?.active === "hq";
}

export function showHq(on) {
  run("layout.select", { stack: "center", child: on ? "hq" : "workspace" });
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

async function openTab() {
  if (findNode(layout(), "center")?.children?.some(c => c.id === "hq")) {
    showHq(!hqShown());
    return;
  }
  const f = focused();
  const anyHq = panes().find(p => p.mod === "hq");
  if (anyHq) {
    const sp = spaces().find(s => s.tabs.some(t => t.id === anyHq.tab));
    if (sp) run("space.select", { id: sp.id });
    run("tab.select", { id: anyHq.tab });
    return;
  }
  run("tab.new", { name: "HQ", space: f?.space, mod: "hq", props: {} });
}
