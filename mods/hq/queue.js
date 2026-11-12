// Queue: the merge queue as a live pipeline. PRs flow left to right: waiting (READY, not yet in a
// batch) → testing (the batch's CI) → ready to merge (green, waiting for the merge) → landed. Below,
// the last batches as a timeline (CI time, then the wait to merge), and what's held and why.
// One queue per epic (each merge-queue manager serves one worktree group): tabs pick the epic.
// Data: hq.py's `queues` (each queue engine's state.json, summarised). Read-only, except Approve,
// which answers the batch's approval in Review.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { exec } from "herdr";

import { agentMark, alpha, btn, chip, clip, clock, dur, empty, icon, ok, panel, scrollY, segmented, SP, statusGlyph, tone, TYPE } from "./ui.js";

const RECENT = 10;

/** What each batch status means here: its word, tone, pipeline column and glyph. */
const BATCH = {
  ci: { word: "Testing", tone: "info", col: "testing", glyph: "working" },
  red: { word: "CI failed", tone: "alert", col: "testing", glyph: "blocked" },
  error: { word: "CI error", tone: "alert", col: "testing", glyph: "blocked" },
  stale: { word: "Stale", tone: "warn", col: "testing", glyph: "blocked" },
  green: { word: "Passed CI", tone: "ok", col: "merging", glyph: "done" },
  "trunk-check": { word: "Merged · checking trunk", tone: "ok", col: "merging", glyph: "done" },
};
const batchColor = (t, status) => tone(t)[BATCH[status]?.tone] ?? t.muted;

export class QueueView {
  constructor(app) {
    this.app = app;
    this.picked = null; // { epic, during: the epic HQ showed then }: a tab picked here, until HQ switches epic
  }

  onShow(cx, arg) {
    if (arg?.epic) this.pick(arg.epic, cx);
  }

  pick(epic, cx) {
    this.picked = { epic: epic ?? null, during: this.app.data?.epic ?? null };
    cx.notify();
  }

  queues() {
    return this.app.data?.queues ?? [];
  }

  typing() {
    return false;
  }

  q() {
    const all = this.queues();
    const hq = this.app.data?.epic ?? null;
    const want = this.picked?.during === hq ? this.picked.epic : hq;
    return all.find(x => (x.epic ?? null) === want) ?? all.find(x => x.live?.length) ?? all[0] ?? null;
  }

  // ---- helpers

  title(pr) {
    return this.cur?.titles?.[String(pr)] ?? "";
  }

  /** "feat(engine-v3): score X live" → "score X live": the conventional-commit prefix is noise here. */
  short(pr, n = 64) {
    return clip(this.title(pr).replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ""), n);
  }

  owner(addr) {
    const d = this.app.data;
    if (!addr) return null;
    if (addr === d?.master?.terminal) return { id: "master", label: "Master", kind: "master" };
    const m = (d?.managers ?? []).find(x => x.terminal === addr);
    return m ? { id: m.id, label: m.name || m.id, kind: m.kind } : { id: addr, label: addr };
  }

  openPr(pr) {
    const base = this.cur?.prBase;
    if (base) exec("open", [`${base}${pr}`]).catch(() => {});
  }

  // ---- the page

  render(t, cx) {
    const q = (this.cur = this.q()); // the queue on screen, for the row helpers (titles, links)
    if (!q) return empty(t, "No merge queue", "Each epic can have its own. The master starts one with `hq manager-new --kind merge-queue --group <epic>`.", { icon: "git-branch" });
    if (q.missing)
      return v_flex().flex_1().child(this.tabs(t)).child(empty(t, `The ${q.epic} queue hasn't started yet`, `${q.manager} is ${q.status ?? "planned"}. Its batches show here once its engine writes its state.`, { icon: "git-branch" }));
    return scrollY(
      "queue-scroll",
      v_flex()
        .w_full()
        .items_center()
        .px(SP.xxl)
        .pt(SP.xl)
        .pb(48)
        .child(
          v_flex()
            .w_full()
            .max_w(1240)
            .gap(28)
            .child(this.tabs(t))
            .child(this.header(t, q))
            .child(this.pipeline(t, q))
            .child(this.timeline(t, q))
            .child(this.rules(t, q)),
        ),
    );
  }

  /** One tab per epic's queue, each with a dot for its state (green waits for you, red failed). */
  tabs(t) {
    const all = this.queues();
    if (all.length < 2) return div();
    const items = all.map(x => {
      const st = x.live?.[x.live.length - 1]?.status;
      const c = st ? batchColor(t, st) : x.missing ? t.dim : alpha(t.foreground, 0.3);
      const label = h_flex()
        .gap(7)
        .items_center()
        .child(div().size(7).rounded_full().bg(c))
        .child(x.epic ?? "Queue")
        .when((x.waiting?.length ?? 0) > 0, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(String(x.waiting.length))));
      return { id: x.epic ?? "", label };
    });
    return segmented(t, "queue-tab", items, this.q()?.epic ?? "", (id, cx) => this.pick(id || null, cx));
  }

  /** One sentence about right now, the one action it may need, and today in four numbers. */
  header(t, q) {
    const live = q.live[q.live.length - 1];
    const tn = tone(t);
    const now = this.app.data.now;
    const held = q.waiting.filter(w => w.held).length;
    const ready = q.waiting.length - held;
    let line, color = t.foreground, action = null;
    if (live?.status === "green") {
      const ap = live.approval;
      line = `Batch ${live.n} passed CI and is waiting to be merged.`;
      color = ok(t);
      if (ap)
        action = h_flex()
          .gap(SP.sm)
          .child(btn(t, "queue-approve", "Approve merge", cx => this.app.act(cx, `decide-${ap}`, ["decide", ap, "approve", ""], { done: `Batch ${live.n} approved`, fail: "Couldn't approve" }), { kind: "primary", icon: "check" }))
          .child(btn(t, "queue-review", "Open in Review", cx => this.app.go("review", cx, { id: ap }), { kind: "ghost" }));
    } else if (live?.status === "ci") line = `Batch ${live.n} is testing: ${dur(now - live.created)} in, usually ${q.today.ciMin ? Math.round(q.today.ciMin) : "~20"}m.`;
    else if (live?.status === "trunk-check") line = `Batch ${live.n} is merged. Checking trunk.`;
    else if (live?.status === "red" || live?.status === "error") {
      line = `Batch ${live.n} failed CI${live.failing?.length ? `: ${live.failing.join(", ")}` : ""}.`;
      color = tn.alert;
    } else if (live?.status === "stale") {
      line = `Batch ${live.n} went stale: trunk moved under it. It gets rebuilt.`;
      color = tn.warn;
    } else line = ready ? `${ready} PR${ready === 1 ? "" : "s"} waiting. The next batch starts at 4, or after 20 minutes.` : "Nothing in the queue.";
    const stat = (value, label, tip) =>
      v_flex()
        .id(`queue-stat-${label}`)
        .gap(2)
        .when(!!tip, el => el.tooltip(tip))
        .child(div().text_size(22).font_semibold().text_color(t.foreground).child(value))
        .child(div().text_size(TYPE.meta).text_color(t.muted).child(label));
    const d = q.today;
    return h_flex()
      .gap(SP.xl)
      .items_end()
      .flex_wrap()
      .child(
        v_flex()
          .flex_1()
          .min_w(360)
          .gap(SP.sm)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .child(icon("git-branch", 18, t.muted))
              .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child(q.epic ? `${q.epic} queue` : "Merge queue"))
              .when(!!q.trunk, el => el.child(chip(t, `→ ${q.trunk}`, t.muted, { tooltip: "Trunk: where this queue merges" }))),
          )
          .child(div().text_size(TYPE.body).line_height(1.45).text_color(color).child(line))
          .when(!!action, el => el.child(div().pt(SP.xs).child(action))),
      )
      .child(
        h_flex()
          .gap(28)
          .child(stat(String(d.prs), "PRs landed today"))
          .child(stat(String(d.landed.length), "batches merged", d.failed ? `${d.failed} batch${d.failed === 1 ? "" : "es"} failed or released today` : null))
          .child(stat(d.ciMin ? `${Math.round(d.ciMin)}m` : "–", "CI per batch", "Median over the last 12 batches"))
          .child(stat(d.waitMin ? `${Math.round(d.waitMin)}m` : "–", "READY to trunk", "Median time from a READY line to the merge, today")),
      );
  }

  // ---- the pipeline

  pipeline(t, q) {
    const live = q.live;
    const testing = live.filter(b => BATCH[b.status]?.col === "testing");
    const merging = live.filter(b => BATCH[b.status]?.col === "merging");
    const landed = q.today.landed;
    const col = (id, title, count, body, o = {}) =>
      v_flex()
        .id(`queue-col-${id}`)
        .flex_1()
        .min_w(0)
        .gap(SP.sm)
        .child(
          h_flex()
            .gap(SP.sm)
            .items_center()
            .px(2)
            .child(div().text_size(TYPE.ui).font_semibold().text_color(o.color ?? t.foreground).child(title))
            .child(div().text_size(TYPE.meta).text_color(t.muted).child(count == null ? "" : String(count))),
        )
        .child(v_flex().flex_1().gap(SP.sm).child(body));
    const arrow = () => div().flex_none().pt(26).child(icon("chevron-right", 14, alpha(t.foreground, 0.3)));
    const none = text => div().px(SP.md).py(SP.lg).rounded(10).border(1).border_dashed().border_color(alpha(t.border, 0.7)).text_size(TYPE.ui).text_color(t.dim).child(text);
    return h_flex()
      .gap(SP.sm)
      .items_start()
      .child(col("waiting", "Waiting", q.waiting.length, q.waiting.length ? v_flex().gap(6).children(q.waiting.map(w => this.waitRow(t, w))) : none("No READY PRs")))
      .child(arrow())
      .child(col("testing", "Testing", null, testing.length ? v_flex().gap(SP.sm).children(testing.map(b => this.batchCard(t, q, b))) : none("No batch in CI")))
      .child(arrow())
      .child(col("merging", "Ready to merge", null, merging.length ? v_flex().gap(SP.sm).children(merging.map(b => this.batchCard(t, q, b))) : none("Nothing green yet"), { color: merging.length ? ok(t) : undefined }))
      .child(arrow())
      .child(
        col(
          "landed",
          "Landed today",
          q.today.prs,
          landed.length
            ? v_flex()
                .gap(4)
                .children(landed.slice(0, 6).map(b => this.landedRow(t, b)))
                .when(landed.length > 6, el => el.child(div().px(SP.sm).pt(2).text_size(TYPE.meta).text_color(t.muted).child(`+${landed.length - 6} earlier batches`)))
            : none("Nothing landed yet today"),
        ),
      );
  }

  prLine(t, pr, o = {}) {
    return h_flex()
      .id(`queue-pr-${o.key ?? ""}${pr}`)
      .min_w(0)
      .gap(7)
      .items_center()
      .cursor_pointer()
      .tooltip(`#${pr} ${this.title(pr)}\nClick to open on GitHub`)
      .on_click(() => this.openPr(pr))
      .child(div().flex_none().text_size(TYPE.ui).font_semibold().text_color(o.muted ? t.muted : t.accent).child(`#${pr}`))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).text_color(o.muted ? t.muted : t.foreground).child(this.short(pr) || "…"));
  }

  ownerChip(t, addr) {
    const o = this.owner(addr);
    if (!o) return null;
    return h_flex()
      .flex_none()
      .gap(5)
      .items_center()
      .child(agentMark(t, { id: o.id, kind: o.kind, label: o.label, avatar: true, size: 16 }) ?? div())
      .child(div().text_size(TYPE.meta).text_color(t.muted).child(clip(o.label, 18)));
  }

  waitRow(t, w) {
    const tn = tone(t);
    const now = this.app.data.now;
    return v_flex()
      .px(SP.md)
      .py(10)
      .gap(6)
      .rounded(10)
      .bg(t.raised)
      .border(1)
      .border_color(w.priority ? alpha(t.accent, 0.6) : alpha(t.border, 0.8))
      .when(!!w.held, el => el.opacity(0.7))
      .child(this.prLine(t, w.pr, { key: "w", muted: !!w.held }))
      .child(
        h_flex()
          .gap(SP.sm)
          .items_center()
          .child(this.ownerChip(t, w.owner) ?? div())
          .child(div().flex_1())
          .when(!!w.priority, el => el.child(chip(t, "priority", t.accent)))
          .when(!!w.after, el => el.child(chip(t, `after #${w.after}`, tn.warn, { tooltip: `Lands after #${w.after} merges` })))
          .when(!!w.held, el => el.child(chip(t, "held", tn.warn, { tooltip: w.held })))
          .when(!w.held && !!w.since, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(dur(now - w.since)))),
      );
  }

  /** A batch in flight: its state, CI progress against the usual time, and its PRs in order. */
  batchCard(t, q, b) {
    const tn = tone(t);
    const now = this.app.data.now;
    const color = batchColor(t, b.status);
    const word = BATCH[b.status]?.word ?? b.status;
    const usual = (q.today.ciMin ?? 20) * 60000;
    const elapsed = (b.ciEnd ?? now) - b.created;
    const frac = b.status === "ci" ? Math.min(0.97, elapsed / usual) : 1;
    return v_flex()
      .id(`queue-batch-${b.n}`)
      .p(SP.md)
      .gap(SP.sm)
      .rounded(12)
      .bg(alpha(color, 0.06))
      .border(1)
      .border_color(alpha(color, 0.55))
      .child(
        h_flex()
          .gap(SP.sm)
          .items_center()
          .child(statusGlyph(BATCH[b.status]?.glyph ?? "idle", t, 12, { still: this.app.palette?.open }))
          .child(div().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(`Batch ${b.n}`))
          .child(div().text_size(TYPE.meta).font_medium().text_color(color).child(word))
          .child(div().flex_1())
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(b.status === "ci" ? `${dur(elapsed)} / ~${dur(usual)}` : `CI ${dur(elapsed)}`)),
      )
      .child(div().w_full().h(4).rounded_full().bg(alpha(t.foreground, 0.08)).child(div().h_full().rounded_full().bg(color).w(`${Math.max(3, frac * 100)}%`).when(b.status === "ci" && !this.app.palette?.open, el => el.loop("opacity", { from: 0.55, to: 1, period: 1600 }))))
      .when(!!b.failing?.length, el => el.child(div().text_size(TYPE.meta).text_color(tn.alert).child(`Failing: ${b.failing.join(", ")}${b.reruns ? ` · rerun ${b.reruns}×` : ""}`)))
      .child(
        v_flex()
          .pt(2)
          .gap(6)
          .children(
            b.members.map((m, i) =>
              h_flex()
                .gap(SP.sm)
                .items_center()
                .child(div().flex_none().w(14).text_size(TYPE.meta).text_color(t.dim).child(String(i + 1)))
                .child(div().flex_1().min_w(0).child(this.prLine(t, m.pr, { key: `b${b.n}-` })))
                .when(!!m.parent, e2 => e2.child(chip(t, `on #${m.parent}`, t.muted, { tooltip: "Stacked: rides right after its parent" })))
                .child(this.ownerChip(t, m.owner) ?? div()),
            ),
          ),
      );
  }

  landedRow(t, b) {
    const bad = b.trunk && b.trunk !== "success";
    return h_flex()
      .id(`queue-landed-${b.n}`)
      .px(SP.md)
      .py(8)
      .gap(SP.sm)
      .items_center()
      .rounded(9)
      .hover(s => s.bg(alpha(t.foreground, 0.04)))
      .tooltip(b.members.map(m => `#${m.pr} ${this.title(m.pr)}`).join("\n"))
      .child(icon(bad ? "alert" : "check", 12, bad ? tone(t).alert : ok(t)))
      .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(`Batch ${b.n}`))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).child(b.members.map(m => `#${m.pr}`).join(" ")))
      .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(clock(b.merged)));
  }

  // ---- the last batches as a timeline

  /** One row per batch: a bar for its CI time and, after it, the wait until the merge, on a shared
   *  scale; red and released batches say why in one line. */
  timeline(t, q) {
    const rows = q.recent.slice(0, RECENT);
    if (!rows.length) return div();
    const tn = tone(t);
    const span = b => ((b.merged ?? b.ciEnd ?? b.created) - b.created) || 1;
    const max = Math.max(...rows.map(span));
    return v_flex()
      .gap(SP.sm)
      .child(
        h_flex()
          .gap(SP.sm)
          .items_baseline()
          .px(2)
          .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child("Recent batches"))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(q.throughput ?? ""))
          .child(div().flex_1())
          .child(h_flex().gap(SP.md).text_size(TYPE.meta).text_color(t.muted).child(h_flex().gap(5).items_center().child(div().w(14).h(5).rounded_full().bg(alpha(t.accent, 0.7))).child("CI")).child(h_flex().gap(5).items_center().child(div().w(14).h(5).rounded_full().bg(alpha(ok(t), 0.55))).child("waiting to merge"))),
      )
      .child(
        panel(t)
          .p(SP.sm)
          .gap(2)
          .children(
            rows.map(b => {
              const released = b.status === "released";
              const bad = released || (b.trunk && b.trunk !== "success") || !!b.failing?.length;
              const ci = (b.ciEnd ?? b.created) - b.created;
              const wait = b.merged && b.ciEnd ? b.merged - b.ciEnd : 0;
              return h_flex()
                .id(`queue-row-${b.n}`)
                .px(SP.md)
                .py(9)
                .gap(SP.md)
                .items_center()
                .rounded(8)
                .hover(s => s.bg(alpha(t.foreground, 0.04)))
                .tooltip(b.members.map(m => `#${m.pr} ${this.title(m.pr)}`).join("\n"))
                .child(div().flex_none().w(16).child(icon(released ? "minus" : bad ? "alert" : "check", 12, released ? t.muted : bad ? tn.alert : ok(t))))
                .child(div().flex_none().w(72).text_size(TYPE.ui).font_semibold().text_color(released ? t.muted : t.foreground).child(`Batch ${b.n}`))
                .child(div().flex_none().w(44).text_size(TYPE.meta).text_color(t.muted).child(clock(b.created)))
                .child(
                  h_flex()
                    .flex_none()
                    .w(260)
                    .h(6)
                    .child(div().h_full().rounded_l_full().when(!wait, el => el.rounded_r_full()).bg(released ? alpha(t.foreground, 0.2) : alpha(t.accent, 0.7)).w(`${Math.max(2, (ci / max) * 100)}%`))
                    .when(wait > 0, el => el.child(div().h_full().rounded_r_full().bg(alpha(ok(t), 0.55)).w(`${Math.max(1, (wait / max) * 100)}%`))),
                )
                .child(div().flex_none().w(96).text_size(TYPE.meta).text_color(t.muted).child(released ? "released" : `CI ${dur(ci)}${wait ? ` · +${dur(wait)}` : ""}`))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(TYPE.meta)
                    .text_color(bad && !released ? tn.alert : t.muted)
                    .child(b.failing?.length ? `failed: ${b.failing.join(", ")}` : b.trunk && b.trunk !== "success" ? `trunk ${b.trunk}` : b.members.map(m => `#${m.pr} ${this.short(m.pr, 28)}`).join(" · ")),
                );
            }),
          ),
      );
  }

  // ---- what's held, the rules in force, the last rejections

  rules(t, q) {
    const tn = tone(t);
    const held = q.waiting.filter(w => w.held);
    const r = q.rules;
    const items = [
      ...held.map(w => ({ key: `held-${w.pr}`, pr: w.pr, text: w.held, label: "held" })),
      ...Object.entries(r.after).map(([a, b]) => ({ key: `after-${a}`, pr: Number(a), text: `lands after #${b}`, label: "order" })),
      ...r.apart.map(([a, b]) => ({ key: `apart-${a}-${b}`, pr: a, text: `never in the same batch as #${b}`, label: "apart" })),
      ...q.rejected.slice(0, 3).map(x => ({ key: `rej-${x.pr}`, pr: x.pr, text: x.why, label: "rejected", alert: true })),
    ];
    if (!items.length) return div();
    return v_flex()
      .gap(SP.sm)
      .child(div().px(2).text_size(TYPE.ui).font_semibold().text_color(t.foreground).child("Holds and rules"))
      .child(
        panel(t)
          .p(SP.sm)
          .gap(2)
          .children(
            items.map(it =>
              h_flex()
                .id(`queue-rule-${it.key}`)
                .px(SP.md)
                .py(8)
                .gap(SP.md)
                .items_start()
                .child(div().flex_none().w(72).child(chip(t, it.label, it.alert ? tn.alert : it.label === "held" ? tn.warn : t.muted)))
                .child(div().flex_none().w(260).child(this.prLine(t, it.pr, { key: `r-${it.key}-` })))
                .child(div().flex_1().min_w(0).text_size(TYPE.meta).line_height(1.45).text_color(t.muted).child(it.text)),
            ),
          ),
      );
  }
}
