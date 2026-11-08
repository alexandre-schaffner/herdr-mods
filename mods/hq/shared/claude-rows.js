// Generated from shared/js/claude-rows.js by shared/sync.sh: edit it there.

// How each row of a Claude chat looks. `ctx` carries the live facts (results, running tool) and the
// handlers rows call: ctx.isOpen(key, byDefault), ctx.toggle(key, cx), ctx.copy(text, cx).

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { family, toolName, toolLine, groupLine, fmtDuration, fmtTime, shortPath } from "./claude-model.js";
import { openLink, openViewer, viewable } from "./viewer-link.js";
import { alpha, dark, ICON, icon, mix, mono, ok } from "./look.js";

export { alpha, ICON, icon, mix, mono };

export const COLUMN = 860;
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Claude's orange, kept recognisable on any theme. */
export const claudeColor = () => (dark() ? "#d97757" : "#c15f3c");

const FAMILY = {
  shell: { icon: "terminal", color: (t) => t.ansi2 ?? t.accent },
  read: { icon: "file-text", color: (t) => t.ansi4 ?? t.accent },
  edit: { icon: "square-pen", color: (t) => t.ansi3 ?? t.accent },
  search: { icon: "search", color: (t) => t.ansi6 ?? t.accent },
  web: { icon: "eye", color: (t) => t.ansi6 ?? t.accent },
  agent: { icon: "sparkles", color: (t) => t.ansi5 ?? t.accent },
  todo: { icon: "list", color: (t) => t.ansi5 ?? t.accent },
  skill: { icon: "bolt", color: (t) => t.ansi3 ?? t.accent },
  tool: { icon: "wrench", color: (t) => t.muted },
};
const famLook = (name, t) => {
  const f = FAMILY[family(name)];
  return { icon: f.icon, color: f.color(t) };
};

const lines = (text, max) => {
  const all = String(text ?? "").replace(/\t/g, "  ").replace(/\s+$/, "").split("\n");
  if (all.length <= max) return all.join("\n");
  return all.slice(0, max).join("\n") + `\n… ${all.length - max} more lines`;
};
const countLines = (s) => (s ? String(s).replace(/\s+$/, "").split("\n").length : 0);

/** Centers a row's content in the reading column. */
export function column(content, o = {}) {
  return div()
    .w_full()
    .flex()
    .justify_center()
    .pt(o.pt ?? 0)
    .pb(o.pb ?? 0)
    .child(div().w_full().max_w(COLUMN).px(28).child(content));
}

function avatar(t, kind) {
  const box = div().flex_none().w(22).h(22).rounded(7).flex().items_center().justify_center();
  if (kind === "claude") return box.bg(alpha(claudeColor(), 0.16)).child(image("icons/claude.svg").w(13).h(13));
  return box.bg(alpha(t.accent, 0.18)).child(icon("user", 12, t.accent));
}

function who(t, kind, label, ts, extra) {
  return h_flex()
    .gap(9)
    .items_center()
    .child(avatar(t, kind))
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(label))
    .child(div().text_size(11).text_color(t.dim).child(fmtTime(ts)))
    .when(!!extra, (el) => el.child(extra));
}

function badge(t, label, color) {
  return div().flex_none().px(6).py(1).rounded(5).text_size(10.5).bg(alpha(color, 0.13)).text_color(color).child(label);
}

function markdown(id, text, t, size = 13.5, cwd = null) {
  return div()
    .w_full()
    .text_size(size)
    .line_height(1.65)
    .text_color(t.foreground)
    .child(TextView.markdown(id, text).on_link_click((url) => openLink(url, cwd)));
}

/** Images from the transcript as chips; each opens the viewer, stepping through all of them. */
function imageChips(t, id, files) {
  return h_flex()
    .flex_wrap()
    .gap(6)
    .children(
      files.map((f, k) =>
        h_flex()
          .id(`${id}-${k}`)
          .h(26)
          .px(9)
          .gap(6)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .bg(alpha(t.foreground, 0.05))
          .border(1)
          .border_color(alpha(t.border, 0.9))
          .hover((s) => s.bg(alpha(t.accent, 0.1)).border_color(alpha(t.accent, 0.5)))
          .tooltip("Open in the viewer")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openViewer(f, files);
          })
          .child(icon("image", 12, t.accent))
          .child(div().text_size(11.5).text_color(t.foreground).child(files.length > 1 ? `Image ${k + 1}` : "Image")),
      ),
    );
}

/** The file a read or edit step is about, when the viewer can show it. */
const viewableFile = (e) => {
  const fam = family(e.name);
  const f = (fam === "read" || fam === "edit") && e.input?.file_path;
  return viewable(f) ? f : null;
};

// ─── tool bodies ─────────────────────────────────────────────────────────

const well = (t) => mix(t.background, t.foreground, dark() ? 0.045 : 0.035);

function codeBox(t, text, o = {}) {
  return div()
    .w_full()
    .px(12)
    .py(9)
    .rounded(8)
    .bg(o.bg ?? well(t))
    .font_family(mono())
    .text_size(11.5)
    .line_height(1.6)
    .text_color(o.color ?? t.muted)
    .child(lines(text, o.max ?? 40) || " ");
}

function errorBox(t, text) {
  return codeBox(t, text, { color: t.blocked, bg: alpha(t.blocked, 0.08), max: 20 });
}

function terminalBox(t, command, output, error) {
  return v_flex()
    .w_full()
    .rounded(8)
    .overflow_hidden()
    .bg(well(t))
    .font_family(mono())
    .text_size(11.5)
    .line_height(1.6)
    .child(
      h_flex()
        .px(12)
        .pt(9)
        .pb(output ? 7 : 9)
        .gap(8)
        .items_start()
        .child(div().flex_none().text_color(t.ansi2 ?? ok(t)).child("$"))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(lines(command, 12))),
    )
    .when(!!output, (el) =>
      el.child(
        div()
          .px(12)
          .py(8)
          .border_t(1)
          .border_color(alpha(t.border, 0.5))
          .text_color(error ? t.blocked : t.muted)
          .child(lines(output, 30)),
      ),
    );
}

function diffBox(t, edits) {
  const rows = [];
  edits.forEach((e, k) => {
    if (k) rows.push(div().h(1).my(4).bg(alpha(t.border, 0.6)));
    const old = String(e.old_string ?? "").split("\n");
    const neu = String(e.new_string ?? "").split("\n");
    if (e.old_string) for (const line of old.slice(0, 30)) rows.push(diffLine(t, "−", line, t.blocked));
    if (old.length > 30) rows.push(diffLine(t, " ", `… ${old.length - 30} more`, t.dim));
    for (const line of neu.slice(0, 30)) rows.push(diffLine(t, "+", line, ok(t)));
    if (neu.length > 30) rows.push(diffLine(t, " ", `… ${neu.length - 30} more`, t.dim));
  });
  return v_flex().w_full().py(6).rounded(8).overflow_hidden().bg(well(t)).children(rows);
}

function diffLine(t, sign, text, c) {
  const plain = sign === " ";
  return h_flex()
    .px(4)
    .bg(plain ? alpha(c, 0) : alpha(c, dark() ? 0.1 : 0.08))
    .font_family(mono())
    .text_size(11.5)
    .line_height(1.6)
    .child(div().flex_none().w(22).text_center().text_color(alpha(c, 0.9)).child(sign))
    .child(div().flex_1().min_w(0).pr(8).text_color(plain ? t.dim : t.foreground).child(text || " "));
}

/** Read's output is `   12→text`: keep the numbers, dimmed, in a gutter. */
function fileBox(t, text) {
  const rows = String(text ?? "").replace(/\s+$/, "").split("\n");
  const shown = rows.slice(0, 30).map((l) => {
    const m = l.match(/^\s*(\d+)[→\t](.*)$/);
    return h_flex()
      .font_family(mono())
      .text_size(11.5)
      .line_height(1.6)
      .child(div().flex_none().w(40).pr(10).text_right().text_color(alpha(t.dim, 0.7)).child(m ? m[1] : ""))
      .child(div().flex_1().min_w(0).text_color(t.muted).child((m ? m[2] : l) || " "));
  });
  if (rows.length > 30) shown.push(div().pl(40).text_size(11).text_color(t.dim).child(`… ${rows.length - 30} more lines`));
  return v_flex().w_full().py(8).pr(10).rounded(8).bg(well(t)).children(shown);
}

function toolBody(t, e, res, ctx) {
  const detail = toolDetail(t, e, res, ctx);
  if (!res?.files?.length) return detail;
  return v_flex().gap(8).child(detail).child(imageChips(t, `res-img-${e.id}`, res.files));
}

function toolDetail(t, e, res, ctx) {
  const i = e.input ?? {};
  const fam = family(e.name);
  if (fam === "shell" && i.command != null) return terminalBox(t, i.command, res?.text, res?.err);
  const parts = [];
  if (fam === "edit") {
    if (i.edits) parts.push(diffBox(t, i.edits));
    else if (i.old_string != null || i.new_string != null) parts.push(diffBox(t, [i]));
    else if (i.content != null) parts.push(diffBox(t, [{ new_string: i.content }]));
    if (res?.err) parts.push(errorBox(t, res.text));
    return v_flex().gap(6).children(parts);
  }
  if (fam === "read") {
    if (!res) return codeBox(t, "Reading…");
    if (res.err) return errorBox(t, res.text);
    return res.files?.length && !res.text?.trim() ? div() : fileBox(t, res.text);
  }
  if (fam === "agent") {
    if (i.prompt) parts.push(codeBox(t, i.prompt, { max: 14 }));
    if (res)
      parts.push(
        res.err
          ? errorBox(t, res.text)
          : div().pl(12).border_l(2).border_color(alpha(t.ansi5 ?? t.accent, 0.5)).child(markdown(`ag-${e.id}`, lines(res.text, 80), t, 12.5, ctx.cwd)),
      );
    return v_flex().gap(8).children(parts);
  }
  if (fam === "todo" && Array.isArray(i.todos)) {
    return v_flex().gap(4).px(4).children(
      i.todos.map((x) => {
        const done = x.status === "completed";
        const now = x.status === "in_progress";
        return h_flex()
          .gap(9)
          .items_center()
          .child(
            done
              ? div().flex_none().w(14).h(14).rounded_full().bg(alpha(ok(t), 0.18)).flex().items_center().justify_center().child(icon("check", 9, ok(t)))
              : div().flex_none().w(14).h(14).rounded_full().border(now ? 2 : 1).border_color(now ? t.working : t.dim),
          )
          .child(div().text_size(12.5).text_color(done ? t.dim : now ? t.foreground : t.muted).when(done, (d) => d.line_through()).child(x.content ?? x.subject ?? ""));
      }),
    );
  }
  const args = Object.entries(i).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (args.length) parts.push(codeBox(t, args.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"), { max: 14, color: t.foreground }));
  if (res) parts.push(res.err ? errorBox(t, res.text) : codeBox(t, res.text || "(no output)", { max: 30 }));
  return v_flex().gap(6).children(parts);
}

// ─── steps: one line per tool call ───────────────────────────────────────

const VERB = {
  Bash: "Ran", BashOutput: "Checked", KillShell: "Stopped", Monitor: "Watched",
  Read: "Read", NotebookRead: "Read", Edit: "Edited", MultiEdit: "Edited", Write: "Wrote", NotebookEdit: "Edited",
  Grep: "Searched", Glob: "Listed", ToolSearch: "Loaded", WebFetch: "Fetched", WebSearch: "Searched the web",
  Agent: "Agent", Task: "Agent", SendMessage: "Messaged", TodoWrite: "Todos", Skill: "Skill",
};

/** What a step's line says: the verb, its object, whether the object is code, and a stat. */
function describe(e, res, ctx) {
  const i = e.input ?? {};
  const fam = family(e.name);
  const out = { verb: VERB[e.name] ?? toolName(e.name), main: toolLine(e.name, i, ctx.cwd), code: true, sub: null, stat: null, statColor: null };
  if (fam === "shell") {
    if (i.description && i.command) {
      out.main = i.description;
      out.code = false;
      out.sub = String(i.command).split("\n")[0];
    }
    if (res?.err) {
      const m = String(res.text).match(/Exit code (\d+)/);
      out.stat = m ? `exit ${m[1]}` : "failed";
    } else if (res?.text) out.stat = `${countLines(res.text)} lines`;
  } else if (fam === "edit") {
    const pairs = i.edits ?? [i];
    let add = 0;
    let del = 0;
    for (const p of pairs) {
      if (p.content != null) add += countLines(p.content);
      else {
        add += countLines(p.new_string);
        del += countLines(p.old_string);
      }
    }
    out.stat = [add ? `+${add}` : null, del ? `−${del}` : null].filter(Boolean);
  } else if (fam === "read") {
    if (res && !res.err) out.stat = res.files?.length && !res.text?.trim() ? "image" : `${countLines(res.text)} lines`;
  } else if (fam === "search" && e.name !== "ToolSearch") {
    out.main = i.pattern ?? out.main;
    out.sub = i.path ? shortPath(i.path, ctx.cwd) : i.glob ?? null;
    if (res && !res.err) {
      const n = /^No (matches|files) found/i.test(res.text.trim()) ? 0 : countLines(res.text);
      out.stat = n ? `${n} result${n === 1 ? "" : "s"}` : "none";
    }
  } else if (fam === "agent") {
    out.code = false;
    out.stat = i.subagent_type ?? null;
  } else if (fam === "todo") {
    out.code = false;
    if (Array.isArray(i.todos)) {
      const done = i.todos.filter((x) => x.status === "completed").length;
      out.main = `${done} of ${i.todos.length} done`;
    }
  } else if (fam === "web") {
    out.code = e.name === "WebFetch";
  }
  if (res?.err && !out.stat) out.stat = "failed";
  return out;
}

function tile(t, iconName, color, size = 22) {
  return div()
    .flex_none()
    .w(size)
    .h(size)
    .rounded(6)
    .bg(alpha(color, dark() ? 0.15 : 0.12))
    .flex()
    .items_center()
    .justify_center()
    .child(icon(iconName, Math.round(size * 0.55), color));
}

function stepRow(t, e, res, ctx, o) {
  const key = `t:${e.id}`;
  const open = ctx.isOpen(key, ctx.mode === "verbose");
  const running = !res && ctx.running && e.id === ctx.lastTool;
  const failed = !!res?.err;
  const look = famLook(e.name, t);
  const d = describe(e, res, ctx);
  const file = viewableFile(e);
  const color = failed ? t.blocked : look.color;
  let stat = null;
  if (running) stat = svg(ICON("spinner")).w(12).h(12).flex_none().text_color(t.working).spin(900);
  else if (Array.isArray(d.stat))
    stat = h_flex().flex_none().gap(5).font_family(mono()).text_size(11)
      .children(d.stat.map((s) => div().text_color(s[0] === "+" ? ok(t) : t.blocked).child(s)));
  else if (d.stat) stat = div().flex_none().font_family(mono()).text_size(11).text_color(failed ? t.blocked : t.dim).child(d.stat);

  const line = h_flex()
    .id(`step-${e.id}`)
    .h(36)
    .pl(10)
    .pr(12)
    .gap(10)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(alpha(t.foreground, 0.035)))
    .on_click((_e, cx) => ctx.toggle(key, cx))
    .on_mouse_down("right", (_e, cx) => ctx.copy(e.input?.command ?? toolLine(e.name, e.input, ctx.cwd), cx))
    .child(tile(t, look.icon, color))
    .child(div().flex_none().text_size(12.5).font_medium().text_color(failed ? t.blocked : t.foreground).child(d.verb))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(8)
        .items_center()
        .child(
          div()
            .min_w(0)
            .truncate()
            .text_size(d.code ? 12 : 12.5)
            .when(d.code, (x) => x.font_family(mono()))
            .text_color(t.muted)
            .when(running, (x) => x.loop("opacity", { from: 0.45, to: 1, period: 1100 }))
            .child(d.main || ""),
        )
        .when(!!d.sub, (x) => x.child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(alpha(t.dim, 0.85)).child(d.sub))),
    )
    .when(!!stat, (x) => x.child(stat))
    .when(!!file, (x) => x.child(viewButton(t, `view-${e.id}`, file)))
    .child(icon(open ? "chevron-down" : "chevron-right", 11, alpha(t.dim, 0.8)));

  return v_flex()
    .w_full()
    .when(!o.first, (x) => x.border_t(1).border_color(alpha(t.border, 0.45)))
    .child(line)
    .when(open, (x) => x.child(div().pl(42).pr(12).pb(12).child(toolBody(t, e, res, ctx))));
}

function viewButton(t, id, file) {
  return div()
    .id(id)
    .flex_none()
    .w(22)
    .h(22)
    .rounded(6)
    .flex()
    .items_center()
    .justify_center()
    .cursor_pointer()
    .hover((s) => s.bg(alpha(t.accent, 0.14)))
    .tooltip("Open in the viewer")
    .on_click((_e, cx) => {
      cx.stop_propagation();
      openViewer(file);
    })
    .child(icon("eye", 12, t.accent));
}

function thoughtRow(t, e, ctx, o) {
  const key = `k:${e.id}`;
  const open = ctx.isOpen(key, ctx.mode === "verbose");
  return v_flex()
    .w_full()
    .when(!o.first, (x) => x.border_t(1).border_color(alpha(t.border, 0.45)))
    .child(
      h_flex()
        .id(`think-${e.id}`)
        .h(36)
        .pl(10)
        .pr(12)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .hover((s) => s.bg(alpha(t.foreground, 0.035)))
        .on_click((_e, cx) => ctx.toggle(key, cx))
        .child(tile(t, "brain", t.dim))
        .child(div().flex_none().text_size(12.5).font_medium().text_color(t.muted).child("Thought"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).italic().text_color(t.dim).child(String(e.text).split("\n")[0]))
        .child(icon(open ? "chevron-down" : "chevron-right", 11, alpha(t.dim, 0.8))),
    )
    .when(open, (x) => x.child(div().pl(42).pr(14).pb(12).text_size(12.5).italic().line_height(1.6).text_color(t.muted).child(lines(e.text, 200))));
}

/** A burst of tool calls: one card. Several calls get a header that folds them. */
export function groupRow(t, row, ctx) {
  const tools = row.tools;
  const errors = tools.filter((x) => ctx.results.get(x.id)?.err).length;
  const running = ctx.running && tools.some((x) => x.id === ctx.lastTool && !ctx.results.has(x.id));
  const single = row.items.length === 1;
  const open = single || ctx.isOpen(row.key, ctx.mode === "verbose" || running || !!ctx.query);

  const card = v_flex()
    .w_full()
    .rounded(10)
    .overflow_hidden()
    .border(1)
    .border_color(alpha(errors ? t.blocked : t.border, errors ? 0.35 : 0.75))
    .bg(mix(t.background, t.foreground, dark() ? 0.018 : 0.012));

  if (!single) {
    const fams = [];
    for (const x of tools) {
      const f = famLook(x.name, t);
      if (!fams.some((y) => y.icon === f.icon)) fams.push(f);
    }
    const summary = tools.length ? groupLine(tools) : "Thought";
    card.child(
      h_flex()
        .id(`grp-${row.key}`)
        .h(38)
        .pl(10)
        .pr(12)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .hover((s) => s.bg(alpha(t.foreground, 0.03)))
        .on_click((_e, cx) => ctx.toggle(row.key, cx))
        .on_mouse_down("right", (_e, cx) => ctx.copy(ctx.rowText(row), cx))
        .child(h_flex().flex_none().gap(3).children(fams.slice(0, 4).map((f) => tile(t, f.icon, f.color, 20))))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(summary))
        .when(errors > 0, (x) => x.child(badge(t, `${errors} failed`, t.blocked)))
        .child(
          running
            ? svg(ICON("spinner")).w(12).h(12).flex_none().text_color(t.working).spin(900)
            : div().flex_none().text_size(11).font_family(mono()).text_color(t.dim).child(`${row.items.length}`),
        )
        .child(icon(open ? "chevron-down" : "chevron-right", 11, alpha(t.dim, 0.8))),
    );
  }
  if (open) {
    card.children(
      row.items.map((e, k) => {
        const o = { first: single && k === 0 };
        return e.k === "think" ? thoughtRow(t, e, ctx, o) : stepRow(t, e, ctx.results.get(e.id), ctx, o);
      }),
    );
  }
  return column(div().pl(31).child(card), { pt: 6, pb: 6 });
}

// ─── messages ────────────────────────────────────────────────────────────

export function promptRow(t, row, ctx) {
  const e = row.ev;
  // A message another terminal sent with `hc send` arrives wrapped in <hc from="t7">…</hc>:
  // show who sent it instead of "You", and only what it said.
  const relayed = /^\s*<hc from="([^"]+)">([\s\S]*?)(?:<\/hc>)?\s*$/.exec(e.text ?? "");
  const text = relayed ? relayed[2].trim() : e.text;
  const files = e.files ?? [];
  const badges = [];
  // Relayed messages always land mid-turn; the badge only means something on the person's own.
  if (e.queued && !relayed) badges.push(badge(t, "queued", t.muted));
  if (e.images && !files.length) badges.push(badge(t, `${e.images} image${e.images > 1 ? "s" : ""}`, t.muted));
  if (relayed) {
    // Another agent reporting in: a quiet block, sender first, so it reads as a note in the log.
    return column(
      v_flex()
        .id(`prompt-${row.key}`)
        .w_full()
        .gap(5)
        .px(12)
        .py(9)
        .rounded(8)
        .bg(alpha(t.foreground, 0.035))
        .on_mouse_down("right", (_e, cx) => ctx.copy(text, cx))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(icon("arrow-left", 11, t.muted))
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child(relayed[1]))
            .child(div().text_size(11).text_color(t.dim).child(fmtTime(e.ts))),
        )
        .when(!!text, (el) => el.child(div().pl(18).text_size(13).line_height(1.55).text_color(t.foreground).child(text))),
      { pt: row.turn === 1 ? 14 : 18, pb: 4 },
    );
  }
  return column(
    v_flex()
      .id(`prompt-${row.key}`)
      .w_full()
      .gap(8)
      .px(14)
      .py(12)
      .rounded(12)
      .bg(alpha(t.accent, 0.075))
      .border(1)
      .border_color(alpha(t.accent, 0.22))
      .on_mouse_down("right", (_e, cx) => ctx.copy(text, cx))
      .child(who(t, "user", "You", e.ts, badges.length ? h_flex().gap(6).children(badges) : null))
      .when(!!text, (el) => el.child(div().pl(31).text_size(13.5).line_height(1.6).text_color(t.foreground).child(text)))
      .when(files.length > 0, (el) => el.child(div().pl(31).child(imageChips(t, `prompt-img-${row.key}`, files)))),
    { pt: row.turn === 1 ? 18 : 30, pb: 6 },
  );
}

export function textRow(t, row, ctx) {
  const body = div()
    .id(`text-${row.key}`)
    .pl(31)
    .on_mouse_down("right", (_e, cx) => ctx.copy(row.ev.text, cx))
    .child(markdown(`md-${row.key}`, row.ev.text, t, 13.5, ctx.cwd));
  if (!row.first) return column(body, { pt: 6, pb: 4 });
  return column(v_flex().w_full().gap(6).child(who(t, "claude", "Claude", row.ev.ts)).child(body), { pt: 14, pb: 4 });
}

export function noteRow(t, row, ctx) {
  const e = row.ev;
  const blue = t.ansi4 ?? t.accent;
  if (e.kind === "recap")
    return column(
      v_flex()
        .gap(6)
        .px(14)
        .py(11)
        .rounded(10)
        .bg(alpha(blue, 0.07))
        .border(1)
        .border_color(alpha(blue, 0.25))
        .child(h_flex().gap(7).items_center().child(icon("clock", 12, blue)).child(div().text_size(11.5).font_semibold().text_color(blue).child("While you were away")))
        .child(div().text_size(13).line_height(1.6).text_color(t.foreground).child(e.text)),
      { pt: 14, pb: 6 },
    );
  if (e.kind === "error") return column(div().pl(31).child(errorBox(t, e.text)), { pt: 8, pb: 6 });
  const look = {
    compact: { icon: "layers", label: "Conversation compacted", color: t.muted },
    task: { icon: "bolt", label: e.text, color: t.muted },
    interrupt: { icon: "square", label: "Interrupted by you", color: t.blocked },
    info: { icon: "terminal", label: e.text, color: t.dim },
  }[e.kind] ?? { icon: "list", label: e.text, color: t.dim };
  const expandable = e.kind === "compact" && !!e.text;
  const open = expandable && ctx.isOpen(row.key, false);
  return column(
    v_flex()
      .gap(6)
      .child(
        h_flex()
          .id(`note-${row.key}`)
          .gap(10)
          .items_center()
          .when(expandable, (el) => el.cursor_pointer().on_click((_e, cx) => ctx.toggle(row.key, cx)))
          .child(div().flex_1().h(1).bg(alpha(t.border, 0.8)))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .max_w(COLUMN - 160)
              .child(icon(look.icon, 11, look.color))
              .child(div().truncate().text_size(11.5).text_color(look.color).when(e.kind === "info", (d) => d.font_family(mono())).child(look.label))
              .when(expandable, (el) => el.child(icon(open ? "chevron-down" : "chevron-right", 10, t.dim))),
          )
          .child(div().flex_1().h(1).bg(alpha(t.border, 0.8))),
      )
      .when(open, (el) => el.child(div().pt(4).child(markdown(`cs-${row.key}`, lines(e.text, 400), t, 12.5, ctx.cwd)))),
    { pt: 14, pb: 8 },
  );
}

export function durRow(t, row) {
  return column(
    h_flex()
      .ml(31)
      .gap(6)
      .items_center()
      .child(div().text_size(11).text_color(alpha(claudeColor(), 0.9)).child("✻"))
      .child(div().text_size(11).text_color(t.dim).child(`Worked for ${fmtDuration(row.ev.ms)}`)),
    { pt: 4, pb: 4 },
  );
}

export function cmdRow(t, row) {
  return column(
    h_flex()
      .gap(8)
      .items_center()
      .child(avatar(t, "user"))
      .child(div().px(8).py(3).rounded(6).bg(alpha(t.accent, 0.1)).font_family(mono()).text_size(12).text_color(t.accent).child(row.ev.name))
      .when(!!row.ev.args, (el) => el.child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(12).text_color(t.muted).child(row.ev.args))),
    { pt: 22, pb: 4 },
  );
}

export function bashRow(t, row) {
  const out = [row.out?.out, row.out?.err].filter((s) => s && s.trim()).join("\n");
  return column(div().pl(31).child(terminalBox(t, row.ev.cmd, out, !!row.out?.err?.trim())), { pt: 14, pb: 4 });
}

export function workingRow(t, msg) {
  return column(
    h_flex()
      .ml(31)
      .gap(8)
      .items_center()
      .child(div().w(14).text_size(13).text_color(claudeColor()).frames(SPIN, 90))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).loop("opacity", { from: 0.55, to: 1, period: 1400 }).child(msg || "Working…")),
    { pt: 12, pb: 8 },
  );
}

export function renderRow(t, row, ctx) {
  switch (row.type) {
    case "prompt":
      return promptRow(t, row, ctx);
    case "text":
      return textRow(t, row, ctx);
    case "group":
      return groupRow(t, row, ctx);
    case "note":
      return noteRow(t, row, ctx);
    case "dur":
      return durRow(t, row);
    case "cmd":
      return cmdRow(t, row);
    case "bash":
      return bashRow(t, row);
    case "working":
      return workingRow(t, ctx.workingMsg);
    case "top":
      return column(div().py(10).text_center().text_size(11).text_color(t.dim).child(row.text), { pt: 12 });
  }
  return div().h(24);
}
