// Generated from shared/js/proxy-ui.js by shared/sync.sh: edit it there.

// Formatting, colors and the small pieces every view draws: cards, bars, tables.

import { h_flex, Scrollbar, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { alpha, icon, mix, mono, ok } from "./look.js";

export { alpha, icon, mix, mono, ok };

// ---- numbers and time

export function num(n) {
  if (n == null) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export const pct = (x, digits = 0) => (x == null ? "–" : `${(x * 100).toFixed(digits)}%`);

export function ms(v) {
  if (v == null) return "–";
  return v >= 10000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function span(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export const ago = ts => (ts ? `${span(Date.now() / 1000 - ts)} ago` : "never");
export const until = ts => (ts ? `in ${span(ts - Date.now() / 1000)}` : "");

export function clock(ts, withDay) {
  const d = new Date(ts * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (!withDay) return hm;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

/** The change from `prev` to `cur` as "+12%" (null when there's nothing to compare). */
export function delta(cur, prev) {
  if (!prev || cur == null) return null;
  if (prev === 0) return cur ? "new" : null;
  const d = (cur - prev) / prev;
  return `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%`;
}

// ---- colors

const PROVIDERS = {
  claude: { name: "Claude", slot: "ansi3" },
  codex: { name: "Codex", slot: "ansi6" },
  "openai-compatibility": { name: "OpenCode Go", slot: "ansi5" },
  openai: { name: "OpenAI", slot: "ansi2" },
  gemini: { name: "Gemini", slot: "ansi4" },
};

export const providerName = p => PROVIDERS[p]?.name ?? (p || "–");
export const providerColor = (p, t) => t[PROVIDERS[p]?.slot] ?? t.accent;

/** Token kinds, one color each everywhere. */
export const tokenColors = t => ({ input: t.accent, cache: mix(t.accent, t.background, 0.62), output: t.ansi5 ?? t.accent });

/** A plan window's fill: calm, then warm, then hot. */
export const usedColor = (p, t) => (p == null ? t.dim : p >= 90 ? t.blocked : p >= 70 ? (t.working ?? t.ansi3) : ok(t));

// ---- pieces

export function scrollArea(id, content) {
  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(content.id(id).size_full().overflow_y_scroll())
    .child(Scrollbar.vertical(id).mode("always").absolute().inset_0());
}

export function card(t, id, title, body, o = {}) {
  return v_flex()
    .id(id)
    .min_w(0)
    .gap(10)
    .p(14)
    .rounded(10)
    .bg(t.background)
    .border(1)
    .border_color(alpha(t.border, 0.9))
    .when(!!o.grow, el => el.flex_1())
    .when(!!title, el =>
      el.child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(title))
          .when(!!o.note, e => e.child(div().text_size(11).text_color(t.dim).truncate().child(o.note)))
          .when(!!o.right, e => e.child(div().flex_1()).child(o.right)),
      ),
    )
    .child(body);
}

/** A thin bar filled to `frac` (0..1). */
export function bar(t, frac, color, h = 6) {
  const f = Math.max(0, Math.min(1, frac ?? 0));
  return div()
    .relative()
    .w_full()
    .h(h)
    .rounded(h / 2)
    .bg(alpha(t.foreground, 0.08))
    .child(div().absolute().top(0).left(0).h_full().rounded(h / 2).w(`${f * 100}%`).bg(color));
}

/** One bar split into colored parts: [{value, color, label}]. */
export function stack(t, parts, h = 8) {
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  return h_flex()
    .w_full()
    .h(h)
    .rounded(h / 2)
    .overflow_hidden()
    .bg(alpha(t.foreground, 0.08))
    .children(
      total
        ? parts.filter(p => p.value > 0).map(p => div().h_full().w(`${(p.value / total) * 100}%`).bg(p.color))
        : [],
    );
}

export function badge(t, text, color) {
  return div()
    .flex_none()
    .px(6)
    .h(18)
    .flex()
    .items_center()
    .rounded(5)
    .text_size(10.5)
    .font_medium()
    .text_color(color ?? t.muted)
    .bg(alpha(color ?? t.muted, 0.13))
    .child(text);
}

export function dot(color, size = 8) {
  return div().flex_none().size(size).rounded(size / 2).bg(color);
}

export function legend(t, items) {
  return h_flex()
    .gap(12)
    .flex_wrap()
    .children(
      items.map(i =>
        h_flex().gap(5).items_center().child(dot(i.color, 7)).child(div().text_size(11).text_color(t.muted).child(i.label)),
      ),
    );
}

/**
 * A table: cols [{key, label, w?, align?, flex?}], rows [{id, cells: {key: string | element}, tooltip?}].
 * Numbers line up on the right in the monospace font.
 */
export function table(t, id, cols, rows, o = {}) {
  const cell = (c, content, head) =>
    div()
      .flex_none()
      .when(!!c.flex, el => el.flex_1().min_w(c.w ?? 80))
      .when(!c.flex, el => el.w(c.w ?? 80))
      .px(6)
      .flex()
      .items_center()
      .when(c.align === "right", el => el.justify_end())
      .text_size(head ? 10.5 : 12)
      .when(head, el => el.font_semibold().text_color(t.dim))
      .when(!head && c.align === "right", el => el.font_family(mono()).text_size(11.5))
      .when(!head, el => el.text_color(t.foreground))
      .child(typeof content === "string" || typeof content === "number" ? div().truncate().child(String(content)) : content ?? "");
  return v_flex()
    .id(id)
    .w_full()
    .child(
      h_flex()
        .h(26)
        .border_b(1)
        .border_color(alpha(t.border, 0.8))
        .children(cols.map(c => cell(c, c.label, true))),
    )
    .children(
      rows.length
        ? rows.map((r, i) =>
            h_flex()
              .id(`${id}-${r.id ?? i}`)
              .min_h(o.rowH ?? 32)
              .py(3)
              .rounded(6)
              .hover(s => s.bg(alpha(t.foreground, 0.04)))
              .when(!!r.tooltip, el => el.tooltip(r.tooltip))
              .children(cols.map(c => cell(c, r.cells[c.key], false))),
          )
        : [div().p(16).text_size(12).text_color(t.dim).child(o.empty ?? "Nothing yet in this range.")],
    );
}

export function empty(t, title, body) {
  return v_flex()
    .items_center()
    .justify_center()
    .gap(6)
    .p(32)
    .child(div().text_size(13).font_medium().text_color(t.muted).child(title))
    .child(div().text_size(12).text_color(t.dim).child(body));
}
