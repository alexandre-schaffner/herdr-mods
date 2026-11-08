// Icons, the monospace font and color math, for every mod that draws its own look.

import { svg } from "gpui-kit";
import { settings } from "herdr";

/** Path of one of the shared one-color icons (~/.config/herdr-app/shared/icons). */
export const ICON = name => `shared/icons/${name}.svg`;
/** A one-color icon tinted `color`: a shared one by name, or any home-relative `path`. */
export const icon = (name, size, color, path) => svg(path ?? ICON(name)).flex_none().w(size).h(size).text_color(color);

export const mono = () => settings()?.font_family || settings()?.font || "JetBrains Mono";
export const dark = () => settings()?.dark !== false;

/** A theme color at `a` times its own opacity (`#rrggbb` or `#rrggbbaa` in, `#rrggbbaa` out). */
export function alpha(hex, a) {
  const c = hex ?? "#888888";
  const own = c.length >= 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
  const v = Math.round(Math.max(0, Math.min(1, a * own)) * 255);
  return `${c.slice(0, 7)}${v.toString(16).padStart(2, "0")}`;
}

/** Linear mix of two `#rrggbb` colors, `t` of the way from `a` to `b`. */
export function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a ?? "#000000"), p(b ?? "#ffffff")];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Success green: the theme's `done` means "finished unseen", which many themes draw blue. */
export const ok = t => t.ansi2 ?? t.done;
