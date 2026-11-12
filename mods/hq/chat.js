// Chat: talk to the master (or any manager) from HQ with everything its terminal offers —
// the shared ClaudeChat (shared/claude-chat.js): the conversation, messages queued while it
// works, slash commands, Stop, permission mode, model, effort, dialogs, todos, background
// work. The full view picks who you're talking to from the status strip's lanes; the narrow side
// panel has one agent chip with a menu.
//
// With the master, a second tab holds the org's mail: what managers and workflow owners filed for
// the master (`hq tell`), which it reads on its tick instead of in the conversation. The
// conversation folds the master's own turns (ticks, mail, HQ's lines) so the person's stay plain.
//
// The host calls poll(cx) about once a second while the chat (or its side panel) shows, and
// release() once it has been hidden for a while: a chat holds its agent's transcript, and the
// mods share one small script memory, so a hidden chat is dropped and read again when shown.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { ClaudeChat } from "./shared/claude-chat.js";
import { ago, agentMark, alpha, chip, dot, empty, icon, kbd, loading, mdBlock, plain, row, scrollY, segmented, SP, statusGlyph, statusLook, timeAgo, tint, TYPE } from "./ui.js";

export class ChatView {
  /** `cx` is optional: without it the chat is made on the first onData/onShow/poll. */
  constructor(app, cx) {
    this.app = app;
    this.chosen = null; // an address the person picked; else the master
    this.chat = null;
    this.tab = "chat"; // "chat" | "mail" (the master's org mail)
    if (cx) this.ensure(cx);
  }

  ensure(cx) {
    if (this.chat) return this.chat;
    this.chat = new ClaudeChat(cx, {
      terminal: this.target(),
      picker: false,
      slim: true,
      // In HQ, Esc stopping the master (or a manager) takes a second press.
      confirmEsc: true,
      // Only the master's chat folds the org's turns: there they crowd out the person's. For a
      // manager, the master's messages are its conversation, as its terminal shows.
      foldOrg: () => this.isMaster(),
      // The full view has one toolbar: the master's tabs lead it. The panel leads with who.
      lead: (t) => (this.chat?.o.compact ? this.targetChip(t) : this.leadFull(t)),
      below: (t) => this.belowBar(t),
      replace: (t) => (this.showingMail() ? this.mailPane(t) : null),
      title: () => this.title(),
      onGoToTerminal: (addr) => this.app.focusTerminal(addr),
      // Typed from the mail tab: show the conversation the message went to.
      onSent: (_text, cx) => this.tab === "mail" && this.setTab("chat", cx),
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

  /** Follows the master when it moves to a new terminal, unless the person picked another.
   *  Doesn't make the chat: a hidden one stays unmade (see release). */
  onData(data, cx) {
    // Another epic: its own master and managers. Drop whom the person picked in the last one.
    if (data?.epic !== this.epic) {
      this.epic = data?.epic;
      this.chosen = null;
      this.menuOpen = false;
      this.tab = "chat";
      if (this.chat && data?.master?.terminal) this.chat.setTarget(data.master.terminal, cx);
    }
    // The master's session ended: its terminal is a plain shell now, so stop offering to type into it.
    this.masterGone = !this.chosen && !!data?.master && !data.master.terminal;
    const chat = this.chat;
    const want = this.target();
    if (chat && want && want !== chat.addr && (!this.chosen || !chat.addr)) chat.setTarget(want, cx);
  }

  /** Drops the chat (its transcript, rows and @-mention list) unless something would be lost:
   *  a draft in the composer or messages still queued. The next show reads the transcript again. */
  release() {
    const c = this.chat;
    if (!c || c.composer?.value()?.trim() || c.queued?.length) return false;
    // Native input states outlive their JS owner until released (their handlers hold the chat).
    c.composer?.release?.();
    c.search?.release?.();
    c.dispose();
    this.chat = null;
    this.menuOpen = false;
    return true;
  }

  poll(cx) {
    const chat = this.ensure(cx);
    if (!chat.addr && this.target()) chat.setTarget(this.target(), cx);
    chat.poll(cx);
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (!this.typing() && this.isMaster() && !m.control && !m.platform && !m.alt && !m.shift) {
      if (e.key === "m") {
        this.setTab(this.tab === "mail" ? "chat" : "mail", cx);
        return true;
      }
      if (e.key === "escape" && this.showingMail()) {
        this.setTab("chat", cx);
        return true;
      }
    }
    return this.chat ? this.chat.onKey(e, cx) : false;
  }

  // ---- the org's mail (the master's queue)

  isMaster() {
    const addr = this.chat?.addr;
    return !!addr && addr === this.app.data?.master?.terminal;
  }

  showingMail() {
    return this.tab === "mail" && this.isMaster();
  }

  setTab(tab, cx) {
    this.tab = tab;
    cx.notify();
  }

  /** Under the panel's toolbar: the target menu, then, with the master, the tab switch. */
  belowBar(t) {
    if (!this.chat?.o.compact) return null;
    const parts = [this.menuOpen ? this.targetMenu(t) : null, this.isMaster() ? this.tabBar(t) : null].filter(Boolean);
    return parts.length ? v_flex().flex_none().children(parts) : null;
  }

  /** The full view's toolbar lead: with the master, Conversation | Org mail; else who it is. */
  leadFull(t) {
    if (this.isMaster()) return h_flex().flex_none().gap(8).items_center().child(this.tabSwitch(t)).child(kbd(t, "M"));
    const cur = this.targets().find((x) => x.addr === this.chat?.addr);
    return h_flex()
      .flex_none()
      .gap(7)
      .items_center()
      .when(!!cur, (el) => el.child(statusGlyph(cur.status, t, 10, { still: this.app.palette?.open })))
      .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(this.title()));
  }

  tabBar(t) {
    return h_flex()
      .flex_none()
      .px(10)
      .py(5)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .child(this.tabSwitch(t));
  }

  tabSwitch(t) {
    const items = this.app.data?.mail?.items ?? [];
    const unread = this.app.data?.mail?.unread ?? items.filter((x) => !x.readAt).length;
    const urgent = items.filter((x) => x.urgent && !x.readAt).length;
    const mailLabel = h_flex()
      .gap(6)
      .items_center()
      .child("Org mail")
      .when(unread > 0, (el) =>
        el.child(
          chip(t, String(unread), urgent ? t.blocked : t.accent, {
            icon: urgent ? "alert" : null,
            tooltip: urgent ? `${unread} unread, ${urgent} urgent` : `${unread} unread`,
          }),
        ),
      );
    return segmented(
      t,
      "chat-tab",
      [
        { id: "chat", label: "Conversation" },
        { id: "mail", label: mailLabel },
      ],
      this.tab,
      (id, cx) => this.setTab(id, cx),
    );
  }

  /** What managers and owners filed for the master, newest first: a timeline, not bubbles. */
  mailPane(t) {
    const mail = this.app.data?.mail;
    const items = mail?.items ?? [];
    if (!items.length)
      return empty(t, "No org mail", "Managers' reports to the master land here instead of in the conversation. The master reads them on its tick; urgent ones wake it.", { icon: "send" });
    const now = Date.now();
    const unread = mail.unread ?? items.filter((x) => !x.readAt).length;
    const compact = !!this.chat?.o.compact;
    return scrollY(
      "chat-mail",
      v_flex()
        .px(compact ? SP.sm : SP.lg)
        .py(SP.md)
        .gap(2)
        .child(
          div()
            .px(SP.sm)
            .pb(SP.sm)
            .text_size(TYPE.meta)
            .text_color(t.muted)
            .child(`${unread ? `${unread} unread` : "All read"} · the master reads these on its tick; urgent ones wake it when idle.`),
        )
        .children(items.map((m) => this.mailRow(t, m, now, compact))),
    );
  }

  mailRow(t, m, now, compact) {
    const d = this.app.data ?? {};
    const role = m.from?.role ?? null;
    const term = m.from?.terminal ?? null;
    const mgr = role ? (d.managers ?? []).find((x) => x.id === role) : null;
    const name = role ?? term ?? "someone";
    const unread = !m.readAt;
    const state = [
      unread ? "Unread" : `Read by the master ${ago(m.readAt, now)}`,
      m.wokeAt ? `woke it ${ago(m.wokeAt, now)}` : null,
      m.why || null,
    ].filter(Boolean);
    // Shape and word, not color alone: urgent is an alert, unread a filled dot, read a ring.
    const mark = m.urgent && unread
      ? icon("alert", 12, t.blocked)
      : unread
        ? dot(t.accent, 7)
        : div().flex_none().w(7).h(7).rounded_full().border(1).border_color(alpha(t.muted, 0.8));
    const sender = h_flex()
      .id(`mail-from-${m.id}`)
      .min_w(0)
      .gap(6)
      .items_center()
      .when(!!term, (el) => el.cursor_pointer().hover((s) => s.underline()).tooltip(`Chat with ${name} (${term})`).on_click((_e, cx) => this.app.chatWith(term, cx)))
      .child(agentMark(t, { id: name, label: name, kind: mgr?.kind, avatar: true, size: 18 }))
      .child(div().flex_none().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(name))
      .when(!!role && !!term, (el) => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(term)));
    return row()
      .id(`mail-${m.id}`)
      .px(SP.sm)
      .py(10)
      .gap(10)
      .rounded(8)
      .when(unread, (el) => el.bg(alpha(t.accent, 0.045)))
      .on_mouse_down("right", (_e, cx) => cx.write_to_clipboard(m.text ?? ""))
      .child(div().flex_none().w(14).pt(5).flex().justify_center().child(mark))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .child(
            h_flex()
              .min_w(0)
              .gap(8)
              .items_center()
              .child(sender)
              .when(!!m.urgent, (el) => el.child(chip(t, "urgent", t.blocked, { icon: "alert" })))
              .child(div().flex_1())
              .child(timeAgo(t, m.at, now)),
          )
          .child(mdBlock(t, `mail-text-${m.id}`, m.text ?? "", { size: compact ? TYPE.ui : TYPE.body }))
          .child(div().text_size(TYPE.meta).text_color(unread ? t.foreground : t.muted).child(state.join(" · "))),
      );
  }

  typing() {
    return this.chat?.typing() ?? false;
  }

  targets() {
    const d = this.app.data;
    if (!d) return [];
    const out = [];
    if (d.master?.terminal)
      out.push({ addr: d.master.terminal, label: "Master", status: d.master.status, kind: "master", doing: d.master.facts?.doing ?? d.status?.text });
    for (const m of d.managers ?? []) {
      if (m.status === "retired" || !m.live || !m.terminal) continue;
      const f = m.facts ?? {};
      out.push({ addr: m.terminal, label: m.id, status: m.status, kind: m.kind, doing: m.status === "working" ? f.doing : f.said });
    }
    return out;
  }

  /** Panel: the current target as a chip; its menu lists the others. */
  targetChip(t) {
    const cur = this.targets().find((x) => x.addr === this.chat?.addr);
    const mark = cur && agentMark(t, { kind: cur.kind, size: 11 });
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
      .bg(this.menuOpen ? tint(t).on : tint(t).hover)
      .hover((s) => s.bg(alpha(t.foreground, 0.09)))
      .tooltip("Who to talk to")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.menuOpen = !this.menuOpen;
        cx.notify();
      })
      .when(!!cur, (el) => el.child(statusGlyph(cur.status, t, 10, { still: this.app.palette?.open })))
      .when(!!mark, (el) => el.child(mark))
      .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(cur?.label ?? "Pick an agent"))
      .child(icon("chevron-down", 9, t.muted));
  }

  targetMenu(t) {
    return v_flex()
      .px(6)
      .pb(6)
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .children(this.targets().map((x) => this.targetRow(t, x)));
  }

  targetRow(t, x) {
    const on = x.addr === this.chat?.addr;
    const st = statusLook(x.status, t);
    const mark = agentMark(t, { kind: x.kind, size: 11, color: on ? t.accent : t.muted });
    return row()
      .id(`chat-t-m-${x.addr}`)
      .px(8)
      .py(6)
      .gap(9)
      .items_start()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(tint(t).on))
      .when(!on, (el) => el.hover((s) => s.bg(tint(t).hover)))
      .tooltip(`${x.label} · ${x.addr} · ${st.label}${x.doing ? `\n${plain(x.doing)}` : ""}`)
      .on_click((_e, cx) => this.pick(x.addr, cx))
      .child(div().flex_none().pt(3).child(statusGlyph(x.status, t, 11, { still: this.app.palette?.open })))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(5)
          .items_center()
          .when(!!mark, (el) => el.child(mark))
          .child(div().text_size(TYPE.ui).font_medium().text_color(on ? t.accent : t.foreground).child(x.label))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(x.addr)),
      );
  }

  body(t, cx, compact) {
    if (!this.chat) return loading(t, "Opening the chat…");
    this.chat.o.compact = compact;
    if (!this.chat.addr || this.masterGone) return empty(t, "The master isn't running", "Start it from the status strip, then chat here.", { icon: "send" });
    return this.chat.render(t, cx);
  }

  render(t, cx) {
    return v_flex().id("chat-root").flex_1().min_h(0).min_w(0).child(this.body(t, cx, false));
  }

  /** The same chat, narrow: for a side panel beside the other views. Don't show both at once
   * (they share one composer). */
  renderPanel(t, cx) {
    return v_flex().size_full().min_h(0).child(v_flex().flex_1().min_h(0).child(this.body(t, cx, true)));
  }
}
