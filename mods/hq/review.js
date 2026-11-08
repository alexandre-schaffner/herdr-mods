// Review: a decision deck, not an inbox. The decision in front of the person is the hero card,
// with what's asked, who asked, what runs on a yes, why, the evidence and the decision bar on the
// card itself. Other pending decisions wait in a short queue above it (←/→ or j/k). Work the org
// finished on its own is a quiet timeline below; past decisions fold into a history at the end.
// A decision goes back to whoever asked (hq.py delivers it).

import { h_flex, Textarea, TextareaState, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { openLink } from "./shared/viewer-link.js";
import { ago, alpha, btn, chip, clip, frame, icon, label, mdBlock, mono, ok, plain, row, scrollY, SP, TYPE, tone } from "./ui.js";

const KIND = {
  approval: { label: "Approval", icon: "alert", color: t => t.blocked },
  question: { label: "Question", icon: "user", color: t => t.accent },
  done: { label: "Work done", icon: "circle-check", color: t => ok(t) },
};

const VERDICT = {
  approve: { word: "Approved", color: t => ok(t) },
  reject: { word: "Rejected", color: t => t.blocked },
  answer: { word: "Answered", color: t => t.accent },
  ack: { word: "Looked over", color: t => t.muted },
  reopen: { word: "Reopened", color: t => tone(t).warn },
};

const DECK_W = 860;

export class ReviewView {
  constructor(app) {
    this.app = app;
    this.cur = null; // the pending decision on the deck
    this.focusDone = null; // a work-done item brought onto the deck to reply to
    this.open = new Set(); // expanded timeline and history rows
    this.history = false;
    this.focus = false;
    this.note = TextareaState.new({ placeholder: "Note for the decision (optional; needed to reject)", rows: 1 });
    this.note.set_auto_grow(1, 6);
    this.note.on("focus", (_e, cx) => {
      this.focus = true;
      cx.notify();
    });
    this.note.on("blur", (_e, cx) => {
      this.focus = false;
      cx.notify();
    });
    this.note.on("change", (_e, cx) => {
      if (this.needNote) this.needNote = false;
      cx.notify();
    });
  }

  typing() {
    return this.focus;
  }

  onShow(cx, arg) {
    if (!arg?.id) return;
    const it = (this.app.data?.inbox ?? []).find(i => i.id === arg.id);
    if (!it) return;
    if (it.state !== "open") {
      this.history = true;
      this.open.add(it.id);
    } else if (it.kind === "done") this.bring(it.id, cx);
    else this.select(it.id, cx);
    cx.notify();
  }

  lists() {
    const all = this.app.data?.inbox ?? [];
    return {
      waiting: all.filter(i => i.state === "open" && i.kind !== "done").sort((a, b) => (a.kind === b.kind ? b.createdAt - a.createdAt : a.kind === "approval" ? -1 : 1)),
      done: all.filter(i => i.state === "open" && i.kind === "done"),
      decided: all.filter(i => i.state !== "open").sort((a, b) => (b.decision?.at ?? 0) - (a.decision?.at ?? 0)),
    };
  }

  /** The item on the deck: a work-done item being replied to, else the chosen pending decision. */
  hero() {
    const ls = this.lists();
    const done = this.focusDone ? ls.done.find(i => i.id === this.focusDone) : null;
    if (done) return done;
    return ls.waiting.find(i => i.id === this.cur) ?? ls.waiting[0] ?? null;
  }

  resetNote() {
    this.note.set_value("");
    this.needNote = false;
  }

  select(id, cx) {
    if (id !== this.cur || this.focusDone) {
      this.cur = id;
      this.focusDone = null;
      this.resetNote();
    }
    cx?.notify();
  }

  bring(id, cx) {
    if (id !== this.focusDone) {
      this.focusDone = id;
      this.resetNote();
    }
    cx?.notify();
  }

  decide(it, verdict, cx) {
    const note = this.note.value().trim();
    if ((verdict === "reject" || verdict === "reopen" || verdict === "answer") && !note) {
      this.needNote = true;
      this.note.focus();
      cx.notify();
      return;
    }
    const ls = this.lists();
    const i = ls.waiting.findIndex(x => x.id === it.id);
    const next = i >= 0 ? (ls.waiting[i + 1] ?? ls.waiting[i - 1]) : null;
    this.app.act(cx, `decide-${it.id}`, ["decide", it.id, verdict, note], {
      fail: "Couldn't record the decision",
      then: (_r, cx) => {
        if (it.kind === "done") {
          this.focusDone = null;
          this.resetNote();
          cx.notify();
        } else this.select(next?.id ?? null, cx);
      },
    });
  }

  /** "Looks good" from the timeline: silent, nothing is sent. */
  ack(it, cx) {
    this.app.act(cx, `decide-${it.id}`, ["decide", it.id, "ack", ""], { fail: "Couldn't mark it looked over" });
  }

  ackAll(cx) {
    const items = this.lists().done;
    cx.spawn(async cx => {
      for (const it of items) {
        try {
          await this.app.hq(["decide", it.id, "ack", ""]);
        } catch {
          // left open; shows again
        }
      }
      this.app.refresh(cx);
    });
  }

  onKey(e, cx) {
    const ls = this.lists();
    const it = this.hero();
    const i = ls.waiting.findIndex(x => x.id === it?.id);
    if (["j", "right", "down"].includes(e.key)) {
      if (ls.waiting[i + 1]) this.select(ls.waiting[i + 1].id, cx);
      return true;
    }
    if (["k", "left", "up"].includes(e.key)) {
      if (i > 0) this.select(ls.waiting[i - 1].id, cx);
      return true;
    }
    if (e.key === "escape" && this.focusDone) {
      this.focusDone = null;
      cx.notify();
      return true;
    }
    if (!it) return false;
    if (e.key === "a" && it.kind === "approval") return this.decide(it, "approve", cx), true;
    if (e.key === "r" && it.kind !== "done") return this.decide(it, "reject", cx), true;
    if (e.key === "e" && it.kind === "done") return this.decide(it, "ack", cx), true;
    if (e.key === "n") return this.note.focus(), true;
    return false;
  }

  /** Who filed it, as the person knows them: the manager's id, else its terminal. */
  who(it) {
    return it.from?.role ?? it.from?.terminal ?? "someone";
  }

  // ---- drawing

  render(t, cx) {
    const ls = this.lists();
    const hero = this.hero();
    return scrollY(
      "rv-deck",
      v_flex()
        .w_full()
        .items_center()
        .px(SP.xl)
        .pt(SP.xl)
        .pb(SP.xxl)
        .child(
          v_flex()
            .w_full()
            .max_w(DECK_W)
            .gap(SP.xl)
            .child(this.deckHead(t, ls, hero))
            .when(ls.waiting.length > 1 && !this.focusDone, el => el.child(this.queue(t, ls.waiting, hero)))
            .child(hero ? this.card(t, hero) : this.calm(t, ls))
            .when(ls.done.length > 0, el => el.child(this.timeline(t, ls.done, hero)))
            .when(ls.decided.length > 0, el => el.child(this.historyBlock(t, ls.decided))),
        ),
    );
  }

  deckHead(t, ls, hero) {
    const n = ls.waiting.length;
    const i = ls.waiting.findIndex(x => x.id === hero?.id);
    return row()
      .items_center()
      .gap(SP.md)
      .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child(n ? (n === 1 ? "1 decision" : `${n} decisions`) : "Decisions"))
      .when(n > 1 && i >= 0 && !this.focusDone, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child(`${i + 1} of ${n} · ← → to move`)))
      .when(!!this.focusDone, el =>
        el.child(
          div()
            .id("rv-back")
            .text_size(TYPE.ui)
            .text_color(t.accent)
            .cursor_pointer()
            .hover(s => s.underline())
            .on_click((_e, cx) => {
              this.focusDone = null;
              cx.notify();
            })
            .child(n ? "Back to the decisions" : "Back"),
        ),
      );
  }

  /** The other pending decisions: small cards in a row, the one on the deck outlined. */
  queue(t, list, hero) {
    const now = this.app.data.now;
    return div()
      .id("rv-queue")
      .w_full()
      .overflow_x_scroll()
      .child(
        h_flex()
          .gap(SP.sm)
          .pb(2)
          .children(
            list.map(it => {
              const k = KIND[it.kind];
              const on = it.id === hero?.id;
              return v_flex()
                .id(`rv-q-${it.id}`)
                .flex_none()
                .w(220)
                .px(SP.md)
                .py(10)
                .gap(6)
                .rounded(10)
                .bg(t.background)
                .border(on ? 2 : 1)
                .border_color(on ? k.color(t) : alpha(t.border, 0.8))
                .cursor_pointer()
                .hover(s => s.border_color(k.color(t)))
                .tooltip(plain(it.title))
                .on_click((_e, cx) => this.select(it.id, cx))
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(icon(k.icon, 12, k.color(t)))
                    .child(div().text_size(TYPE.meta).font_medium().text_color(k.color(t)).child(k.label))
                    .child(div().flex_1())
                    .child(div().text_size(TYPE.meta).text_color(t.muted).child(ago(it.createdAt, now))),
                )
                .child(div().text_size(TYPE.ui).font_medium().line_height(1.35).text_color(t.foreground).child(clip(plain(it.title), 70)))
                .child(div().text_size(TYPE.meta).text_color(t.muted).child(`from ${this.who(it)}`));
            }),
          ),
      );
  }

  calm(t, ls) {
    return v_flex()
      .w_full()
      .items_center()
      .py(SP.xxl)
      .gap(SP.sm)
      .rounded(12)
      .border(1)
      .border_color(alpha(t.border, 0.6))
      .child(icon("circle-check", 22, ok(t)))
      .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Nothing needs your decision"))
      .child(
        div()
          .max_w(520)
          .text_center()
          .text_size(TYPE.ui)
          .line_height(1.5)
          .text_color(t.muted)
          .child(
            ls.done.length
              ? "The org is running on its own. Its finished work is below, to look over when you have a moment."
              : "Merges, deploys and messages to people land here for a yes or no, with exactly what will run and why.",
          ),
      );
  }

  /** The decision in front of the person: everything needed to decide, and the decision bar. */
  card(t, it) {
    const k = KIND[it.kind] ?? KIND.done;
    const now = this.app.data.now;
    const body = (it.body ?? "").trim();
    const from = it.from?.terminal && it.from?.role ? `${it.from.role} (${it.from.terminal})` : this.who(it);
    return v_flex()
      .id(`rv-card-${it.id}`)
      .w_full()
      .rounded(12)
      .bg(t.background)
      .border(1)
      .border_color(alpha(k.color(t), 0.45))
      .shadow_sm()
      .overflow_hidden()
      .child(
        v_flex()
          .px(SP.xl)
          .pt(20)
          .pb(SP.xl)
          .gap(SP.lg)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .flex_wrap()
              .child(chip(t, k.label, k.color(t), { icon: k.icon }))
              .child(
                div()
                  .id("rv-from")
                  .text_size(TYPE.ui)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover(s => s.underline())
                  .tooltip(it.from?.terminal ? `Chat with ${from}` : "")
                  .on_click((_e, cx) => it.from?.terminal && this.app.chatWith(it.from.terminal, cx))
                  .child(`From ${from}`),
              )
              .child(div().text_size(TYPE.ui).text_color(t.muted).child(`· filed ${ago(it.createdAt, now)}`)),
          )
          .child(div().text_size(TYPE.heading).font_semibold().line_height(1.3).text_color(t.foreground).child(plain(it.title)))
          .when(!!it.action, el =>
            el.child(
              v_flex()
                .gap(6)
                .child(label(t, it.kind === "approval" ? "Runs when you approve" : "Action"))
                .child(
                  div()
                    .px(SP.md)
                    .py(10)
                    .rounded(8)
                    .bg(alpha(it.kind === "approval" ? t.blocked : t.foreground, 0.05))
                    .border(1)
                    .border_color(alpha(it.kind === "approval" ? t.blocked : t.border, 0.4))
                    .font_family(mono())
                    .text_size(TYPE.ui)
                    .line_height(1.5)
                    .text_color(t.foreground)
                    .child(it.action),
                ),
            ),
          )
          .when(!!body, el => el.child(v_flex().gap(6).child(label(t, it.kind === "done" ? "What changed" : "Why")).child(mdBlock(t, `rv-body-${it.id}`, body, { maxW: 760 }))))
          .when((it.links ?? []).length > 0, el => el.child(this.evidence(t, it))),
      )
      .child(this.bar(t, it));
  }

  evidence(t, it) {
    return v_flex()
      .gap(6)
      .child(label(t, "Evidence"))
      .child(
        h_flex()
          .gap(SP.sm)
          .flex_wrap()
          .children(
            it.links.map((u, i) =>
              h_flex()
                .id(`rv-link-${it.id}-${i}`)
                .h(26)
                .px(SP.sm)
                .gap(6)
                .items_center()
                .rounded(6)
                .border(1)
                .border_color(alpha(t.accent, 0.35))
                .cursor_pointer()
                .hover(s => s.bg(alpha(t.accent, 0.08)))
                .tooltip(u)
                .on_click(() => openLink(u))
                .child(icon("external", 11, t.accent))
                .child(div().text_size(TYPE.ui).text_color(t.accent).child(clip(linkLabel(u), 60))),
            ),
          ),
      );
  }

  /** The decision bar, attached to the card: a note that grows, and the verdicts. */
  bar(t, it) {
    const busy = this.app.isBusy(`decide-${it.id}`);
    const buttons = {
      approval: [
        btn(t, "rv-reject", "Reject", cx => this.decide(it, "reject", cx), { kind: "danger", kbd: "R", disabled: busy }),
        btn(t, "rv-approve", "Approve", cx => this.decide(it, "approve", cx), { kind: "ok", kbd: "A", disabled: busy }),
      ],
      question: [
        btn(t, "rv-decline", "Decline", cx => this.decide(it, "reject", cx), { kind: "danger", kbd: "R", disabled: busy }),
        btn(t, "rv-answer", "Send answer", cx => this.decide(it, "answer", cx), { kind: "primary", disabled: busy }),
      ],
      done: [
        btn(t, "rv-reopen", "Reopen", cx => this.decide(it, "reopen", cx), { disabled: busy, tooltip: "Sends it back with your note" }),
        btn(t, "rv-ack", this.note.value().trim() ? "Looks good, send note" : "Looks good", cx => this.decide(it, "ack", cx), { kind: "ok", kbd: "E", disabled: busy }),
      ],
    }[it.kind];
    const needs = it.kind === "question" ? "Write your answer first." : "Add a note first: it goes back with the decision.";
    return v_flex()
      .px(SP.xl)
      .py(SP.md)
      .gap(6)
      .border_t(1)
      .border_color(alpha(t.border, 0.7))
      .bg(alpha(t.foreground, 0.025))
      .child(
        row()
          .gap(SP.sm)
          .items_end()
          .child(div().flex_1().min_w(0).child(frame(t, Textarea.new(this.note).w_full(), this.focus, { multiline: true })))
          .child(h_flex().flex_none().gap(SP.sm).children(buttons)),
      )
      .when(this.needNote, el => el.child(div().text_size(TYPE.meta).text_color(t.blocked).child(needs)));
  }

  /** Work the org finished on its own: one line each, "Looks good" inline. */
  timeline(t, list, hero) {
    const now = this.app.data.now;
    return v_flex()
      .gap(SP.sm)
      .child(
        row()
          .items_center()
          .gap(SP.sm)
          .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Work done"))
          .child(div().text_size(TYPE.ui).text_color(t.muted).child(`${list.length} to look over · nothing is sent unless you add a note`))
          .child(div().flex_1())
          .when(list.length > 1, el =>
            el.child(
              div()
                .id("rv-ackall")
                .text_size(TYPE.ui)
                .text_color(t.accent)
                .cursor_pointer()
                .hover(s => s.underline())
                .tooltip("Marks every item looked over. Nothing is sent to the org.")
                .on_click((_e, cx) => this.ackAll(cx))
                .child("Mark all looked over"),
            ),
          ),
      )
      .child(
        v_flex().children(
          list.map(it => {
            const expanded = this.open.has(it.id);
            const body = (it.body ?? "").trim();
            const onDeck = hero?.id === it.id;
            return v_flex()
              .id(`rv-done-${it.id}`)
              .border_b(1)
              .border_color(alpha(t.border, 0.5))
              .child(
                row()
                  .py(10)
                  .gap(SP.md)
                  .items_center()
                  .child(div().w(64).flex_none().text_size(TYPE.meta).text_color(t.muted).child(ago(it.createdAt, now)))
                  .child(icon("circle-check", 13, onDeck ? t.accent : ok(t)))
                  .child(
                    div()
                      .id(`rv-done-t-${it.id}`)
                      .flex_1()
                      .min_w(0)
                      .text_size(TYPE.body)
                      .text_color(t.foreground)
                      .cursor_pointer()
                      .hover(s => s.underline())
                      .on_click((_e, cx) => {
                        expanded ? this.open.delete(it.id) : this.open.add(it.id);
                        cx.notify();
                      })
                      .child(plain(it.title)),
                  )
                  .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(this.who(it)))
                  .child(btn(t, `rv-ack-${it.id}`, "Looks good", cx => this.ack(it, cx), { size: "sm", kind: "ghost", disabled: this.app.isBusy(`decide-${it.id}`) }))
                  .child(btn(t, `rv-reply-${it.id}`, null, cx => this.bring(it.id, cx), { size: "sm", kind: "ghost", icon: "send", tooltip: "Reply or reopen with a note" })),
              )
              .when(expanded && (!!body || (it.links ?? []).length > 0), el =>
                el.child(
                  v_flex()
                    .pl(64 + SP.md + 13 + SP.md)
                    .pb(SP.md)
                    .gap(SP.sm)
                    .when(!!body, e2 => e2.child(mdBlock(t, `rv-done-md-${it.id}`, body, { maxW: 680, size: TYPE.ui })))
                    .when((it.links ?? []).length > 0, e2 => e2.child(this.evidence(t, it))),
                ),
              );
          }),
        ),
      );
  }

  /** Past decisions, folded by default. */
  historyBlock(t, list) {
    const now = this.app.data.now;
    return v_flex()
      .gap(SP.sm)
      .child(
        h_flex()
          .id("rv-history-toggle")
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.history = !this.history;
            cx.notify();
          })
          .child(icon(this.history ? "chevron-down" : "chevron-right", 12, t.muted))
          .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("History"))
          .child(div().text_size(TYPE.ui).text_color(t.muted).child(`${list.length} decided`)),
      )
      .when(this.history, el =>
        el.child(
          v_flex().children(
            list.slice(0, 60).map(it => {
              const d = it.decision ?? {};
              const v = VERDICT[d.verdict] ?? { word: d.verdict ?? "Decided", color: () => t.muted };
              const sent = d.silent ? "nothing sent" : d.delivered ? `sent ${ago(d.deliveredAt, now)}` : `not sent: ${d.error ?? "waiting to retry"}`;
              const expanded = this.open.has(it.id);
              return v_flex()
                .id(`rv-h-${it.id}`)
                .border_b(1)
                .border_color(alpha(t.border, 0.5))
                .child(
                  row()
                    .id(`rv-h-row-${it.id}`)
                    .py(9)
                    .gap(SP.md)
                    .items_center()
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      expanded ? this.open.delete(it.id) : this.open.add(it.id);
                      cx.notify();
                    })
                    .child(div().w(64).flex_none().text_size(TYPE.meta).text_color(t.muted).child(ago(d.at, now)))
                    .child(div().w(96).flex_none().child(chip(t, v.word, v.color(t))))
                    .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).text_color(t.foreground).child(plain(it.title)))
                    .child(div().flex_none().text_size(TYPE.meta).text_color(!d.delivered && !d.silent ? t.blocked : t.muted).child(sent)),
                )
                .when(expanded, e2 =>
                  e2.child(
                    v_flex()
                      .pl(64 + SP.md)
                      .pb(SP.md)
                      .gap(SP.sm)
                      .child(div().text_size(TYPE.ui).text_color(t.muted).child(`${KIND[it.kind]?.label ?? it.kind} from ${this.who(it)} · filed ${ago(it.createdAt, now)}`))
                      .when(!!d.note, e3 => e3.child(div().text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(`“${d.note}”`)))
                      .when(!d.delivered && !d.silent, e3 =>
                        e3.child(div().child(btn(t, `rv-retry-${it.id}`, "Retry sending", cx => this.app.act(cx, "deliver", ["deliver"], { fail: "Couldn't send" }), { size: "sm" }))),
                      ),
                  ),
                );
            }),
          ),
        ),
      );
  }
}

/** A link as words: "PR #5322" for a pull request, the host and path otherwise. */
function linkLabel(u) {
  const pr = /\/pull\/(\d+)/.exec(u);
  if (pr) return `PR #${pr[1]} · ${u.replace(/^https?:\/\//, "").split("/")[0]}`;
  return u.replace(/^https?:\/\//, "");
}
