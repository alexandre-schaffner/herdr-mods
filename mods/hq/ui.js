// HQ's controls and formatting: one look for buttons, chips, cards, meters and scroll areas.

import { h_flex, Scrollbar, TextView, v_flex } from "gpui-base";
import { openLink } from "./shared/viewer-link.js";
import { div, svg } from "gpui-kit";
import { alpha, icon, mix, mono, ok } from "./shared/look.js";

export { alpha, icon, mix, mono, ok };

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

/** A clickable row's washes: the theme's hover, and a light accent fill while selected. */
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
    primary: t.accent_foreground ?? "#ffffff",
    ok: "#ffffff",
    danger: t.blocked,
    ghost: t.muted,
    secondary: t.foreground,
  }[kind];
  const bg = {
    primary: t.accent,
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
    .rounded(7)
    .bg(bg)
    .when(kind === "secondary", el => el.border(1).border_color(t.border))
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
            ? s.bg(mix(bg.slice(0, 7), "#ffffff", 0.12))
            : kind === "danger"
              ? s.bg(alpha(t.blocked, 0.18))
              : s.bg(alpha(t.foreground, 0.07)).text_color(t.foreground),
        )
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => onClick(cx, e)),
    )
    .when(!!o.icon, el => el.child(icon(o.icon, o.size === "sm" ? 12 : 14, fg)))
    .when(!!label, el => el.child(label))
    .when(!!o.kbd, el => el.child(kbd(t, o.kbd, kind === "primary" || kind === "ok")));
}

export function kbd(t, text, onColor) {
  return div()
    .px(5)
    .h(16)
    .rounded(4)
    .flex()
    .items_center()
    .bg(onColor ? alpha("#ffffff", 0.22) : alpha(t.foreground, 0.07))
    .text_size(10.5)
    .font_medium()
    .text_color(onColor ? "#ffffff" : t.dim)
    .child(text);
}

export function chip(t, text, color, o = {}) {
  const c = color ?? t.muted;
  return h_flex()
    .flex_none()
    .h(o.h ?? 18)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(5)
    .bg(alpha(c, 0.13))
    .text_size(o.size ?? 10.5)
    .font_medium()
    .text_color(c)
    .when(!!o.icon, el => el.child(icon(o.icon, 10, c)))
    .child(text);
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

/** A titled block of a detail pane. */
export function section(t, title, body, o = {}) {
  return v_flex()
    .gap(8)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(label(t, title))
        .when(!!o.hint, el => el.child(div().text_size(11).text_color(t.dim).truncate().child(o.hint)))
        .child(div().flex_1())
        .when(!!o.right, el => el.child(o.right)),
    )
    .children(Array.isArray(body) ? body : [body]);
}

export function card(t, o = {}) {
  return v_flex()
    .p(o.p ?? 12)
    .gap(o.gap ?? 8)
    .rounded(10)
    .bg(o.bg ?? t.surface)
    .border(1)
    .border_color(o.border ?? alpha(t.border, 0.9));
}

/** Context size against a soft limit: a slim bar that turns amber, then red. */
export function meter(t, value, warnAt, o = {}) {
  const max = o.max ?? warnAt * 1.6;
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
    .child(div().text_size(10.5).font_family(mono()).text_color(value > warnAt ? color : t.dim).child(value ? compact(value) : "—"));
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
    .rounded(8)
    .bg(t.background)
    .border(1)
    .border_color(focused ? t.accent : (t.input ?? t.border))
    .text_size(o.size ?? 12.5)
    .text_color(t.foreground)
    .when(!!o.mono, el => el.font_family(mono()))
    .child(inner);
}

export function empty(t, title, body, o = {}) {
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap(8)
    .p(30)
    .when(!!o.icon, el => el.child(icon(o.icon, 26, t.dim)))
    .child(div().text_size(14).font_semibold().text_color(t.muted).child(title))
    .when(!!body, el => el.child(div().max_w(420).text_size(12).text_color(t.dim).text_center().child(body)))
    .when(!!o.action, el => el.child(div().pt(6).child(o.action)));
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

export function clip(text, n) {
  const s = plain(text).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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

/** A selectable two-line list row: glyph, title (one line, full text in its tooltip), subtitle
 *  wrapped to two lines, and a right column for small facts. */
export function listRow(t, o) {
  const sub = o.sub ? clip(o.sub, o.subMax ?? 120) : null;
  return row()
    .id(o.id)
    .px(SP.md)
    .py(10)
    .gap(SP.md)
    .items_start()
    .rounded(8)
    .cursor_pointer()
    .when(!!o.on, el => el.bg(tint(t).on))
    .when(!o.on, el => el.hover(s => s.bg(tint(t).hover)))
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .on_click((e, cx) => o.onClick?.(cx, e))
    .when(!!o.glyph, el => el.child(div().flex_none().pt(3).child(o.glyph)))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .min_w(0)
            .children(o.lead ?? [])
            .child(div().min_w(0).truncate().text_size(TYPE.body).font_medium().text_color(t.foreground).child(o.title))
            .children(o.tags ?? []),
        )
        .when(!!sub, el => el.child(div().text_size(TYPE.ui).line_height(1.4).text_color(t.muted).child(sub))),
    )
    .when(!!o.right, el => el.child(v_flex().flex_none().items_end().gap(4).pt(2).children([].concat(o.right))));
}

/** Facts as label/value rows: easier to scan than a dot-joined monospace line. */
export function facts(t, rows) {
  return v_flex()
    .gap(6)
    .children(
      rows
        .filter(r => r && r[1] != null && r[1] !== "")
        .map(([k, v, o = {}]) =>
          row()
            .gap(SP.md)
            .items_start()
            .child(div().w(o.w ?? 96).flex_none().text_size(TYPE.ui).text_color(t.muted).child(k))
            .child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(t.foreground).when(!!o.mono, el => el.font_family(mono())).child(String(v))),
        ),
    );
}

/** A pane that scrolls, with the standard reading padding. */
export function pane(id, content, o = {}) {
  return scrollY(id, v_flex().px(o.px ?? SP.xl).py(o.py ?? 20).gap(o.gap ?? SP.xl).child(content));
}

/** Markdown, rendered for reading: one size, comfortable line length, links open in place. */
export function mdBlock(t, id, text, o = {}) {
  return div()
    .max_w(o.maxW ?? 760)
    .text_size(o.size ?? TYPE.body)
    .line_height(1.55)
    .text_color(t.foreground)
    .child(TextView.markdown(id, text ?? "").selectable(true).on_link_click(url => openLink(url, o.cwd)));
}
