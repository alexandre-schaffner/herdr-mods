// The status strip: one line that answers "what's going on". Left, who: the master (its state as
// a glyph) and the epic. Middle, what: the master's headline (set each tick with `hq status`).
// Right, quiet until it isn't: the org as one glyph per manager (names only for those that need
// someone), plan usage once it runs hot, the master's loop and context, notifications, and,
// loudest of all, what waits for the person. Details live in tooltips and one click away.

import { h_flex } from "gpui-base";
import { div } from "gpui-kit";
import { layout, settings, window as window_ } from "herdr";

import { epicMenu } from "./epics.js";
import { ago, usageTone, alpha, clip, compact, ctxLimits, icon, inkOn, inTime, kbd, mix, ok, onTint, row, statusGlyph, statusLook, tint, tone, TYPE } from "./ui.js";

/** Room for macOS's window buttons when the sidebar is hidden and HQ reaches the window's edge. */
function lightsPad() {
  const root = layout();
  const find = n => (n?.id === "sidebar" ? n : (n?.children ?? []).map(find).find(Boolean));
  const w = window_();
  if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights) return 14;
  return find(root)?.hidden ? (root.traffic_lights[0] + 64) / (settings()?.zoom ?? 1) : 14;
}

/** One small control in the strip's right-hand cluster: the same height, radius and hover. */
const tool = (t, id) => h_flex().id(id).flex_none().h(28).px(8).gap(6).items_center().rounded(7).cursor_pointer().hover(s => s.bg(tint(t).hover));
const rule = t => div().flex_none().w(1).h(18).bg(alpha(t.border, 0.9));

export function statusStrip(app, t, _cx) {
  const d = app.data;
  const base = row().flex_none().h(44).bg(t.chrome ?? t.surface).border_b(1).border_color(t.border);
  if (!d) return base;
  const c = d.counts;
  return base
    .pl(lightsPad())
    .pr(10)
    .gap(12)
    .items_center()
    .children(identity(app, d, t))
    .child(rule(t))
    .child(headline(d, t))
    .child(
      h_flex()
        .flex_none()
        .gap(2)
        .items_center()
        .child(org(app, d, t))
        .child(usage(app, d, t) ?? div())
        .child(vitals(app, d, t))
        .child(app.notices ? app.notices.bell(t, Date.now()) : div()),
    )
    .child(judgement(app, d, t, c.approvals + c.questions));
}

/** Who: the master's state as its glyph, the repository, and the epic switcher. */
function identity(app, d, t) {
  const m = d.master;
  const status = m.terminal ? m.status : "gone";
  const st = statusLook(status, t);
  const current = app.view === "chat" && !!m.terminal && app.views.chat?.chat?.addr === m.terminal;
  const tip = m.terminal
    ? `Master (${m.terminal}) · ${st.label}${m.facts?.doing && m.status === "working" ? `\nNow: ${clip(m.facts.doing, 200)}` : ""}\nClick to chat · double-click for its terminal`
    : "The master isn't running. Click to start it.";
  return [
    h_flex()
      .id("strip-master")
      .flex_none()
      .h(28)
      .px(8)
      .ml(-8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(current, el => el.bg(tint(t).on))
      .hover(s => s.bg(current ? tint(t).on : tint(t).hover))
      .tooltip(tip)
      .on_click((e, cx) => (!m.terminal ? app.openMaster(cx) : e.click_count > 1 ? app.focusTerminal(m.terminal) : app.chatWith(m.terminal, cx)))
      .child(statusGlyph(status, t, 13, { still: app.palette?.open }))
      .child(div().flex_none().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(d.repo.repoName ?? d.repo.name))
      .when(!m.terminal, el => el.child(div().flex_none().text_size(TYPE.meta).font_medium().text_color(onTint(t, t.blocked)).child("Start master"))),
    epicMenu(app, d, t),
  ].filter(Boolean);
}

/** What: the master's one line. Grayed, with its age, once it's half an hour old. */
function headline(d, t) {
  const f = d.master.facts ?? {};
  const text = d.status?.text;
  const stale = !!d.status?.at && d.now - d.status.at > 30 * 60_000;
  const now = d.master.status === "working" ? f.doing : null;
  return h_flex()
    .id("strip-headline")
    .flex_1()
    .min_w(0)
    .overflow_hidden()
    .gap(8)
    .items_center()
    .tooltip([text, now ? `Now: ${now}` : null, d.status?.at ? `Set ${ago(d.status.at, d.now)}` : null].filter(Boolean).join("\n") || "The master sets this line each tick with hq status.")
    .child(
      div()
        .min_w(0)
        .flex_1()
        .truncate()
        .text_size(TYPE.body)
        .text_color(text && !stale ? t.foreground : t.muted)
        .child(text ? clip(text, 260) : f.said ? clip(f.said, 220) : "No headline yet"),
    )
    .when(!!text && stale, el => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(ago(d.status.at, d.now))));
}

/** The org: one glyph per manager. Only one that needs someone (blocked, gone) gets its name. */
function org(app, d, t) {
  const live = d.managers.filter(m => m.status !== "retired");
  if (!live.length)
    return tool(t, "strip-no-org")
      .tooltip("No managers yet")
      .on_click((_e, cx) => app.go("org", cx, { create: true }))
      .child(icon("plus", 12, t.muted))
      .child(div().text_size(TYPE.meta).text_color(t.muted).child("Set up the org"));
  const shown = live.slice(0, 10);
  const chatting = app.view === "chat";
  const heavyAt = ctxLimits(d.settings, "manager").warn;
  return h_flex()
    .flex_none()
    .items_center()
    .children(
      shown.map(m => {
        const status = m.live ? m.status : "gone";
        const st = statusLook(status, t);
        const f = m.facts ?? {};
        const what = m.live ? (m.status === "working" ? f.doing : f.said) || m.handoff?.goal || "" : "Its session is gone.";
        const ctx = f.context ?? 0;
        const loud = status === "blocked" || status === "gone";
        const current = chatting && !!m.terminal && app.views.chat?.chat?.addr === m.terminal;
        const wash = loud ? alpha(t.blocked, 0.1) : current ? tint(t).on : null;
        return h_flex()
          .id(`lane-${m.id}`)
          .flex_none()
          .h(28)
          .min_w(26)
          .px(loud ? 8 : 6)
          .gap(6)
          .items_center()
          .justify_center()
          .rounded(7)
          .cursor_pointer()
          .when(!!wash, el => el.bg(wash))
          .hover(s => s.bg(loud ? alpha(t.blocked, 0.16) : (wash ?? tint(t).hover)))
          .tooltip(
            [
              `${m.name || m.id} · ${st.label}`,
              what ? clip(what, 300) : null,
              ctx ? `${compact(ctx)} context${ctx > heavyAt ? " (heavy)" : ""}` : null,
              chatting ? "Click to talk to it" : "Click for details · double-click to chat",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .on_click((e, cx) => (chatting || e.click_count > 1 ? app.chatWith(m.terminal, cx) : app.go("org", cx, { id: m.id })))
          .child(statusGlyph(status, t, 12, { still: app.palette?.open }))
          .when(loud, el =>
            el.child(div().text_size(TYPE.meta).font_medium().text_color(onTint(t, t.blocked)).child(`${clip(m.name || m.id, 22)} ${status === "gone" ? "gone" : "needs you"}`)),
          );
      }),
    )
    .when(live.length > shown.length, el => el.child(div().px(4).text_size(TYPE.meta).text_color(t.muted).child(`+${live.length - shown.length}`)));
}

/** Plan usage, only once the hottest window passes 70%. */
function usage(app, d, t) {
  const u = app.views.usage?.summary?.()?.hottest;
  const pct = Math.round(u?.pct ?? 0);
  if (!u || pct < 70) return null;
  const color = usageTone(t, pct);
  return tool(t, "strip-usage")
    .tooltip(`Highest plan usage: ${u.label} at ${pct}%${u.resets ? `, resets ${inTime(u.resets * 1000, d.now)}` : ""}. Click for usage.`)
    .on_click((_e, cx) => app.go("usage", cx))
    .child(icon("layers", 12, color))
    .child(div().text_size(TYPE.meta).font_medium().text_color(onTint(t, color)).child(`${clip(u.label, 22)} ${pct}%`));
}

/** The master's loop and context in one control. Red when the loop is off or overdue. */
function vitals(app, d, t) {
  // HQ decides the loop's state once (hq.py loop_state): unarmed | stopped | running | waiting | overdue.
  const loop = d.master.loop ?? {};
  const on = ["running", "waiting", "overdue"].includes(loop.state);
  const bad = !on || loop.state === "overdue";
  const f = d.master.facts ?? {};
  const ctx = f.context ?? 0;
  const lim = ctxLimits(d.settings, "master");
  const ctxColor = ctx > lim.warn * 1.3 ? tone(t).alert : ctx > lim.warn ? tone(t).warn : null;
  const when = app.isBusy("loop")
    ? "arming…"
    : !on
      ? "Loop off"
      : loop.state === "overdue"
        ? "Overdue"
        : loop.wakeAt
          ? `tick ${inTime(loop.wakeAt, d.now)}`
          : "ticking";
  return tool(t, "strip-loop")
    .when(bad, el => el.bg(alpha(t.blocked, 0.1)).hover(s => s.bg(alpha(t.blocked, 0.16))))
    .tooltip(
      [
        on ? `${loop.reason ?? "Next tick"}${loop.wakeAt ? ` ${inTime(loop.wakeAt, d.now)}` : ""}` : "The master isn't looping, so it only acts when spoken to.",
        `Master context: ${ctx ? compact(ctx) : "?"} tokens${f.compactedAt ? `, compacted ${ago(f.compactedAt, d.now)}` : ""}`,
        bad ? "Click to arm /loop master tick" : "Click to see and edit its loop (L)",
      ].join("\n"),
    )
    .on_click((_e, cx) => (bad ? app.doAction("loop-arm", "master", d.master.terminal, cx) : app.go("loops", cx, { agent: "master" })))
    .child(icon("repeat", 12, bad ? t.blocked : t.muted))
    .child(div().text_size(TYPE.meta).font_medium().text_color(bad ? onTint(t, t.blocked) : t.muted).child(when))
    .when(!!ctx, el =>
      el
        .child(div().w(1).h(10).bg(alpha(t.border, 0.9)))
        .child(div().text_size(TYPE.meta).text_color(ctxColor ? onTint(t, ctxColor) : t.muted).child(compact(ctx))),
    );
}

/** The one loud control: what waits for the person. Quiet when nothing does. */
function judgement(app, d, t, waiting) {
  const c = d.counts;
  const key = app.viewList?.().find(v => v.id === "review")?.key;
  if (waiting > 0) {
    const what = [c.approvals ? `${c.approvals} approval${c.approvals > 1 ? "s" : ""}` : null, c.questions ? `${c.questions} question${c.questions > 1 ? "s" : ""}` : null]
      .filter(Boolean)
      .join(", ");
    const ink = t.accent_foreground ?? inkOn(t, t.accent);
    return h_flex()
      .id("strip-review")
      .flex_none()
      .h(30)
      .pl(11)
      .pr(key ? 7 : 11)
      .gap(8)
      .items_center()
      .rounded(8)
      .bg(t.accent)
      .cursor_pointer()
      .hover(s => s.bg(mix(t.accent.slice(0, 7), t.foreground.slice(0, 7), 0.12)))
      .tooltip(`${what} ${waiting === 1 ? "waits" : "wait"} for you`)
      .on_click((_e, cx) => app.go("review", cx))
      .child(icon("circle-check", 14, ink))
      .child(div().text_size(TYPE.ui).font_semibold().text_color(ink).child(`${what} ${waiting === 1 ? "waits" : "wait"}`))
      .when(!!key, el => el.child(kbd(t, key, ink)));
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
    .hover(s => s.bg(tint(t).hover))
    .tooltip(c.done ? `Nothing waits for you. ${c.done} finished item${c.done > 1 ? "s" : ""} to look over.` : "Nothing waits for you")
    .on_click((_e, cx) => app.go("review", cx))
    .child(icon("circle-check", 13, ok(t)))
    .child(div().text_size(TYPE.ui).text_color(t.muted).child(c.done ? `${c.done} to look over` : "All clear"));
}
