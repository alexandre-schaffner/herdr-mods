// Chat: talk to the master (or any manager) from HQ with everything its terminal offers —
// the shared ClaudeChat (shared/claude-chat.js): the conversation, messages queued while it
// works, slash commands, Stop, permission mode, model, effort, dialogs, todos, background
// work. Who you're talking to is a row of agent chips in the toolbar (the current one outlined);
// the conversation takes the whole view. Agents that don't fit go into a "+N" menu.
//
// The host calls poll(cx) about once a second while the chat (or its side panel) shows.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { ClaudeChat } from "./shared/claude-chat.js";
import { alpha, clip, icon, plain, row, statusGlyph, statusLook, TYPE } from "./ui.js";

export class ChatView {
  /** `cx` is optional: without it the chat is made on the first onData/onShow/poll. */
  constructor(app, cx) {
    this.app = app;
    this.chosen = null; // an address the person picked; else the master
    this.chat = null;
    if (cx) this.ensure(cx);
  }

  ensure(cx) {
    if (this.chat) return this.chat;
    this.chat = new ClaudeChat(cx, {
      terminal: this.target(),
      picker: false,
      slim: true,
      // Full view: a chip per agent, overflow in "+N". Panel: one chip with a menu.
      // The full view's agent switcher is the status strip's lanes (no second row of chips);
      // the narrow side panel keeps its one chip with a menu.
      lead: (t) => (this.chat?.o.compact ? this.targetChip(t) : null),
      below: (t) => (this.menuOpen ? this.targetMenu(t, this.chat?.o.compact ? null : this.overflow) : null),
      title: () => this.title(),
      onGoToTerminal: (addr) => this.app.focusTerminal(addr),
    });
    return this.chat;
  }

  target() {
    return this.chosen ?? this.app.data?.master?.terminal ?? null;
  }

  title() {
    const d = this.app.data;
    const addr = this.chat?.addr;
    if (!d || !addr) return "Chat";
    if (addr === d.master?.terminal) return `Master · ${d.repo?.name ?? ""}`;
    const m = (d.managers ?? []).find((x) => x.terminal === addr);
    return m ? `${m.name || m.id} · manager` : addr;
  }

  pick(addr, cx) {
    this.menuOpen = false;
    this.chosen = addr === this.app.data?.master?.terminal ? null : addr;
    this.ensure(cx).setTarget(addr, cx);
    cx.notify();
  }

  onShow(cx, arg) {
    const chat = this.ensure(cx);
    if (arg?.terminal) this.pick(arg.terminal, cx);
    else if (!chat.addr && this.target()) chat.setTarget(this.target(), cx);
    chat.composer.focus();
  }

  /** Follows the master when it moves to a new terminal, unless the person picked another. */
  onData(data, cx) {
    const chat = this.ensure(cx);
    const want = this.target();
    if (want && want !== chat.addr && (!this.chosen || !chat.addr)) chat.setTarget(want, cx);
  }

  poll(cx) {
    this.ensure(cx).poll(cx);
  }

  onKey(e, cx) {
    return this.chat ? this.chat.onKey(e, cx) : false;
  }

  typing() {
    return this.chat?.typing() ?? false;
  }

  targets() {
    const d = this.app.data;
    if (!d) return [];
    const out = [];
    if (d.master?.terminal)
      out.push({ addr: d.master.terminal, label: "Master", status: d.master.status, crown: true, doing: d.master.facts?.doing ?? d.status?.text });
    for (const m of d.managers ?? []) {
      if (m.status === "retired" || !m.live || !m.terminal) continue;
      const f = m.facts ?? {};
      out.push({ addr: m.terminal, label: m.id, status: m.status, mq: m.kind === "merge-queue", doing: m.status === "working" ? f.doing : f.said });
    }
    return out;
  }

  /** Panel: the current target as a chip; its menu lists the others. */
  targetChip(t) {
    const cur = this.targets().find((x) => x.addr === this.chat?.addr);
    return h_flex()
      .id("chat-target")
      .flex_none()
      .min_w(0)
      .h(24)
      .px(7)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .bg(this.menuOpen ? alpha(t.accent, 0.15) : alpha(t.foreground, 0.05))
      .hover((s) => s.bg(alpha(t.foreground, 0.09)))
      .tooltip("Who to talk to")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.menuOpen = !this.menuOpen;
        cx.notify();
      })
      .when(!!cur, (el) => el.child(statusGlyph(cur.status, t, 10)))
      .when(!!cur?.crown, (el) => el.child(icon("crown", 11, t.accent)))
      .when(!!cur?.mq, (el) => el.child(icon("git-branch", 11, t.accent)))
      .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(cur?.label ?? "Pick an agent"))
      .child(icon("chevron-down", 9, t.muted));
  }

  targetMenu(t, only) {
    const list = only ?? this.targets();
    return v_flex()
      .px(6)
      .pb(6)
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .children(list.map((x) => this.targetRow_(t, x, true)));
  }

  /** Full view: one chip per agent (status, name), the current one outlined. Chips that don't
   *  fit the toolbar go into a "+N" menu. */
  targetChips(t) {
    const all = this.targets();
    const room = this.width ? Math.max(1, Math.floor((this.width - 600) / 112)) : 4;
    const cur = this.chat?.addr;
    let shown = all.slice(0, room);
    // The current agent is always visible.
    if (cur && !shown.some((x) => x.addr === cur)) {
      const c = all.find((x) => x.addr === cur);
      if (c) shown = [...shown.slice(0, Math.max(0, room - 1)), c];
    }
    this.overflow = all.filter((x) => !shown.includes(x));
    return h_flex()
      .flex_none()
      .gap(4)
      .items_center()
      .children(
        shown.map((x) => {
          const on = x.addr === cur;
          const st = statusLook(x.status, t);
          return h_flex()
            .id(`chat-chip-${x.addr}`)
            .flex_none()
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(7)
            .border(1)
            .border_color(on ? t.accent : alpha(t.border, 0))
            .when(on, (el) => el.bg(alpha(t.accent, 0.06)))
            .when(!on, (el) => el.hover((s) => s.bg(alpha(t.foreground, 0.06))))
            .cursor_pointer()
            .tooltip(`${x.label} · ${x.addr} · ${st.label}${x.doing ? `\n${plain(x.doing)}` : ""}`)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.pick(x.addr, cx))
            .child(statusGlyph(x.status, t, 10))
            .when(!!x.crown, (el) => el.child(icon("crown", 11, on ? t.accent : t.muted)))
            .when(!!x.mq, (el) => el.child(icon("git-branch", 11, on ? t.accent : t.muted)))
            .child(div().text_size(TYPE.ui).font_medium().text_color(on ? t.accent : t.foreground).child(x.label));
        }),
      )
      .when(this.overflow.length > 0, (el) =>
        el.child(
          h_flex()
            .id("chat-chip-more")
            .flex_none()
            .h(26)
            .px(8)
            .gap(4)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(this.menuOpen ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.05))
            .hover((s) => s.bg(alpha(t.foreground, 0.09)))
            .tooltip(this.overflow.map((x) => x.label).join(", "))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              this.menuOpen = !this.menuOpen;
              cx.notify();
            })
            .child(div().text_size(TYPE.ui).text_color(t.muted).child(`+${this.overflow.length}`))
            .child(icon("chevron-down", 9, t.muted)),
        ),
      );
  }

  targetRow_(t, x, compact) {
    const on = x.addr === this.chat?.addr;
    const st = statusLook(x.status, t);
    return row()
      .id(`chat-t-${compact ? "m" : "c"}-${x.addr}`)
      .px(8)
      .py(compact ? 6 : 8)
      .gap(9)
      .items_start()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(alpha(t.accent, 0.12)))
      .when(!on, (el) => el.hover((s) => s.bg(alpha(t.foreground, 0.05))))
      .tooltip(`${x.label} · ${x.addr} · ${st.label}${x.doing ? `\n${plain(x.doing)}` : ""}`)
      .on_click((_e, cx) => this.pick(x.addr, cx))
      .child(div().flex_none().pt(3).child(statusGlyph(x.status, t, 11)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .when(!!x.crown, (el) => el.child(icon("crown", 11, on ? t.accent : t.muted)))
              .when(!!x.mq, (el) => el.child(icon("git-branch", 11, on ? t.accent : t.muted)))
              .child(div().text_size(TYPE.ui).font_medium().text_color(on ? t.accent : t.foreground).child(x.label))
              .child(div().text_size(TYPE.meta).text_color(t.dim).child(x.addr)),
          )
          .when(!compact && !!x.doing, (el) => el.child(div().text_size(TYPE.meta).line_height(1.4).text_color(t.muted).child(clip(x.doing, 90)))),
      );
  }

  body(t, cx, compact) {
    if (!this.chat)
      return div().flex_1().p(20).text_size(12).text_color(t.dim).child("Opening the chat…");
    this.chat.o.compact = compact;
    if (!this.chat.addr)
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(6)
        .child(div().text_size(13.5).font_semibold().child("The master isn't running"))
        .child(div().text_size(12).text_color(t.dim).child("Start it from the status strip, then chat here."));
    return this.chat.render(t, cx);
  }

  render(t, cx) {
    return v_flex()
      .id("chat-root")
      .flex_1()
      .min_h(0)
      .min_w(0)
      .on_size_change((size, cx) => {
        if (Math.abs((this.width ?? 0) - size.width) < 8) return;
        this.width = size.width;
        cx.notify();
      })
      .child(this.body(t, cx, false));
  }

  /** The same chat, narrow: for a side panel beside the other views. Don't show both at once
   * (they share one composer). */
  renderPanel(t, cx) {
    return v_flex().size_full().min_h(0).child(v_flex().flex_1().min_h(0).child(this.body(t, cx, true)));
  }
}
