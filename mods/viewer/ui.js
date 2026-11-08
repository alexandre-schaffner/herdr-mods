// Look, formatting and the few controls every kind of file shares.

import { h_flex, Scrollbar, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { exec } from "herdr";

import { alpha, icon, mix, mono } from "./shared/look.js";

export { alpha, icon, mix, mono };

// ─── formatting ──────────────────────────────────────────────────────────

export function bytes(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const dims = (w, h) => (w && h ? `${w}×${h}` : "");
export const facts = (...parts) => parts.filter(Boolean).join("  ·  ");

// ─── controls ────────────────────────────────────────────────────────────

/** A toolbar button: an icon, a label, or both. `o`: { icon, tip, active, disabled, primary }. */
export function button(t, id, label, onClick, o = {}) {
  const fg = o.primary ? (t.accent_foreground ?? "#ffffff") : o.active ? t.accent : t.muted;
  return h_flex()
    .id(id)
    .flex_none()
    .h(28)
    .when(!!label, el => el.px(10))
    .when(!label, el => el.w(28).justify_center())
    .gap(6)
    .items_center()
    .rounded(7)
    .text_size(12)
    .font_medium()
    .text_color(fg)
    .when(!!o.primary, el => el.bg(t.accent))
    .when(!!o.active && !o.primary, el => el.bg(alpha(t.accent, 0.13)))
    .when(!!o.tip, el => el.tooltip(o.tip))
    .when(!!o.disabled, el => el.opacity(0.35))
    .when(!o.disabled, el =>
      el
        .cursor_pointer()
        .hover(s => (o.primary ? s.bg(mix(t.accent, "#ffffff", 0.12)) : s.bg(alpha(t.foreground, 0.07)).text_color(t.foreground)))
        .on_click((_e, cx) => onClick(cx)),
    )
    .when(!!o.icon, el => el.child(icon(o.icon, 14, fg)))
    .when(!!label, el => el.child(label));
}

/** One of a few options, inline. */
export function segmented(t, id, options, value, onPick) {
  return h_flex()
    .flex_none()
    .p(2)
    .gap(2)
    .rounded(8)
    .bg(alpha(t.foreground, 0.055))
    .children(
      options.map(opt => {
        const on = opt.id === value;
        return h_flex()
          .id(`${id}-${opt.id}`)
          .h(24)
          .px(9)
          .gap(6)
          .items_center()
          .rounded(6)
          .text_size(11.5)
          .cursor_pointer()
          .when(!!opt.tip, el => el.tooltip(opt.tip))
          .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
          .on_click((_e, cx) => onPick(opt.id, cx))
          .when(!!opt.icon, el => el.child(icon(opt.icon, 12, on ? t.accent : t.dim)))
          .child(opt.label);
      }),
    );
}

export const divider = t => div().flex_none().w(1).h(18).mx(4).bg(alpha(t.border, 0.9));

/** `content` scrolling on `axis` ("y" or "both"), with its bars. */
export function scroller(id, axis, content) {
  const area = content.id(id).size_full();
  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(axis === "y" ? area.overflow_y_scroll() : area.overflow_scroll())
    .child((axis === "y" ? Scrollbar.vertical(id) : Scrollbar.new(id)).absolute().inset_0());
}

/** A centered message filling the stage. */
export function notice(t, iconName, title, detail, action) {
  return v_flex()
    .size_full()
    .items_center()
    .justify_center()
    .gap(10)
    .p(24)
    .child(icon(iconName, 26, iconName === "alert" ? t.blocked : t.dim))
    .child(div().text_size(13.5).font_medium().text_color(t.foreground).child(title))
    .when(!!detail, el => el.child(div().max_w(560).text_center().text_size(12).line_height(1.55).text_color(t.muted).child(detail)))
    .when(!!action, el => el.child(div().pt(6).child(action)));
}

export function loading(t, label) {
  return v_flex()
    .size_full()
    .items_center()
    .justify_center()
    .gap(10)
    .child(icon("spinner", 18, t.dim).spin(900))
    .when(!!label, el => el.child(div().text_size(12).text_color(t.dim).child(label)));
}

// ─── the system ──────────────────────────────────────────────────────────

/** Opens a file or URL with whatever the system uses for it. */
export async function openExternally(target) {
  try {
    await exec("open", [target]);
  } catch {
    await exec("xdg-open", [target]);
  }
}

export async function reveal(path) {
  try {
    await exec("open", ["-R", path]);
  } catch {
    await exec("xdg-open", [path.slice(0, path.lastIndexOf("/")) || "/"]);
  }
}
