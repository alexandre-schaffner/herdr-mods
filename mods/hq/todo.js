// Next: the master's next moves (`hq todo`), as a plan the person steers. The master writes and
// closes items; the person reorders them, vetoes one, or attaches a note, and the master reads
// that in its next tick. In progress first, then the queue in order, then what's blocked.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { openLink } from "./shared/viewer-link.js";
import { ago, alpha, btn, chip, clip, empty, frame, icon, kbd, ok, plain, row, scrollY, sectionHead, SP, statusGlyph, TYPE } from "./ui.js";

const GROUPS = [
  { id: "doing", title: "In progress" },
  { id: "next", title: "Next", ordered: true },
  { id: "blocked", title: "Blocked" },
];

export class TodoView {
  constructor(app) {
    this.app = app;
    this.sel = null;
    this.noteFor = null; // item id whose note box is open, and why: "note" | "veto"
    this.noteKind = "note";
    this.showDone = false;
    this.focus = false;
    this.input = InputState.new({ placeholder: "A note for the master…" });
    this.input.on("focus", (_e, cx) => ((this.focus = true), cx.notify()));
    this.input.on("blur", (_e, cx) => ((this.focus = false), cx.notify()));
    this.input.on("submit", (_e, cx) => this.sendNote(cx));
  }

  typing() {
    return this.focus;
  }

  items() {
    return this.app.data?.todo?.items ?? [];
  }

  live() {
    const all = this.items();
    return GROUPS.flatMap(g => all.filter(x => x.status === g.id));
  }

  openNote(id, kind, cx) {
    this.noteFor = id;
    this.noteKind = kind;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  sendNote(cx) {
    const id = this.noteFor;
    const text = this.input.value().trim();
    if (!id || (this.noteKind === "note" && !text)) return;
    const args = this.noteKind === "veto" ? ["todo", "veto", id, text] : ["todo", "note", id, text];
    this.app.act(cx, `todo-${id}`, args, {
      done: this.noteKind === "veto" ? "Vetoed: the master sees it next tick" : "Note sent: the master sees it next tick",
      fail: "Couldn't save",
      then: (_r, cx) => {
        this.noteFor = null;
        cx.notify();
      },
    });
  }

  move(id, where, cx) {
    this.app.act(cx, `todo-${id}`, ["todo", "move", id, where], { fail: "Couldn't reorder" });
  }

  onKey(e, cx) {
    const list = this.live();
    const i = list.findIndex(x => x.id === this.sel);
    if (e.key === "j" || e.key === "down") return (this.sel = list[Math.min(list.length - 1, i + 1)]?.id ?? this.sel), cx.notify(), true;
    if (e.key === "k" || e.key === "up") return (this.sel = list[Math.max(0, i - 1)]?.id ?? this.sel), cx.notify(), true;
    const it = list[i];
    if (!it) return false;
    if (e.key === "n") return this.openNote(it.id, "note", cx), true;
    if (e.key === "[" && it.status === "next") return this.move(it.id, "up", cx), true;
    if (e.key === "]" && it.status === "next") return this.move(it.id, "down", cx), true;
    if (e.key === "escape" && this.noteFor) return (this.noteFor = null), cx.notify(), true;
    return false;
  }

  render(t, cx) {
    const d = this.app.data;
    const td = d.todo ?? {};
    const all = this.items();
    const live = this.live();
    const closed = all.filter(x => x.status === "done" || x.status === "dropped").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return scrollY(
      "todo-scroll",
      v_flex()
        .w_full()
        .items_center()
        .px(SP.xl)
        .py(SP.xl)
        .child(
          v_flex()
            .w_full()
            .max_w(860)
            .gap(SP.xl)
            .child(
              row()
                .items_end()
                .gap(SP.md)
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(4)
                    .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child("Next moves"))
                    .child(
                      div()
                        .text_size(TYPE.ui)
                        .text_color(t.muted)
                        .child(
                          td.updatedAt
                            ? `Kept by the master · updated ${ago(td.updatedAt, d.now)}${td.updatedBy && td.updatedBy !== "master" ? ` by ${td.updatedBy}` : ""}. Reorder, veto or add a note: it reads them next tick.`
                            : "The master writes its next moves here and keeps them current each tick.",
                        ),
                    ),
                )
                .child(h_flex().gap(4).items_center().child(kbd(t, "["))
                  .child(kbd(t, "]")).child(div().text_size(TYPE.meta).text_color(t.muted).child("reorder"))
                  .child(div().w(6)).child(kbd(t, "N")).child(div().text_size(TYPE.meta).text_color(t.muted).child("note"))),
            )
            .when(live.length === 0, el => el.child(empty(t, "No next moves yet", "The master adds them in its tick. Ask it in Chat if you want the plan now.", { icon: "list" })))
            .children(
              GROUPS.map(g => {
                const items = all.filter(x => x.status === g.id);
                if (!items.length) return div();
                return v_flex()
                  .gap(6)
                  .child(sectionHead(t, { level: "group", title: g.title, count: items.length }))
                  .children(items.map((it, i) => this.item(t, it, g.ordered ? i + 1 : null, i, items.length)));
              }),
            )
            .when(closed.length > 0, el =>
              el.child(
                v_flex()
                  .gap(4)
                  .child(
                    sectionHead(t, {
                      id: "todo-done-toggle",
                      level: "group",
                      title: "Done and dropped",
                      count: closed.length,
                      open: this.showDone,
                      onToggle: cx => ((this.showDone = !this.showDone), cx.notify()),
                    }),
                  )
                  .when(this.showDone, e2 => e2.children(closed.slice(0, 40).map(it => this.closedRow(t, it)))),
              ),
            ),
        ),
    );
  }

  owner(t, it) {
    const d = this.app.data;
    const o = it.owner;
    if (!o) return null;
    if (o === "person" || o === "you" || o === "alex") return chip(t, "You", t.accent, { icon: "user" });
    if (o === "master") return h_flex().gap(5).items_center().child(statusGlyph(d.master.terminal ? d.master.status : "gone", t, 10)).child(div().text_size(TYPE.meta).font_medium().text_color(t.foreground).child("master"));
    const m = d.managers.find(x => x.id === o || x.terminal === o);
    const term = !m && /^t[0-9a-z]+$/.test(o) ? o : null; // a session outside the org, by terminal
    return h_flex()
      .id(`todo-owner-${it.id}`)
      .gap(5)
      .items_center()
      .cursor_pointer()
      .tooltip(m ? `${m.name || m.id} · ${m.terminal ?? ""}: click to open` : term ? `Session ${term}: click to chat` : o)
      .on_click((_e, cx) => (m ? this.app.go("org", cx, { id: m.id }) : term ? this.app.chatWith(term, cx) : null))
      .child(m ? statusGlyph(m.live ? m.status : "gone", t, 10) : icon(term ? "terminal" : "user", 10, t.muted))
      .child(div().text_size(TYPE.meta).font_medium().text_color(t.foreground).child(m ? m.id : o));
  }

  item(t, it, n, i, count) {
    const d = this.app.data;
    const on = this.sel === it.id;
    const busy = this.app.isBusy(`todo-${it.id}`);
    const unseen = (it.notes ?? []).filter(x => !x.seen && x.kind !== "move");
    const tone = { doing: t.working, blocked: t.blocked, next: t.muted }[it.status] ?? t.muted;
    const lead =
      it.status === "doing"
        ? statusGlyph("working", t, 13, { still: this.app.palette?.open })
        : it.status === "blocked"
          ? icon("alert", 13, t.blocked)
          : div().w(20).text_size(TYPE.ui).font_semibold().text_color(t.muted).child(`${n}.`);
    return v_flex()
      .id(`todo-${it.id}`)
      .px(SP.lg)
      .py(SP.md)
      .gap(6)
      .rounded(10)
      .border(1)
      .border_color(on ? t.accent : alpha(t.border, 0.8))
      .bg(it.status === "doing" ? alpha(t.working, 0.04) : t.background)
      .when(busy, el => el.opacity(0.6))
      .on_click((_e, cx) => ((this.sel = it.id), cx.notify()))
      .child(
        row()
          .gap(SP.md)
          .items_start()
          .child(div().flex_none().pt(2).w(20).child(lead))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .child(div().text_size(TYPE.body).font_medium().line_height(1.4).text_color(t.foreground).child(it.title))
              .when(!!it.why, el => el.child(div().text_size(TYPE.ui).line_height(1.45).text_color(t.muted).child(plain(it.why))))
              .when(it.status === "blocked" && !!it.blockedOn, el => el.child(div().text_size(TYPE.ui).text_color(t.blocked).child(`Blocked on ${it.blockedOn}`)))
              .when((it.links ?? []).length > 0, el =>
                el.child(
                  h_flex()
                    .gap(6)
                    .flex_wrap()
                    .children(
                      it.links.map((u, k) => {
                        const pr = /\/pull\/(\d+)/.exec(u)?.[1];
                        return h_flex()
                          .id(`todo-link-${it.id}-${k}`)
                          .h(20)
                          .px(7)
                          .gap(4)
                          .items_center()
                          .rounded(5)
                          .border(1)
                          .border_color(alpha(t.border, 0.9))
                          .cursor_pointer()
                          .hover(s => s.border_color(t.accent))
                          .on_click(() => openLink(u))
                          .child(icon("external", 10, t.muted))
                          .child(div().text_size(TYPE.meta).text_color(t.foreground).child(pr ? `PR #${pr}` : clip(u.replace(/^https?:\/\//, ""), 40)));
                      }),
                    ),
                ),
              )
              .child(
                h_flex()
                  .gap(SP.sm)
                  .items_center()
                  .child(this.owner(t, it) ?? div())
                  .child(div().text_size(TYPE.meta).text_color(t.muted).child(`${it.by && it.by !== "master" ? `${it.by} · ` : ""}${ago(it.updatedAt ?? it.createdAt, d.now)}`))
                  .when(unseen.length > 0, el => el.child(chip(t, `${unseen.length} note${unseen.length > 1 ? "s" : ""} pending`, t.accent))),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(2)
              .items_center()
              .when(it.status === "next", el =>
                el
                  .child(btn(t, `todo-up-${it.id}`, null, cx => this.move(it.id, "up", cx), { kind: "ghost", size: "sm", icon: "arrow-up", tooltip: "Earlier ([)", disabled: i === 0 }))
                  .child(btn(t, `todo-down-${it.id}`, null, cx => this.move(it.id, "down", cx), { kind: "ghost", size: "sm", icon: "arrow-down", tooltip: "Later (])", disabled: i === count - 1 })),
              )
              .child(btn(t, `todo-note-${it.id}`, null, cx => this.openNote(it.id, "note", cx), { kind: "ghost", size: "sm", icon: "send", tooltip: "Note for the master (N)" }))
              .child(btn(t, `todo-veto-${it.id}`, null, cx => this.openNote(it.id, "veto", cx), { kind: "ghost", size: "sm", icon: "x", tooltip: "Veto: drop this move" })),
          ),
      )
      .when((it.notes ?? []).some(x => x.kind !== "move"), el =>
        el.child(
          v_flex()
            .pl(32)
            .gap(2)
            .children(
              it.notes
                .filter(x => x.kind !== "move")
                .slice(-3)
                .map((x, k) =>
                  div()
                    .id(`todo-n-${it.id}-${k}`)
                    .text_size(TYPE.meta)
                    .text_color(x.seen ? t.muted : t.accent)
                    .child(`You, ${ago(x.at, d.now)}: ${x.text}${x.seen ? "" : " (not read yet)"}`),
                ),
            ),
        ),
      )
      .when(this.noteFor === it.id, el =>
        el.child(
          row()
            .pl(32)
            .pt(4)
            .gap(SP.sm)
            .items_center()
            .child(div().flex_1().min_w(0).child(frame(t, Input.new(this.input).w_full(), this.focus)))
            .child(btn(t, `todo-send-${it.id}`, this.noteKind === "veto" ? "Veto" : "Send", cx => this.sendNote(cx), { kind: this.noteKind === "veto" ? "danger" : "primary", size: "sm" }))
            .child(btn(t, `todo-cancel-${it.id}`, null, cx => ((this.noteFor = null), cx.notify()), { kind: "ghost", size: "sm", icon: "x", tooltip: "Cancel (Esc)" })),
        ),
      );
  }

  closedRow(t, it) {
    const d = this.app.data;
    const dropped = it.status === "dropped";
    return row()
      .id(`todo-c-${it.id}`)
      .py(5)
      .pl(SP.lg)
      .gap(SP.md)
      .items_center()
      .child(icon(dropped ? "x" : "check", 12, dropped ? t.muted : ok(t)))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).text_color(t.muted).when(dropped, el => el.line_through()).child(it.title))
      .when(!!it.vetoed, el => el.child(chip(t, "vetoed", t.blocked)))
      .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(`${it.owner ?? ""} · ${ago(it.closedAt, d.now)}`));
  }
}
