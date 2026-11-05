// Formatting and color helpers shared by every view.

import { svg } from "gpui-kit";
import { settings } from "herdr";

export const ICON = (name) => `mods/revv/icons/${name}.svg`;
export const icon = (name, size, color) =>
  svg(ICON(name)).flex_none().w(size).h(size).text_color(color);

export const mono = () => settings()?.font_family || settings()?.font || "JetBrains Mono";

/** A theme color at `a` times its own opacity (`#rrggbb[aa]` in, `#rrggbbaa` out). */
export function alpha(hex, a) {
  const c = typeof hex === "string" && hex.startsWith("#") ? hex : "#888888";
  const own = c.length >= 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
  const v = Math.round(Math.max(0, Math.min(1, a * own)) * 255);
  return `${c.slice(0, 7)}${v.toString(16).padStart(2, "0")}`;
}

/** Linear mix of two `#rrggbb` colors. */
export function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => Number.parseInt((h ?? "#000000").slice(i, i + 2), 16) || 0);
  const [x, y] = [p(a), p(b)];
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Relative luminance of `#rrggbb`, 0..1. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = (Number.parseInt((hex ?? "#000000").slice(i, i + 2), 16) || 0) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isDark = (t) => luminance(t.background) < 0.35;

/**
 * A hue that reads as text on this theme: ANSI yellows and cyans wash out on
 * light backgrounds, so pull them toward the foreground there.
 */
export function ink(t, hex) {
  if (isDark(t)) return hex;
  const l = luminance(hex);
  return l > 0.45 ? mix(hex, t.foreground, 0.42) : l > 0.3 ? mix(hex, t.foreground, 0.2) : hex;
}

/** Semantic colors, derived from the theme so light and dark both work. */
export function palette(t) {
  const red = t.ansi1 ?? t.blocked;
  const green = t.ansi2 ?? t.done;
  const yellow = t.ansi3 ?? t.working;
  const blue = t.ansi4 ?? t.accent;
  return {
    critical: ink(t, red),
    warning: ink(t, yellow),
    info: ink(t, blue),
    ok: ink(t, green),
    risk: { high: ink(t, red), medium: ink(t, yellow), low: ink(t, green) },
    verdict: { pass: ink(t, green), concern: ink(t, yellow), blocker: ink(t, red) },
  };
}

export const SEVERITY = {
  critical: { label: "Critical", plural: "Critical", icon: "critical", rank: 3 },
  warning: { label: "Warning", plural: "Warnings", icon: "warning", rank: 2 },
  info: { label: "Note", plural: "Notes", icon: "info", rank: 1 },
};

export const RISK = {
  high: { label: "High risk", bars: 3, line: "Needs a careful look before merging." },
  medium: { label: "Medium risk", bars: 2, line: "A few things are worth a second look." },
  low: { label: "Low risk", bars: 1, line: "Looks safe to merge once findings are handled." },
};

export const shortSha = (sha) => (sha ? sha.slice(0, 7) : "");

export function ago(iso, now = Date.now()) {
  const ms = typeof iso === "number" ? iso : Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function elapsed(iso, now = Date.now()) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clip(text, n) {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** Markdown → one plain line, for previews. */
export function plain(markdown) {
  return (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function basename(path) {
  return (path ?? "").split("/").pop() ?? "";
}

export function location(issue) {
  if (!issue.filePath) return null;
  const name = basename(issue.filePath);
  if (issue.startLine == null) return name;
  return issue.endLine && issue.endLine !== issue.startLine
    ? `${name}:${issue.startLine}–${issue.endLine}`
    : `${name}:${issue.startLine}`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A finding's file, inside the checkout, or null. Paths come from AI output over
 * a pull request that may be hostile: never absolute, never `..`, no NULs.
 */
export function checkoutFile(root, filePath) {
  if (typeof root !== "string" || !root || typeof filePath !== "string" || !filePath) return null;
  if (filePath.startsWith("/") || filePath.startsWith("~") || /^[A-Za-z]:[\\/]/.test(filePath))
    return null;
  if (filePath.includes("\0")) return null;
  if (filePath.split(/[\\/]/).some((segment) => segment === "..")) return null;
  return `${root.replace(/\/+$/, "")}/${filePath}`;
}
