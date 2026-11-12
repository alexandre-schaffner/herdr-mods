// Memory: explore ~/agent-memory (its files, entries and history) and watch Dreaming, which
// runs on its own (daily, or when the master asks); the person can start one by hand.

import { h_flex, Input, InputState, Scrollbar, TextView, v_flex, v_virtual_list } from "gpui-base";
import { div } from "gpui-kit";

import { openLink } from "./shared/viewer-link.js";
import { ago, alpha, banner, btn, card, chip, clip, dot, empty, facts, frame, icon, lines, loading, mono, ok, row, scrollY, sectionHead, segmented, stamp, tint, tone, toolbar, TYPE } from "./ui.js";

const MAX_DIFF_LINES = 400;
const ENTRY_H = 80;

/** "3 files changed, 12 insertions(+), 4 deletions(-)" → "+12 −4 in 3 files". */
function shortStat(stat) {
  if (!stat) return "";
  const n = re => Number((stat.match(re) ?? [])[1] ?? 0);
  const files = n(/(\d+) files? changed/), add = n(/(\d+) insertions?/), del = n(/(\d+) deletions?/);
  return `+${add} −${del}${files > 1 ? ` in ${files} files` : ""}`;
}
const COMMIT_H = 62;

export class MemoryView {
  constructor(app) {
    this.app = app;
    this.mem = null;
    this.error = null;
    this.loading = false;
    this.tab = "entries";
    this.file = null; // a file's path, or null: every file
    this.sort = "file"; // "file" | "recent"
    this.entryKey = null;
    this.commit = null;
    this.diff = null; // { sha, text } | { sha, error }
    this.dreamTerminal = null;
    this.searching = false;
    this.search = InputState.new({ placeholder: "Search memory…" });
    this.search.on("focus", (_e, cx) => {
      this.searching = true;
      cx.notify();
    });
    this.search.on("blur", (_e, cx) => {
      this.searching = false;
      cx.notify();
    });
    this.search.on("change", (_e, cx) => cx.notify());
  }

  typing() {
    return this.searching;
  }

  onShow(cx) {
    this.load(cx);
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.mem = await this.app.hq(["memory"]);
        this.error = null;
        if (this.tab === "history" && !this.commit && this.mem.log?.length) this.pickCommit(this.mem.log[0].sha, cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  pickCommit(sha, cx) {
    this.commit = sha;
    if (this.diff?.sha === sha) return cx.notify();
    this.diff = { sha, loading: true };
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await this.app.hq(["memory-show", sha]);
        if (this.commit === sha) this.diff = { sha, text: r.text ?? "" };
      } catch (e) {
        if (this.commit === sha) this.diff = { sha, error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  dreamNow(cx) {
    this.app.act(cx, "dream", ["dream"], {
      done: "Dream started",
      fail: "Couldn't start a Dream",
      then: (r, cx) => {
        this.dreamTerminal = r.terminal ?? null;
        this.load(cx);
      },
    });
  }

  // ---- data shaping

  entries() {
    const q = this.search.value().trim().toLowerCase();
    const rows = [];
    for (const f of this.mem?.files ?? []) {
      if (this.file && f.path !== this.file) continue;
      for (const e of f.entries) {
        if (q && !e.text.toLowerCase().includes(q) && !(e.source ?? "").toLowerCase().includes(q)) continue;
        rows.push({ ...e, file: f.name, path: f.path, key: `${f.name}:${e.line}` });
      }
    }
    if (this.sort === "recent") rows.sort((a, b) => (b.updated ?? b.added ?? "").localeCompare(a.updated ?? a.added ?? ""));
    return rows;
  }

  onKey(e, cx) {
    if (e.key !== "j" && e.key !== "k") return false;
    const step = e.key === "j" ? 1 : -1;
    if (this.tab === "entries") {
      const rows = this.entries();
      if (!rows.length) return true;
      const i = rows.findIndex(r => r.key === this.entryKey);
      this.entryKey = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + step))].key;
    } else {
      const log = this.mem?.log ?? [];
      if (!log.length) return true;
      const i = log.findIndex(c => c.sha === this.commit);
      this.pickCommit(log[Math.max(0, Math.min(log.length - 1, i < 0 ? 0 : i + step))].sha, cx);
    }
    cx.notify();
    return true;
  }

  // ---- drawing

  render(t, cx) {
    if (!this.mem)
      return this.error
        ? empty(t, "Couldn't read memory", this.error, { icon: "brain", action: btn(t, "mem-retry", "Retry", cx => this.load(cx)) })
        : loading(t, "Reading ~/agent-memory…");
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.side(t))
      .child(v_flex().flex_1().min_w(0).min_h(0).child(this.toolbar(t)).child(this.tab === "entries" ? this.entryPane(t) : this.historyPane(t)));
  }

  side(t) {
    const files = this.mem.files ?? [];
    const total = files.reduce((n, f) => n + f.entries.length, 0);
    const fileRow = (id, name, count, bytes, on, onClick) =>
      h_flex()
        .id(id)
        .h(30)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, el => el.bg(tint(t).on))
        .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
        .on_click((_e, cx) => {
          onClick();
          this.tab = "entries";
          cx.notify();
        })
        .child(icon(name ? "file-md" : "layers", 13, on ? t.accent : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.muted).child(name || "All files"))
        .child(div().text_size(10.5).font_family(mono()).text_color(t.muted).child(`${count}${bytes != null ? ` · ${Math.round(bytes / 1024)}k` : ""}`));
    return v_flex()
      .flex_none()
      .w(264)
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(
        v_flex()
          .p(10)
          .gap(8)
          .child(frame(t, Input.new(this.search), this.searching))
          .child(
            v_flex()
              .gap(1)
              .child(fileRow("mem-all", null, total, null, !this.file, () => (this.file = null)))
              .children(files.map(f => fileRow(`mem-f-${f.name}`, f.name, f.entries.length, f.bytes, this.file === f.path, () => (this.file = f.path)))),
          ),
      )
      .child(div().flex_1())
      .child(this.dreamCard(t));
  }

  dreamCard(t) {
    const d = this.mem.dream ?? {};
    const running = !!d.running;
    const why = running ? "A Dream is already running" : d.dirty ? "~/agent-memory has uncommitted edits; a Dream would skip" : null;
    const last = d.lastCommit;
    return v_flex()
      .m(10)
      .child(
        card(t, { gap: 7, p: 11 })
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(icon("sparkles", 13, running ? t.working : t.accent))
              .child(div().text_size(12.5).font_semibold().child("Dreaming"))
              .child(div().flex_1())
              .child(running ? h_flex().gap(5).items_center().child(dot(t.working, 7, true)).child(div().text_size(11).text_color(t.working).child("running")) : div()),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .line_height(1.45)
              .child(last ? `Last Dream ${ago(last.at)}: ${clip(last.subject.replace(/^Dream:\s*/, ""), 110)}` : "No Dream commit yet."),
          )
          .child(
            h_flex()
              .gap(6)
              .flex_wrap()
              .child(chip(t, d.commitsSince ? `${d.commitsSince} memory commit${d.commitsSince === 1 ? "" : "s"} since` : "Nothing new since", d.commitsSince >= 10 ? tone(t).warn : t.muted))
              .when(!!d.dirty, el => el.child(chip(t, "uncommitted edits", t.blocked)))
              .when((d.pending ?? []).length > 0, el => el.child(chip(t, `${d.pending.length} pending patch`, t.blocked))),
          )
          .child(div().text_size(11).line_height(1.45).text_color(t.muted).child(`Automatic: ${d.schedule ?? "daily"}, and whenever the master sees memory pile up. Nothing for you to approve.`))
          .children(
            (d.pending ?? []).map((p, i) =>
              h_flex()
                .id(`mem-pending-${i}`)
                .gap(5)
                .items_center()
                .cursor_pointer()
                .on_click(() => openLink(p))
                .child(icon("file-text", 11, t.blocked))
                .child(div().text_size(10.5).truncate().text_color(t.blocked).child(p.split("/").pop())),
            ),
          )
          .child(
            h_flex()
              .gap(6)
              .pt(2)
              .child(
                btn(t, "mem-dream", this.app.isBusy("dream") ? "Starting…" : "Dream now", cx => this.dreamNow(cx), {
                  size: "sm",
                  kind: "primary",
                  icon: "sparkles",
                  disabled: !!why || this.app.isBusy("dream"),
                  tooltip: why ?? "Consolidate memory now: merge duplicates, drop outdated entries, save patterns",
                }),
              )
              .when(!!this.dreamTerminal, el =>
                el.child(btn(t, "mem-watch", "Watch", () => this.app.peek(this.dreamTerminal), { size: "sm", icon: "eye", tooltip: `Peek at ${this.dreamTerminal}` })),
              ),
          ),
      );
  }

  toolbar(t) {
    const tabs = [
      { id: "e", label: "Entries" },
      { id: "h", label: "History" },
    ];
    const sorts = [
      { id: "f", label: "By file" },
      { id: "r", label: "Recent first" },
    ];
    return toolbar(t, [
      segmented(t, "mem-tab", tabs, this.tab === "entries" ? "e" : "h", (id, cx) => {
        this.tab = id === "e" ? "entries" : "history";
        if (this.tab === "history" && !this.commit && this.mem.log?.length) this.pickCommit(this.mem.log[0].sha, cx);
        cx.notify();
      }),
      ...(this.tab === "entries"
        ? [
            segmented(t, "mem-sort", sorts, this.sort === "file" ? "f" : "r", (id, cx) => {
              this.sort = id === "f" ? "file" : "recent";
              cx.notify();
            }),
          ]
        : []),
      div().flex_1(),
      div().text_size(TYPE.meta).text_color(t.muted).child((this.mem.root ?? "~/agent-memory").replace(/^\/Users\/[^/]+/, "~")),
      btn(t, "mem-refresh", "", cx => this.load(cx), { size: "sm", kind: "ghost", icon: "repeat", tooltip: "Reload", disabled: this.loading }),
    ]);
  }

  entryPane(t) {
    const rows = this.entries();
    if (!rows.length)
      return empty(t, this.search.value().trim() ? "Nothing matches" : "No entries", this.search.value().trim() ? "Try fewer words." : null, { icon: "search" });
    const sel = rows.find(r => r.key === this.entryKey) ?? rows[0];
    const showFile = !this.file;
    // Two lines of text per row: clip the string to what two lines of this width hold.
    const perLine = Math.max(40, Math.floor(((this.listW ?? 560) - 32) / 6.9));
    const list = v_virtual_list("mem-entries", rows.length, ENTRY_H, i => rows[i].key, range =>
      rows.slice(range.start, range.end).map(r => {
        const on = r.key === sel?.key;
        const meta = [showFile ? r.file : null, r.updated ? `updated ${r.updated}` : r.added ? `added ${r.added}` : null, r.source ? `from ${r.source}` : null]
          .filter(Boolean)
          .join("  ·  ");
        return v_flex()
          .h(ENTRY_H)
          .px(16)
          .py(10)
          .gap(4)
          .overflow_hidden()
          .border_b(1)
          .border_color(alpha(t.border, 0.5))
          .cursor_pointer()
          .when(on, el => el.bg(tint(t).on))
          .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
          .child(lines(r.text, 12.5, 2, perLine - 2, 1.4).h(36).text_color(t.foreground))
          .child(div().truncate().text_size(11).text_color(r.updated ? t.accent : t.muted).child(meta || " "));
      }),
    )
      .on_item_click((key, cx) => {
        this.entryKey = key;
        cx.notify();
      })
      .size_full();
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(
        v_flex()
          .id("mem-list-box")
          .flex_1()
          .min_w(320)
          .min_h(0)
          .on_size_change((size, cx) => {
            if (Math.abs((this.listW ?? 0) - size.width) > 8) {
              this.listW = size.width;
              cx.notify();
            }
          })
          .child(div().px(16).py(8).border_b(1).border_color(t.border).child(sectionHead(t, { title: "Entries", count: rows.length })))
          .child(v_flex().relative().flex_1().min_h(0).child(list).child(Scrollbar.vertical("mem-entries").mode("always").absolute().inset_0())),
      )
      .child(v_flex().flex_none().w(460).min_w(0).min_h(0).border_l(1).border_color(t.border).bg(t.background).child(this.entryDetail(t, sel)));
  }

  entryDetail(t, r) {
    return scrollY(
      `mem-entry-${r.key}`,
      v_flex()
        .px(24)
        .py(20)
        .gap(16)
        .child(div().text_size(14).line_height(1.6).text_color(t.foreground).child(TextView.markdown(`mem-md-${r.key}`, r.text).selectable(true)))
        .child(div().h(1).bg(alpha(t.border, 0.7)))
        .child(
          facts(t, [
            ["File", `${r.file}, line ${r.line}`],
            ["Added", r.added],
            ["Updated", r.updated],
            ["Learned from", r.source],
          ]),
        )
        .child(h_flex().child(btn(t, "mem-open", "Open the file", () => openLink(r.path), { size: "sm", icon: "external", tooltip: r.path }))),
    );
  }

  historyPane(t) {
    const log = this.mem.log ?? [];
    if (!log.length) return empty(t, "No history", null, { icon: "clock" });
    const c = log.find(x => x.sha === this.commit);
    const list = v_virtual_list("mem-log", log.length, COMMIT_H, i => log[i].sha, range =>
      log.slice(range.start, range.end).map(x => {
        const on = x.sha === this.commit;
        return v_flex()
          .h(COMMIT_H)
          .px(14)
          .py(9)
          .gap(4)
          .overflow_hidden()
          .border_b(1)
          .border_color(alpha(t.border, 0.5))
          .cursor_pointer()
          .when(on, el => el.bg(tint(t).on))
          .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .items_start()
              .when(x.dream, el => el.child(div().pt(2).child(icon("sparkles", 11, t.accent))))
              .child(lines(x.subject, 12.5, 1, 52).flex_1().text_color(t.foreground)),
          )
          .child(div().truncate().text_size(11).text_color(t.muted).child([ago(x.at), shortStat(x.stat), x.sha.slice(0, 7)].filter(Boolean).join("  ·  ")));
      }),
    )
      .on_item_click((sha, cx) => this.pickCommit(sha, cx))
      .size_full();
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(
        v_flex()
          .flex_none()
          .w(380)
          .min_h(0)
          .relative()
          .border_r(1)
          .border_color(t.border)
          .child(list)
          .child(Scrollbar.vertical("mem-log").mode("always").absolute().inset_0()),
      )
      .child(v_flex().flex_1().min_w(0).min_h(0).child(c ? this.commitPane(t, c) : empty(t, "Pick a commit", null, { icon: "clock" })));
  }

  commitPane(t, c) {
    const head = v_flex()
      .p(14)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(c.dream, el => el.child(chip(t, "Dream", t.accent, { icon: "sparkles" })))
          .child(div().flex_1().min_w(0).text_size(13).font_semibold().child(c.subject)),
      )
      .child(
        h_flex()
          .gap(10)
          .text_size(TYPE.meta)
          .text_color(t.muted)
          .child(div().font_family(mono()).child(c.sha.slice(0, 10)))
          .child(div().child(stamp(c.at)))
          .child(div().child(c.stat ?? "")),
      );
    const d = this.diff?.sha === c.sha ? this.diff : null;
    let body;
    if (!d || d.loading) body = loading(t, "Loading the change…");
    else if (d.error) body = banner(t, { tone: t.blocked, text: d.error });
    else body = scrollY(`mem-diff-${c.sha}`, this.diffView(t, d.text));
    return v_flex().flex_1().min_h(0).child(head).child(body);
  }

  /** `git show --word-diff=plain`, drawn as the file headers, hunk markers and the lines
   * that changed: removed words struck through, added words in bold. */
  diffView(t, text) {
    const lines = (text ?? "").split("\n");
    const start = lines.findIndex(l => l.startsWith("diff --git"));
    const message = (start < 0 ? lines : lines.slice(0, start)).slice(3).join("\n").trim();
    const out = [];
    let n = 0;
    let truncated = false;
    for (const line of start < 0 ? [] : lines.slice(start)) {
      if (line.startsWith("diff --git")) {
        const name = line.replace(/^diff --git a\/(\S+).*$/, "$1");
        out.push(h_flex().pt(out.length ? 14 : 0).pb(2).gap(6).items_center().child(icon("file-md", 12, t.muted)).child(div().text_size(12).font_semibold().child(name)));
        continue;
      }
      if (!/\[-|\{\+/.test(line)) continue;
      if (++n > MAX_DIFF_LINES) {
        truncated = true;
        break;
      }
      const removedOnly = /^\[-[\s\S]*-\]$/.test(line);
      const addedOnly = /^\{\+[\s\S]*\+\}$/.test(line);
      const md = line
        .replace(/\[-([\s\S]*?)-\]/g, (_m, x) => (x.trim() ? `~~${x.trim()}~~ ` : ""))
        .replace(/\{\+([\s\S]*?)\+\}/g, (_m, x) => (x.trim() ? `**${x.trim()}** ` : ""));
      const tone = removedOnly ? t.blocked : addedOnly ? ok(t) : t.accent;
      out.push(
        h_flex()
          .gap(8)
          .py(5)
          .px(9)
          .rounded(6)
          .bg(alpha(tone, 0.07))
          .border_l(2)
          .border_color(tone)
          .child(div().flex_none().w(10).text_size(12).font_family(mono()).text_color(tone).child(removedOnly ? "−" : addedOnly ? "+" : "~"))
          .child(div().flex_1().min_w(0).text_size(12).child(TextView.markdown(`mem-diff-${n}`, md).selectable(true))),
      );
    }
    return v_flex()
      .p(14)
      .gap(4)
      .when(!!message, el => el.child(div().pb(10).text_size(12).text_color(t.muted).child(TextView.markdown("mem-commit-msg", message).selectable(true))))
      .children(out)
      .when(truncated, el => el.child(div().pt(8).text_size(TYPE.meta).text_color(t.muted).child(`Only the first ${MAX_DIFF_LINES} changed lines are drawn.`)))
      .when(!out.length, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child("No line changes.")));
  }
}
