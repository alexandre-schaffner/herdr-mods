// The panel's controls: one look for buttons, chips and section headers.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { alpha, icon, mix, mono } from "./util.js";

/** Keeps a press from reaching the window behind (a press a mod doesn't stop drags it). */
export const stop = (_e, cx) => cx.stop_propagation();

/** kind: "primary" | "secondary" | "ghost" | "tinted"; size: "sm" | "md" | "lg". */
export function btn(t, id, label, onClick, o = {}) {
  const kind = o.kind ?? "secondary";
  const h = o.size === "lg" ? 36 : o.size === "sm" ? 26 : 30;
  const tint = o.tint ?? t.accent;
  const fg =
    kind === "primary"
      ? t.solid_foreground
      : kind === "tinted"
        ? tint
        : kind === "ghost"
          ? t.muted
          : t.foreground;
  const bg =
    kind === "primary"
      ? t.solid
      : kind === "tinted"
        ? alpha(tint, 0.12)
        : kind === "ghost"
          ? alpha(t.foreground, 0)
          : t.background;
  return h_flex()
    .id(id)
    .flex_none()
    .h(h)
    .px(label ? (o.size === "lg" ? 14 : o.size === "sm" ? 9 : 11) : 0)
    .when(!label, (el) => el.w(h).justify_center())
    .when(Boolean(o.grow), (el) => el.flex_1().min_w(0).justify_center())
    .gap(7)
    .items_center()
    .rounded(o.size === "lg" ? 10 : 8)
    .bg(bg)
    .when(kind === "secondary", (el) => el.border(1).border_color(t.border).shadow_sm())
    .when(kind === "primary", (el) => el.shadow_sm())
    .text_size(o.size === "lg" ? 13 : o.size === "sm" ? 11.5 : 12.5)
    .font_medium()
    .text_color(fg)
    .when(Boolean(o.tooltip), (el) => el.tooltip(o.tooltip))
    .when(Boolean(o.disabled), (el) => el.opacity(0.45))
    .when(!o.disabled, (el) =>
      el
        .cursor_pointer()
        .hover((s) =>
          kind === "primary"
            ? s.bg(mix(t.solid, t.background, 0.14))
            : kind === "tinted"
              ? s.bg(alpha(tint, 0.2))
              : s.bg(alpha(t.foreground, 0.06)).text_color(t.foreground),
        )
        .on_mouse_down("left", stop)
        .on_click((e, cx) => {
          cx.stop_propagation();
          onClick(cx, e);
        }),
    )
    .when(Boolean(o.busy), (el) =>
      el.child(icon("spinner", o.size === "sm" ? 11 : 13, fg).spin(800)),
    )
    .when(!o.busy && Boolean(o.icon), (el) =>
      el.child(o.iconEl ?? icon(o.icon, o.size === "sm" ? 12 : 14, fg)),
    )
    .when(Boolean(label), (el) => el.child(div().min_w(0).truncate().child(label)))
    .when(Boolean(o.trailing), (el) => el.child(o.trailing));
}

export function iconBtn(t, id, name, onClick, tip, o = {}) {
  const size = o.size ?? 26;
  return h_flex()
    .id(id)
    .flex_none()
    .w(size)
    .h(size)
    .rounded(7)
    .justify_center()
    .items_center()
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(Boolean(o.disabled), (el) => el.opacity(0.35))
    .when(!o.disabled, (el) =>
      el
        .cursor_pointer()
        .hover((s) => s.bg(alpha(t.foreground, 0.07)))
        .on_mouse_down("left", stop)
        .on_click((e, cx) => {
          cx.stop_propagation();
          onClick(cx, e);
        }),
    )
    .child(
      o.spin
        ? icon(name, o.icon ?? 14, o.color ?? t.muted).spin(o.spin)
        : icon(name, o.icon ?? 14, o.color ?? t.muted),
    );
}

/** A small rounded label. */
export function chip(t, text, color, o = {}) {
  const c = color ?? t.muted;
  return h_flex()
    .flex_none()
    .h(o.h ?? 20)
    .px(o.px ?? 7)
    .gap(4)
    .items_center()
    .rounded(o.round ? 10 : 6)
    .bg(alpha(c, o.strong ? 0.16 : 0.1))
    .text_size(o.size ?? 10.5)
    .font_medium()
    .text_color(c)
    .when(Boolean(o.mono), (el) => el.font_family(mono()))
    .when(Boolean(o.icon), (el) => el.child(icon(o.icon, 10, c)))
    .child(text);
}

/** A section's title row: label, count, and an optional control on the right. */
export function sectionHeader(t, label, o = {}) {
  return h_flex()
    .h(24)
    .flex_none()
    .gap(7)
    .items_center()
    .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(label))
    .when(o.count != null, (el) =>
      el.child(div().text_size(11).font_family(mono()).text_color(t.dim).child(String(o.count))),
    )
    .child(div().flex_1())
    .when(Boolean(o.right), (el) => el.child(o.right));
}

/** A segmented control: one of a few options, inline. */
export function seg(t, id, options, value, onPick) {
  return h_flex()
    .flex_none()
    .p(2)
    .gap(2)
    .rounded(8)
    .bg(alpha(t.foreground, 0.055))
    .children(
      options.map((opt) => {
        const on = opt.id === value;
        return h_flex()
          .id(`${id}-${opt.id}`)
          .h(20)
          .px(8)
          .gap(5)
          .items_center()
          .rounded(6)
          .text_size(11)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            onPick(opt.id, cx);
          })
          .child(opt.label);
      }),
    );
}

/** A rounded card with an optional tint. */
export function card(t, o = {}) {
  const tint = o.tint;
  return v_flex()
    .w_full()
    .flex_none()
    .p(o.p ?? 14)
    .gap(o.gap ?? 10)
    .rounded(o.radius ?? 12)
    .bg(tint ? alpha(tint, o.bgA ?? 0.06) : (t.surface ?? t.background))
    .border(1)
    .border_color(tint ? alpha(tint, o.borderA ?? 0.24) : t.border);
}

/** A thin rule. */
export const rule = (t) => div().w_full().h(1).flex_none().bg(alpha(t.border, 0.9));

/** A link-like text button. */
export function textLink(t, id, label, onClick, color) {
  return div()
    .id(id)
    .flex_none()
    .text_size(11.5)
    .font_medium()
    .text_color(color ?? t.accent)
    .cursor_pointer()
    .hover((s) => s.underline())
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .child(label);
}

/** Keyboard hint. */
export function kbd(t, text) {
  return div()
    .px(4)
    .h(16)
    .rounded(4)
    .flex()
    .items_center()
    .bg(alpha(t.foreground, 0.07))
    .font_family(mono())
    .text_size(9.5)
    .text_color(t.dim)
    .child(text);
}
