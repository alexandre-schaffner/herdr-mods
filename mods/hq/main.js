// HQ: the master chat's desk. What's going on now (the status strip), what waits for the
// person (Review), the org the master runs (Org), its memory (Memory), its prompts (Prompts)
// and what it noticed (Pulse). The machine side is hq.py; every write goes through it.

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { appHome, closeOverlay, exec, focused, home, layout, nextCommand, notify, panes, props, run, spaces, theme } from "herdr";

import { BriefView } from "./brief.js";
import { ChatView } from "./chat.js";
import { MapView } from "./map.js";
import { MemoryView } from "./memory.js";
import { OrgView } from "./org.js";
import { Palette } from "./palette.js";
import { PromptsView } from "./prompts.js";
import { PulseView } from "./pulse.js";
import { ReviewView } from "./review.js";
import { TodoView } from "./todo.js";
import { UsageView } from "./usage.js";
import { statusStrip } from "./strip.js";
import { alpha, icon, row, tint } from "./ui.js";

const REFRESH_MS = 12_000;
const AUTOPILOT_MS = 60_000;

const CHAT_PANEL_W = 460;
const AWAY_MS = 2 * 3600_000;

// The rail, in the order a day uses them: catch up, decide, talk, steer, then the instruments.
const VIEWS = [
  { id: "map", label: "Map", icon: "flow", key: "1" },
  { id: "next", label: "Next", icon: "check", key: "2" },
  { id: "review", label: "Review", icon: "circle-check", key: "3" },
  { id: "chat", label: "Chat", icon: "send", key: "4" },
  { id: "org", label: "Org", icon: "layers", key: "5" },
  { id: "brief", label: "Brief", icon: "file-text", key: "6" },
  { id: "usage", label: "Usage", icon: "bolt", key: "7", sep: true },
  { id: "pulse", label: "Pulse", icon: "list", key: "8" },
  { id: "memory", label: "Memory", icon: "brain", key: "9" },
  { id: "prompts", label: "Prompts", icon: "square-pen", key: null },
];

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
    // Back after a while: open on the Brief, the recap of what happened meanwhile.
    const seen = Number(localStorage.getItem("brief.seen") ?? 0);
    const saved = localStorage.getItem("view");
    this.view = Date.now() - seen > AWAY_MS || !saved ? "map" : saved;
    this.data = null;
    this.error = null;
    this.busy = new Set();
    this.h = cx.focus_handle();
    this.chatPanel = localStorage.getItem("chatPanel") === "1";
    this.views = {
      map: new MapView(this),
      brief: new BriefView(this),
      review: new ReviewView(this),
      chat: new ChatView(this, cx),
      org: new OrgView(this),
      pulse: new PulseView(this),
      memory: new MemoryView(this),
      prompts: new PromptsView(this),
      usage: new UsageView(this),
      next: new TodoView(this),
    };
    this.palette = new Palette(this);
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
        if (next !== this.folder) {
          this.folder = next;
          this.refresh(cx);
        }
      }
      this.lastFocus = key;
      const looking = hqShown() || panes().some(p => p.mod === "hq" && p.focused);
      if (looking && !this.looking && Date.now() - this.lastLook > AWAY_MS && this.view !== "map") this.go("map", cx);
      if (looking) this.lastLook = Date.now();
      this.looking = looking;
      if (this.data && (this.view === "chat" || this.chatPanel)) this.views.chat.poll(cx);
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
    const r = await exec("python3", ["-I", `${appHome()}/mods/hq/hq.py`, "--repo", this.folder, ...args]);
    let out;
    try {
      out = JSON.parse(r.stdout || "{}");
    } catch {
      throw new Error(r.stderr.trim().split("\n").pop() || `hq.py exited ${r.code}`);
    }
    if (out.error) throw new Error(out.error);
    return out;
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        this.data = await this.hq(["snapshot"]);
        this.error = null;
        for (const v of Object.values(this.views)) v.onData?.(this.data, cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  autopilot(cx) {
    cx.spawn(async cx => {
      try {
        const r = await this.hq(["autopilot"]);
        if (r.did?.length) {
          notify({ title: "HQ autopilot", body: r.did.join("; "), level: "info", timeout: 4000 });
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
        if (o.done) notify({ title: o.done, level: "success", timeout: 2500 });
        o.then?.(r, cx);
      } catch (e) {
        notify({ title: o.fail ?? "HQ", body: String(e?.message ?? e), level: "error" });
        o.catch?.(e, cx);
      }
      this.busy.delete(key);
      this.refresh(cx);
      cx.notify();
    });
  }

  isBusy(key) {
    return this.busy.has(key);
  }

  go(view, cx, arg) {
    if (view !== this.view) this.views[this.view]?.onHide?.(cx);
    this.view = view;
    localStorage.setItem("view", view);
    this.views[view]?.onShow?.(cx, arg);
    cx.notify();
  }

  focusTerminal(addr) {
    if (!addr) return;
    if (hqShown()) showHq(false);
    run("agent.focus", { terminal: addr });
  }

  peek(addr) {
    if (addr) run("terminal.peek", { terminal: addr });
  }

  openMaster(cx) {
    cx.spawn(async () => {
      const r = await exec("python3", ["-I", `${appHome()}/mods/master/master.py`, "open", this.data?.repo?.path ?? this.folder, ""]);
      try {
        const out = JSON.parse(r.stdout || "{}");
        if (out.error) notify({ title: "No master chat", body: out.error, level: "error" });
      } catch {
        notify({ title: "No master chat", body: r.stderr.trim(), level: "error" });
      }
    });
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
  }

  // ---- drawing

  render(cx) {
    if (this.opener) return div();
    const t = theme();
    const v = this.views[this.view] ?? this.views.review;
    return v_flex()
      .id("hq-root")
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
              .when(!!this.error, el =>
                el.child(
                  div()
                    .m(10)
                    .p(10)
                    .rounded(8)
                    .bg(alpha(t.blocked, 0.1))
                    .text_size(12)
                    .text_color(t.blocked)
                    .child(this.error),
                ),
              )
              .child(this.data ? v.render(t, cx) : div().p(20).text_size(12).text_color(t.dim).child("Reading the org…")),
          )
          .when(!!this.data && this.chatPanel && this.view !== "chat", el =>
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
      .when(this.palette.open, el => el.child(this.palette.render(t)));
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
      .tooltip("Back to the workspace (⌘⇧H or Esc)")
      .on_click(() => showHq(false))
      .child(icon("terminal", 15, t.muted))
      .child(div().text_size(10.5).text_color(t.muted).child("Panes"));
    const c = this.data?.counts ?? {};
    const badge = {
      review: (c.approvals ?? 0) + (c.questions ?? 0),
      org: (c.blocked ?? 0) + (c.gone ?? 0),
      pulse: (this.data?.signals ?? []).filter(s => s.level !== "info").length,
      next: (this.data?.todo?.items ?? []).filter(x => x.status === "blocked").length,
    };
    const urgent = { review: true, org: (c.blocked ?? 0) + (c.gone ?? 0) > 0 };
    return v_flex()
      .flex_none()
      .w(72)
      .py(8)
      .gap(2)
      .bg(t.chrome ?? t.surface)
      .border_r(1)
      .border_color(t.border)
      .children(
        this.viewList().flatMap(v => {
          const on = this.view === v.id;
          const n = badge[v.id] ?? 0;
          const sep = v.sep ? [div().mx(18).my(6).h(1).bg(alpha(t.border, 0.9))] : [];
          return [...sep, v_flex()
            .id(`rail-${v.id}`)
            .mx(6)
            .py(9)
            .gap(5)
            .items_center()
            .rounded(8)
            .relative()
            .cursor_pointer()
            .when(on, el => el.bg(tint(t).on))
            .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
            .tooltip(v.key ? `${v.label}  (${v.key})` : v.label)
            .on_click((_e, cx) => this.go(v.id, cx))
            .child(icon(v.icon, 17, on ? t.accent : t.muted))
            .child(div().text_size(11).font_medium().text_color(on ? t.foreground : t.muted).child(v.label))
            .when(n > 0 && v.id !== "chat", el =>
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
                  .bg(urgent[v.id] ? t.blocked : alpha(t.foreground, 0.18))
                  .text_size(10)
                  .font_semibold()
                  .text_color("#ffffff")
                  .child(String(n)),
              ),
            )];
        }),
      )
      .child(div().flex_1())
      .when(!props()?.repo && !!findNode(layout(), "center"), el => el.child(back));
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    const chat = this.views.chat;
    if (this.palette.open) return; // the palette handles its own keys
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
      showHq(false);
      cx.stop_propagation();
    }
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
