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
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
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
  "openai-compatible-opencode-go": { name: "OpenCode Go", slot: "ansi5" },
  "openai-compatible-opencode": { name: "OpenCode Zen", slot: "ansi5" },
  openai: { name: "OpenAI", slot: "ansi2" },
  gemini: { name: "Gemini", slot: "ansi4" },
};

export const providerName = p => PROVIDERS[p]?.name ?? (p || "–");
export const providerColor = (p, t) => t[PROVIDERS[p]?.slot] ?? t.accent;

/** Token kinds, one color each everywhere. */
export const tokenColors = t => ({ input: t.accent, cache: mix(t.accent, t.background, 0.62), output: t.ansi5 ?? t.accent });

function luminance(hex) {
  const c = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG contrast ratio of two `#rrggbb` colors. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The theme with its muted text pulled toward the foreground until it reads at 4.5:1 or better
 *  on the background (meta text: resets, peaks, notes). Unchanged when it already does. */
export function legible(t) {
  const hex = /^#[0-9a-f]{6}/i;
  if (!hex.test(t.muted ?? "") || !hex.test(t.background ?? "") || !hex.test(t.foreground ?? "")) return t;
  const bg = t.background.slice(0, 7);
  let m = t.muted.slice(0, 7);
  if (t.muted.length <= 7 && contrast(m, bg) >= 4.5) return t;
  for (let i = 0; i < 12 && contrast(m, bg) < 4.6; i++) m = mix(m, t.foreground.slice(0, 7), 0.12);
  return { ...t, muted: m };
}

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

/** Numbers' font: the host theme's (`t.mono`, Geist Mono in HQ), else the terminal font. */
export const numFont = t => t.mono ?? mono();

/** A bordered section: a 14px heading (a muted note and a control on its right), then the body.
 *  `flush`: the body runs edge to edge (lists and tables pad their own rows, 16px). */
export function card(t, id, title, body, o = {}) {
  return v_flex()
    .id(id)
    .min_w(0)
    .rounded(8)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .when(!!o.grow, el => el.flex_1())
    .when(!!title, el =>
      el.child(
        h_flex()
          .flex_none()
          .min_h(28)
          .px(16)
          .pt(12)
          .pb(o.flush ? 4 : 12)
          .gap(8)
          .items_center()
          .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(title))
          .when(!!o.note, e => e.child(div().min_w(0).text_size(12).text_color(t.muted).truncate().child(o.note)))
          .when(!!o.right, e => e.child(div().flex_1()).child(o.right)),
      ),
    )
    .child(
      v_flex()
        .min_w(0)
        .when(!o.flush, el => el.px(16).pb(16).when(!title, e => e.pt(16)))
        .when(!!o.flush, el => el.pb(4))
        .child(body),
    );
}

/** A segmented switch: items [{id, label, tip?}], the current `value`, `onPick(id, cx)`. */
export function switcher(t, id, items, value, onPick, o = {}) {
  return h_flex()
    .flex_none()
    .p(2)
    .gap(2)
    .rounded(8)
    .bg(alpha(t.foreground, 0.05))
    .when(!!o.busy, el => el.opacity(0.5))
    .children(
      items.map(x => {
        const on = x.id === value;
        return div()
          .id(`${id}-${x.id}`)
          .h(24)
          .px(10)
          .flex()
          .items_center()
          .rounded(6)
          .text_size(12)
          .when(!!x.tip, el => el.tooltip(x.tip))
          .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, el => el.text_color(t.muted).cursor_pointer().hover(s => s.text_color(t.foreground)).on_click((_e, cx) => onPick(x.id, cx)))
          .child(x.label);
      }),
    );
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

/** A status pill: the word in its hue on a faint wash of it. */
export function badge(t, text, color) {
  return div()
    .flex_none()
    .px(8)
    .h(20)
    .flex()
    .items_center()
    .rounded_full()
    .text_size(11)
    .font_medium()
    .text_color(color ?? t.muted)
    .bg(alpha(color ?? t.muted, 0.12))
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
 * Hairline rows; numbers right-aligned in the numbers' font. `inset`: padding at both ends, so a
 * table in a flush card lines up with its heading while its rules run edge to edge.
 */
export function table(t, id, cols, rows, o = {}) {
  const inset = o.inset ?? 0;
  const last = cols.length - 1;
  const cell = (c, i, content, head) =>
    div()
      .flex_none()
      .when(!!c.flex, el => el.flex_1().min_w(c.w ?? 80))
      .when(!c.flex, el => el.w((c.w ?? 80) + (i === 0 || i === last ? inset : 0)))
      .pl(i === 0 ? inset : 8)
      .pr(i === last ? inset : 8)
      .flex()
      .items_center()
      .when(c.align === "right", el => el.justify_end())
      .text_size(head ? 12 : 13)
      .when(head, el => el.font_medium().text_color(t.muted))
      .when(!head && c.align === "right", el => el.font_family(numFont(t)).text_size(12))
      .when(!head, el => el.text_color(t.foreground))
      .child(typeof content === "string" || typeof content === "number" ? div().truncate().child(String(content)) : content ?? "");
  return v_flex()
    .id(id)
    .w_full()
    .child(
      h_flex()
        .h(36)
        .border_b(1)
        .border_color(t.border)
        .children(cols.map((c, i) => cell(c, i, c.label, true))),
    )
    .children(
      rows.length
        ? rows.map((r, i) =>
            h_flex()
              .id(`${id}-${r.id ?? i}`)
              .h(o.rowH ?? 36)
              .when(i > 0, el => el.border_t(1).border_color(t.border))
              .hover(s => s.bg(alpha(t.foreground, 0.03)))
              .when(!!r.tooltip, el => el.tooltip(r.tooltip))
              .children(cols.map((c, j) => cell(c, j, r.cells[c.key], false))),
          )
        : [div().px(Math.max(inset, 8)).py(16).text_size(13).text_color(t.muted).child(o.empty ?? "Nothing yet in this range.")],
    );
}

export function empty(t, title, body) {
  return v_flex()
    .items_center()
    .justify_center()
    .gap(6)
    .p(32)
    .child(div().text_size(14).font_medium().text_color(t.foreground).child(title))
    .child(div().text_size(13).text_color(t.muted).child(body));
}
