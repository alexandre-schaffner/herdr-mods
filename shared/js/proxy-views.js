// The four views: Overview, Models, Accounts, Requests. Each takes the report proxy.py made.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import {
  ago, alpha, badge, bar, card, clock, delta, dot, empty, legible, ms, num, numFont, ok, pct, providerColor,
  providerName, stack, switcher, table, until, usedColor,
} from "./proxy-ui.js";

const RANGE_WORDS = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

/** A row whose children stretch to its height (h_flex centers them instead). */
const row = () => div().flex().flex_row();

// ---- overview
//
// Top to bottom: one line of totals, one chart (the metric is a switch, not three charts), then
// who served it (accounts) beside what it went to (models), then the token mix. No tables:
// the other tabs have the detail.

export function overview(t, d, o) {
  t = legible(t);
  return v_flex()
    .gap(16)
    .child(summary(t, d))
    .child(card(t, "c-chart", "Activity", chart(t, d), { note: RANGE_WORDS[d.range], right: metricSwitch(t) }))
    .child(
      row()
        .flex_wrap()
        .gap(16)
        .child(div().flex().flex_col().flex_basis(0).flex_grow(1).min_w(480).child(card(t, "c-accounts", "Accounts", accountList(t, d, o), { flush: true, grow: true })))
        .child(div().flex().flex_col().flex_basis(0).flex_grow(1).min_w(480).child(card(t, "c-models", "Models", modelList(t, d, o), { flush: true, grow: true, note: "by tokens" }))),
    )
    .child(card(t, "c-tokens", "Tokens", tokenMix(t, d.totals ?? {}, "ov"), { note: "read and written, with the prompt cache" }));
}

/** The range's totals as one sentence-like line; a muted change only where the previous
 *  period had data, and failures in red only when there are some. */
function summary(t, d) {
  const T = d.totals ?? {};
  const P = d.previous?.requests ? d.previous : null;
  const change = (cur, prev) => {
    const c = P ? delta(cur, prev) : null;
    return c && c !== "new" ? c : null;
  };
  const items = [
    { id: "req", value: num(T.requests), label: "requests", change: change(T.requests, P?.requests), tip: `${num(T.sessions)} sessions` },
    {
      id: "tok",
      value: num(T.tokens),
      label: "tokens",
      change: change(T.tokens, P?.tokens),
      tip: `Fresh input ${num(T.in_uncached)} · cache writes ${num(T.cache_write)} · cache reads ${num(T.cache_read)} · output ${num(T.output)} (reasoning ${num(T.reasoning)})`,
    },
    { id: "cache", value: pct(T.cache_hit), label: "from cache", tip: "Share of input tokens served from the prompt cache. Higher is faster and uses less quota." },
    { id: "lat", value: ms(T.latency_p50), label: "median reply", change: change(T.latency_p50, P?.latency_p50), tip: `First token ${ms(T.ttft_p50)} · p95 ${ms(T.latency_p95)}` },
    {
      id: "fail",
      value: num(T.failed),
      label: T.requests ? `failed (${pct((T.failed ?? 0) / T.requests, 1)})` : "failed",
      color: T.failed ? t.blocked : null,
    },
  ];
  return h_flex()
    .flex_wrap()
    .gap(8)
    .items_baseline()
    .text_size(13)
    .children(
      items.flatMap((x, i) => [
        i > 0 ? div().text_color(t.dim).child("·") : null,
        h_flex()
          .id(`sum-${x.id}`)
          .gap(4)
          .items_baseline()
          .when(!!x.tip, el => el.tooltip(x.tip))
          .child(div().font_medium().text_color(x.color ?? t.foreground).child(x.value))
          .child(div().text_color(x.color ?? t.muted).child(x.label))
          .when(!!x.change, el => el.child(div().text_size(12).text_color(t.dim).child(x.change))),
      ]).filter(Boolean),
    )
    .when(!!P, el => el.child(div().text_size(12).text_color(t.dim).child(`vs the previous ${d.range}`)));
}

// ---- the chart

const METRICS = [
  { id: "req", label: "Requests", value: p => p.req, whole: true },
  { id: "tok", label: "Tokens", value: p => p.input + p.cache + p.output, whole: false },
  { id: "fail", label: "Failures", value: p => p.fail, whole: true },
];

// The chosen metric lives here, not in a host: both hosts (HQ, the proxy panel) draw the same
// views, and a click re-renders whichever is showing.
let metric = null;
const metricNow = () => (metric ??= readPref("usage.metric") ?? "req");

function readPref(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function metricSwitch(t) {
  return switcher(t, "metric", METRICS, metricNow(), (id, cx) => {
    metric = id;
    try {
      globalThis.localStorage?.setItem("usage.metric", id);
    } catch {}
    cx.notify();
  });
}

/** Gridlines for a peak: a round step that gives three or four lines above the baseline. */
function ticks(peak, whole) {
  const e = Math.floor(Math.log10(peak));
  for (let k = e + 1; k >= e - 2; k--)
    for (const m of [5, 2.5, 2, 1]) {
      const step = m * 10 ** k;
      if (whole && !Number.isInteger(step)) continue;
      const n = Math.ceil(peak / step - 1e-9);
      if (n >= 3 && n <= 4) return { step, n };
    }
  const step = whole ? Math.max(1, Math.ceil(peak / 3)) : peak / 3;
  return { step, n: Math.max(1, Math.ceil(peak / step - 1e-9)) };
}

const AXIS_W = 44;
const CHART_H = 168;

/** One column chart over the whole range: a bar per bucket (empty buckets keep their place),
 *  gridlines with values on the left, start / middle / now under it, a tooltip on each bar. */
function chart(t, d) {
  const pts = d.series?.points ?? [];
  const m = METRICS.find(x => x.id === metricNow()) ?? METRICS[0];
  const H = CHART_H;
  const quiet = text => div().h(H + 22).flex().items_center().justify_center().text_size(13).text_color(t.muted).child(text);
  if (!pts.length || !d.totals?.requests) return quiet("No requests in this range.");
  const peak = Math.max(0, ...pts.map(m.value));
  if (!peak) return quiet(m.id === "fail" ? "No failures in this range." : "Nothing in this range.");
  const { step, n } = ticks(peak, m.whole);
  const top = step * n;
  const color = m.id === "fail" ? t.blocked : t.accent;
  const size = d.series.size;
  const withDay = size >= 21600 || pts.length * size > 86400;
  const span = p => `${clock(p.t, withDay)}–${clock(p.t + size, false)}`;
  const tip = p =>
    `${span(p)}\n${num(p.req)} request${p.req === 1 ? "" : "s"}${p.fail ? `, ${num(p.fail)} failed` : ""}\n` +
    `${num(p.input + p.cache + p.output)} tokens: ${num(p.cache)} cache read, ${num(p.input)} fresh in, ${num(p.output)} out` +
    Object.entries(p.by ?? {}).map(([k, v]) => `\n${providerName(k)}: ${num(v)}`).join("");
  const lines = Array.from({ length: n }, (_, i) => (i + 1) * step);
  const gap = pts.length > 90 ? 1 : 2;
  return v_flex()
    .gap(8)
    .child(
      row()
        .child(
          div()
            .relative()
            .w(AXIS_W)
            .flex_none()
            .h(H)
            .children(
              [0, ...lines].map(v =>
                div()
                  .absolute()
                  .right(8)
                  .bottom(Math.max(0, (v / top) * H - 7))
                  .text_size(11)
                  .font_family(numFont(t))
                  .text_color(t.muted)
                  .child(num(v)),
              ),
            ),
        )
        .child(
          div()
            .relative()
            .flex_1()
            .min_w(0)
            .h(H)
            .children(lines.map(v => div().absolute().left(0).right(0).bottom((v / top) * H).h(1).bg(alpha(t.border, 0.6))))
            .child(div().absolute().bottom(0).left(0).right(0).h(1).bg(t.border))
            .child(
              h_flex()
                .absolute()
                .inset_0()
                .gap(gap)
                .items_end()
                .children(
                  pts.map((p, i) => {
                    const v = m.value(p);
                    const h = v > 0 ? Math.max(2, (v / top) * H) : 0;
                    return v_flex()
                      .id(`chart-${m.id}-${i}`)
                      .flex_basis(0)
                      .flex_grow(1)
                      .min_w(1)
                      .h_full()
                      .justify_end()
                      .hover(s => s.bg(alpha(t.foreground, 0.04)))
                      .tooltip(tip(p))
                      .when(h > 0, el => el.child(div().w_full().h(h).rounded_t(Math.min(3, h / 2)).bg(color)));
                  }),
                ),
            ),
        ),
    )
    .child(
      h_flex()
        .pl(AXIS_W)
        .text_size(11)
        .text_color(t.muted)
        .child(div().child(clock(pts[0].t, withDay)))
        .child(div().flex_1().text_center().child(clock(pts[Math.floor(pts.length / 2)].t, withDay)))
        .child(div().child("now")),
    );
}

// ---- who served it, what it went to

const CURRENCY = { EUR: "€", USD: "$", GBP: "£" };

/** An account's plan windows, with Claude's 5-hour window shown as "not started" when absent. */
function windowsOf(a) {
  const wins = [...(a.plan?.windows ?? [])];
  if (a.provider === "claude" && wins.length && !wins.some(w => w.label === "5-hour")) wins.unshift({ label: "5-hour", pct: 0, resets: null, idle: true });
  return wins;
}

/** Where an account sits in the pool, in words. */
function rankWord(a, ranks, strategy) {
  if (a.disabled) return "out of the pool";
  const r = ranks[a.auth_index];
  if (strategy === "fill-first") return r === 0 ? "used first" : r != null ? `${ORD(r + 1)} in line` : null;
  return strategy ? "shares the load" : null;
}

const METER_W = 104;

/** A thin meter: label and value on one line, a 4px bar under. */
function meter(t, id, label, value, frac, color, tip) {
  return v_flex()
    .id(id)
    .flex_none()
    .w(METER_W)
    .gap(5)
    .when(!!tip, el => el.tooltip(tip))
    .child(
      h_flex()
        .gap(6)
        .items_baseline()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(label))
        .child(div().flex_none().text_size(12).font_family(numFont(t)).text_color(color === t.blocked ? t.blocked : t.foreground).child(value)),
    )
    .child(bar(t, frac, color, 4));
}

/** Live accounts, one compact row each: state, name, place in the pool, then the 5-hour and
 *  weekly windows and the month's extra usage. A row opens the Accounts tab. */
function accountList(t, d, o) {
  const live = d.accounts.filter(a => a.live);
  const keyed = d.accounts.filter(a => !a.live);
  if (!d.accounts.length) return div().px(16).py(10).text_size(13).text_color(t.muted).child("No accounts. Log in with cliproxyapi -claude-login or -codex-login.");
  const ranks = poolRanks(d);
  const strategy = d.routing?.strategy;
  const open = (_e, cx) => o?.goto?.("accounts", cx);
  const rows = live.map((a, i) => {
    const state = accountState(t, a);
    const wins = windowsOf(a);
    const pick = re => wins.find(w => re.test(w.label));
    const five = pick(/5-hour/i) ?? wins[0];
    const week = pick(/week/i) ?? wins.find(w => w !== five);
    const win = (w, k) =>
      w
        ? meter(t, `ov-win-${a.auth_index}-${k}`, w.label, w.pct == null ? "–" : `${Math.round(w.pct)}%`, (w.pct ?? 0) / 100, usedColor(w.pct, t), w.idle ? "Not started" : w.resets ? `Resets ${until(w.resets)}` : null)
        : div().flex_none().w(METER_W);
    const x = a.plan?.extra;
    const sym = x ? CURRENCY[x.currency] ?? "" : "";
    const sub = [state.text !== "Active" ? state.text : null, rankWord(a, ranks, strategy)].filter(Boolean).join(" · ");
    const hasPlan = wins.length || x;
    return h_flex()
      .id(`ov-acct-${a.auth_index}`)
      .px(16)
      .py(10)
      .gap(12)
      .items_center()
      .when(i > 0, el => el.border_t(1).border_color(t.border))
      .cursor_pointer()
      .hover(s => s.bg(alpha(t.foreground, 0.03)))
      .on_click(open)
      .child(dot(state.color, 8))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().text_size(13).font_medium().text_color(t.foreground).child(a.label))
          .child(div().truncate().text_size(12).text_color(state.text === "Active" ? t.muted : state.color).child(sub || providerName(a.provider))),
      )
      .when(!hasPlan, el => el.child(div().flex_none().text_size(12).text_color(t.muted).child(a.plan?.stale ? "Limits unavailable" : "No usage reported yet")))
      .when(!!hasPlan, el =>
        el
          .child(win(five, 0))
          .child(win(week, 1))
          .child(
            x
              ? meter(t, `ov-extra-${a.auth_index}`, "Extra", `${sym}${x.used.toFixed(0)}/${x.limit.toFixed(0)}`, (x.pct ?? 0) / 100, (x.pct ?? 0) >= 100 ? t.blocked : usedColor(x.pct, t), `Extra usage this month: ${x.used.toFixed(2)} of ${x.limit.toFixed(2)} ${x.currency}${(x.pct ?? 0) >= 100 ? " (cap reached)" : ""}`)
              : div().flex_none().w(METER_W),
          ),
      );
  });
  return v_flex()
    .children(rows)
    .when(keyed.length > 0, el =>
      el.child(
        div()
          .px(16)
          .py(10)
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.muted)
          .child(`Pay per token: ${keyed.map(a => `${a.label} (${num(a.requests)} requests)`).join(" · ")}`),
      ),
    );
}

/** Models ranked by tokens: name, requests, tokens, and a bar for the share. */
function modelList(t, d, o) {
  const list = (d.models ?? []).filter(m => m.tokens || m.requests);
  if (!list.length) return div().px(16).py(10).text_size(13).text_color(t.muted).child("Nothing in this range.");
  const total = list.reduce((s, m) => s + m.tokens, 0) || 1;
  const max = Math.max(1, ...list.map(m => m.tokens));
  const SHOW = 5;
  return v_flex()
    .children(
      list.slice(0, SHOW).map((m, i) =>
        v_flex()
          .id(`ov-model-${i}`)
          .px(16)
          .py(10)
          .gap(6)
          .when(i > 0, el => el.border_t(1).border_color(t.border))
          .tooltip(`${m.key}: ${num(m.tokens)} tokens (${pct(m.tokens / total, 1)}), ${num(m.requests)} requests`)
          .child(
            h_flex()
              .gap(12)
              .items_baseline()
              .child(h_flex().flex_1().min_w(0).gap(8).items_center().child(dot(providerColor(m.provider, t), 6)).child(div().truncate().text_size(13).text_color(t.foreground).child(m.key)))
              .child(div().flex_none().text_size(12).text_color(t.muted).child(`${num(m.requests)} req`))
              .child(div().flex_none().w(52).flex().justify_end().text_size(12).font_family(numFont(t)).text_color(t.foreground).child(num(m.tokens)))
              .child(div().flex_none().w(40).flex().justify_end().text_size(12).font_family(numFont(t)).text_color(t.muted).child(pct(m.tokens / total))),
          )
          .child(bar(t, m.tokens / max, t.accent, 4)),
      ),
    )
    .when(list.length > SHOW, el =>
      el.child(
        div()
          .id("ov-models-more")
          .px(16)
          .py(10)
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.muted)
          .cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => o?.goto?.("models", cx))
          .child(`View all ${list.length} models`),
      ),
    );
}

/** The four token kinds as one stacked bar, then a four-column legend: amount and share. */
function tokenMix(t, src, id) {
  const kinds = tokenKinds(t);
  const total = kinds.reduce((s, x) => s + (src[x.k] ?? 0), 0) || 1;
  return v_flex()
    .gap(16)
    .child(stack(t, kinds.map(x => ({ value: src[x.k] ?? 0, color: x.c })), 8))
    .child(
      row()
        .flex_wrap()
        .gap(24)
        .children(
          kinds.map(x =>
            v_flex()
              .id(`${id}-tok-${x.k}`)
              .flex_basis(0)
              .flex_grow(1)
              .min_w(120)
              .gap(4)
              .tooltip(x.hint)
              .child(h_flex().gap(8).items_center().child(div().flex_none().w(8).h(8).rounded(2).bg(x.c)).child(div().truncate().text_size(12).text_color(t.muted).child(x.label)))
              .child(
                h_flex()
                  .gap(8)
                  .items_baseline()
                  .child(div().text_size(16).font_semibold().text_color(t.foreground).child(num(src[x.k] ?? 0)))
                  .child(div().text_size(12).font_family(numFont(t)).text_color(t.muted).child(pct((src[x.k] ?? 0) / total, 1))),
              ),
          ),
        ),
    );
}

export function accountState(t, a) {
  if (!a.live) return { text: "API key", color: t.dim };
  if (a.disabled) return { text: "Disabled", color: t.dim };
  if (a.requires_sign_in) return { text: "Sign in again", color: t.blocked };
  if (a.quota_blocked) return { text: "Quota reached", color: t.blocked };
  if (a.unavailable || (a.cooldowns ?? []).length) return { text: "Cooling down", color: t.working };
  return { text: "Active", color: ok(t) };
}

// ---- routing: which account the pool uses first (management API, applied at once)

const STRATEGY_WORDS = {
  "fill-first": ["Fill first", "Use the highest-priority account until it hits a limit, then the next. Keeps one account's prompt cache warm."],
  "round-robin": ["Round robin", "Spread requests evenly across enabled accounts."],
  "weighted-round-robin": ["Weighted", "Spread requests in proportion to each account's priority."],
};

function strategyControl(t, d, o) {
  const items = (d.routing?.strategies ?? Object.keys(STRATEGY_WORDS)).map(id => {
    const [label, tip] = STRATEGY_WORDS[id] ?? [id, ""];
    return { id, label, tip };
  });
  return switcher(t, "strategy", items, d.routing?.strategy, (id, cx) => o.routing.setStrategy(id, cx), { busy: o.routing.busy?.("strategy") });
}

/** An account's place in the pool: on or off, and its priority (higher is used first). */
function routingRow(t, a, o) {
  const busy = o.routing.busy?.(a.name);
  const step = (id, glyph, n, tip) =>
    div()
      .id(`prio-${id}-${a.name}`)
      .w(22)
      .h(22)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .text_size(12)
      .text_color(t.foreground)
      .cursor_pointer()
      .tooltip(tip)
      .hover(s => s.bg(alpha(t.foreground, 0.05)))
      .on_click((_e, cx) => o.routing.setPriority(a.name, Math.max(-100, n), cx))
      .child(glyph);
  const on = !a.disabled;
  return h_flex()
    .gap(8)
    .items_center()
    .when(!!busy, el => el.opacity(0.5))
    .child(
      h_flex()
        .id(`enable-${a.name}`)
        .gap(6)
        .items_center()
        .cursor_pointer()
        .tooltip(on ? "In the pool. Click to take it out." : "Out of the pool. Click to put it back.")
        .on_click((_e, cx) => o.routing.setEnabled(a.name, !on, cx))
        .child(
          div()
            .w(26)
            .h(15)
            .rounded_full()
            .bg(on ? ok(t) : alpha(t.foreground, 0.18))
            .relative()
            .child(div().absolute().top(2).left(on ? 13 : 2).w(11).h(11).rounded_full().bg("#ffffff")),
        )
        .child(div().text_size(12).text_color(on ? t.foreground : t.muted).child(on ? "In pool" : "Off")),
    )
    .child(div().w(1).h(16).bg(t.border))
    .child(div().text_size(12).text_color(t.muted).child("Priority"))
    .child(step("down", "−", (a.priority ?? 0) - 1, "Lower priority"))
    .child(div().min_w(18).text_center().text_size(12).font_medium().font_family(numFont(t)).text_color(t.foreground).child(String(a.priority ?? 0)))
    .child(step("up", "+", (a.priority ?? 0) + 1, "Higher priority: used before lower ones"));
}

// ---- models

export function models(t, d) {
  t = legible(t);
  const total = d.models.reduce((s, m) => s + m.tokens, 0) || 1;
  const cols = [
    { key: "model", label: "Model", flex: true, w: 200 },
    { key: "req", label: "Requests", w: 76, align: "right" },
    { key: "fail", label: "Failed", w: 60, align: "right" },
    { key: "in", label: "Fresh in", w: 76, align: "right" },
    { key: "cache", label: "Cache read", w: 84, align: "right" },
    { key: "out", label: "Output", w: 70, align: "right" },
    { key: "hit", label: "Cache hit", w: 72, align: "right" },
    { key: "lat", label: "Median", w: 60, align: "right" },
    { key: "ttft", label: "First token", w: 84, align: "right" },
    { key: "tps", label: "Tokens/s", w: 72, align: "right" },
    { key: "share", label: "Share", w: 120 },
    { key: "last", label: "Last used", w: 88, align: "right" },
  ];
  const rows = d.models.map(m => ({
    id: m.key,
    tooltip: `${m.key}: ${num(m.in_uncached)} fresh input, ${num(m.cache_write)} cache writes, ${num(m.cache_read)} cache reads, ${num(m.output)} output (${num(m.reasoning)} reasoning) across ${num(m.sessions)} sessions`,
    cells: {
      model: h_flex().gap(8).items_center().min_w(0).child(dot(providerColor(m.provider, t), 6)).child(div().truncate().child(m.key)),
      req: num(m.requests),
      fail: m.failed ? div().text_color(t.blocked).child(num(m.failed)) : "0",
      in: num(m.in_uncached + m.cache_write),
      cache: num(m.cache_read),
      out: num(m.output),
      hit: pct(m.cache_hit),
      lat: ms(m.latency_p50),
      ttft: ms(m.ttft_p50),
      tps: m.tok_s ? num(m.tok_s) : "–",
      share: h_flex().w_full().gap(8).items_center().child(div().flex_1().child(bar(t, m.tokens / total, t.accent, 4))).child(div().w(36).flex().justify_end().text_size(12).font_family(numFont(t)).text_color(t.muted).child(pct(m.tokens / total))),
      last: div().text_color(t.muted).child(ago(m.last)),
    },
  }));
  return card(t, "c-models", "Models", table(t, "t-models", cols, rows, { inset: 16 }), { flush: true, note: `${d.models.length} used in the ${RANGE_WORDS[d.range]}` });
}

// ---- accounts

/** The four token kinds, one hue each everywhere (never the ok/warn/alert status hues for
 *  input/output/cache read, so a token chart never reads as a health signal). */
export function tokenKinds(t) {
  return [
    { k: "in_uncached", label: "Input read", hint: "Fresh input tokens: not served from the prompt cache", c: t.ansi4 ?? t.accent },
    { k: "output", label: "Output written", hint: "Tokens the model wrote, thinking included", c: t.ansi5 ?? t.accent },
    { k: "cache_read", label: "Cache read", hint: "Input tokens served from the prompt cache (cheaper and faster)", c: t.ansi6 ?? t.accent },
    { k: "cache_write", label: "Cache write", hint: "Input tokens stored into the prompt cache for later turns", c: t.ansi3 ?? t.working },
  ];
}

/** Where each live account sits in the pool, by the strategy: 1st, 2nd... under fill-first
 *  (highest priority first, enabled only), or "shared" under round robin. */
function poolRanks(d) {
  const live = d.accounts.filter(a => a.live && !a.disabled).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const out = {};
  live.forEach((a, i) => (out[a.auth_index] = i));
  return out;
}

const ORD = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

export function accounts(t, d, o) {
  t = legible(t);
  if (!d.accounts.length) return empty(t, "No accounts", "Log in with cliproxyapi -claude-login or -codex-login.");
  const live = d.accounts.filter(a => a.live);
  const keyed = d.accounts.filter(a => !a.live);
  const ranks = poolRanks(d);
  const strategy = d.routing?.strategy;
  const [sWord, sHint] = STRATEGY_WORDS[strategy] ?? [strategy ?? "Unknown", ""];
  return v_flex()
    .gap(16)
    .child(
      row()
        .gap(12)
        .items_center()
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .gap(8)
                .items_baseline()
                .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Routing"))
                .child(div().text_size(13).text_color(t.muted).child(sWord.toLowerCase())),
            )
            .child(div().text_size(12).text_color(t.muted).child(sHint)),
        )
        .when(!!o?.routing, el => el.child(strategyControl(t, d, o))),
    )
    .children(live.map(a => accountCard(t, d, a, ranks, strategy, o)))
    .when(keyed.length > 0, el =>
      el.child(
        card(
          t,
          "acct-keyed",
          "Pay per token",
          v_flex().children(
            keyed.map((a, i) =>
              h_flex()
                .id(`acct-k-${a.auth_index}`)
                .px(16)
                .py(10)
                .gap(12)
                .items_center()
                .when(i > 0, el => el.border_t(1).border_color(t.border))
                .child(dot(providerColor(a.provider, t), 8))
                .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(a.label))
                .child(div().text_size(12).font_family(numFont(t)).text_color(t.muted).child(`${num(a.requests)} req · ${num(a.tokens)} tok`)),
            ),
          ),
          { flush: true, note: "API-key upstreams: no plan limits" },
        ),
      ),
    );
}

// An account card: the name leads (state, place in the pool, routing controls beside it), then two
// columns. Left: each plan limit as one row (label · bar · % · reset), the % in one column. Right:
// what it did (requests, tokens, failures on one line, a short chart over the range, the token split
// as a legend, its models as rows like the limits). An account with no requests gets one line there.

const LIM_LABEL_W = 112;
const LIM_PCT_W = 44;
const LIM_NOTE_W = 196;

function accountCard(t, d, a, ranks, strategy, o) {
  const state = accountState(t, a);
  const place = a.disabled ? null : rankWord(a, ranks, strategy);
  const head = row()
    .gap(16)
    .items_start()
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(4)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().min_w(0).truncate().text_size(16).font_semibold().text_color(t.foreground).child(a.label))
            .child(badge(t, state.text, state.color))
            .when(!!place, el => el.child(div().flex_none().text_size(13).text_color(t.muted).child(place))),
        )
        .child(
          div()
            .truncate()
            .text_size(12)
            .text_color(t.muted)
            .child([providerName(a.provider), a.email, a.last ? `last request ${ago(a.last)}` : null].filter(Boolean).join(" · ")),
        ),
    )
    .when(!!o?.routing && !!a.name, el => el.child(div().flex_none().pt(2).child(routingRow(t, a, o))));
  const notes = [
    a.status_message ? { text: a.status_message, c: state.color } : null,
    (a.cooldowns ?? []).length ? { text: `Cooling down: ${a.cooldowns.map(c => (typeof c === "string" ? c : c.model ?? c.reason ?? JSON.stringify(c))).join(", ")}`, c: t.working } : null,
  ].filter(Boolean);
  return v_flex()
    .id(`acct-${a.auth_index}`)
    .min_w(0)
    .p(16)
    .gap(16)
    .rounded(8)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .child(head)
    .children(notes.map((n, i) => div().id(`acct-note-${a.auth_index}-${i}`).text_size(12).text_color(n.c).child(n.text)))
    .child(div().h(1).bg(t.border))
    .child(
      row()
        .flex_wrap()
        .gap(32)
        .items_start()
        .child(v_flex().flex_basis(0).flex_grow(1).min_w(420).gap(6).child(limitRows(t, a)))
        .child(v_flex().flex_basis(0).flex_grow(1).min_w(360).child(a.requests ? activity(t, d, a) : idleLine(t, d, a, ranks, strategy))),
    );
}

/** One line for an account with no requests in the range: why, and when that changes. */
function idleLine(t, d, a, ranks, strategy) {
  const when = `No requests in the ${RANGE_WORDS[d.range] ?? d.range}.`;
  const r = ranks[a.auth_index];
  const ahead = strategy === "fill-first" && r > 0 ? d.accounts.find(x => ranks[x.auth_index] === r - 1) : null;
  const text = a.disabled ? "Out of the pool: no requests go here." : ahead ? `${when} Takes over when ${ahead.label} hits a limit.` : when;
  return div().pt(2).text_size(13).line_height(1.45).text_color(t.muted).child(text);
}

/** A grid row shared by limits and models: label · bar · value, then an optional note, every
 *  value in the same column so they read top to bottom. */
function gridRow(t, id, label, frac, color, value, o = {}) {
  return h_flex()
    .id(id)
    .h(26)
    .gap(12)
    .items_center()
    .when(!!o.tip, el => el.tooltip(o.tip))
    .child(div().flex_none().w(o.labelW ?? LIM_LABEL_W).truncate().text_size(13).text_color(t.foreground).child(label))
    .child(div().flex_1().min_w(48).child(bar(t, frac, color, 6)))
    .child(
      div()
        .flex_none()
        .w(LIM_PCT_W)
        .flex()
        .justify_end()
        .text_size(13)
        .font_family(numFont(t))
        .text_color(o.valueColor ?? t.foreground)
        .child(value),
    )
    .when(o.note !== undefined, el => el.child(div().flex_none().w(LIM_NOTE_W).truncate().text_size(12).text_color(o.noteColor ?? t.muted).child(o.note ?? "")));
}

/** An API key's money: estimated spend (tokens x list prices) and, when a balance was set, what's left.
 *  Anthropic has no balance endpoint, so the balance is the one last read off the Console minus spend since. */
function spendRows(t, a) {
  const sp = a.spend ?? {};
  const usd = n => (n == null ? "–" : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
  const line = (label, value, note, color) =>
    h_flex()
      .gap(10)
      .items_baseline()
      .child(div().w(150).flex_none().text_size(13).text_color(t.muted).child(label))
      .child(div().text_size(15).font_semibold().text_color(color ?? t.foreground).child(value))
      .when(!!note, el => el.child(div().text_size(12).text_color(t.dim).child(note)));
  const b = sp.balance;
  const low = b && b.left < Math.max(5, b.set * 0.1);
  return v_flex()
    .gap(10)
    .when(!!b, el => el.child(line("Balance left", usd(b.left), `≈ ${usd(b.set)} set ${new Date(b.as_of * 1000).toLocaleDateString()} − ${usd(b.used)} spent since`, low ? t.blocked : t.foreground)))
    .child(line("Spent today", usd(sp.today)))
    .child(line("Spent this month", usd(sp.month)))
    .child(line("Spent in range", usd(sp.range)))
    .child(
      div()
        .text_size(11.5)
        .text_color(t.dim)
        .child(b ? "Estimated from tokens at list prices; the Console has the exact figure."
          : "Estimated from tokens at list prices. Anthropic has no balance API: set yours with proxy.py set-balance <usd> (as the Console shows it)."),
    );
}

/** An account's plan limits, one row each; the month's extra usage reads the same way. */
function limitRows(t, a) {
  const plan = a.plan;
  const wins = windowsOf(a);
  if (a.kind === "api-key") return spendRows(t, a);
  if (!wins.length && !plan?.extra)
    return div()
      .text_size(13)
      .text_color(t.muted)
      .child(a.kind === "upstream" ? `Its limits aren't reported to the proxy${a.prefix ? `. Models: ${a.prefix}/<model>` : ""}` : a.kind === "api-key" ? "No plan limits: pay per token, billed to the API key" : a.provider === "claude" || a.provider === "codex" ? (plan?.stale ? `Limits unavailable: ${plan.stale}` : "No usage reported yet") : "No plan limits (pay per token)");
  const pctText = p => (p == null ? "–" : `${Math.round(p)}%`);
  const hot = p => (p ?? 0) >= 90;
  const rows = wins.map((w, i) =>
    gridRow(t, `lim-${a.auth_index}-${i}`, w.label, (w.pct ?? 0) / 100, usedColor(w.pct, t), pctText(w.pct), {
      valueColor: hot(w.pct) ? t.blocked : t.foreground,
      note: w.idle ? "not started" : w.resets ? `resets ${until(w.resets)}` : "",
    }),
  );
  if (plan?.extra) {
    const x = plan.extra;
    const reached = (x.pct ?? 0) >= 100;
    const spent = `${x.used.toFixed(2)} / ${x.limit.toFixed(0)} ${x.currency}`;
    rows.push(
      gridRow(t, `lim-${a.auth_index}-extra`, "Extra usage", (x.pct ?? 0) / 100, reached ? t.blocked : usedColor(x.pct, t), pctText(x.pct), {
        valueColor: hot(x.pct) ? t.blocked : t.foreground,
        note: reached ? `${spent} · limit reached` : `${spent} this month`,
        noteColor: reached ? t.blocked : t.muted,
        tip: `Extra usage this month: ${x.used.toFixed(2)} of ${x.limit.toFixed(2)} ${x.currency}`,
      }),
    );
  }
  return v_flex()
    .gap(6)
    .children(rows)
    .when(!!plan.stale, el => el.child(div().pt(4).text_size(12).text_color(t.muted).child(`Last known values: ${plan.stale}`)))
    .when(plan.from === "headers", el => el.child(div().pt(4).text_size(12).text_color(t.muted).child("From the last response's rate-limit headers")));
}

/** What the account did: the headline numbers on one line (the rest on hover), a short chart
 *  over the whole range, the token split as a legend, then its models. */
function activity(t, d, a) {
  const pts = d.series?.points ?? [];
  const ser = a.series?.length ? a.series : pts.map(() => [0, 0]);
  const size = d.series?.size ?? 3600;
  const total = a.requests ?? ser.reduce((s, x) => s + x[0], 0);
  const fails = a.failed ?? ser.reduce((s, x) => s + x[1], 0);
  const peak = Math.max(0, ...ser.map(x => x[0]));
  const unit = size >= 86400 ? "day" : size >= 3600 ? "hour" : `${Math.round(size / 60)} min`;
  const tip = [
    `peak ${num(peak)} requests per ${unit}`,
    a.cache_hit != null ? `cache hit ${pct(a.cache_hit)}` : null,
    a.latency_p50 ? `median reply ${ms(a.latency_p50)}` : null,
    a.ttft_p50 ? `first token ${ms(a.ttft_p50)}` : null,
    a.sessions ? `${num(a.sessions)} sessions` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const fig = (value, label, color) =>
    h_flex()
      .gap(4)
      .items_baseline()
      .child(div().text_size(16).font_semibold().text_color(color ?? t.foreground).child(value))
      .child(div().text_size(13).text_color(color ?? t.muted).child(label));
  return v_flex()
    .gap(12)
    .child(
      h_flex()
        .id(`acct-head-${a.auth_index}`)
        .flex_wrap()
        .gap(16)
        .items_baseline()
        .tooltip(tip)
        .child(fig(num(total), total === 1 ? "request" : "requests"))
        .child(fig(num(a.tokens ?? 0), "tokens"))
        .when(fails > 0, el => el.child(fig(num(fails), `failed (${pct(fails / Math.max(1, total), 1)})`, t.blocked))),
    )
    .child(miniChart(t, d, a, ser))
    .child(tokenLegend(t, a))
    .child(modelRows(t, a));
}

/** Requests per bucket across the whole range, 40px tall, failures on hover. */
function miniChart(t, d, a, ser) {
  const H = 40;
  const pts = d.series?.points ?? [];
  const size = d.series?.size ?? 3600;
  const top = Math.max(1, ...ser.map(x => x[0]));
  const day = size >= 86400;
  return v_flex()
    .gap(4)
    .child(
      div()
        .relative()
        .h(H)
        .w_full()
        .child(div().absolute().bottom(0).left(0).right(0).h(1).bg(t.border))
        .child(
          div()
            .absolute()
            .inset_0()
            .flex()
            .flex_row()
            .gap(ser.length > 90 ? 1 : 2)
            .items_end()
            .children(
              ser.map((x, i) => {
                const h = x[0] > 0 ? Math.max(2, (x[0] / top) * H) : 0;
                const at = pts[i]?.t;
                return v_flex()
                  .id(`acct-bar-${a.auth_index}-${i}`)
                  .flex_basis(0)
                  .flex_grow(1)
                  .min_w(0)
                  .h_full()
                  .justify_end()
                  .hover(s => s.bg(alpha(t.foreground, 0.04)))
                  .tooltip(`${at ? clock(at, day) : ""}: ${num(x[0])} request${x[0] === 1 ? "" : "s"}${x[1] ? `, ${num(x[1])} failed` : ""}`)
                  .when(h > 0, el => el.child(div().w_full().h(h).rounded_t(Math.min(2, h / 2)).bg(t.accent)));
              }),
            ),
        ),
    )
    .child(
      h_flex()
        .text_size(11)
        .text_color(t.muted)
        .child(div().child(pts[0] ? clock(pts[0].t, day) : ""))
        .child(div().flex_1())
        .child(div().child("now")),
    );
}

/** The four token kinds on one wrapping line, each value right after its label; shares on hover. */
function tokenLegend(t, a) {
  const kinds = tokenKinds(t);
  const total = kinds.reduce((s, x) => s + (a[x.k] ?? 0), 0) || 1;
  return h_flex()
    .flex_wrap()
    .gap(16)
    .items_center()
    .children(
      kinds.map(x =>
        h_flex()
          .id(`acct-tok-${a.auth_index}-${x.k}`)
          .gap(6)
          .items_center()
          .tooltip(`${x.label}: ${pct((a[x.k] ?? 0) / total, 1)} of tokens. ${x.hint}`)
          .child(div().flex_none().w(8).h(8).rounded(2).bg(x.c))
          .child(div().text_size(12).text_color(t.muted).child(x.label))
          .child(div().text_size(12).font_family(numFont(t)).text_color(t.foreground).child(num(a[x.k] ?? 0))),
      ),
    );
}

/** The account's top models by tokens: name · bar · share, tokens and requests on hover. */
function modelRows(t, a) {
  const list = (a.models ?? []).slice(0, 3);
  if (!list.length) return div();
  const total = (a.models ?? []).reduce((s, m) => s + m.tokens, 0) || 1;
  return v_flex()
    .gap(2)
    .children(
      list.map((m, i) =>
        gridRow(t, `acct-model-${a.auth_index}-${i}`, m.model.replace(/^claude-/, ""), m.tokens / total, t.accent, pct(m.tokens / total), {
          labelW: 140,
          tip: `${m.model}: ${num(m.tokens)} tokens, ${num(m.requests)} requests`,
        }),
      ),
    )
    .when((a.models ?? []).length > 3, el => el.child(div().pt(2).text_size(12).text_color(t.muted).child(`and ${a.models.length - 3} more`)));
}

// ---- requests

export function requests(t, d) {
  t = legible(t);
  const cols = [
    { key: "when", label: "Time", w: 96 },
    { key: "model", label: "Model", flex: true, w: 180 },
    { key: "account", label: "Account", w: 160 },
    { key: "client", label: "Client", w: 104 },
    { key: "in", label: "Input", w: 72, align: "right" },
    { key: "cache", label: "Cached", w: 76, align: "right" },
    { key: "out", label: "Output", w: 72, align: "right" },
    { key: "lat", label: "Duration", w: 76, align: "right" },
    { key: "ttft", label: "First token", w: 84, align: "right" },
    { key: "status", label: "Status", w: 72, align: "right" },
  ];
  const rows = d.recent.map((r, i) => ({
    id: i,
    tooltip: r.failed ? `${r.status ?? ""} ${r.error ?? ""}`.trim() : `${r.stream ? "streamed" : "not streamed"}${r.effort ? ` · effort ${r.effort}` : ""}`,
    cells: {
      when: div().font_family(numFont(t)).text_size(12).text_color(t.muted).child(clock(r.ts, d.range !== "1h" && d.range !== "24h")),
      model: h_flex().gap(8).items_center().min_w(0).child(dot(providerColor(r.provider, t), 6)).child(div().truncate().child(r.model ?? "–")),
      account: div().text_color(t.muted).truncate().child(r.account ?? "–"),
      client: div().text_color(t.muted).truncate().child(r.client ?? "–"),
      in: num(r.input),
      cache: num(r.cache_read),
      out: num(r.output),
      lat: ms(r.latency),
      ttft: ms(r.ttft),
      status: h_flex()
        .gap(6)
        .items_center()
        .child(dot(r.failed ? t.blocked : ok(t), 6))
        .child(div().font_family(numFont(t)).text_size(12).text_color(r.failed ? t.blocked : t.muted).child(String(r.status ?? (r.failed ? "failed" : "ok")))),
    },
  }));
  return v_flex()
    .gap(16)
    .when(d.errors.length > 0, el =>
      el.child(
        card(
          t,
          "c-errors",
          "Recent failures",
          v_flex().children(
            d.errors.map((e, i) =>
              v_flex()
                .id(`err-${i}`)
                .px(16)
                .py(10)
                .gap(4)
                .when(i > 0, x => x.border_t(1).border_color(t.border))
                .child(
                  h_flex()
                    .gap(8)
                    .items_center()
                    .child(badge(t, String(e.status ?? "error"), t.blocked))
                    .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(e.model ?? "–"))
                    .child(div().flex_none().text_size(12).text_color(t.muted).child(`${e.account ?? ""} · ${ago(e.ts)}`)),
                )
                .when(!!e.error, x => x.child(div().text_size(12).text_color(t.muted).truncate().child(e.error))),
            ),
          ),
          { flush: true, note: `${d.errors.length} in range` },
        ),
      ),
    )
    .child(card(t, "c-recent", "Latest requests", table(t, "t-recent", cols, rows, { inset: 16 }), { flush: true, note: "newest first, up to 60" }));
}

/**
 * The routing callbacks the views use (`o.routing`), for a host: each change goes through
 * proxy.py (the proxy's management API), then `refresh(cx)`. `notify` posts the outcome.
 */
export function routingActions(host, script, exec, notify) {
  const busy = new Set();
  const run = (key, args, done) => cx => {
    if (busy.has(key)) return;
    busy.add(key);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", [script, ...args]);
        const out = JSON.parse(r.stdout || "{}");
        if (!out.ok) throw new Error(out.error || r.stderr || "proxy.py failed");
        notify({ title: done, level: "success", timeout: 2500 });
      } catch (e) {
        notify({ title: "Couldn't change routing", body: String(e?.message ?? e), level: "error" });
      }
      busy.delete(key);
      host.refresh(cx);
      cx.notify();
    });
  };
  return {
    busy: key => busy.has(key),
    setStrategy: (s, cx) => run("strategy", ["set-strategy", s], `Routing: ${s.replace(/-/g, " ")}`)(cx),
    setPriority: (name, n, cx) => run(name, ["set-priority", name, String(n)], `Priority set to ${n}`)(cx),
    setEnabled: (name, on, cx) => run(name, ["set-enabled", name, on ? "on" : "off"], on ? "Account back in the pool" : "Account taken out of the pool")(cx),
  };
}
