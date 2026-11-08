// The status strip: what's going on right now. Two bands. The first is the master: its headline
// (set each tick with `hq status`), what it's doing this minute, and, loudest of all, what waits
// for the person. The second is the org as lanes, one per manager, plus the loop, context,
// plan usage and the top bottleneck, all quiet until they need attention.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { layout, settings, window as window_ } from "herdr";

import { ago, alpha, clip, icon, inTime, kbd, meter, mix, ok, row, statusGlyph, statusLook, TYPE } from "./ui.js";

/** Room for macOS's window buttons when the sidebar is hidden and HQ reaches the window's edge. */
function lightsPad() {
  const root = layout();
  const find = n => (n?.id === "sidebar" ? n : (n?.children ?? []).map(find).find(Boolean));
  const w = window_();
  if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights) return 14;
  return find(root)?.hidden ? (root.traffic_lights[0] + 64) / (settings()?.zoom ?? 1) : 14;
}

export function statusStrip(app, t, cx) {
  const d = app.data;
  if (!d) return div().h(88).bg(t.chrome ?? t.surface).border_b(1).border_color(t.border);
  return v_flex()
    .flex_none()
    .bg(t.chrome ?? t.surface)
    .border_b(1)
    .border_color(t.border)
    .child(masterBand(app, d, t))
    .child(orgBand(app, d, t));
}

function masterBand(app, d, t) {
  const m = d.master;
  const f = m.facts ?? {};
  const status = m.terminal ? m.status : "gone";
  const st = statusLook(status, t);
  const headline = d.status?.text;
  const stale = d.status?.at && d.now - d.status.at > 30 * 60_000;
  const now = m.status === "working" ? f.doing : null;
  const c = d.counts;
  const waiting = c.approvals + c.questions;
  return row()
    .h(44)
    .px(14)
    .pl(lightsPad())
    .gap(12)
    .items_center()
    .child(
      h_flex()
        .id("strip-master")
        .flex_none()
        .gap(10)
        .items_center()
        .px(8)
        .py(4)
        .ml(-8)
        .rounded(7)
        .when(app.view === "chat" && !!m.terminal && app.views.chat?.chat?.addr === m.terminal, el => el.border(1).border_color(t.accent).bg(alpha(t.accent, 0.1)))
        .hover(s => s.bg(alpha(t.foreground, 0.05)))
        .cursor_pointer()
        .tooltip(m.terminal ? `Chat with the master (${m.terminal}) · double-click for its terminal` : "Start the master chat")
        .on_click((e, cx) => (!m.terminal ? app.openMaster(cx) : e.click_count > 1 ? app.focusTerminal(m.terminal) : app.chatWith(m.terminal, cx)))
        .child(statusGlyph(status, t, 14, { still: app.palette?.open }))
        .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(d.repo.name))
        .child(div().text_size(TYPE.meta).text_color(status === "working" ? st.color : t.muted).child(m.terminal ? `${m.terminal} · ${st.label.toLowerCase()}` : "master not running")),
    )
    .child(div().flex_none().w(1).h(20).bg(alpha(t.border, 0.9)))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(10)
        .items_center()
        .tooltip([headline, now ? `Now: ${now}` : null, d.status?.at ? `Headline set ${ago(d.status.at, d.now)}` : null].filter(Boolean).join("\n"))
        .child(
          div()
            .min_w(0)
            .flex_1()
            .truncate()
            .text_size(TYPE.body)
            .font_medium()
            .text_color(stale ? t.muted : t.foreground)
            .child(headline ? clip(headline, 260) : f.said ? clip(f.said, 220) : ("No headline yet. The master sets one each tick with hq status.")),
        )

    )
    .child(judgement(app, d, t, waiting));
}

/** The one loud control: what waits for the person. Quiet when nothing does. */
function judgement(app, d, t, waiting) {
  const c = d.counts;
  if (waiting > 0) {
    const what = [c.approvals ? `${c.approvals} approval${c.approvals > 1 ? "s" : ""}` : null, c.questions ? `${c.questions} question${c.questions > 1 ? "s" : ""}` : null]
      .filter(Boolean)
      .join(", ");
    return h_flex()
      .id("strip-review")
      .flex_none()
      .h(30)
      .pl(11)
      .pr(7)
      .gap(8)
      .items_center()
      .rounded(8)
      .bg(t.accent)
      .cursor_pointer()
      .hover(s => s.bg(mix(t.accent.slice(0, 7), "#ffffff", 0.12)))
      .on_click((_e, cx) => app.go("review", cx))
      .child(icon("circle-check", 14, t.accent_foreground ?? "#ffffff"))
      .child(div().text_size(TYPE.ui).font_semibold().text_color(t.accent_foreground ?? "#ffffff").child(`${what} ${waiting === 1 ? "waits" : "wait"} for you`))
      .child(kbd(t, "3", true));
  }
  return h_flex()
    .id("strip-review")
    .flex_none()
    .h(30)
    .px(10)
    .gap(7)
    .items_center()
    .rounded(8)
    .cursor_pointer()
    .hover(s => s.bg(alpha(t.foreground, 0.05)))
    .on_click((_e, cx) => app.go("review", cx))
    .child(icon("circle-check", 13, ok(t)))
    .child(div().text_size(TYPE.ui).text_color(t.muted).child(c.done ? `Nothing waits · ${c.done} to look over` : "Nothing waits for you"));
}

function orgBand(app, d, t) {
  const live = d.managers.filter(m => m.status !== "retired");
  const f = d.master.facts ?? {};
  const loop = f.loop;
  const loopOn = loop && !loop.stopped && loop.wakeAt;
  const overdue = loopOn && d.now > loop.wakeAt + 3 * 60_000;
  const alerts = d.signals.filter(s => s.level !== "info");
  const top = d.signals.find(s => s.level === "alert") ?? d.signals.find(s => s.level === "warn");
  const usage = app.views.usage?.summary?.();
  const shown = live.slice(0, 8);
  return row()
    .h(32)
    .px(6)
    .gap(2)
    .items_center()
    .border_t(1)
    .border_color(alpha(t.border, 0.6))
    .children(shown.map(m => lane(app, d, t, m)))
    .when(live.length > shown.length, el => el.child(div().px(8).text_size(TYPE.meta).text_color(t.muted).child(`+${live.length - shown.length}`)))
    .when(live.length === 0, el =>
      el.child(
        h_flex()
          .id("strip-no-org")
          .px(8)
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => app.go("org", cx, { create: true }))
          .child(icon("plus", 12, t.muted))
          .child(div().text_size(TYPE.ui).text_color(t.muted).child("No managers yet. Set up the org")),
      ),
    )
    .child(div().flex_1().min_w(8))
    .when(!!top, el =>
      el.child(
        h_flex()
          .id("strip-signal")
          .flex_none()
          .h(26)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover(s => s.bg(alpha(t.foreground, 0.05)))
          .tooltip(alerts.map(s => `${s.who}: ${s.text}`).join("\n") || top.text)
          .on_click((_e, cx) => app.go("pulse", cx))
          .child(icon("alert", 12, top.level === "alert" ? t.blocked : (t.ansi3 ?? t.working)))
          .child(div().text_size(TYPE.meta).text_color(top.level === "alert" ? t.blocked : t.muted).child(alerts.length > 1 ? `${alerts.length}` : top.who)),
      ),
    )
    .when(!!usage?.hottest, el => {
      const u = usage.hottest;
      const pct = Math.round(u.pct ?? 0);
      const color = pct >= 90 ? t.blocked : pct >= 70 ? (t.ansi3 ?? t.working) : t.muted;
      return el.child(
        h_flex()
          .id("strip-usage")
          .flex_none()
          .h(26)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover(s => s.bg(alpha(t.foreground, 0.05)))
          .tooltip(`Highest plan usage: ${u.label} at ${pct}%${u.resets ? `, resets ${inTime(u.resets * 1000, d.now)}` : ""}. Click for proxy usage.`)
          .on_click((_e, cx) => app.go("usage", cx))
          .child(icon("layers", 12, color))
          .child(div().text_size(TYPE.meta).text_color(color).child(`${clip(u.label, 22)} ${pct}%`)),
      );
    })
    .child(
      h_flex()
        .id("strip-loop")
        .flex_none()
        .h(26)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(!loopOn || overdue, el => el.bg(alpha(t.blocked, 0.1)))
        .hover(s => s.bg(alpha(t.foreground, 0.06)))
        .tooltip(
          loopOn
            ? `${loop.reason ?? "Next tick"}${overdue ? ". Overdue: click to re-arm" : ""}`
            : "The master isn't looping, so it only acts when spoken to. Click to arm /loop master tick.",
        )
        .on_click((_e, cx) => (!loopOn || overdue ? app.doAction("loop-arm", "master", d.master.terminal, cx) : app.chatWith(d.master.terminal, cx)))
        .child(icon("repeat", 12, loopOn && !overdue ? t.muted : t.blocked))
        .child(
          div()
            .text_size(TYPE.meta)
            .text_color(loopOn && !overdue ? t.muted : t.blocked)
            .child(app.isBusy("loop") ? "arming…" : loopOn ? `tick ${inTime(loop.wakeAt, d.now)}` : "loop off"),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .px(8)
        .gap(6)
        .items_center()
        .tooltip(`Master context: ${f.context ?? "?"} tokens${f.compactedAt ? `, compacted ${ago(f.compactedAt, d.now)}` : ""}`)
        .child(meter(t, f.context, d.settings.masterCompactAt * 0.7, { max: d.settings.masterCompactAt * 1.2, w: 44 })),
    );
}

function lane(app, d, t, m) {
  const status = m.live ? m.status : "gone";
  const st = statusLook(status, t);
  const f = m.facts ?? {};
  const what = m.live ? (m.status === "working" ? f.doing : f.said) || m.handoff?.goal || "" : "session gone";
  const ctx = f.context ?? 0;
  const heavy = ctx > d.settings.managerWarnAt;
  // Only what needs attention gets words; the rest is shape and name (details on hover).
  const flag = status === "blocked" ? "needs you" : status === "gone" ? "gone" : heavy ? `${Math.round(ctx / 1000)}k ctx` : null;
  const flagColor = status === "blocked" || status === "gone" ? t.blocked : (t.ansi3 ?? t.working);
  const chatting = app.view === "chat";
  const current = chatting && !!m.terminal && app.views.chat?.chat?.addr === m.terminal;
  return h_flex()
    .id(`lane-${m.id}`)
    .flex_none()
    .h(24)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .when(status === "blocked" || status === "gone", el => el.bg(alpha(t.blocked, 0.1)))
    .when(current, el => el.border(1).border_color(t.accent).bg(alpha(t.accent, 0.1)))
    .hover(s => s.bg(alpha(t.foreground, 0.06)))
    .tooltip(
      `${m.name || m.id} · ${m.terminal ?? "no terminal"} · ${st.label}\n${clip(what, 300)}\n${chatting ? "Click to talk to it" : "Click for details · double-click to chat"}`,
    )
    .on_click((e, cx) => (chatting || e.click_count > 1 ? app.chatWith(m.terminal, cx) : app.go("org", cx, { id: m.id })))
    .child(statusGlyph(status, t, 11, { still: app.palette?.open }))
    .when(m.kind === "merge-queue", el => el.child(icon("git-branch", 11, t.accent)))
    .child(div().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(m.id))
    .when(!!flag, el => el.child(div().text_size(TYPE.meta).font_medium().text_color(flagColor).child(flag)));
}
