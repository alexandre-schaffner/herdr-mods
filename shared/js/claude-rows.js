// How each row of a Claude chat looks. `ctx` carries the live facts (results, running tool) and the
// handlers rows call: ctx.isOpen(key, byDefault), ctx.toggle(key, cx), ctx.copy(text, cx).

import { h_flex, TextView, v_flex } from "gpui-base";
import { div, image, svg } from "gpui-kit";
import {
  family,
  fmtDuration,
  fmtTime,
  foldLine,
  groupLine,
  relayed as relayedMsg,
  shortPath,
  toolLine,
  toolName,
} from "./claude-model.js";
import { alpha, dark, ICON, icon, mix, mono, ok } from "./look.js";
import { openLink, openViewer, viewable } from "./viewer-link.js";

export { alpha, ICON, icon, mix, mono };

export const COLUMN = 820;
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Claude's orange, kept recognisable on any theme. */
export const claudeColor = () => (dark() ? "#d97757" : "#c15f3c");

const FAMILY = {
  shell: { icon: "terminal", color: t => t.ansi2 ?? t.accent },
  read: { icon: "file-text", color: t => t.ansi4 ?? t.accent },
  edit: { icon: "square-pen", color: t => t.ansi3 ?? t.accent },
  search: { icon: "search", color: t => t.ansi6 ?? t.accent },
  web: { icon: "eye", color: t => t.ansi6 ?? t.accent },
  agent: { icon: "sparkles", color: t => t.ansi5 ?? t.accent },
  todo: { icon: "list", color: t => t.ansi5 ?? t.accent },
  skill: { icon: "bolt", color: t => t.ansi3 ?? t.accent },
  tool: { icon: "wrench", color: t => t.muted },
};
const famLook = (name, t) => {
  const f = FAMILY[family(name)];
  return { icon: f.icon, color: f.color(t) };
};

const lines = (text, max) => {
  const all = String(text ?? "")
    .replace(/\t/g, "  ")
    .replace(/\s+$/, "")
    .split("\n");
  if (all.length <= max) return all.join("\n");
  return all.slice(0, max).join("\n") + `\n… ${all.length - max} more lines`;
};
const countLines = s => (s ? String(s).replace(/\s+$/, "").split("\n").length : 0);

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

/** Claude's mark in a warm disc: heads a reply and the working line. */
function mark(t, size = 22) {
  return div()
    .flex_none()
    .w(size)
    .h(size)
    .rounded_full()
    .bg(alpha(claudeColor(), dark() ? 0.18 : 0.14))
    .flex()
    .items_center()
    .justify_center()
    .child(
      image("icons/claude.svg")
        .w(Math.round(size * 0.6))
        .h(Math.round(size * 0.6)),
    );
}

function avatar(t, kind) {
  const box = div().flex_none().w(22).h(22).rounded(7).flex().items_center().justify_center();
  if (kind === "claude") return box.bg(alpha(claudeColor(), 0.16)).child(image("icons/claude.svg").w(13).h(13));
  return box.bg(alpha(t.accent, 0.18)).child(icon("user", 12, t.accent));
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
    .child(TextView.markdown(id, keepLineBreaks(text)).on_link_click(url => openLink(url, cwd)));
}

/** Claude Code's terminal shows every newline, but Markdown folds a single one into a space
 *  ("What it won't do It won't…"). Each single newline outside code fences and tables becomes
 *  a hard break, so the chat reads like the terminal. */
function keepLineBreaks(text) {
  const lines = text.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length && !line.trim().slice(open.length)) fence = null;
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    const next = lines[i + 1];
    if (!line.trim() || !next.trim() || /(\s{2}|\\)$/.test(line)) continue;
    if (/^\s*\|/.test(line) || /^\s*\|/.test(next)) continue;
    lines[i] = `${line}  `;
  }
  return lines.join("\n");
}

// ─── rich blocks ─────────────────────────────────────────────────────────

/** A ```mermaid block: drawn as a diagram. (HTML stays code: a page opens in the browser.) */
const RICH_FENCE = /```(mermaid)[^\n]*\n([\s\S]*?)\n?```/g;

/** Markdown with its Mermaid diagrams drawn (shared/rich.js); the rest as markdown. */
export function richMarkdown(id, text, t, size, ctx) {
  if (!ctx?.rich || !/```mermaid/.test(text)) return markdown(id, text, t, size, ctx?.cwd);
  const parts = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(RICH_FENCE)) {
    if (m.index > last) parts.push(markdown(`${id}-${n++}`, text.slice(last, m.index), t, size, ctx.cwd));
    parts.push(richBlock(t, `${id}-r${n++}`, m[1], m[2], ctx));
    last = m.index + m[0].length;
  }
  if (!parts.length) return markdown(id, text, t, size, ctx.cwd);
  if (last < text.length) parts.push(markdown(`${id}-${n++}`, text.slice(last), t, size, ctx.cwd));
  return v_flex().w_full().gap(12).children(parts);
}

/** A drawn diagram: a card with its image (or a spinner, or what went wrong), its source on
 *  demand, and a way to open the image outside. */
function richBlock(t, id, kind, code, ctx) {
  const r = ctx.rich(kind, code);
  const codeKey = `rich-code:${id}`;
  const showCode = ctx.isOpen(codeKey, false) || r.status === "error";
  const maxW = Math.max(200, (ctx.colW ?? COLUMN - 56) - 2);
  const scale = r.width ? Math.min(1, maxW / r.width) : 1;
  const btn = (bid, label, iconName, onClick) =>
    h_flex()
      .id(`${id}-${bid}`)
      .h(24)
      .px(8)
      .gap(5)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(11.5)
      .text_color(t.muted)
      .hover(s => s.bg(alpha(t.foreground, 0.07)).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(icon(iconName, 11, t.dim))
      .child(label);
  const body =
    r.status === "done"
      ? div()
          .w_full()
          .p(12)
          .flex()
          .justify_center()
          .bg(alpha(t.foreground, 0.02))
          .child(
            image(r.src)
              .w(Math.round(r.width * scale))
              .h(Math.round(r.height * scale)),
          )
      : r.status === "busy"
        ? h_flex()
            .h(120)
            .w_full()
            .gap(8)
            .items_center()
            .justify_center()
            .child(svg(ICON("spinner")).w(13).h(13).text_color(t.dim).spin(900))
            .child(div().text_size(12).text_color(t.dim).child("Drawing the diagram…"))
        : h_flex()
            .px(14)
            .py(10)
            .gap(8)
            .items_center()
            .child(icon("alert", 12, t.blocked))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(12)
                .text_color(t.blocked)
                .child(`Couldn't draw it: ${r.error ?? "unknown error"}`),
            );
  return v_flex()
    .id(id)
    .w_full()
    .rounded(12)
    .overflow_hidden()
    .border(1)
    .border_color(alpha(t.border, 0.7))
    .bg(mix(t.background, t.foreground, dark() ? 0.025 : 0.015))
    .child(
      h_flex()
        .h(34)
        .pl(12)
        .pr(6)
        .gap(6)
        .items_center()
        .border_b(1)
        .border_color(alpha(t.border, 0.5))
        .child(icon("layers", 12, t.ansi5 ?? t.accent))
        .child(div().text_size(12).font_medium().text_color(t.foreground).child("Diagram"))
        .child(div().text_size(11).font_family(mono()).text_color(t.dim).child(kind))
        .child(div().flex_1())
        .child(btn("code", showCode ? "Hide code" : "Code", "terminal", cx => ctx.toggle(codeKey, cx)))
        .when(r.status === "done", el => el.child(btn("open", "Open", "arrow-up", () => ctx.openRich(kind, code)))),
    )
    .child(body)
    .when(showCode, el =>
      el.child(
        div()
          .p(10)
          .border_t(1)
          .border_color(alpha(t.border, 0.5))
          .child(codeBox(t, code, { max: 60, color: t.foreground })),
      ),
    );
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
          .hover(s => s.bg(alpha(t.accent, 0.1)).border_color(alpha(t.accent, 0.5)))
          .tooltip("Open in the viewer")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openViewer(f, files);
          })
          .child(icon("image", 12, t.accent))
          .child(
            div()
              .text_size(11.5)
              .text_color(t.foreground)
              .child(files.length > 1 ? `Image ${k + 1}` : "Image"),
          ),
      ),
    );
}

/** The file a read or edit step is about, when the viewer can show it. */
const viewableFile = e => {
  const fam = family(e.name);
  const f = (fam === "read" || fam === "edit") && e.input?.file_path;
  return viewable(f) ? f : null;
};

// ─── tool bodies ─────────────────────────────────────────────────────────

const well = t => mix(t.background, t.foreground, dark() ? 0.045 : 0.035);

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
        .child(
          div()
            .flex_none()
            .text_color(t.ansi2 ?? ok(t))
            .child("$"),
        )
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(lines(command, 12))),
    )
    .when(!!output, el =>
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
    .child(
      div()
        .flex_1()
        .min_w(0)
        .pr(8)
        .text_color(plain ? t.dim : t.foreground)
        .child(text || " "),
    );
}

/** Read's output is `   12→text`: keep the numbers, dimmed, in a gutter. */
function fileBox(t, text) {
  const rows = String(text ?? "")
    .replace(/\s+$/, "")
    .split("\n");
  const shown = rows.slice(0, 30).map(l => {
    const m = l.match(/^\s*(\d+)[→\t](.*)$/);
    return h_flex()
      .font_family(mono())
      .text_size(11.5)
      .line_height(1.6)
      .child(
        div()
          .flex_none()
          .w(40)
          .pr(10)
          .text_right()
          .text_color(alpha(t.dim, 0.7))
          .child(m ? m[1] : ""),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .text_color(t.muted)
          .child((m ? m[2] : l) || " "),
      );
  });
  if (rows.length > 30)
    shown.push(
      div()
        .pl(40)
        .text_size(11)
        .text_color(t.dim)
        .child(`… ${rows.length - 30} more lines`),
    );
  return v_flex().w_full().py(8).pr(10).rounded(8).bg(well(t)).children(shown);
}

function toolBody(t, e, res, ctx) {
  const detail = toolDetail(t, e, res, ctx);
  if (!res?.files?.length) return detail;
  return v_flex()
    .gap(8)
    .child(detail)
    .child(imageChips(t, `res-img-${e.id}`, res.files));
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
          : div()
              .pl(12)
              .border_l(2)
              .border_color(alpha(t.ansi5 ?? t.accent, 0.5))
              .child(markdown(`ag-${e.id}`, lines(res.text, 80), t, 12.5, ctx.cwd)),
      );
    return v_flex().gap(8).children(parts);
  }
  if (fam === "todo" && Array.isArray(i.todos)) {
    return v_flex()
      .gap(4)
      .px(4)
      .children(
        i.todos.map(x => {
          const done = x.status === "completed";
          const now = x.status === "in_progress";
          return h_flex()
            .gap(9)
            .items_center()
            .child(
              done
                ? div()
                    .flex_none()
                    .w(14)
                    .h(14)
                    .rounded_full()
                    .bg(alpha(ok(t), 0.18))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(icon("check", 9, ok(t)))
                : div()
                    .flex_none()
                    .w(14)
                    .h(14)
                    .rounded_full()
                    .border(now ? 2 : 1)
                    .border_color(now ? t.working : t.dim),
            )
            .child(
              div()
                .text_size(12.5)
                .text_color(done ? t.dim : now ? t.foreground : t.muted)
                .when(done, d => d.line_through())
                .child(x.content ?? x.subject ?? ""),
            );
        }),
      );
  }
  const args = Object.entries(i).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (args.length)
    parts.push(
      codeBox(t, args.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"), {
        max: 14,
        color: t.foreground,
      }),
    );
  if (res) parts.push(res.err ? errorBox(t, res.text) : codeBox(t, res.text || "(no output)", { max: 30 }));
  return v_flex().gap(6).children(parts);
}

// ─── steps: one line per tool call ───────────────────────────────────────

const VERB = {
  Bash: "Ran",
  BashOutput: "Checked",
  KillShell: "Stopped",
  Monitor: "Watched",
  Read: "Read",
  NotebookRead: "Read",
  Edit: "Edited",
  MultiEdit: "Edited",
  Write: "Wrote",
  NotebookEdit: "Edited",
  Grep: "Searched",
  Glob: "Listed",
  ToolSearch: "Loaded",
  WebFetch: "Fetched",
  WebSearch: "Searched the web",
  Agent: "Agent",
  Task: "Agent",
  SendMessage: "Messaged",
  TodoWrite: "Todos",
  Skill: "Skill",
};

/** What a step's line says: the verb, its object, whether the object is code, and a stat. */
function describe(e, res, ctx) {
  const i = e.input ?? {};
  const fam = family(e.name);
  const out = {
    verb: VERB[e.name] ?? toolName(e.name),
    main: toolLine(e.name, i, ctx.cwd),
    code: true,
    sub: null,
    stat: null,
    statColor: null,
  };
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
    out.sub = i.path ? shortPath(i.path, ctx.cwd) : (i.glob ?? null);
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
      const done = i.todos.filter(x => x.status === "completed").length;
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
    stat = h_flex()
      .flex_none()
      .gap(5)
      .font_family(mono())
      .text_size(11)
      .children(
        d.stat.map(s =>
          div()
            .text_color(s[0] === "+" ? ok(t) : t.blocked)
            .child(s),
        ),
      );
  else if (d.stat)
    stat = div()
      .flex_none()
      .font_family(mono())
      .text_size(11)
      .text_color(failed ? t.blocked : t.dim)
      .child(d.stat);

  const line = h_flex()
    .id(`step-${e.id}`)
    .h(34)
    .pl(10)
    .pr(12)
    .gap(10)
    .items_center()
    .cursor_pointer()
    .hover(s => s.bg(alpha(t.foreground, 0.035)))
    .on_click((_e, cx) => ctx.toggle(key, cx))
    .on_mouse_down("right", (_e, cx) => ctx.copy(e.input?.command ?? toolLine(e.name, e.input, ctx.cwd), cx))
    .child(tile(t, look.icon, color))
    .child(
      div()
        .flex_none()
        .text_size(12.5)
        .font_medium()
        .text_color(failed ? t.blocked : t.foreground)
        .child(d.verb),
    )
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
            .when(d.code, x => x.font_family(mono()))
            .text_color(t.muted)
            .when(running, x => x.loop("opacity", { from: 0.45, to: 1, period: 1100 }))
            .child(d.main || ""),
        )
        .when(!!d.sub, x =>
          x.child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .font_family(mono())
              .text_size(11)
              .text_color(alpha(t.dim, 0.85))
              .child(d.sub),
          ),
        ),
    )
    .when(!!stat, x => x.child(stat))
    .when(!!file, x => x.child(viewButton(t, `view-${e.id}`, file)))
    .child(icon(open ? "chevron-down" : "chevron-right", 11, alpha(t.dim, 0.8)));

  return v_flex()
    .w_full()
    .when(!o.first, x => x.border_t(1).border_color(alpha(t.border, 0.45)))
    .child(line)
    .when(open, x =>
      x.child(
        div()
          .pl(42)
          .pr(12)
          .pb(12)
          .child(toolBody(t, e, res, ctx)),
      ),
    );
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
    .hover(s => s.bg(alpha(t.accent, 0.14)))
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
    .when(!o.first, x => x.border_t(1).border_color(alpha(t.border, 0.45)))
    .child(
      h_flex()
        .id(`think-${e.id}`)
        .h(34)
        .pl(10)
        .pr(12)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .hover(s => s.bg(alpha(t.foreground, 0.035)))
        .on_click((_e, cx) => ctx.toggle(key, cx))
        .child(tile(t, "brain", t.dim))
        .child(div().flex_none().text_size(12.5).font_medium().text_color(t.muted).child("Thought"))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .italic()
            .text_color(t.dim)
            .child(String(e.text).split("\n")[0]),
        )
        .child(icon(open ? "chevron-down" : "chevron-right", 11, alpha(t.dim, 0.8))),
    )
    .when(open, x =>
      x.child(
        div()
          .pl(42)
          .pr(14)
          .pb(12)
          .text_size(12.5)
          .italic()
          .line_height(1.6)
          .text_color(t.muted)
          .child(lines(e.text, 200)),
      ),
    );
}

/** A burst of tool calls: a small pill under the answer; opened, a card of its steps. */
export function groupRow(t, row, ctx) {
  const tools = row.tools;
  const errors = tools.filter(x => ctx.results.get(x.id)?.err).length;
  const running = ctx.running && tools.some(x => x.id === ctx.lastTool && !ctx.results.has(x.id));
  const single = row.items.length === 1;
  const only = row.items[0];
  const key = single ? (only.k === "think" ? `k:${only.id}` : `t:${only.id}`) : row.key;
  const open = ctx.isOpen(key, ctx.mode === "verbose" || (!single && (running || !!ctx.query)));
  const fams = [];
  for (const x of tools) {
    const f = famLook(x.name, t);
    if (!fams.some(y => y.icon === f.icon)) fams.push(f);
  }
  if (!fams.length) fams.push({ icon: "brain", color: t.dim });
  let label;
  if (single && only.k === "think") label = "Thought";
  else if (single) {
    const d = describe(only, ctx.results.get(only.id), ctx);
    label = `${d.verb} ${d.main || ""}`.trim();
  } else label = tools.length ? groupLine(tools) : "Thought";
  const tone = errors ? t.blocked : t.muted;
  const pill = h_flex()
    .id(`grp-${row.key}`)
    .flex_none()
    .max_w(COLUMN - 120)
    .h(28)
    .pl(10)
    .pr(10)
    .gap(8)
    .items_center()
    .rounded_full()
    .cursor_pointer()
    .bg(open ? alpha(t.foreground, 0.08) : alpha(t.foreground, dark() ? 0.045 : 0.04))
    .border(1)
    .border_color(alpha(errors ? t.blocked : t.border, errors ? 0.45 : 0.5))
    .hover(s => s.bg(alpha(t.foreground, 0.09)))
    .on_click((_e, cx) => ctx.toggle(key, cx))
    .on_mouse_down("right", (_e, cx) => ctx.copy(ctx.rowText(row), cx))
    .child(
      running
        ? svg(ICON("spinner")).flex_none().w(12).h(12).text_color(t.working).spin(900)
        : h_flex()
            .flex_none()
            .gap(4)
            .children(fams.slice(0, 3).map(f => icon(f.icon, 12, errors ? t.blocked : f.color))),
    )
    .child(
      div()
        .min_w(0)
        .truncate()
        .text_size(12)
        .text_color(tone)
        .when(running, x => x.loop("opacity", { from: 0.5, to: 1, period: 1100 }))
        .child(label),
    )
    .when(errors > 0, x => x.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${errors} failed`)))
    .when(!single, x =>
      x.child(div().flex_none().text_size(11).font_family(mono()).text_color(t.dim).child(String(row.items.length))),
    )
    .child(icon(open ? "chevron-down" : "chevron-right", 10, t.dim));
  const body = !open
    ? null
    : v_flex()
        .w_full()
        .mt(8)
        .rounded(14)
        .overflow_hidden()
        .border(1)
        .border_color(alpha(errors ? t.blocked : t.border, errors ? 0.35 : 0.6))
        .bg(mix(t.background, t.foreground, dark() ? 0.03 : 0.018))
        .children(
          row.items.map((e, k) =>
            e.k === "think"
              ? thoughtRow(t, e, ctx, { first: k === 0 })
              : stepRow(t, e, ctx.results.get(e.id), ctx, { first: k === 0 }),
          ),
        );
  return column(
    v_flex()
      .w_full()
      .items_start()
      .child(pill)
      .when(!!body, el => el.child(body)),
    { pt: 5, pb: 5 },
  );
}

// ─── messages ────────────────────────────────────────────────────────────

/** A small action under a queued message. */
function queueAction(t, id, label, iconName, onClick, tip) {
  return h_flex()
    .id(id)
    .h(22)
    .px(7)
    .gap(4)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(11)
    .text_color(t.muted)
    .hover(s => s.bg(alpha(t.foreground, 0.07)).text_color(t.foreground))
    .when(!!tip, el => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onClick(cx))
    .child(icon(iconName, 10, t.dim))
    .child(label);
}

export function promptRow(t, row, ctx) {
  const e = row.ev;
  // A message another terminal sent with `hc send` (see relayed()): who sent it, then what it said.
  const relayed = relayedMsg(e.text);
  const text = relayed ? relayed.text : e.text;
  const files = e.files ?? [];
  if (relayed) {
    return column(
      v_flex()
        .id(`prompt-${row.key}`)
        .max_w(COLUMN - 160)
        .gap(5)
        .px(14)
        .py(10)
        .rounded(14)
        .bg(alpha(t.foreground, 0.035))
        .border(1)
        .border_color(alpha(t.border, 0.45))
        .on_mouse_down("right", (_e, cx) => ctx.copy(text, cx))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(icon("arrow-left", 11, t.muted))
            .child(
              div()
                .text_size(12)
                .font_semibold()
                .text_color(t.foreground)
                .child(relayed.from ?? "Herdr"),
            )
            .child(div().text_size(11).text_color(t.dim).child(fmtTime(e.ts))),
        )
        .when(!!text, el =>
          el.child(div().text_size(12.5).line_height(1.55).text_color(t.muted).child(lines(text, 12))),
        ),
      { pt: 14, pb: 4 },
    );
  }
  const badges = [];
  if (e.queued) badges.push(badge(t, "queued", t.muted));
  if (e.images && !files.length) badges.push(badge(t, `${e.images} image${e.images > 1 ? "s" : ""}`, t.muted));
  // Waiting in Claude Code's queue: the same bubble, lighter, until Claude takes it.
  if (row.waiting)
    return column(
      v_flex()
        .id(`prompt-${row.key}`)
        .w_full()
        .items_end()
        .gap(6)
        .on_mouse_down("right", (_e, cx) => ctx.copy(text, cx))
        .child(
          div()
            .max_w(Math.round(COLUMN * 0.72))
            .px(16)
            .py(10)
            .rounded(18)
            .rounded_br(6)
            .bg(mix(t.background, t.accent, dark() ? 0.1 : 0.06))
            .border(1)
            .border_color(alpha(t.accent, 0.35))
            .text_size(14.5)
            .line_height(1.5)
            .text_color(alpha(t.foreground, 0.78))
            .child(text || " "),
        )
        .child(
          h_flex()
            .pr(2)
            .gap(4)
            .items_center()
            .child(icon("clock", 11, t.dim).loop("opacity", { from: 0.4, to: 1, period: 1600 }))
            .child(
              div()
                .pr(6)
                .text_size(11)
                .text_color(t.dim)
                .child(
                  row.qof > 1
                    ? `Queued ${row.qn} of ${row.qof} · sent together when Claude finishes`
                    : "Queued · sends when Claude finishes this turn",
                ),
            )
            .when(!!ctx.queue, el =>
              el
                .child(queueAction(t, `${row.key}-edit`, "Edit", "square-pen", cx => ctx.queue.edit(row.qid, cx)))
                .child(
                  queueAction(
                    t,
                    `${row.key}-now`,
                    "Send now",
                    "arrow-up",
                    cx => ctx.queue.now(row.qid, cx),
                    "Into the running turn (⌘↵)",
                  ),
                )
                .child(queueAction(t, `${row.key}-rm`, "Remove", "x", cx => ctx.queue.remove(row.qid, cx))),
            ),
        ),
      { pt: 14, pb: 6 },
    );
  // The person's words: a bubble on the right, in the accent's own tint.
  return column(
    v_flex()
      .id(`prompt-${row.key}`)
      .w_full()
      .items_end()
      .gap(6)
      .on_mouse_down("right", (_e, cx) => ctx.copy(text, cx))
      .child(
        div()
          .max_w(Math.round(COLUMN * 0.72))
          .px(16)
          .py(10)
          .rounded(18)
          .rounded_br(6)
          .bg(mix(t.background, t.accent, dark() ? 0.24 : 0.13))
          .text_size(14.5)
          .line_height(1.5)
          .text_color(t.foreground)
          .child(text || " "),
      )
      .when(files.length > 0, el => el.child(imageChips(t, `prompt-img-${row.key}`, files)))
      .child(
        h_flex()
          .pr(6)
          .gap(6)
          .items_center()
          .children(badges)
          .child(div().text_size(11).text_color(t.dim).child(fmtTime(e.ts))),
      ),
    { pt: row.turn === 1 ? 20 : 40, pb: 10 },
  );
}

export function textRow(t, row, ctx) {
  const thought = !!row.thought;
  const md = thought
    ? markdown(`md-${row.key}`, row.ev.text, { ...t, foreground: t.muted }, 14.5, ctx.cwd)
    : richMarkdown(`md-${row.key}`, row.ev.text, t, 14.5, ctx);
  const body = div()
    .id(`text-${row.key}`)
    .on_mouse_down("right", (_e, cx) => ctx.copy(row.ev.text, cx))
    .child(md);
  const head = h_flex()
    .h(22)
    .gap(8)
    .items_center()
    .child(mark(t))
    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Claude"))
    .child(div().text_size(11).text_color(t.dim).child(fmtTime(row.ev.ts)));
  if (thought) {
    // A turn that ended with no reply: its last thought, plainly marked as one (see buildRows).
    return column(
      v_flex()
        .w_full()
        .gap(10)
        .child(head)
        .child(
          v_flex()
            .gap(6)
            .px(14)
            .py(11)
            .rounded(14)
            .bg(alpha(t.foreground, 0.035))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(icon("brain", 11, t.dim))
                .child(div().text_size(11.5).text_color(t.dim).child("No reply written. Its last thought:")),
            )
            .child(body.italic()),
        ),
      { pt: 14, pb: 4 },
    );
  }
  if (!row.first) return column(body, { pt: 8, pb: 4 });
  return column(v_flex().w_full().gap(10).child(head).child(body), { pt: 14, pb: 4 });
}

export function noteRow(t, row, ctx) {
  const e = row.ev;
  const blue = t.ansi4 ?? t.accent;
  if (e.kind === "recap")
    return column(
      v_flex()
        .gap(6)
        .px(16)
        .py(12)
        .rounded(14)
        .bg(alpha(blue, 0.09))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(icon("clock", 12, blue))
            .child(div().text_size(12).font_semibold().text_color(blue).child("While you were away"))
            .child(div().text_size(11).text_color(t.dim).child(fmtTime(e.ts))),
        )
        .child(div().text_size(13.5).line_height(1.6).text_color(t.foreground).child(e.text)),
      { pt: 20, pb: 6 },
    );
  if (e.kind === "error") return column(errorBox(t, e.text), { pt: 8, pb: 6 });
  if (e.kind === "compact") {
    const open = !!e.text && ctx.isOpen(row.key, false);
    return column(
      v_flex()
        .gap(6)
        .child(
          divider(
            t,
            `note-${row.key}`,
            [
              icon("layers", 11, t.muted),
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .child(`Conversation compacted · ${fmtTime(e.ts)}`),
            ],
            {
              click: e.text ? cx => ctx.toggle(row.key, cx) : null,
              open,
            },
          ),
        )
        .when(open, el =>
          el.child(
            div()
              .pt(4)
              .child(markdown(`cs-${row.key}`, lines(e.text, 400), t, 12.5, ctx.cwd)),
          ),
        ),
      { pt: 20, pb: 10 },
    );
  }
  // A background agent's report (see read.py's hand-back): a line that opens onto the report.
  if (e.kind === "task" && e.report) {
    const open = ctx.isOpen(row.key, false);
    const pill = h_flex()
      .id(`note-${row.key}`)
      .flex_none()
      .h(28)
      .px(10)
      .gap(8)
      .items_center()
      .rounded_full()
      .cursor_pointer()
      .bg(open ? alpha(t.foreground, 0.08) : alpha(t.foreground, dark() ? 0.045 : 0.04))
      .border(1)
      .border_color(alpha(t.border, 0.5))
      .hover(x => x.bg(alpha(t.foreground, 0.09)))
      .on_click((_e, cx) => ctx.toggle(row.key, cx))
      .on_mouse_down("right", (_e, cx) => ctx.copy(e.report, cx))
      .child(icon("sparkles", 12, t.ansi5 ?? t.accent))
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(open ? "Background agent's report" : "A background agent reported back · read its report"),
      )
      .child(div().flex_none().text_size(11).text_color(t.dim).child(fmtTime(e.ts)))
      .child(icon(open ? "chevron-down" : "chevron-right", 10, t.dim));
    return column(
      v_flex()
        .w_full()
        .items_start()
        .child(pill)
        .when(open, el =>
          el.child(
            div()
              .w_full()
              .mt(8)
              .px(16)
              .py(12)
              .rounded(14)
              .bg(mix(t.background, t.foreground, dark() ? 0.03 : 0.018))
              .border(1)
              .border_color(alpha(t.border, 0.6))
              .child(richMarkdown(`rep-${row.key}`, e.report, t, 13, ctx)),
          ),
        ),
      { pt: 8, pb: 4 },
    );
  }
  const look = {
    task: { icon: "bolt", label: e.text, color: t.muted },
    interrupt: { icon: "square", label: "Interrupted by you", color: t.blocked },
    info: { icon: "terminal", label: e.text, color: t.dim },
  }[e.kind] ?? { icon: "list", label: e.text, color: t.dim };
  return column(
    h_flex()
      .gap(8)
      .items_center()
      .child(icon(look.icon, 11, look.color))
      .child(
        div()
          .min_w(0)
          .truncate()
          .text_size(12)
          .text_color(look.color)
          .when(e.kind === "info", d => d.font_family(mono()).text_size(11.5))
          .child(look.label),
      )
      .child(div().flex_none().text_size(11).text_color(t.dim).child(fmtTime(e.ts))),
    { pt: 6, pb: 4 },
  );
}

/** A centred pill on a hairline: compactions, the org's folded turns. */
function divider(t, id, content, o = {}) {
  const pill = h_flex()
    .id(id)
    .flex_none()
    .max_w(COLUMN - 160)
    .h(28)
    .px(12)
    .gap(8)
    .items_center()
    .rounded_full()
    .border(1)
    .border_color(alpha(t.border, o.open ? 0.9 : 0.55))
    .bg(o.open ? alpha(t.foreground, 0.06) : t.background)
    .children(content)
    .when(!!o.click, el =>
      el
        .cursor_pointer()
        .hover(s => s.bg(alpha(t.foreground, 0.07)).border_color(alpha(t.border, 1)))
        .on_click((_e, cx) => o.click(cx))
        .when(!!o.tip, x => x.tooltip(o.tip))
        .child(icon(o.open ? "chevron-down" : "chevron-right", 10, t.dim)),
    );
  if (o.onRight) pill.on_mouse_down("right", (_e, cx) => o.onRight(cx));
  return h_flex()
    .w_full()
    .gap(12)
    .items_center()
    .child(div().flex_1().h(1).bg(alpha(t.border, 0.55)))
    .child(pill)
    .child(div().flex_1().h(1).bg(alpha(t.border, 0.55)));
}

/** How long the turn took: a quiet caption under it. */
export function durRow(t, row) {
  return column(
    h_flex()
      .gap(6)
      .items_center()
      .child(div().text_size(11).text_color(alpha(claudeColor(), 0.85)).child("✻"))
      .child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .child(`Worked for ${fmtDuration(row.ev.ms)} · ${fmtTime(row.ev.ts)}`),
      ),
    { pt: 6, pb: 2 },
  );
}

/** A run of turns the person didn't start (ticks, agents' messages, HQ's lines), folded to one
 *  divider: how many, when, and what started them. A click opens it in place. */
export function foldRow(t, row, ctx) {
  const from = fmtTime(row.from);
  const to = fmtTime(row.to);
  const when = from && to && from !== to ? `${from}–${to}` : from || to;
  return column(
    divider(
      t,
      `fold-${row.key}`,
      [
        icon("layers", 11, t.muted),
        div().flex_none().text_size(12).font_medium().text_color(t.muted).child("Org work"),
        div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(foldLine(row.turns)),
        when ? div().flex_none().text_size(10.5).font_family(mono()).text_color(t.dim).child(when) : null,
      ].filter(Boolean),
      {
        click: cx => ctx.toggle(row.key, cx),
        open: row.open,
        tip: row.open ? "Fold the org's turns" : "Show the org's turns",
        onRight: cx => ctx.copy(ctx.rowText(row), cx),
      },
    ),
    { pt: 26, pb: 8 },
  );
}

/** The end of an open fold: the same divider, folding it back from below. */
export function foldEndRow(t, row, ctx) {
  return column(
    divider(
      t,
      `foldend-${row.key}`,
      [icon("arrow-up", 11, t.dim), div().text_size(11.5).text_color(t.dim).child("End of org work")],
      { click: cx => ctx.toggle(row.of, cx), open: true },
    ),
    { pt: 14, pb: 8 },
  );
}

/** A slash command the person ran: their side, in code. */
export function cmdRow(t, row) {
  return column(
    v_flex()
      .w_full()
      .items_end()
      .gap(6)
      .child(
        h_flex()
          .max_w(Math.round(COLUMN * 0.72))
          .px(12)
          .py(7)
          .gap(8)
          .items_center()
          .rounded(14)
          .rounded_br(6)
          .bg(mix(t.background, t.accent, dark() ? 0.16 : 0.1))
          .child(div().flex_none().font_family(mono()).text_size(12.5).text_color(t.accent).child(row.ev.name))
          .when(!!row.ev.args, el =>
            el.child(
              div().min_w(0).truncate().font_family(mono()).text_size(12.5).text_color(t.foreground).child(row.ev.args),
            ),
          ),
      )
      .child(div().pr(6).text_size(11).text_color(t.dim).child(fmtTime(row.ev.ts))),
    { pt: row.turn === 1 ? 20 : 36, pb: 8 },
  );
}

export function bashRow(t, row) {
  const out = [row.out?.out, row.out?.err].filter(s => s && s.trim()).join("\n");
  return column(terminalBox(t, row.ev.cmd, out, !!row.out?.err?.trim()), { pt: row.turn === 1 ? 20 : 36, pb: 8 });
}

/** The turn in progress: Claude's mark breathing, what it's doing, and for how long. */
export function workingRow(t, row, ctx) {
  const since = row.since ? Date.parse(row.since) : Number.NaN;
  const took = Number.isFinite(since) ? fmtDuration(Math.max(0, Date.now() - since)) : null;
  return column(
    h_flex()
      .h(26)
      .gap(10)
      .items_center()
      .child(div().loop("opacity", { from: 0.45, to: 1, period: 1200 }).child(mark(t, 24)))
      .child(
        div()
          .min_w(0)
          .truncate()
          .text_size(13)
          .text_color(t.foreground)
          .loop("opacity", { from: 0.55, to: 1, period: 1400 })
          .child(ctx.workingMsg || "Working…"),
      )
      .when(!!took, el => el.child(div().flex_none().text_size(11).font_family(mono()).text_color(t.dim).child(took)))
      .child(div().flex_1())
      .child(div().flex_none().text_size(11).text_color(t.dim).child("esc to stop")),
    { pt: 16, pb: 10 },
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
    case "fold":
      return foldRow(t, row, ctx);
    case "foldend":
      return foldEndRow(t, row, ctx);
    case "bash":
      return bashRow(t, row);
    case "working":
      return workingRow(t, row, ctx);
    case "top":
      return column(div().py(10).text_center().text_size(11).text_color(t.dim).child(row.text), { pt: 12 });
  }
  return div().h(24);
}
