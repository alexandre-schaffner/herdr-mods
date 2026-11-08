// The four views: Overview, Models, Accounts, Requests. Each takes the report proxy.py made.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import {
  ago, alpha, badge, bar, card, clock, delta, dot, empty, icon, mono, ms, num, ok, pct, providerColor,
  providerName, stack, table, tokenColors, until, usedColor,
} from "./proxy-ui.js";

const RANGE_WORDS = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

// ---- overview
//
// Ordered by what a decision needs: plan limits first (can the org keep working?), then a
// one-line summary, then when the work happened, then where it went. Charts are single-series
// small multiples on one time axis (requests, tokens): no stacks where one part (cache reads)
// dwarfs the rest, no dual axes. Exact numbers are in each bar's tooltip.

export function overview(t, d, o) {
  return v_flex()
    .gap(16)
    .child(
      card(t, "c-limits", "Plan limits and routing", planList(t, d.accounts, o), {
        note: "live, per account",
        right: o?.routing ? strategyControl(t, d, o) : null,
      }),
    )
    .child(summary(t, d))
    .child(card(t, "c-tokens", "Tokens", tokenBreakdown(t, d), { note: "read and write, with the prompt cache" }))
    .child(card(t, "c-activity", "When", activity(t, d), { note: RANGE_WORDS[d.range] }))
    .child(card(t, "c-split", "Where it went", splits(t, d, o), { note: "tokens, ranked" }));
}

/** The range in one row of small stats; a change only where the previous period had data. */
function summary(t, d) {
  const T = d.totals;
  const P = d.previous?.requests ? d.previous : null;
  const stat = (id, value, label, o = {}) =>
    v_flex()
      .id(id)
      .flex_none()
      .min_w(96)
      .gap(2)
      .when(!!o.tooltip, el => el.tooltip(o.tooltip))
      .child(
        h_flex()
          .gap(6)
          .items_baseline()
          .child(div().text_size(17).font_semibold().text_color(o.color ?? t.foreground).child(value))
          .when(!!o.change, el => el.child(div().text_size(11).font_medium().text_color(o.changeColor ?? t.muted).child(o.change))),
      )
      .child(div().text_size(11.5).text_color(t.muted).child(label));
  const tone = (ch, goodWhenDown) => (!ch || ch === "new" ? t.muted : (ch.startsWith("+") !== !!goodWhenDown ? ok(t) : t.blocked));
  const reqCh = P ? delta(T.requests, P.requests) : null;
  const tokCh = P ? delta(T.tokens, P.tokens) : null;
  const latCh = P ? delta(T.latency_p50, P.latency_p50) : null;
  return h_flex()
    .px(4)
    .gap(28)
    .flex_wrap()
    .child(stat("s-req", num(T.requests), `requests · ${num(T.sessions)} sessions`, { change: reqCh, changeColor: t.muted }))
    .child(
      stat("s-tok", num(T.tokens), "tokens", {
        change: tokCh,
        changeColor: t.muted,
        tooltip: `Fresh input ${num(T.in_uncached)} · cache writes ${num(T.cache_write)} · cache reads ${num(T.cache_read)} · output ${num(T.output)} (reasoning ${num(T.reasoning)})`,
      }),
    )
    .child(
      stat("s-cache", pct(T.cache_hit), "from the prompt cache", {
        tooltip: "Share of input tokens served from the prompt cache. Higher is faster and uses less quota.",
      }),
    )
    .child(stat("s-lat", ms(T.latency_p50), `median reply · first token ${ms(T.ttft_p50)}`, { change: latCh, changeColor: tone(latCh, true), tooltip: `p95 ${ms(T.latency_p95)}` }))
    .child(
      stat("s-fail", num(T.failed), T.requests ? `failed · ${pct(T.failed / T.requests, 1)}` : "failed", {
        color: T.failed ? t.blocked : t.foreground,
      }),
    )
    .when(!!P, el => el.child(div().self_end().pb(2).text_size(11).text_color(t.dim).child(`changes vs the previous ${d.range}`)));
}

/** A round number at or above `v`, for a chart's top gridline. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => f <= x);
  return step * p;
}

/** Two small multiples on one time axis: requests, then tokens. Leading empty hours are cut,
 *  with a note saying so, so a range with a short burst doesn't draw a wall of nothing. */
function activity(t, d) {
  const all = d.series.points;
  const first = all.findIndex(p => p.req > 0);
  if (first < 0) return div().py(24).text_size(12).text_color(t.dim).child("No requests in this range.");
  const MIN = 6;
  const start = Math.max(0, Math.min(first - 1, all.length - MIN));
  const pts = all.slice(start);
  const size = d.series.size;
  const withDay = size >= 21600 || pts.length * size > 86400;
  const span = p => `${clock(p.t, withDay)}–${clock(p.t + size, false)}`;
  const tip = p =>
    `${span(p)}\n${num(p.req)} request${p.req === 1 ? "" : "s"}${p.fail ? `, ${p.fail} failed` : ""}\n` +
    `${num(p.input + p.cache + p.output)} tokens: ${num(p.cache)} cache read, ${num(p.input)} fresh in, ${num(p.output)} out` +
    Object.entries(p.by ?? {}).map(([k, v]) => `\n${providerName(k)}: ${num(v)}`).join("");
  return v_flex()
    .gap(14)
    .child(columns(t, "req", "Requests", pts, p => p.req, { H: 110, tip, fail: p => p.fail }))
    .child(columns(t, "tok", "Tokens", pts, p => p.input + p.cache + p.output, { H: 64, tip }))
    .child(
      h_flex()
        .pl(AXIS_W)
        .gap(2)
        .children(
          pts.map((p, i) => {
            const every = Math.max(1, Math.ceil(pts.length / 8));
            return div()
              .flex_1()
              .min_w(2)
              .text_size(10.5)
              .text_color(t.muted)
              .child(i % every === 0 ? clock(p.t, withDay && size >= 86400) : "");
          }),
        ),
    )
    .when(start > 0, el =>
      el.child(div().text_size(11).text_color(t.dim).child(`No requests before ${clock(pts[0].t, withDay)}; earlier hours of the range are hidden.`)),
    );
}

const AXIS_W = 52;

/** One single-series column chart: a labelled top gridline, a baseline, 2px gaps between
 *  bars, rounded tops, a hover tooltip per bar. `fail` marks buckets with failures. */
function columns(t, id, title, pts, value, o) {
  const H = o.H;
  const top = niceMax(Math.max(...pts.map(value)));
  const color = t.accent;
  const peak = Math.max(...pts.map(value));
  return v_flex()
    .gap(6)
    .child(
      h_flex()
        .pl(AXIS_W)
        .gap(8)
        .items_baseline()
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(title))
        .child(div().text_size(11).text_color(t.muted).child(`peak ${num(peak)} in an hour${o.unit ? ` ${o.unit}` : ""}`)),
    )
    .child(
      row(t)
        .items_end()
        .child(
          v_flex()
            .w(AXIS_W - 8)
            .flex_none()
            .h(H)
            .items_end()
            .justify_between()
            .child(div().text_size(10.5).text_color(t.muted).child(num(top)))
            .child(div().text_size(10.5).text_color(t.muted).child("0")),
        )
        .child(
          div()
            .relative()
            .flex_1()
            .min_w(0)
            .h(H)
            .child(div().absolute().top(0).left(0).right(0).h(1).bg(alpha(t.border, 0.7)))
            .child(div().absolute().bottom(0).left(0).right(0).h(1).bg(t.border))
            .child(
              h_flex()
                .absolute()
                .inset_0()
                .gap(2)
                .items_end()
                .children(
                  pts.map((p, i) => {
                    const v = value(p);
                    const h = v > 0 ? Math.max(2, (v / top) * (H - 1)) : 0;
                    const failed = o.fail?.(p) > 0;
                    return v_flex()
                      .id(`${id}-bar-${i}`)
                      .flex_1()
                      .min_w(2)
                      .h_full()
                      .items_center()
                      .justify_end()
                      .hover(s => s.bg(alpha(t.foreground, 0.04)))
                      .tooltip(o.tip(p))
                      .when(failed, el => el.child(div().mb(3).w(6).h(6).rounded(3).bg(t.blocked)))
                      .child(div().w_full().max_w(28).h(h).rounded_t(Math.min(4, h)).bg(color));
                  }),
                ),
            ),
        ),
    );
}

const row = () => div().flex().flex_row().gap(8);

export function planWindows(t, a, o = {}) {
  const plan = a.plan;
  if (!plan?.windows?.length && !plan?.extra)
    return div().text_size(11.5).text_color(t.dim).child(a.provider === "claude" || a.provider === "codex" ? (plan?.stale ? `Unavailable: ${plan.stale}` : "No usage reported yet") : "No plan limits (pay per token)");
  const wins = [...(plan.windows ?? [])];
  if (a.provider === "claude" && wins.length && !wins.some(w => w.label === "5-hour")) wins.unshift({ label: "5-hour", pct: 0, resets: null, idle: true });
  return v_flex()
    .gap(8)
    .children(
      wins.map((w, i) =>
        v_flex()
          .id(`win-${a.auth_index}-${i}`)
          .gap(4)
          .child(
            h_flex()
              .gap(6)
              .items_baseline()
              .child(div().text_size(11.5).text_color(t.muted).child(w.label))
              .child(div().flex_1())
              .child(div().text_size(12).font_semibold().text_color(usedColor(w.pct, t)).child(w.pct == null ? "–" : `${Math.round(w.pct)}%`))
              .child(div().text_size(11).text_color(t.dim).child(w.idle ? "not started" : w.resets ? `resets ${until(w.resets)}` : "")),
          )
          .child(bar(t, (w.pct ?? 0) / 100, usedColor(w.pct, t), o.h ?? 6)),
      ),
    )
    .when(!!plan.extra, el =>
      el.child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .gap(6)
              .items_baseline()
              .child(div().text_size(11.5).text_color(t.muted).child("Extra usage this month"))
              .child(div().flex_1())
              .child(
                div()
                  .text_size(12)
                  .font_semibold()
                  .text_color(usedColor(plan.extra.pct, t))
                  .child(`${plan.extra.used.toFixed(2)} / ${plan.extra.limit.toFixed(0)} ${plan.extra.currency}`),
              ),
          )
          .child(bar(t, (plan.extra.pct ?? 0) / 100, usedColor(plan.extra.pct, t), o.h ?? 6)),
      ),
    )
    .when(!!plan.stale, el => el.child(div().text_size(10.5).text_color(t.dim).child(`Last known values: ${plan.stale}`)))
    .when(plan.from === "headers", el => el.child(div().text_size(10.5).text_color(t.dim).child("From the last response's rate-limit headers")));
}

function accountTitle(t, a, i, live) {
  const color = providerColor(a.provider, t);
  const state = accountState(t, a);
  return h_flex()
    .gap(7)
    .items_center()
    .flex_wrap()
    .child(dot(state.color))
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(a.label))
    .child(badge(t, providerName(a.provider), color))
    .when(live && a.live && i === 0 && a.priority > 0, el => el.child(badge(t, "used first", t.accent)))
    .when(state.text !== "Active", el => el.child(badge(t, state.text, state.color)));
}

export function accountState(t, a) {
  if (!a.live) return { text: "API key", color: t.dim };
  if (a.disabled) return { text: "Disabled", color: t.dim };
  if (a.requires_sign_in) return { text: "Sign in again", color: t.blocked };
  if (a.quota_blocked) return { text: "Quota reached", color: t.blocked };
  if (a.unavailable || (a.cooldowns ?? []).length) return { text: "Cooling down", color: t.working };
  return { text: "Active", color: ok(t) };
}

/** The decision block: per live account, its windows side by side, with a word as well as a
 *  color when a limit is close or reached. */
function planList(t, accounts, o) {
  const live = accounts.filter(a => a.live);
  if (!accounts.length) return empty(t, "No accounts", "Log in with cliproxyapi -claude-login or -codex-login.");
  return v_flex()
    .gap(4)
    .children(
      live.map((a, i) =>
        div()
          .flex()
          .flex_row()
          .flex_wrap()
          .gap(20)
          .py(10)
          .when(i > 0, el => el.border_t(1).border_color(alpha(t.border, 0.6)))
          .child(
            v_flex()
              .w(240)
              .flex_none()
              .gap(4)
              .child(accountTitle(t, a, i, true))
              .when(!!o?.routing && !!a.name, el => el.child(routingRow(t, a, o)))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(a.requests ? `${num(a.requests)} requests · ${num(a.tokens)} tokens · last ${ago(a.last)}` : "No requests in this range"),
              ),
          )
          .child(windowRow(t, a)),
      ),
    )
    .when(accounts.some(a => !a.live), el =>
      el.child(
        div()
          .pt(8)
          .border_t(1)
          .border_color(alpha(t.border, 0.6))
          .text_size(11.5)
          .text_color(t.muted)
          .child(
            "Pay-per-token: " +
              accounts
                .filter(a => !a.live)
                .map(a => `${a.label} (${num(a.requests)} req, ${num(a.tokens)} tok)`)
                .join(" · "),
          ),
      ),
    );
}

// ---- routing: which account the pool uses first (management API, applied at once)

const STRATEGY_WORDS = {
  "fill-first": ["Fill first", "Use the highest-priority account until it hits a limit, then the next. Keeps one account's prompt cache warm."],
  "round-robin": ["Round robin", "Spread requests evenly across enabled accounts."],
  "weighted-round-robin": ["Weighted", "Spread requests in proportion to each account's priority."],
};

function strategyControl(t, d, o) {
  const cur = d.routing?.strategy;
  const busy = o.routing.busy?.("strategy");
  return h_flex()
    .flex_none()
    .p(2)
    .gap(2)
    .rounded(7)
    .bg(alpha(t.foreground, 0.05))
    .children(
      (d.routing?.strategies ?? Object.keys(STRATEGY_WORDS)).map(id => {
        const on = id === cur;
        const [word, hint] = STRATEGY_WORDS[id] ?? [id, ""];
        return div()
          .id(`strategy-${id}`)
          .h(22)
          .px(9)
          .flex()
          .items_center()
          .rounded(5)
          .text_size(11.5)
          .tooltip(hint)
          .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
          .when(!on, el => el.text_color(t.muted).cursor_pointer().hover(s => s.text_color(t.foreground)).on_click((_e, cx) => o.routing.setStrategy(id, cx)))
          .when(!!busy, el => el.opacity(0.5))
          .child(word);
      }),
    );
}

/** An account's place in the pool: on or off, and its priority (higher is used first). */
function routingRow(t, a, o) {
  const busy = o.routing.busy?.(a.name);
  const step = (id, glyph, n, tip) =>
    div()
      .id(`prio-${id}-${a.name}`)
      .w(20)
      .h(20)
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      .border(1)
      .border_color(alpha(t.border, 0.9))
      .text_size(12)
      .text_color(t.foreground)
      .cursor_pointer()
      .tooltip(tip)
      .hover(s => s.bg(alpha(t.foreground, 0.07)))
      .on_click((_e, cx) => o.routing.setPriority(a.name, Math.max(0, n), cx))
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
        .child(div().text_size(11).text_color(on ? t.foreground : t.muted).child(on ? "In pool" : "Off")),
    )
    .child(div().w(1).h(14).bg(alpha(t.border, 0.9)))
    .child(div().text_size(11).text_color(t.muted).child("Priority"))
    .child(step("down", "−", (a.priority ?? 0) - 1, "Lower priority"))
    .child(div().min_w(18).text_center().text_size(12).font_semibold().font_family(mono()).text_color(t.foreground).child(String(a.priority ?? 0)))
    .child(step("up", "+", (a.priority ?? 0) + 1, "Higher priority: used before lower ones"));
}

// ---- tokens: what was read and written, fresh and through the prompt cache

/** Four amounts that answer "what did we send and get back": fresh input read, output written,
 *  cache reads (cheap, fast) and cache writes (new prompt prefixes stored). Each with its share
 *  of the total, then the same split per account and per model. */
function tokenBreakdown(t, d) {
  const T = d.totals ?? {};
  const kinds = [
    { k: "in_uncached", label: "Input read", hint: "Fresh input tokens: not served from the prompt cache", c: t.accent },
    { k: "output", label: "Output written", hint: "Tokens the model wrote, thinking included", c: t.ansi5 ?? t.accent },
    { k: "cache_read", label: "Cache read", hint: "Input tokens served from the prompt cache (cheaper and faster)", c: ok(t) },
    { k: "cache_write", label: "Cache write", hint: "Input tokens stored into the prompt cache for later turns", c: t.ansi3 ?? t.working },
  ];
  const total = kinds.reduce((s, x) => s + (T[x.k] ?? 0), 0) || 1;
  const cell = x =>
    v_flex()
      .id(`tok-${x.k}`)
      .flex_1()
      .min_w(130)
      .gap(3)
      .tooltip(x.hint)
      .child(h_flex().gap(6).items_center().child(div().w(8).h(8).rounded(2).bg(x.c)).child(div().text_size(11.5).text_color(t.muted).child(x.label)))
      .child(div().text_size(18).font_semibold().text_color(t.foreground).child(num(T[x.k] ?? 0)))
      .child(div().text_size(11).text_color(t.muted).child(`${pct((T[x.k] ?? 0) / total, 1)} of tokens`));
  const rowsOf = (list, name) =>
    list
      .filter(r => r.tokens || r.requests)
      .slice(0, 8)
      .map((r, i) => ({
        id: `${i}`,
        cells: { name: name(r), ...Object.fromEntries(kinds.map(x => [x.k, num(r[x.k] ?? 0)])), hit: pct(r.cache_hit ?? 0) },
      }));
  const cols = first => [
    { key: "name", label: first, flex: true, w: 140 },
    ...kinds.map(x => ({ key: x.k, label: x.label, w: 108, align: "right" })),
    { key: "hit", label: "Cache hit", w: 80, align: "right" },
  ];
  return v_flex()
    .gap(14)
    .child(div().flex().flex_row().flex_wrap().gap(20).children(kinds.map(cell)))
    .child(table(t, "tok-accounts", cols("By account"), rowsOf(d.accounts ?? [], r => r.label)))
    .child(table(t, "tok-models", cols("By model"), rowsOf(d.models ?? [], r => r.key)));
}

/** An account's windows as equal cells in a row: label, percent, a bar, when it resets. */
function windowRow(t, a) {
  const plan = a.plan;
  if (!plan?.windows?.length && !plan?.extra) return div().flex_1().min_w(200).pt(2).child(planWindows(t, a));
  const wins = [...(plan.windows ?? [])];
  if (a.provider === "claude" && wins.length && !wins.some(w => w.label === "5-hour")) wins.unshift({ label: "5-hour", pct: 0, resets: null, idle: true });
  const cells = wins.map(w => ({ label: w.label, pct: w.pct, value: w.pct == null ? "–" : `${Math.round(w.pct)}%`, note: w.idle ? "not started" : w.resets ? `resets ${until(w.resets)}` : "" }));
  if (plan.extra)
    cells.push({
      label: "Extra usage this month",
      pct: plan.extra.pct,
      value: `${plan.extra.used.toFixed(2)} / ${plan.extra.limit.toFixed(0)} ${plan.extra.currency}`,
      note: "",
    });
  const word = p => (p == null ? "" : p >= 100 ? "limit reached" : p >= 90 ? "nearly full" : p >= 70 ? "high" : "");
  return div()
    .flex()
    .flex_row()
    .flex_wrap()
    .flex_1()
    .min_w(260)
    .gap(20)
    .children(
      cells.map((c, j) =>
        v_flex()
          .id(`win-${a.auth_index}-${j}`)
          .flex_1()
          .min_w(150)
          .max_w(340)
          .gap(5)
          .child(div().text_size(11.5).text_color(t.muted).child(c.label))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(c.pct >= 90, el => el.child(icon("alert", 12, usedColor(c.pct, t))))
              .child(div().text_size(15).font_semibold().text_color(c.pct >= 70 ? usedColor(c.pct, t) : t.foreground).child(c.value))
              .when(!!word(c.pct), el => el.child(div().text_size(11).font_medium().text_color(usedColor(c.pct, t)).child(word(c.pct)))),
          )
          .child(bar(t, (c.pct ?? 0) / 100, usedColor(c.pct, t), 6))
          .child(div().text_size(11).text_color(t.muted).child(c.note || " ")),
      ),
    );
}

/** Where tokens went, as ranked lists side by side: a name, a bar proportional to the
 *  largest, the value and its share. One color: the label carries identity. */
function splits(t, d, o) {
  const lists = [
    { id: "model", title: "By model", rows: d.models.map(m => ({ key: m.key, label: m.key, tokens: m.tokens, sub: `${num(m.requests)} req` })), more: () => o?.goto?.("models") },
    { id: "client", title: "By client", rows: d.clients.map(c => ({ key: c.key, label: c.key, tokens: c.tokens, sub: `${num(c.requests)} req` })) },
    { id: "account", title: "By account", rows: d.accounts.filter(a => a.tokens).map(a => ({ key: a.auth_index, label: a.label, tokens: a.tokens, sub: `${num(a.requests)} req` })) },
  ];
  if (!d.models.length) return div().text_size(12).text_color(t.dim).child("Nothing yet in this range.");
  return div()
    .flex()
    .flex_row()
    .flex_wrap()
    .gap(28)
    .children(
      lists.map(l => {
        const max = Math.max(1, ...l.rows.map(r => r.tokens));
        const total = l.rows.reduce((s, r) => s + r.tokens, 0) || 1;
        return v_flex()
          .flex_1()
          .min_w(240)
          .gap(10)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child(l.title))
          .children(
            l.rows.slice(0, 6).map(r =>
              v_flex()
                .id(`rank-${l.id}-${r.key}`)
                .gap(4)
                .tooltip(`${r.label}: ${num(r.tokens)} tokens, ${r.sub}, ${pct(r.tokens / total, 1)} of the range`)
                .child(
                  h_flex()
                    .gap(8)
                    .items_baseline()
                    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.label))
                    .child(div().flex_none().text_size(11).text_color(t.muted).child(r.sub))
                    .child(div().flex_none().w(52).flex().justify_end().font_family(mono()).text_size(12).text_color(t.foreground).child(num(r.tokens)))
                    .child(div().flex_none().w(40).flex().justify_end().font_family(mono()).text_size(11.5).text_color(t.muted).child(pct(r.tokens / total))),
                )
                .child(bar(t, r.tokens / max, t.accent, 4)),
            ),
          )
          .when(l.rows.length > 6, el => el.child(div().text_size(11).text_color(t.muted).child(`and ${l.rows.length - 6} more`)));
      }),
    );
}

// ---- models

export function models(t, d) {
  const total = d.models.reduce((s, m) => s + m.tokens, 0) || 1;
  const cols = [
    { key: "model", label: "Model", flex: true, w: 180 },
    { key: "req", label: "Requests", w: 76, align: "right" },
    { key: "fail", label: "Failed", w: 60, align: "right" },
    { key: "in", label: "Fresh in", w: 76, align: "right" },
    { key: "cache", label: "Cache read", w: 84, align: "right" },
    { key: "out", label: "Output", w: 70, align: "right" },
    { key: "hit", label: "Cache hit", w: 72, align: "right" },
    { key: "lat", label: "Median", w: 60, align: "right" },
    { key: "ttft", label: "1st token", w: 72, align: "right" },
    { key: "tps", label: "Tok/s", w: 56, align: "right" },
    { key: "share", label: "Share", w: 110 },
    { key: "last", label: "Last used", w: 84, align: "right" },
  ];
  const rows = d.models.map(m => ({
    id: m.key,
    tooltip: `${m.key}: ${num(m.in_uncached)} fresh input, ${num(m.cache_write)} cache writes, ${num(m.cache_read)} cache reads, ${num(m.output)} output (${num(m.reasoning)} reasoning) across ${num(m.sessions)} sessions`,
    cells: {
      model: h_flex().gap(7).items_center().min_w(0).child(dot(providerColor(m.provider, t), 7)).child(div().truncate().child(m.key)),
      req: num(m.requests),
      fail: m.failed ? div().text_color(t.blocked).child(num(m.failed)) : "0",
      in: num(m.in_uncached + m.cache_write),
      cache: num(m.cache_read),
      out: num(m.output),
      hit: pct(m.cache_hit),
      lat: ms(m.latency_p50),
      ttft: ms(m.ttft_p50),
      tps: m.tok_s ? num(m.tok_s) : "–",
      share: h_flex().w_full().gap(6).items_center().child(div().flex_1().child(bar(t, m.tokens / total, providerColor(m.provider, t), 5))).child(div().w(34).text_size(10.5).text_color(t.dim).child(pct(m.tokens / total))),
      last: ago(m.last),
    },
  }));
  return card(t, "c-models", "Models", table(t, "t-models", cols, rows), { note: `${d.models.length} used in the ${RANGE_WORDS[d.range]}` });
}

// ---- accounts

export function accounts(t, d) {
  if (!d.accounts.length) return empty(t, "No accounts", "Log in with cliproxyapi -claude-login or -codex-login.");
  return v_flex()
    .gap(14)
    .children(
      d.accounts.map((a, i) => {
        const tc = tokenColors(t);
        const stat = (label, value, sub) =>
          v_flex()
            .flex_1()
            .min_w(90)
            .gap(2)
            .child(div().text_size(10.5).text_color(t.dim).child(label))
            .child(div().text_size(15).font_semibold().text_color(t.foreground).child(value))
            .child(div().text_size(10.5).text_color(t.dim).child(sub ?? ""));
        const state = accountState(t, a);
        return card(
          t,
          `acct-${a.auth_index}`,
          null,
          v_flex()
            .gap(12)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(accountTitle(t, a, i, true))
                .child(div().flex_1())
                .when(a.live, el =>
                  el.child(div().text_size(11).text_color(t.dim).child(`priority ${a.priority ?? 0}${a.renewal_state ? ` · ${a.renewal_state.replaceAll("_", " ")}` : ""}`)),
                ),
            )
            .when(!!a.status_message, el => el.child(div().text_size(11.5).text_color(state.color).child(a.status_message)))
            .when((a.cooldowns ?? []).length > 0, el =>
              el.child(div().text_size(11.5).text_color(t.working).child(`Cooling down: ${a.cooldowns.map(c => (typeof c === "string" ? c : c.model ?? c.reason ?? JSON.stringify(c))).join(", ")}`)),
            )
            .child(
              h_flex()
                .gap(20)
                .items_start()
                .child(v_flex().flex_1().min_w(0).child(planWindows(t, a, { h: 7 })))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(10)
                    .child(
                      h_flex()
                        .gap(10)
                        .child(stat("Requests", num(a.requests), a.failed ? `${num(a.failed)} failed` : `${num(a.sessions)} sessions`))
                        .child(stat("Tokens", num(a.tokens), `${num(a.output)} output`))
                        .child(stat("Cache hit", pct(a.cache_hit), `p50 ${ms(a.latency_p50)}`)),
                    )
                    .child(stack(t, [
                      { value: a.in_uncached + a.cache_write, color: tc.input },
                      { value: a.cache_read, color: tc.cache },
                      { value: a.output, color: tc.output },
                    ], 7))
                    .child(div().text_size(11).text_color(t.dim).child(a.last ? `Last request ${ago(a.last)}` : "No requests in this range")),
                ),
            ),
        );
      }),
    );
}

// ---- requests

export function requests(t, d) {
  const cols = [
    { key: "when", label: "When", w: 92 },
    { key: "model", label: "Model", flex: true, w: 150 },
    { key: "account", label: "Account", w: 170 },
    { key: "client", label: "Client", w: 96 },
    { key: "in", label: "In", w: 64, align: "right" },
    { key: "cache", label: "Cached", w: 70, align: "right" },
    { key: "out", label: "Out", w: 60, align: "right" },
    { key: "lat", label: "Time", w: 60, align: "right" },
    { key: "ttft", label: "1st token", w: 64, align: "right" },
    { key: "status", label: "", w: 70, align: "right" },
  ];
  const rows = d.recent.map((r, i) => ({
    id: i,
    tooltip: r.failed ? `${r.status ?? ""} ${r.error ?? ""}`.trim() : `${r.stream ? "streamed" : "not streamed"}${r.effort ? ` · effort ${r.effort}` : ""}`,
    cells: {
      when: div().text_color(t.muted).child(clock(r.ts, d.range !== "1h" && d.range !== "24h")),
      model: h_flex().gap(7).items_center().min_w(0).child(dot(providerColor(r.provider, t), 7)).child(div().truncate().child(r.model ?? "–")),
      account: div().text_color(t.muted).truncate().child(r.account ?? "–"),
      client: div().text_color(t.muted).truncate().child(r.client ?? "–"),
      in: num(r.input),
      cache: num(r.cache_read),
      out: num(r.output),
      lat: ms(r.latency),
      ttft: ms(r.ttft),
      status: r.failed ? badge(t, String(r.status ?? "failed"), t.blocked) : icon("check", 12, ok(t)),
    },
  }));
  return v_flex()
    .gap(14)
    .when(d.errors.length > 0, el =>
      el.child(
        card(
          t,
          "c-errors",
          "Recent failures",
          v_flex()
            .gap(8)
            .children(
              d.errors.map((e, i) =>
                v_flex()
                  .id(`err-${i}`)
                  .gap(2)
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(badge(t, String(e.status ?? "error"), t.blocked))
                      .child(div().text_size(12).text_color(t.foreground).child(e.model ?? "–"))
                      .child(div().text_size(11).text_color(t.dim).child(`${e.account ?? ""} · ${ago(e.ts)}`)),
                  )
                  .when(!!e.error, x => x.child(div().text_size(11).text_color(t.muted).truncate().child(e.error))),
              ),
            ),
          { note: `${d.errors.length} in range` },
        ),
      ),
    )
    .child(card(t, "c-recent", "Latest requests", table(t, "t-recent", cols, rows, { rowH: 28 }), { note: "newest first, up to 60" }));
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
