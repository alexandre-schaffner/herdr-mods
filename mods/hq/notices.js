// Notices: HQ's notification centre. While HQ is on screen, HQ's own messages land here instead of
// Herdr toasts, and HQ watches the agents itself (finished, needs you, gone, something filed for
// you), so a glance at the strip's bell says what happened. Herdr still posts its own agent toasts
// (mods can't intercept those); these are the same events, integrated and clickable.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { agents, notify } from "herdr";

import { ago, alpha, btn, clip, icon, ok, row, SP, statusGlyph, TYPE } from "./ui.js";

const MAX = 60;
const FRESH_MS = 6000;

export class Notices {
  constructor(app) {
    this.app = app;
    this.items = JSON.parse(localStorage.getItem("notices") ?? "[]");
    this.seenAt = Number(localStorage.getItem("notices.seen") ?? 0);
    this.open = false;
    this.last = null; // address -> status, for transitions
    this.inbox = null; // ids already known
  }

  unread() {
    return this.items.filter(n => n.at > this.seenAt).length;
  }

  /** HQ's own messages: here while HQ shows, a Herdr toast otherwise. */
  say(n, shown) {
    if (!shown) return notify(n);
    this.push({ ...n, source: "hq" });
  }

  push(n) {
    this.items = [{ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: Date.now(), ...n }, ...this.items].slice(0, MAX);
    localStorage.setItem("notices", JSON.stringify(this.items));
  }

  markRead() {
    this.seenAt = Date.now();
    localStorage.setItem("notices.seen", String(this.seenAt));
  }

  /** Agent transitions from Herdr's live agent list (every agent, not only the org). */
  watch(cx) {
    const now = {};
    const names = this.names();
    let changed = false;
    for (const a of agents()) {
      now[a.address] = a.status;
      const was = this.last?.[a.address];
      if (!this.last || was === a.status) continue;
      const who = names[a.address] ?? (a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : a.space_name) ?? a.address;
      if (a.status === "blocked") {
        this.push({ kind: "blocked", level: "warning", title: `${who} needs you`, body: clip(a.title, 120), terminal: a.address });
        changed = true;
      } else if ((a.status === "done" || a.status === "idle") && was === "working") {
        this.push({ kind: "done", level: "success", title: `${who} finished`, body: clip(this.lastSaid(a.address) ?? a.title, 160), terminal: a.address });
        changed = true;
      }
    }
    if (this.last)
      for (const addr of Object.keys(this.last))
        if (!(addr in now) && names[addr]) {
          this.push({ kind: "gone", level: "error", title: `${names[addr]}'s session ended`, terminal: addr });
          changed = true;
        }
    this.last = now;
    if (changed) cx.notify();
  }

  /** New inbox items, from each snapshot. */
  onData(d) {
    const ids = new Set((d.inbox ?? []).map(i => i.id));
    if (this.inbox)
      for (const it of d.inbox ?? [])
        if (!this.inbox.has(it.id) && it.state === "open") {
          const word = { approval: "needs your approval", question: "asks you", done: "filed work to look over" }[it.kind] ?? "filed";
          this.push({ kind: `inbox-${it.kind}`, level: it.kind === "done" ? "info" : "warning", title: `${it.from?.role ?? "The org"} ${word}`, body: it.title, review: it.id });
        }
    this.inbox = ids;
  }

  names() {
    const d = this.app.data;
    const out = {};
    if (d?.master?.terminal) out[d.master.terminal] = "Master";
    // One bell for every epic: with two masters running, "Master" alone can't say whose.
    const masters = (d?.epics ?? []).filter(e => e.master);
    if (masters.length > 1) for (const e of masters) out[e.master] = `Master · ${e.name}`;
    for (const m of d?.managers ?? []) if (m.terminal) out[m.terminal] = m.name || m.id;
    return out;
  }

  lastSaid(addr) {
    const d = this.app.data;
    if (d?.master?.terminal === addr) return d.master.facts?.said;
    return d?.managers?.find(m => m.terminal === addr)?.facts?.said;
  }

  run(n, cx) {
    this.open = false;
    if (n.review) return this.app.go("review", cx, { id: n.review });
    if (n.terminal) return this.app.chatWith(n.terminal, cx);
    if (n.action?.name === "agent.focus" && n.action.args?.terminal) return this.app.chatWith(n.action.args.terminal, cx);
    cx.notify();
  }

  // ---- drawing

  /** The newest notice for a few seconds, then the bell with the unread count. */
  bell(t, now) {
    const fresh = this.items[0] && now - this.items[0].at < FRESH_MS && this.items[0].at > this.seenAt ? this.items[0] : null;
    const n = this.unread();
    return h_flex()
      .id("hq-bell")
      .flex_none()
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(this.open, el => el.bg(alpha(t.accent, 0.12)))
      .hover(s => s.bg(this.open ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.06)))
      .tooltip(n ? `${n} new notification${n > 1 ? "s" : ""}` : "Notifications")
      .on_click((_e, cx) => {
        this.open = !this.open;
        if (this.open) this.markRead();
        cx.notify();
      })
      .when(!!fresh, el =>
        el
          .child(dotFor(t, fresh))
          .child(div().max_w(280).truncate().text_size(TYPE.meta).font_medium().text_color(t.foreground).child(fresh.title)),
      )
      .child(icon("bell", 13, n ? t.foreground : t.muted))
      // A neutral count: blue is for what waits for the person, and notices only inform.
      .when(n > 0, el =>
        el.child(
          div()
            .min_w(16)
            .h(16)
            .px(4)
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(alpha(t.foreground, 0.1))
            .text_size(10)
            .font_semibold()
            .text_color(t.foreground)
            .child(n > 99 ? "99+" : String(n)),
        ),
      );
  }

  /** The list, as a panel under the strip's right edge. */
  panel(t, now) {
    return div()
      .id("hq-notices-scrim")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        this.open = false;
        cx.notify();
      })
      .child(
        v_flex()
          .id("hq-notices")
          .absolute()
          .top(46)
          .right(12)
          .w(420)
          .max_h(560)
          .rounded(12)
          .bg(t.popover ?? t.surface)
          .border(1)
          .border_color(t.border)
          .shadow_lg()
          .overflow_hidden()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            row()
              .flex_none()
              .h(40)
              .px(SP.md)
              .items_center()
              .border_b(1)
              .border_color(alpha(t.border, 0.7))
              .child(div().flex_1().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child("Notifications"))
              .when(this.items.length > 0, el =>
                el.child(
                  btn(t, "notices-clear", "Clear", cx => {
                    this.items = [];
                    localStorage.setItem("notices", "[]");
                    cx.notify();
                  }, { kind: "ghost", size: "sm" }),
                ),
              ),
          )
          .child(
            v_flex()
              .id("hq-notices-list")
              .flex_1()
              .min_h(0)
              .overflow_y_scroll()
              .py(4)
              .children(
                this.items.length
                  ? this.items.map(n =>
                      row()
                        .id(`notice-${n.id}`)
                        .mx(4)
                        .px(SP.sm)
                        .py(8)
                        .gap(SP.sm)
                        .items_start()
                        .rounded(8)
                        .cursor_pointer()
                        .hover(s => s.bg(alpha(t.foreground, 0.05)))
                        .on_click((_e, cx) => this.run(n, cx))
                        .child(div().flex_none().pt(3).child(dotFor(t, n)))
                        .child(
                          v_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(2)
                            .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(n.title))
                            .when(!!n.body, el => el.child(div().text_size(TYPE.meta).line_height(1.4).text_color(t.muted).child(clip(n.body, 200)))),
                        )
                        .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(ago(n.at, now))),
                    )
                  : [div().p(SP.lg).text_size(TYPE.ui).text_color(t.muted).child("Nothing yet. Agents finishing, needing you, and what the org files for you show up here.")],
              ),
          ),
      );
  }
}

function dotFor(t, n) {
  if (n.kind === "blocked") return statusGlyph("blocked", t, 11);
  if (n.kind === "done") return statusGlyph("done", t, 11);
  if (n.kind === "gone") return statusGlyph("gone", t, 11);
  const c = { error: t.blocked, warning: t.ansi3 ?? t.working, success: ok(t) }[n.level] ?? t.accent;
  return div().w(8).h(8).mt(2).rounded_full().bg(c);
}
