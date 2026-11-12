// HQ's controls and formatting: one look for buttons, chips, cards, meters and scroll areas.

import { h_flex, Scrollbar, TextView, v_flex } from "gpui-base";
import { openLink } from "./shared/viewer-link.js";
import { Background, div, PathBuilder, svg } from "gpui-kit";
import { settings } from "herdr";
import { alpha, icon, mix, ok } from "./shared/look.js";
import { richMarkdown } from "./shared/claude-rows.js";
import { openRich, richImage } from "./shared/rich.js";

export { alpha, icon, mix, ok };

// ---- the look: Vercel's Geist system. Geist type, true neutrals, 1px hairlines, inverted primary
// buttons, pill badges, small radii; color only where it carries meaning (status, focus, identity).

export const SANS = "Geist";
export const mono = () => "Geist Mono";

/** The theme, re-tuned to Geist: surfaces are the background itself (cards are hairlines, not fills),
 *  grays are mixed from the theme's own ink so light and dark both hold, accent is Vercel blue. */
export function geist(th) {
  const fg = th.foreground.slice(0, 7);
  const bg = th.background.slice(0, 7);
  const dark = settings()?.dark !== false;
  const blue = dark ? "#3291ff" : "#0070f3";
  return {
    ...th,
    canvas: bg,
    chrome: bg,
    surface: bg,
    raised: mix(bg, fg, 0.04),
    popover: mix(bg, fg, dark ? 0.06 : 0.0),
    hover: alpha(fg, 0.05),
    selected: alpha(fg, 0.08),
    border: alpha(fg, dark ? 0.12 : 0.1),
    input: alpha(fg, dark ? 0.18 : 0.16),
    muted: mix(fg, bg, dark ? 0.36 : 0.42),
    dim: mix(fg, bg, dark ? 0.52 : 0.56),
    accent: blue,
    accent_foreground: "#ffffff",
    solid: fg,
    solid_foreground: bg,
  };
}

/** An agent's status (hc's working | blocked | done | idle), as a color and a word. */
export function statusLook(status, t) {
  switch (status) {
    case "working":
      return { color: t.working, label: "Working" };
    case "blocked":
      return { color: t.blocked, label: "Needs you" };
    case "done":
      return { color: t.done, label: "Done" };
    case "idle":
      return { color: t.idle ?? t.muted, label: "Idle" };
    case "gone":
      return { color: t.blocked, label: "Gone" };
    case "retired":
      return { color: t.dim, label: "Retired" };
    default:
      return { color: t.dim, label: status ?? "—" };
  }
}

/** HQ's tones: one color per meaning, so a word reads the same in every view. */
export function tone(t) {
  return { ok: ok(t), warn: t.ansi3 ?? t.working, alert: t.blocked, info: t.accent, muted: t.muted };
}

/** Text in a tone drawn on that tone's own tint (a chip, a wash): pulled a quarter toward the
 *  foreground, which keeps it above 4.5:1 on light and dark themes alike. */
export function onTint(t, c) {
  return mix((c ?? t.muted).slice(0, 7), t.foreground.slice(0, 7), 0.25);
}

/** Text on a solid fill: whichever of the theme's ink pair (solid, solid_foreground) contrasts more. */
export function inkOn(t, fill) {
  const a = t.solid ?? t.foreground;
  const b = t.solid_foreground ?? t.background;
  return contrast(a, fill) >= contrast(b, fill) ? a : b;
}

function contrast(x, y) {
  const lum = hex => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** A clickable row's washes: the theme's hover, and a light accent fill while selected. */
/** A view's hue: one theme color per place, so the rail and each view's headings are
 *  recognisable at a glance. Restrained: icons and small accents only, never large fills. */
const VIEW_HUE = { home: "ansi3", map: "ansi6", next: "ansi2", review: "ansi1", chat: "ansi4", org: "ansi5", library: "ansi14", usage: "ansi11", pulse: "ansi12", memory: "ansi13", prompts: "ansi8" };
export function viewHue(t, id) {
  return t.foreground;
}

/** A theme color nudged toward full strength on dark themes and kept legible on light ones. */
export function vivid(t, c) {
  const base = (c ?? t.accent).slice(0, 7);
  return settingsDark() ? mix(base, "#ffffff", 0.08) : mix(base, "#000000", 0.12);
}

function settingsDark() {
  try {
    return settings()?.dark !== false;
  } catch {
    return true;
  }
}

/** An agent's identity hue (stable per id): its avatar's leading color, for text and washes beside it. */
export function agentHue(t, id) {
  return vivid(t, avatarLook({ id }).from);
}

export function tint(t) {
  return { hover: t.hover ?? alpha(t.foreground, 0.05), on: alpha(t.accent, 0.12) };
}

/** A layout row whose children fill its height (h_flex centers them instead). */
export const row = () => div().flex().flex_row();

export function dot(color, size = 8, pulse = false) {
  return div()
    .flex_none()
    .w(size)
    .h(size)
    .rounded_full()
    .bg(color)
    .when(pulse, el => el.loop("opacity", { from: 0.35, to: 1, period: 1400 }));
}

/** kind: "primary" | "secondary" | "ghost" | "danger" | "ok"; size: "sm" | "md". */
export function btn(t, id, label, onClick, o = {}) {
  const kind = o.kind ?? "secondary";
  const h = o.size === "sm" ? 24 : 30;
  const fg = {
    primary: t.background,
    ok: inkOn(t, ok(t)),
    danger: onTint(t, t.blocked),
    ghost: t.muted,
    secondary: t.foreground,
  }[kind];
  const bg = {
    primary: t.foreground,
    ok: ok(t),
    danger: alpha(t.blocked, 0.1),
    ghost: alpha(t.foreground, 0),
    secondary: t.background,
  }[kind];
  return h_flex()
    .id(id)
    .flex_none()
    .h(h)
    .px(label ? (o.size === "sm" ? 8 : 12) : 0)
    .when(!label, el => el.w(h).justify_center())
    .gap(6)
    .items_center()
    .rounded(6)
    .bg(bg)
    .when(kind === "secondary", el => el.border(1).border_color(t.input ?? t.border))
    .text_size(o.size === "sm" ? 11.5 : 12.5)
    .font_medium()
    .text_color(fg)
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .when(!!o.disabled, el => el.opacity(0.45))
    .when(!o.disabled, el =>
      el
        .cursor_pointer()
        .hover(s =>
          kind === "primary" || kind === "ok"
            ? s.bg(mix(bg.slice(0, 7), t.foreground.slice(0, 7), 0.12))
            : kind === "danger"
              ? s.bg(alpha(t.blocked, 0.18))
              : s.bg(alpha(t.foreground, 0.07)).text_color(t.foreground),
        )
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => onClick(cx, e)),
    )
    .when(!!o.icon, el => el.child(icon(o.icon, o.size === "sm" ? 12 : 14, fg)))
    .when(!!label, el => el.child(label))
    .when(!!o.kbd, el => el.child(kbd(t, o.kbd, kind === "primary" || kind === "ok" ? fg : null)));
}

/** A key hint. `ink`: the text color of the solid fill it sits on (a primary button's); its patch
 *  then moves away from that ink (toward the foreground), so the hint keeps the button's contrast. */
export function kbd(t, text, ink) {
  return div()
    .px(5)
    .h(16)
    .rounded(4)
    .flex()
    .items_center()
    .bg(alpha(t.foreground, ink ? 0.16 : 0.07))
    .text_size(10.5)
    .font_medium()
    .text_color(ink || t.muted)
    .child(text);
}

/** A small label in a tone, on its own tint. `value`: a quiet label, then the value in the tone.
 *  `scale`: the map's zoom, so a chip on the canvas sizes with it. */
export function chip(t, text, color, o = {}) {
  const c = color ?? t.muted;
  const ink = onTint(t, c);
  const s = v => Math.round(v * (o.scale ?? 1));
  return h_flex()
    .when(!!o.id, el => el.id(o.id))
    .flex_none()
    .h(s(o.h ?? 18))
    .px(s(o.value != null ? 8 : 6))
    .gap(s(o.value != null ? 5 : 4))
    .items_center()
    .rounded_full()
    .bg(alpha(c, 0.12))
    .text_size(s(o.size ?? 10.5))
    .font_medium()
    .whitespace_nowrap()
    .text_color(ink)
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .when(!!o.icon, el => el.child(icon(o.icon, s(10), ink)))
    .when(o.value == null, el => el.child(text))
    .when(o.value != null, el => el.child(div().text_color(onTint(t, t.muted)).child(text)).child(div().font_semibold().child(String(o.value))));
}

/** A segmented control: one of a few options, the chosen one raised. Item ids are `${id}-${item.id}`. */
export function segmented(t, id, items, value, onPick) {
  return h_flex()
    .flex_none()
    .p(3)
    .gap(2)
    .rounded(8)
    .bg(alpha(t.foreground, 0.055))
    .children(
      items.map(x => {
        const on = x.id === value;
        return h_flex()
          .id(`${id}-${x.id}`)
          .h(24)
          .px(10)
          .items_center()
          .rounded(6)
          .text_size(TYPE.ui)
          .cursor_pointer()
          .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
          .on_click((_e, cx) => onPick(x.id, cx))
          .child(x.label);
      }),
    );
}

/** A text button that reads as a link: accent, underlined on hover. `chevron`: a disclosure's
 *  open state (true: pointing down). */
export function linkBtn(t, id, text, onClick, o = {}) {
  return h_flex()
    .id(id)
    .gap(5)
    .items_center()
    .cursor_pointer()
    .text_size(TYPE.ui)
    .text_color(t.accent)
    .hover(s => s.underline())
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .on_click((e, cx) => onClick(cx, e))
    .when(o.chevron != null, el => el.child(icon(o.chevron ? "chevron-down" : "chevron-right", 11, t.accent)))
    .when(!!o.icon, el => el.child(icon(o.icon, 11, t.accent)))
    .child(text);
}

/** A bar across the top of a view: one height and one rule for every view. */
export function toolbar(t, children) {
  return row().flex_none().h(44).px(SP.lg).gap(SP.md).items_center().border_b(1).border_color(alpha(t.border, 0.7)).children(children);
}

/** A notice across a pane: a tone's tint and icon, what happened, and the one action that answers it. */
export function banner(t, o) {
  const c = o.tone ?? t.accent;
  return h_flex()
    .flex_none()
    .mx(SP.md)
    .mt(SP.md)
    .px(SP.md)
    .py(SP.sm)
    .gap(SP.sm)
    .items_center()
    .rounded(8)
    .bg(alpha(c, 0.1))
    .border(1)
    .border_color(alpha(c, 0.35))
    .child(icon(o.icon ?? "alert", 13, c))
    .child(div().flex_1().min_w(0).text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child(o.text))
    .when(!!o.action, el => el.child(o.action));
}

/** A section's name: sentence case, quiet weight. (No uppercase eyebrows.) */
export function label(t, text) {
  return div().text_size(12).font_semibold().text_color(t.muted).child(text);
}

// ---- type scale (px): one family, ~1.15 steps. Use these, not ad-hoc sizes.
export const TYPE = { meta: 11, ui: 12.5, body: 13.5, title: 15, heading: 19, display: 24 };

/** Status as shape and color together (never color alone): working spins, blocked alerts,
 *  done checks, idle is a hollow ring, gone is a cross. */
export function statusGlyph(status, t, size = 12, o = {}) {
  const s = statusLook(status, t);
  // `still`: animated layers paint above overlays, so glyphs under one stop spinning.
  if (status === "working" && o.still) return svg("shared/icons/spinner.svg").flex_none().w(size).h(size).text_color(s.color);
  if (status === "working") return svg("shared/icons/spinner.svg").flex_none().w(size).h(size).text_color(s.color).spin(1100);
  if (status === "blocked") return icon("alert", size, s.color);
  if (status === "done") return icon("circle-check", size, s.color);
  if (status === "gone") return icon("x", size, s.color);
  if (status === "retired") return icon("minus", size, s.color);
  return div().flex_none().w(size).h(size).rounded_full().border(Math.max(1.5, size / 7)).border_color(s.color);
}

/** An agent's status as its glyph and word. The word stays quiet unless someone is needed
 *  (blocked, gone). `glyph: false` for the word alone; `still` under an overlay. */
export function statusBadge(t, status, o = {}) {
  const size = o.size ?? 12;
  return h_flex()
    .flex_none()
    .gap(Math.round(size / 2))
    .items_center()
    .when(o.glyph !== false, el => el.child(statusGlyph(status, t, size, { still: o.still })))
    .child(div().text_size(o.text ?? TYPE.ui).text_color(status === "blocked" || status === "gone" ? onTint(t, t.blocked) : t.muted).child(statusLook(status, t).label));
}

/** Who an agent is: the master's crown, the merge queue's branch, a unit's bolt; an area manager has
 *  none. `avatar`: its avatar instead (see `avatar`), sized from `size`, so the map passes its zoomed size. */
export function agentMark(t, o) {
  const glyph = { master: "crown", "merge-queue": "git-branch", unit: "bolt" }[o.kind];
  const size = o.size ?? 12;
  const color = o.kind === "unit" ? agentHue(t, o.id) : (o.color ?? t.accent);
  if (!o.avatar) return glyph ? icon(glyph, size, color) : null;
  return avatar(t, { ...o, size });
}

// ---- avatars: Vercel's default avatar, a two-hue gradient circle per agent, drawn natively.
// [strong, light] pairs: a gradient runs from one agent-picked strong hue to another's light one.
const AVATAR_HUES = [
  ["#3b82f6", "#93c5fd"], ["#8b5cf6", "#c4b5fd"], ["#06b6d4", "#a5f3fc"], ["#10b981", "#a7f3d0"],
  ["#f59e0b", "#fde68a"], ["#ec4899", "#fbcfe8"], ["#6366f1", "#c7d2fe"], ["#14b8a6", "#99f6e4"],
  ["#f97316", "#fed7aa"], ["#a855f7", "#f0abfc"],
];
// The master and the merge queue look the same everywhere.
const AVATAR_RESERVED = { master: ["#6366f1", "#7dd3fc", 135], "merge-queue": ["#14b8a6", "#d9f99d", 135] };
const CIRCLE = () =>
  PathBuilder.fill().move_to("100%", "50%").arc_to("50%", "50%", 0, false, true, "0%", "50%").arc_to("50%", "50%", 0, false, true, "100%", "50%").close().build();

function avatarLook(o) {
  const reserved = AVATAR_RESERVED[o.id === "master" ? "master" : o.kind];
  if (reserved) return { from: reserved[0], to: reserved[1], angle: reserved[2] };
  let h = 2166136261;
  for (const ch of o.id ?? o.label ?? "") h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const n = AVATAR_HUES.length;
  const a = h % n;
  const b = (a + 1 + (Math.floor(h / n) % (n - 1))) % n; // never the same hue twice
  return { from: AVATAR_HUES[a][0], to: AVATAR_HUES[b][1], angle: [45, 135, 225, 315][Math.floor(h / (n * n)) % 4] };
}

/** An agent's avatar: its gradient, and its state as a dot cut into the bottom-right (working pulses
 *  blue, blocked red, done green; idle has none). Gone and retired grey the avatar out instead.
 *  `ring`: the surface it sits on, for the dot's cut-out (default the theme's background). `still`
 *  stops the pulse: animated layers paint above overlays, so one under an overlay must not move. */
export function avatar(t, o) {
  const s = o.size ?? 24;
  const st = o.status;
  const spent = st === "gone" || st === "retired";
  const dark = settingsDark();
  const look = spent ? { from: dark ? "#52525b" : "#a1a1aa", to: dark ? "#27272a" : "#e4e4e7", angle: 135 } : avatarLook(o);
  const fill = window.paint_path(CIRCLE(), Background.linear_gradient(look.angle, look.from, look.to)).absolute().left(0).top(0).w(s).h(s);
  const dotColor = { working: t.working, blocked: t.blocked, done: t.done }[st];
  const d = Math.max(6, Math.round(s * 0.34));
  const cut = Math.max(1.5, Math.round((s / 14) * 2) / 2);
  const dot = dotColor
    ? div()
        .absolute()
        .left(s - d + cut)
        .top(s - d + cut)
        .w(d)
        .h(d)
        .rounded_full()
        .bg(dotColor)
        .border(cut)
        .border_color(o.ring ?? t.background)
        .when(st === "working" && !o.still, el => el.loop("opacity", { from: 0.4, to: 1, period: 1400 }))
    : null;
  return div()
    .flex_none()
    .relative()
    .w(s)
    .h(s)
    .when(st === "retired", el => el.opacity(0.5))
    .child(fill)
    .when(!!dot, el => el.child(dot));
}

/** A section's heading: its title, a count, a hint, and controls on the right. `level`: "label" (a
 *  block of a detail pane, the default), "group" (a list's group) or "title" (a page's section).
 *  With `onToggle` (and an `id`) it folds open and closed. */
export function sectionHead(t, o) {
  const level = o.level ?? "label";
  const meta = level === "title" ? TYPE.ui : TYPE.meta;
  return h_flex()
    .when(!!o.id, el => el.id(o.id))
    .min_w(0)
    .gap(SP.sm)
    .items_center()
    .when(!!o.onToggle, el => el.cursor_pointer().on_click((_e, cx) => o.onToggle(cx)).child(icon(o.open ? "chevron-down" : "chevron-right", 11, t.muted)))
    .child(level === "label" ? label(t, o.title) : div().flex_none().text_size(level === "title" ? TYPE.title : TYPE.ui).font_semibold().text_color(t.foreground).child(o.title))
    .when(o.count != null, el => el.child(div().flex_none().text_size(meta).text_color(t.muted).child(String(o.count))))
    .when(!!o.hint, el => el.child(div().min_w(0).truncate().text_size(meta).text_color(t.muted).child(o.hint)))
    .when(!!o.right, el => el.child(div().flex_1()).child(o.right));
}

/** A titled block of a detail pane. */
export function section(t, title, body, o = {}) {
  return v_flex()
    .gap(8)
    .child(sectionHead(t, { title, hint: o.hint, right: o.right }))
    .children(Array.isArray(body) ? body : [body]);
}

export function card(t, o = {}) {
  return v_flex()
    .p(o.p ?? 12)
    .gap(o.gap ?? 8)
    .rounded(8)
    .bg(o.bg ?? t.surface)
    .border(1)
    .border_color(o.border ?? alpha(t.border, 0.9));
}

/** A raised panel (the dashboard's and the queue's sections): `card` one step up, rounder. */
export function panel(t, id = null) {
  const el = v_flex().min_w(0).rounded(12).bg(t.raised).border(1).border_color(alpha(t.border, 0.8));
  return id ? el.id(id) : el;
}

/** A plan window's fill as a tone: amber from 70%, red from 90% (the strip and Home agree). */
export function usageTone(t, pct) {
  const tn = tone(t);
  return pct >= 90 ? tn.alert : pct >= 70 ? tn.warn : tn.ok;
}

/** Context thresholds, so every meter agrees: the master's from its auto-compact point, a
 *  manager's from its warning size (`settings` is the snapshot's). */
export function ctxLimits(settings, role) {
  if (role === "master") return { warn: settings.masterCompactAt * 0.7, max: settings.masterCompactAt * 1.2 };
  return { warn: settings.managerWarnAt, max: settings.managerWarnAt * 1.6 };
}

/** Context size against its `ctxLimits`: a slim bar that turns amber past `warn`, then red. */
export function meter(t, value, lim, o = {}) {
  const { warn: warnAt, max } = lim;
  const frac = Math.max(0, Math.min(1, (value ?? 0) / max));
  const tn = tone(t);
  const color = value > warnAt * 1.3 ? tn.alert : value > warnAt ? tn.warn : tn.ok;
  return h_flex()
    .gap(6)
    .items_center()
    .child(
      div()
        .w(o.w ?? 64)
        .h(5)
        .rounded_full()
        .bg(alpha(t.foreground, 0.1))
        .child(div().h(5).rounded_full().bg(color).w(Math.max(2, Math.round((o.w ?? 64) * frac)))),
    )
    .child(div().text_size(10.5).font_family(mono()).text_color(value > warnAt ? color : t.muted).child(value ? compact(value) : "—"));
}

/** A region that fills its flex parent and scrolls vertically, with a visible bar. */
export function scrollY(id, content) {
  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(content.id(id).size_full().overflow_y_scroll())
    .child(Scrollbar.vertical(id).mode("always").absolute().inset_0());
}

/** The frame around an Input or Textarea; accent ring while focused. */
export function frame(t, inner, focused, o = {}) {
  return div()
    .w_full()
    .min_w(0)
    .px(10)
    .py(o.multiline ? 8 : 0)
    .when(!o.multiline, el => el.h(o.h ?? 30).flex().items_center())
    .rounded(6)
    .bg(t.background)
    .border(1)
    .border_color(focused ? t.accent : (t.input ?? t.border))
    .text_size(o.size ?? 12.5)
    .text_color(t.foreground)
    .when(!!o.mono, el => el.font_family(mono()))
    .child(inner);
}

/** Nothing to show: what's missing, why or what to do next, and an optional action. It fills its
 *  pane; `framed` draws it as a card inside a page instead. `tone` colors the icon. */
export function empty(t, title, body, o = {}) {
  return v_flex()
    .when(!o.framed, el => el.flex_1().justify_center())
    .when(!!o.framed, el => el.w_full().rounded(12).border(1).border_color(alpha(t.border, 0.6)))
    .items_center()
    .gap(SP.sm)
    .p(SP.xxl)
    .when(!!o.icon, el => el.child(icon(o.icon, 22, o.tone ?? t.muted)))
    .child(div().text_size(TYPE.title).font_semibold().text_center().text_color(t.foreground).child(title))
    .when(!!body, el => el.child(div().max_w(480).text_center().text_size(TYPE.ui).line_height(1.5).text_color(t.muted).child(body)))
    .when(!!o.action, el => el.child(div().pt(SP.xs).child(o.action)));
}

/** A pane whose data is on its way. */
export function loading(t, text) {
  return v_flex().flex_1().items_center().justify_center().p(SP.xxl).child(div().text_size(TYPE.ui).text_color(t.muted).child(text));
}

// ---- formatting

export function compact(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const pad2 = n => String(n).padStart(2, "0");
/** A time of day, 24-hour: "10:56". */
export const clock = ms => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
export const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A moment in full: "Sat 8 Nov, 10:56". */
export function stamp(ms) {
  const d = new Date(ms);
  return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}, ${clock(ms)}`;
}

/** A relative time ("12m ago") as quiet meta text, with the moment in full in its tooltip.
 *  `verb` leads it ("updated 12m ago"); `w` fixes its width for a time column. */
export function timeAgo(t, ms, now, o = {}) {
  return div()
    .flex_none()
    .when(!!o.w, el => el.w(o.w))
    .text_size(o.size ?? TYPE.meta)
    .text_color(t.muted)
    .when(!!ms, el => el.tooltip(stamp(ms)))
    .child(ms ? `${o.verb ? `${o.verb} ` : ""}${ago(ms, now)}` : "");
}

/** A duration: "12m", "1h 5m"; "–" when unknown. */
export function dur(ms) {
  if (ms == null) return "–";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function inTime(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return `${ago(ms, now).replace(" ago", "")} overdue`;
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`;
}

/** Markdown to one plain line: drops emphasis, code ticks, headings and list bullets. */
export function plain(text) {
  return (text ?? "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1· ")
    .replace(/:\s*\n\s*· /g, ": ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/([:.;])\s+[-*•]\s+/g, "$1 ")
    .replace(/\s+[-•]\s+(?=[A-Z])/g, " · ")
    .trim();
}

/** The one truncation rule: plain text cut to about `n` characters, at a word boundary when one is
 *  near, with an ellipsis. Show the full text in a tooltip wherever it's cut. */
export function clip(text, n) {
  const s = plain(text).replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const word = cut.replace(/\s+\S*$/, "").replace(/[\s,;:]+$/, "");
  return `${word.length >= n * 0.6 ? word : cut}…`;
}

/** Text wrapped to at most `n` lines of about `perLine` characters: cut by `clip`, its height capped
 *  as a backstop (the kit has no line clamp). */
export function lines(text, size, n, perLine, lh = 1.3) {
  return div().min_w(0).text_size(size).line_height(lh).max_h(Math.ceil(size * lh * n)).overflow_hidden().child(clip(text, perLine * n));
}

export function tildify(path, home) {
  return path && home && path.startsWith(home) ? "~" + path.slice(home.length) : (path ?? "");
}

export function shortModel(model) {
  if (!model) return "";
  const m = model.replace(/^claude-/, "");
  const hit = m.match(/^(opus|sonnet|haiku|fable)(?:-(\d+)-(\d+))?/);
  return hit ? (hit[2] ? `${hit[1]} ${hit[2]}.${hit[3]}` : hit[1]) : m;
}

// ---- layout primitives: every view builds from these, so the whole HQ reads as one system.
//
// Text rules: primary content (titles, what someone said, a decision's body) never truncates; it
// wraps. Secondary one-liners (a list row's subtitle) wrap to two lines at most by clipping the
// string (`clip(s, n)`), never by an ellipsis mid-word in a tiny box. Anything clipped carries the
// full text as a tooltip. Monospace only for code, commands, paths and ids, never for prose.

export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

/** The top of a detail pane: a title, optional chips beside it, a muted meta line that wraps,
 *  and the actions on their own row (so a long title never fights the buttons). */
export function pageHeader(t, o) {
  return v_flex()
    .gap(SP.sm)
    .child(
      h_flex()
        .gap(SP.sm)
        .items_center()
        .flex_wrap()
        .when(!!o.glyph, el => el.child(o.glyph))
        .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child(o.title))
        .children(o.chips ?? []),
    )
    .when(!!o.meta, el => el.child(div().text_size(TYPE.ui).line_height(1.45).text_color(t.muted).child(o.meta)))
    .when((o.actions ?? []).length > 0, el => el.child(h_flex().pt(SP.xs).gap(SP.sm).flex_wrap().children(o.actions)));
}

/** Facts as label/value rows: easier to scan than a dot-joined monospace line. A value is text or
 *  an element (a meter, a button); `o.mono` for ids and paths, `o.tip` for the full value. */
export function facts(t, rows) {
  return v_flex()
    .gap(SP.sm)
    .children(
      rows
        .filter(r => r && r[1] != null && r[1] !== "")
        .map(([k, v, o = {}]) =>
          row()
            .gap(SP.md)
            .items_start()
            .when(!!o.tip, el => el.id(`fact-${k}`).tooltip(o.tip))
            .child(div().w(o.w ?? 104).flex_none().pt(1).text_size(TYPE.ui).text_color(t.muted).child(k))
            .child(
              typeof v === "string" || typeof v === "number"
                ? div().flex_1().min_w(0).text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).when(!!o.mono, el => el.font_family(mono())).child(String(v))
                : div().flex_1().min_w(0).child(v),
            ),
        ),
    );
}

/** A view's side panel: a title bar with Close, over a body that scrolls itself (`pane`). */
export function drawer(t, o) {
  return v_flex()
    .flex_none()
    .w(o.width ?? 600)
    .min_h(0)
    .border_l(1)
    .border_color(t.border)
    .bg(t.background)
    .child(
      row()
        .flex_none()
        .h(36)
        .px(SP.md)
        .items_center()
        .border_b(1)
        .border_color(alpha(t.border, 0.6))
        .child(div().flex_1().text_size(TYPE.meta).text_color(t.muted).child(o.title))
        .child(btn(t, `${o.id}-close`, null, cx => o.onClose(cx), { kind: "ghost", size: "sm", icon: "x", tooltip: "Close (Esc)" })),
    )
    .child(v_flex().flex_1().min_h(0).child(o.body));
}

/** A pane that scrolls, with the standard reading padding. */
export function pane(id, content, o = {}) {
  return scrollY(id, v_flex().px(o.px ?? SP.xl).py(o.py ?? 20).gap(o.gap ?? SP.xl).child(content));
}

/** Markdown, rendered for reading: one size, comfortable line length, links open in place. */
/** Markdown, its ```mermaid diagrams drawn (shared/rich.js). The diagrams' "Code" toggles live here. */
const diagramCode = new Set();
export function mdBlock(t, id, text, o = {}) {
  if (/```mermaid/.test(text ?? ""))
    return div()
      .max_w(o.maxW ?? 760)
      .child(
        richMarkdown(id, text, t, o.size ?? TYPE.body, {
          cwd: o.cwd,
          colW: Math.min(o.maxW ?? 760, 760),
          rich: (kind, code) => richImage(kind, code),
          openRich: (kind, code) => openRich(richImage(kind, code)),
          isOpen: (key, byDefault) => byDefault !== diagramCode.has(key),
          toggle: (key, cx) => {
            if (diagramCode.has(key)) diagramCode.delete(key);
            else diagramCode.add(key);
            cx.notify();
          },
        }),
      );
  return div()
    .max_w(o.maxW ?? 760)
    .text_size(o.size ?? TYPE.body)
    .line_height(1.55)
    .text_color(t.foreground)
    .child(TextView.markdown(id, text ?? "").selectable(true).on_link_click(url => openLink(url, o.cwd)));
}
