// The command palette (⌘K or /): every HQ action and every agent, one search away.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { alpha, clip, icon, kbd, statusGlyph, TYPE, tint } from "./ui.js";

export class Palette {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.sel = 0;
    this.q = "";
    this.input = InputState.new({ placeholder: "Search actions, views, managers, decisions…" });
    this.input.on("change", (_e, cx) => {
      this.q = this.input.value();
      this.sel = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.run(this.items()[this.sel], cx));
  }

  show(cx) {
    this.open = true;
    this.sel = 0;
    this.q = "";
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  hide(cx) {
    this.open = false;
    this.app.h.focus();
    cx.notify();
  }

  run(item, cx) {
    if (!item) return;
    this.hide(cx);
    item.run(cx);
  }

  /** Everything the palette offers, best match first. */
  items() {
    const app = this.app;
    const d = app.data;
    const all = [];
    for (const v of app.viewList())
      all.push({ id: `view-${v.id}`, group: "Go to", label: v.label, icon: v.icon, key: v.key, run: cx => app.go(v.id, cx) });
    if (d) {
      for (const it of (d.inbox ?? []).filter(i => i.state === "open"))
        all.push({
          id: `rv-${it.id}`,
          group: it.kind === "done" ? "Look over" : "Decide",
          label: it.title,
          icon: it.kind === "approval" ? "alert" : it.kind === "question" ? "user" : "circle-check",
          run: cx => app.go("review", cx, { id: it.id }),
        });
      const m = d.master;
      if (m.terminal) {
        all.push({ id: "chat-master", group: "Chat", label: "Master", glyph: m.status, run: cx => app.chatWith(m.terminal, cx) });
        all.push({ id: "term-master", group: "Terminal", label: `Master (${m.terminal})`, icon: "terminal", run: () => app.focusTerminal(m.terminal) });
      }
      for (const x of d.managers.filter(x => x.status !== "retired" && x.live)) {
        all.push({ id: `chat-${x.id}`, group: "Chat", label: x.name || x.id, hint: x.id, glyph: x.status, run: cx => app.chatWith(x.terminal, cx) });
        all.push({ id: `org-${x.id}`, group: "Manager", label: x.name || x.id, hint: clip(x.area ?? "", 60), icon: "layers", run: cx => app.go("org", cx, { id: x.id }) });
        all.push({ id: `term-${x.id}`, group: "Terminal", label: `${x.id} (${x.terminal})`, icon: "terminal", run: () => app.focusTerminal(x.terminal) });
      }
      for (const x of d.managers.filter(x => x.status !== "retired" && !x.live))
        all.push({ id: `launch-${x.id}`, group: "Action", label: `Launch ${x.id}`, icon: "play", run: cx => app.doAction("launch", x.id, null, cx) });
      all.push(
        { id: "loop", group: "Action", label: "Arm the master's loop", icon: "repeat", run: cx => app.doAction("loop-arm", "master", m.terminal, cx) },
        { id: "compact", group: "Action", label: "Compact the master", icon: "shrink", run: cx => app.doAction("compact", "master", m.terminal, cx) },
        { id: "dream", group: "Action", label: "Dream now", hint: "consolidate ~/agent-memory", icon: "sparkles", run: cx => app.act(cx, "dream", ["dream"], { done: "Dreaming started", fail: "Couldn't start a Dream" }) },
        { id: "new-mgr", group: "Action", label: "New manager", icon: "plus", run: cx => app.go("org", cx, { create: true }) },
        { id: "adopt", group: "Action", label: "Adopt running sessions", icon: "search", run: cx => app.go("org", cx, { discover: true }) },
        { id: "side", group: "Action", label: app.chatPanel ? "Hide the side chat" : "Keep the chat beside every view", icon: "split", key: "C", run: cx => app.toggleChatPanel(cx) },
        { id: "refresh", group: "Action", label: "Refresh", icon: "redo", key: "G", run: cx => app.refresh(cx) },
      );
    }
    const q = this.q.trim().toLowerCase();
    if (!q) return all.filter(x => x.group !== "Terminal" && x.group !== "Manager").slice(0, 40);
    return all
      .map(x => ({ x, s: score(`${x.group} ${x.label} ${x.hint ?? ""}`.toLowerCase(), q) }))
      .filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map(r => r.x);
  }

  onKey(e, cx) {
    const items = this.items();
    if (e.key === "escape") return this.hide(cx), true;
    if (e.key === "down" || (e.key === "n" && e.modifiers?.control)) {
      this.sel = Math.min(items.length - 1, this.sel + 1);
      cx.notify();
      return true;
    }
    if (e.key === "up" || (e.key === "p" && e.modifiers?.control)) {
      this.sel = Math.max(0, this.sel - 1);
      cx.notify();
      return true;
    }
    if (e.key === "enter") return this.run(items[this.sel], cx), true;
    return false;
  }

  render(t) {
    const items = this.items();
    let lastGroup = null;
    const rows = [];
    items.forEach((x, i) => {
      if (x.group !== lastGroup) {
        lastGroup = x.group;
        rows.push(div().px(12).pt(i ? 10 : 4).pb(4).text_size(TYPE.meta).font_semibold().text_color(t.muted).child(x.group));
      }
      const on = i === this.sel;
      rows.push(
        h_flex()
          .id(`pal-${x.id}`)
          .mx(6)
          .h(34)
          .px(8)
          .gap(10)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(on, el => el.bg(tint(t).on))
          .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
          .on_click((_e, cx) => this.run(x, cx))
          .child(x.glyph ? statusGlyph(x.glyph, t, 13) : icon(x.icon ?? "chevron-right", 14, on ? t.accent : t.muted))
          .child(div().flex_none().text_size(TYPE.body).text_color(t.foreground).child(clip(x.label, 70)))
          .when(!!x.hint, el => el.child(div().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).child(x.hint)))
          .child(div().flex_1())
          .when(!!x.key, el => el.child(kbd(t, x.key))),
      );
    });
    return div()
      .id("palette-scrim")
      .absolute()
      .inset_0()
      .bg(alpha("#000000", 0.28))
      .flex()
      .flex_col()
      .items_center()
      .pt(70)
      .on_mouse_down("left", (_e, cx) => this.hide(cx))
      .child(
        v_flex()
          .id("palette")
          .w(600)
          .max_h(520)
          .rounded(12)
          .bg(t.popover ?? t.surface)
          .border(1)
          .border_color(t.border)
          .shadow_lg()
          .overflow_hidden()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => {
            if (this.onKey(e, cx)) cx.stop_propagation();
          })
          .child(
            h_flex()
              .h(48)
              .px(14)
              .gap(10)
              .items_center()
              .border_b(1)
              .border_color(t.border)
              .child(icon("search", 15, t.muted))
              .child(div().flex_1().text_size(TYPE.title).child(Input.new(this.input).w_full()))
              .child(kbd(t, "esc")),
          )
          .child(
            v_flex()
              .id("palette-list")
              .flex_1()
              .min_h(0)
              .py(6)
              .overflow_y_scroll()
              .children(rows.length ? rows : [div().p(16).text_size(TYPE.ui).text_color(t.muted).child("Nothing matches.")]),
          )
          .child(
            h_flex()
              .h(30)
              .px(14)
              .gap(14)
              .items_center()
              .border_t(1)
              .border_color(alpha(t.border, 0.7))
              .text_size(TYPE.meta)
              .text_color(t.muted)
              .child("↑↓ move")
              .child("↵ run")
              .child("esc close"),
          ),
      );
  }
}

/** Subsequence match, with bonuses for word starts and consecutive letters. */
function score(text, q) {
  let s = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = text.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 1;
    s += 1 + run + (at === 0 || text[at - 1] === " " ? 3 : 0);
    ti = at + 1;
  }
  return s;
}
