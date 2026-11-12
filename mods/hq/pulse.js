// Pulse: what HQ noticed and what the org said. Left, the bottlenecks (each with the one action
// that clears it) and HQ's own log; right, the master's conversation with its org, newest first,
// filterable by who.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { alpha, btn, chip, clip, empty, icon, linkBtn, ok, onTint, row, scrollY, sectionHead, SP, timeAgo, tint, tone, TYPE } from "./ui.js";

const ACTION_WORD = {
  "loop-arm": "Arm loop",
  compact: "Compact",
  focus: "Go to",
  peek: "Peek",
  launch: "Launch",
  "open-master": "Start master",
  "new-manager": "Set up",
};

const KIND_WORD = { decision: "Decision", org: "Org", loop: "Loop", compact: "Compact", dream: "Dream", approval: "Asked you", question: "Asked you", done: "Work done", status: "Headline" };
const CLIP = 280; // characters of a message shown before "Show more"

export class PulseView {
  constructor(app) {
    this.app = app;
    this.peer = null; // filter the conversation to one peer
    this.morePeers = false;
    this.open = new Set(); // messages shown in full
  }

  onKey(_e, _cx) {
    return false;
  }

  render(t, cx) {
    const d = this.app.data;
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(
        v_flex()
          .w(360)
          .flex_none()
          .min_h(0)
          .border_r(1)
          .border_color(t.border)
          .bg(t.surface)
          .child(scrollY("pulse-left", v_flex().px(SP.lg).py(SP.lg).gap(SP.xl).child(this.signals(t, d)).child(this.log(t, d)))),
      )
      .child(this.comms(t, d));
  }

  signals(t, d) {
    const sig = d.signals ?? [];
    const color = s => (s.level === "alert" ? t.blocked : s.level === "warn" ? tone(t).warn : t.muted);
    return v_flex()
      .gap(SP.sm)
      .child(sectionHead(t, { level: "title", title: "Bottlenecks", count: sig.length || null }))
      .when(!sig.length, el =>
        el.child(
          h_flex()
            .gap(SP.sm)
            .items_center()
            .child(icon("circle-check", 13, ok(t)))
            .child(div().text_size(TYPE.ui).text_color(t.muted).child("Nothing is stuck.")),
        ),
      )
      .children(
        sig.map((s, i) =>
          v_flex()
            .id(`sig-${i}`)
            .px(SP.md)
            .py(10)
            .gap(6)
            .rounded(8)
            .bg(s.level === "info" ? alpha(t.foreground, 0.035) : alpha(color(s), 0.08))
            .child(
              row()
                .gap(SP.sm)
                .items_start()
                .child(div().flex_none().pt(2).child(icon(s.level === "info" ? "clock" : "alert", 13, color(s))))
                .child(div().flex_1().min_w(0).text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child(s.text)),
            )
            .child(
              h_flex()
                .pl(21)
                .gap(SP.sm)
                .items_center()
                .child(div().text_size(TYPE.meta).font_medium().text_color(s.level === "info" ? t.muted : onTint(t, color(s))).child(s.who))
                .when(!!s.terminal, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(s.terminal)))
                .child(div().flex_1())
                .when(!!s.action, el =>
                  el.child(
                    btn(t, `sig-act-${i}`, s.action.startsWith("review:") ? "Review" : (ACTION_WORD[s.action] ?? s.action), cx => this.app.doAction(s.action, s.who, s.terminal, cx), {
                      size: "sm",
                    }),
                  ),
                ),
            ),
        ),
      );
  }

  log(t, d) {
    const rows = (d.activity ?? []).slice(0, 40);
    return v_flex()
      .gap(SP.sm)
      .child(sectionHead(t, { level: "title", title: "HQ log" }))
      .when(!rows.length, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child("Decisions, org changes and autopilot chores show here.")))
      .children(
        rows.map((r, i) =>
          row()
            .id(`log-${i}`)
            .py(5)
            .gap(SP.md)
            .items_start()
            .child(timeAgo(t, r.at, d.now, { w: 52 }).pt(1))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().text_size(TYPE.ui).line_height(1.4).text_color(t.foreground).child(clip(r.text, 160)))
                .child(div().text_size(TYPE.meta).text_color(t.muted).child([KIND_WORD[r.kind] ?? r.kind, r.by ? `by ${r.by}` : null].filter(Boolean).join(" · "))),
            ),
        ),
      );
  }

  comms(t, d) {
    const all = d.master?.facts?.comms ?? [];
    const nameOf = addr => d.managers.find(m => m.terminal === addr)?.id;
    // Managers (and you) first, then anyone else, by how often they talked.
    const count = {};
    for (const c of all) count[c.peer] = (count[c.peer] ?? 0) + 1;
    const peers = Object.keys(count).sort((a, b) => (nameOf(a) ? 0 : 1) - (nameOf(b) ? 0 : 1) || count[b] - count[a]);
    const top = peers.filter(p => nameOf(p) || p === "person");
    const rest = peers.filter(p => !top.includes(p));
    const shown = this.morePeers ? peers : top;
    const rows = this.peer ? all.filter(c => c.peer === this.peer) : all;
    const pill = (p, text) => {
      const on = this.peer === p;
      return div()
        .id(`peer-${p ?? "all"}`)
        .h(24)
        .px(9)
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(TYPE.ui)
        .when(on, el => el.bg(tint(t).on).text_color(t.accent).font_medium())
        .when(!on, el => el.text_color(t.muted).hover(s => s.bg(tint(t).hover).text_color(t.foreground)))
        .on_click((_e, cx) => {
          this.peer = on ? null : p;
          cx.notify();
        })
        .child(text);
    };
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        v_flex()
          .px(SP.xl)
          .pt(SP.lg)
          .pb(SP.sm)
          .gap(SP.sm)
          .border_b(1)
          .border_color(alpha(t.border, 0.7))
          .child(sectionHead(t, { level: "title", title: "Conversation", hint: "between the master and its org, newest first" }))
          .child(
            h_flex()
              .gap(2)
              .flex_wrap()
              .items_center()
              .child(pill(null, "Everyone"))
              .children(shown.map(p => pill(p, p === "person" ? "You" : (nameOf(p) ?? p))))
              .when(rest.length > 0, el =>
                el.child(
                  div()
                    .id("peer-more")
                    .h(24)
                    .px(9)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(TYPE.ui)
                    .text_color(t.muted)
                    .hover(s => s.bg(tint(t).hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.morePeers = !this.morePeers;
                      cx.notify();
                    })
                    .child(this.morePeers ? "Fewer" : `${rest.length} more`),
                ),
              ),
          ),
      )
      .child(
        rows.length
          ? scrollY("pulse-comms", v_flex().px(SP.xl).py(SP.sm).children(rows.map((c, i) => this.message(t, c, i, nameOf(c.peer), d.now))))
          : empty(t, "No messages yet", "Messages between the master and its managers show here as they happen.", { icon: "send" }),
      );
  }

  /** One message in the conversation: who wrote to whom, its kind, when, and what was said. */
  message(t, c, i, name, now) {
    const out = c.dir === "out";
    const tag = /^\s*(?:[\w-]+(?: \(t\w+\))?:\s*)?(LESSON|READY|QUEUED-GREEN|BLOCKED|QUESTION|DONE)\b/.exec(c.text)?.[1];
    const tagColor = { LESSON: t.ansi5 ?? t.accent, READY: ok(t), "QUEUED-GREEN": ok(t), BLOCKED: t.blocked, QUESTION: t.accent, DONE: ok(t) }[tag];
    const who = c.peer === "person" ? "You" : (name ?? c.peer);
    const key = `${c.at}-${c.peer}-${i}`;
    const full = this.open.has(key);
    const long = (c.text ?? "").length > CLIP;
    return v_flex()
      .id(`msg-${i}`)
      .py(SP.md)
      .gap(6)
      .border_b(1)
      .border_color(alpha(t.border, 0.5))
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(
            div()
              .id(`msg-peer-${i}`)
              .text_size(TYPE.ui)
              .font_semibold()
              .text_color(t.foreground)
              .cursor_pointer()
              .hover(s => s.underline())
              .tooltip(c.peer !== "person" ? `Chat with ${who} (${c.peer})` : "")
              .on_click((_e, cx) => (c.peer !== "person" ? this.app.chatWith(c.peer, cx) : null))
              .child(out ? "Master" : who),
          )
          .child(icon("arrow-right", 10, t.muted))
          .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(out ? who : "Master"))
          .when(!!name, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(c.peer)))
          .when(!!tag, el => el.child(chip(t, tag === "QUEUED-GREEN" ? "Queued green" : tag[0] + tag.slice(1).toLowerCase(), tagColor)))
          .child(div().flex_1())
          .child(timeAgo(t, c.at, now)),
      )
      .child(div().max_w(760).text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(full || !long ? c.text : clip(c.text, CLIP)))
      .when(long, el =>
        el.child(
          linkBtn(t, `msg-more-${i}`, full ? "Show less" : "Show more", cx => {
            full ? this.open.delete(key) : this.open.add(key);
            cx.notify();
          }),
        ),
      );
  }
}
