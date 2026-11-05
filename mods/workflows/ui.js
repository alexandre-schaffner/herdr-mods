// Shared controls for the editor and library: one look for buttons, choices and fields.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { alpha, icon, mix, mono } from "./util.js";

/** kind: "primary" | "secondary" | "ghost" | "danger"; size: "sm" | "md" | "lg". */
export function btn(t, id, label, onClick, o = {}) {
  const kind = o.kind ?? "secondary";
  const h = o.size === "lg" ? 38 : o.size === "sm" ? 26 : 30;
  const fg =
    kind === "primary"
      ? (t.accent_foreground ?? "#ffffff")
      : kind === "danger"
        ? t.blocked
        : kind === "ghost"
          ? t.muted
          : t.foreground;
  const bg =
    kind === "primary"
      ? t.accent
      : kind === "danger"
        ? alpha(t.blocked, 0.1)
        : kind === "ghost"
          ? alpha(t.foreground, 0)
          : t.background;
  return h_flex()
    .id(id)
    .flex_none()
    .h(h)
    .px(label ? (o.size === "lg" ? 16 : o.size === "sm" ? 9 : 12) : 0)
    .when(!label, el => el.w(h).justify_center())
    .gap(7)
    .items_center()
    .rounded(o.size === "lg" ? 10 : 8)
    .bg(bg)
    .when(kind === "secondary", el => el.border(1).border_color(t.border).shadow_sm())
    .when(kind === "primary", el => el.shadow_sm())
    .text_size(o.size === "lg" ? 13.5 : o.size === "sm" ? 11.5 : 12.5)
    .font_medium()
    .text_color(fg)
    .when(!!o.tooltip, el => el.tooltip(o.tooltip))
    .when(!!o.disabled, el => el.opacity(0.45))
    .when(!o.disabled, el =>
      el
        .cursor_pointer()
        .hover(s =>
          kind === "primary"
            ? s.bg(mix(t.accent, "#ffffff", 0.12))
            : kind === "danger"
              ? s.bg(alpha(t.blocked, 0.18))
              : s.bg(alpha(t.foreground, 0.06)).text_color(t.foreground),
        )
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => onClick(cx, e)),
    )
    .when(!!o.icon, el => el.child(icon(o.icon, o.size === "sm" ? 12 : 14, fg)))
    .when(!!label, el => el.child(label))
    .when(!!o.kbd, el => el.child(kbd(t, o.kbd, kind === "primary")));
}

export function kbd(t, text, onAccent) {
  return div()
    .px(5)
    .h(17)
    .rounded(4)
    .flex()
    .items_center()
    .bg(onAccent ? alpha("#ffffff", 0.2) : alpha(t.foreground, 0.07))
    .font_family(mono())
    .text_size(10)
    .text_color(onAccent ? (t.accent_foreground ?? "#ffffff") : t.dim)
    .child(text);
}

/** A segmented control: one of a few options, inline. */
export function seg(t, id, options, value, onPick, o = {}) {
  return h_flex()
    .flex_none()
    .p(3)
    .gap(2)
    .rounded(9)
    .bg(alpha(t.foreground, 0.055))
    .children(
      options.map(opt => {
        const on = opt.id === value;
        return h_flex()
          .id(`${id}-${opt.id || "none"}`)
          .h(o.size === "sm" ? 22 : 26)
          .px(!opt.label ? 6 : o.size === "sm" ? 8 : 11)
          .gap(6)
          .items_center()
          .rounded(7)
          .text_size(o.size === "sm" ? 11 : 12)
          .cursor_pointer()
          .when(!!opt.hint, el => el.tooltip(opt.hint))
          .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
          .on_click((_e, cx) => onPick(opt.id, cx))
          .when(!!opt.icon, el => el.child(icon(opt.icon, 12, on ? t.accent : t.dim)))
          .when(!!opt.label, el => el.child(opt.label));
      }),
    );
}

/** Pills that wrap: one of many options, with an optional color per option. */
export function chips(t, id, options, value, onPick) {
  return h_flex()
    .flex_wrap()
    .gap(6)
    .children(
      options.map(opt => {
        const on = opt.id === value;
        const c = opt.color ?? t.accent;
        return h_flex()
          .id(`${id}-${opt.id || "none"}`)
          .h(26)
          .px(10)
          .gap(6)
          .items_center()
          .rounded(13)
          .border(1)
          .text_size(11.5)
          .cursor_pointer()
          .when(!!opt.hint, el => el.tooltip(opt.hint))
          .when(on, el => el.bg(alpha(c, 0.14)).border_color(alpha(c, 0.6)).text_color(c).font_medium())
          .when(!on, el =>
            el
              .border_color(t.border)
              .text_color(t.muted)
              .hover(s => s.text_color(t.foreground).border_color(alpha(c, 0.45))),
          )
          .on_click((_e, cx) => onPick(opt.id, cx))
          .when(!!opt.dot, el => el.child(div().w(6).h(6).rounded_full().bg(opt.dot)))
          .child(opt.label);
      }),
    );
}

/** A labeled form row. */
export function field(t, label, control, o = {}) {
  return v_flex()
    .gap(7)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(label))
        .when(!!o.hint, el =>
          el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(o.hint)),
        )
        .when(!!o.right, el => el.child(div().flex_1()).child(o.right)),
    )
    .child(control)
    .when(!!o.error, el => el.child(div().text_size(11).text_color(t.blocked).child(o.error)));
}

/** The frame around an Input or Textarea; accent ring while focused. */
export function frame(t, inner, focused, o = {}) {
  return div()
    .w_full()
    .min_w(0)
    .px(o.px ?? 10)
    .py(o.py ?? (o.multiline ? 8 : 0))
    .when(!o.multiline, el =>
      el
        .h(o.h ?? 32)
        .flex()
        .items_center(),
    )
    .rounded(8)
    .bg(t.background)
    .border(1)
    .border_color(focused ? t.accent : o.error ? alpha(t.blocked, 0.7) : (t.input ?? t.border))
    .when(focused, el => el.shadow_sm())
    .text_size(o.size ?? 12.5)
    .text_color(t.foreground)
    .when(!!o.mono, el => el.font_family(mono()))
    .child(inner);
}

export function section(t, title, body, o = {}) {
  return v_flex()
    .gap(14)
    .pb(18)
    .mb(18)
    .when(!o.last, el => el.border_b(1).border_color(alpha(t.border, 0.7)))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
        .when(!!o.right, el => el.child(div().flex_1()).child(o.right)),
    )
    .children(Array.isArray(body) ? body : [body]);
}

export function toggle(t, id, on, onChange, label, hint) {
  return h_flex()
    .id(id)
    .gap(10)
    .items_center()
    .cursor_pointer()
    .on_click((_e, cx) => onChange(!on, cx))
    .child(
      div()
        .flex_none()
        .w(32)
        .h(18)
        .rounded_full()
        .bg(on ? t.accent : alpha(t.foreground, 0.15))
        .relative()
        .child(
          div()
            .absolute()
            .top(2)
            .left(on ? 16 : 2)
            .transition("left", { duration: 140, easing: "ease-out" })
            .w(14)
            .h(14)
            .rounded_full()
            .bg("#ffffff")
            .shadow_sm(),
        ),
    )
    .child(
      v_flex()
        .gap(2)
        .min_w(0)
        .child(div().text_size(12).text_color(t.foreground).child(label))
        .when(!!hint, el => el.child(div().text_size(11).text_color(t.dim).child(hint))),
    );
}

export function stepper(t, id, value, min, max, onChange, suffix = "") {
  const b = (dir, name) =>
    h_flex()
      .id(`${id}-${dir}`)
      .w(26)
      .h(26)
      .rounded(7)
      .justify_center()
      .items_center()
      .when((dir < 0 && value <= min) || (dir > 0 && value >= max), el => el.opacity(0.35))
      .cursor_pointer()
      .hover(s => s.bg(alpha(t.foreground, 0.07)))
      .on_click((_e, cx) => onChange(Math.max(min, Math.min(max, value + dir)), cx))
      .child(icon(name, 12, t.muted));
  return h_flex()
    .flex_none()
    .p(2)
    .gap(2)
    .items_center()
    .rounded(9)
    .border(1)
    .border_color(t.border)
    .child(b(-1, "minus"))
    .child(
      div().w(48).text_center().font_family(mono()).text_size(12).text_color(t.foreground).child(`${value}${suffix}`),
    )
    .child(b(1, "plus"));
}

/** A small rounded label. */
export function badge(t, text, color, o = {}) {
  const c = color ?? t.muted;
  return h_flex()
    .flex_none()
    .h(o.h ?? 18)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(5)
    .bg(alpha(c, o.solid ? 0.16 : 0.1))
    .text_size(10.5)
    .text_color(c)
    .when(!!o.mono, el => el.font_family(mono()))
    .when(!!o.icon, el => el.child(icon(o.icon, 10, c)))
    .child(text);
}

export function iconBtn(t, id, name, onClick, tip, o = {}) {
  return h_flex()
    .id(id)
    .flex_none()
    .w(o.size ?? 24)
    .h(o.size ?? 24)
    .rounded(6)
    .justify_center()
    .items_center()
    .when(!!tip, el => el.tooltip(tip))
    .when(!!o.disabled, el => el.opacity(0.3))
    .when(!o.disabled, el =>
      el
        .cursor_pointer()
        .hover(s => s.bg(o.danger ? alpha(t.blocked, 0.12) : alpha(t.foreground, 0.08)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => onClick(cx)),
    )
    .child(icon(name, o.icon ?? 13, o.color ?? t.muted));
}
