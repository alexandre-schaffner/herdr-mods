// A session transcript: messages, collapsible thinking, and tool calls as cards that carry
// their own result (commands as a terminal, edits as a diff).

import { h_flex, TextView, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { seg } from "./ui.js";
import { alpha, clip, compact, icon, mix, mono, ok } from "./util.js";
import { openLink, openViewer, viewable } from "./shared/viewer-link.js";

/** Shortens multi-line text to `n` characters, keeping its line breaks. */
const cut = (text, n) => {
  const s = String(text ?? "").replace(/\t/g, "  ").replace(/\s+$/, "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const TOOL_ICON = {
  Bash: "terminal",
  Read: "file-text",
  Edit: "square-pen",
  MultiEdit: "square-pen",
  Write: "square-pen",
  Grep: "search",
  Glob: "search",
  Agent: "sparkles",
  Task: "sparkles",
  WebFetch: "eye",
  WebSearch: "search",
  Skill: "bolt",
  ToolSearch: "search",
};

const since = (ts, start) => {
  if (!ts || !start) return "";
  const s = Math.max(0, Math.round((ts - start) / 1000));
  return s < 60 ? `+${s}s` : `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function codeBox(t, text, o = {}) {
  return div()
    .w_full()
    .px(12)
    .py(10)
    .rounded(8)
    .bg(o.bg ?? alpha(t.foreground, 0.045))
    .font_family(mono())
    .text_size(11)
    .line_height(1.55)
    .text_color(o.color ?? t.foreground)
    .child(text);
}

function terminal(t, command, output, error) {
  return v_flex()
    .w_full()
    .rounded(9)
    .overflow_hidden()
    .bg(mix(t.background, t.foreground, 0.88))
    .font_family(mono())
    .text_size(11)
    .line_height(1.55)
    .child(
      h_flex()
        .px(12)
        .pt(10)
        .pb(output ? 6 : 10)
        .gap(8)
        .items_start()
        .child(
          div()
            .flex_none()
            .text_color(t.ansi2 ?? "#7ee787")
            .child("$"),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .text_color(mix(t.background, t.foreground, 0.08))
            .child(command),
        ),
    )
    .when(!!output, el =>
      el.child(
        div()
          .px(12)
          .pb(10)
          .text_color(error ? (t.ansi9 ?? "#ff7b72") : mix(t.background, t.foreground, 0.3))
          .child(cut(output, 1800).split("\n").slice(0, 24).join("\n")),
      ),
    );
}

function diff(t, edits) {
  const rows = [];
  edits.forEach((e, k) => {
    if (k) rows.push(div().h(1).my(4).bg(alpha(t.border, 1)));
    for (const line of String(e.old ?? "")
      .split("\n")
      .slice(0, 40))
      rows.push(diffLine(t, "−", line, t.blocked));
    for (const line of String(e.new ?? "")
      .split("\n")
      .slice(0, 40))
      rows.push(diffLine(t, "+", line, ok(t)));
  });
  return v_flex().w_full().py(6).rounded(8).overflow_hidden().bg(alpha(t.foreground, 0.03)).children(rows);
}

function diffLine(t, sign, text, c) {
  return h_flex()
    .px(10)
    .gap(8)
    .bg(alpha(c, 0.09))
    .font_family(mono())
    .text_size(11)
    .line_height(1.55)
    .child(div().flex_none().w(10).text_color(c).child(sign))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .text_color(t.foreground)
        .child(text || " "),
    );
}

/** Images a tool returned, as chips; each opens the viewer, stepping through all of them. */
function imageChips(t, key, files) {
  return h_flex()
    .flex_wrap()
    .gap(6)
    .children(
      files.map((f, k) =>
        h_flex()
          .id(`${key}-img-${k}`)
          .h(24)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .bg(alpha(t.foreground, 0.05))
          .border(1)
          .border_color(alpha(t.border, 1))
          .hover(s => s.bg(alpha(t.accent, 0.1)).border_color(alpha(t.accent, 0.5)))
          .tooltip("Open in the viewer")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openViewer(f, files);
          })
          .child(icon("image", 11, t.accent))
          .child(div().text_size(11).text_color(t.foreground).child(files.length > 1 ? `Image ${k + 1}` : "Image")),
      ),
    );
}

/** The file a card names, as a link to the viewer when it can show it. */
function fileLine(t, key, file) {
  const line = div().font_family(mono()).text_size(11).text_color(t.accent).child(file);
  if (!viewable(file)) return line;
  return h_flex()
    .id(`${key}-file`)
    .gap(6)
    .items_center()
    .cursor_pointer()
    .hover(s => s.opacity(0.8))
    .tooltip("Open in the viewer")
    .on_click((_e, cx) => {
      cx.stop_propagation();
      openViewer(file);
    })
    .child(line)
    .child(icon("eye", 11, t.accent));
}

function toolBody(t, it, key) {
  const d = it.detail ?? {};
  const res = it.result;
  const parts = [];
  if (it.name === "Bash") return terminal(t, d.command ?? it.text, res?.text, res?.error);
  if (d.file) parts.push(fileLine(t, key, d.file));
  if (d.edits) parts.push(diff(t, d.edits));
  if (d.content != null) parts.push(codeBox(t, cut(d.content, 1500)));
  if (d.pattern)
    parts.push(codeBox(t, `${d.pattern}${d.path ? `   in ${d.path}` : ""}${d.glob ? `   (${d.glob})` : ""}`));
  if (d.prompt) parts.push(div().text_size(12).line_height(1.5).text_color(t.muted).child(cut(d.prompt, 900)));
  if (d.input) parts.push(codeBox(t, d.input));
  if (res && !d.edits && it.name !== "Write" && !(res.files?.length && !res.text?.trim()))
    parts.push(
      codeBox(
        t,
        cut(res.text || "(no output)", 2000)
          .split("\n")
          .slice(0, 30)
          .join("\n"),
        {
          color: res.error ? t.blocked : t.muted,
          bg: res.error ? alpha(t.blocked, 0.07) : alpha(t.foreground, 0.03),
        },
      ),
    );
  if (res?.error && (d.edits || it.name === "Write"))
    parts.push(codeBox(t, res.text, { color: t.blocked, bg: alpha(t.blocked, 0.07) }));
  if (res?.files?.length) parts.push(imageChips(t, key, res.files));
  return v_flex().gap(8).children(parts);
}

function toolCard(t, it, key, ui, start) {
  const open = ui.expandAll || ui.expanded.has(key);
  const file = viewable(it.detail?.file) ? it.detail.file : null;
  const res = it.result;
  const state = !res ? (ui.running ? "running" : "none") : res.error ? "error" : "ok";
  const c = state === "error" ? t.blocked : state === "ok" ? ok(t) : state === "running" ? t.working : t.dim;
  return v_flex()
    .id(key)
    .w_full()
    .rounded(10)
    .border(1)
    .border_color(state === "error" ? alpha(t.blocked, 0.45) : open ? alpha(t.accent, 0.4) : alpha(t.border, 1))
    .bg(t.background)
    .child(
      h_flex()
        .id(`${key}-h`)
        .h(34)
        .px(10)
        .gap(9)
        .items_center()
        .cursor_pointer()
        .rounded(10)
        .hover(s => s.bg(alpha(t.foreground, 0.03)))
        .on_click((_e, cx) => ui.toggle(key, cx))
        .child(
          div()
            .flex_none()
            .w(20)
            .h(20)
            .rounded(6)
            .bg(alpha(t.accent, 0.1))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(TOOL_ICON[it.name] ?? "wrench", 11, t.accent)),
        )
        .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.foreground).child(it.name))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .font_family(mono())
            .text_size(11)
            .text_color(t.muted)
            .child(it.text || ""),
        )
        .when(!!file, el =>
          el.child(
            div()
              .id(`${key}-view`)
              .flex_none()
              .w(20)
              .h(20)
              .rounded(5)
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
              .child(icon("eye", 11, t.accent)),
          ),
        )
        .child(div().flex_none().font_family(mono()).text_size(10).text_color(t.dim).child(since(it.ts, start)))
        .child(
          state === "running" ? icon("spinner", 11, c).spin(900) : div().flex_none().w(7).h(7).rounded_full().bg(c),
        )
        .child(icon(open ? "chevron-down" : "chevron-right", 12, t.dim)),
    )
    .when(open, el => el.child(div().px(10).pb(10).pt(2).child(toolBody(t, it, key))))
    .when(!open && state === "error", el =>
      el.child(div().px(12).pb(9).font_family(mono()).text_size(10.5).text_color(t.blocked).child(clip(res.text, 220))),
    );
}

function message(t, it, key, start, cwd) {
  return h_flex()
    .id(key)
    .w_full()
    .items_start()
    .gap(10)
    .child(
      div()
        .flex_none()
        .mt(2)
        .w(22)
        .h(22)
        .rounded_full()
        .bg(alpha(t.accent, 0.14))
        .flex()
        .items_center()
        .justify_center()
        .child(icon("sparkles", 11, t.accent)),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(4)
        .child(
          h_flex()
            .gap(8)
            .child(div().text_size(11).font_semibold().text_color(t.foreground).child("Agent"))
            .child(div().font_family(mono()).text_size(10).text_color(t.dim).child(since(it.ts, start))),
        )
        .child(
          div()
            .text_size(12.5)
            .line_height(1.6)
            .text_color(t.foreground)
            .child(TextView.markdown(`${key}-md`, it.text).on_link_click(url => openLink(url, cwd))),
        ),
    );
}

function thinking(t, it, key, ui) {
  const open = ui.expanded.has(key);
  return v_flex()
    .id(key)
    .w_full()
    .pl(32)
    .gap(6)
    .child(
      h_flex()
        .id(`${key}-h`)
        .gap(6)
        .items_center()
        .cursor_pointer()
        .on_click((_e, cx) => ui.toggle(key, cx))
        .child(icon("brain", 12, t.dim))
        .child(
          div()
            .text_size(11)
            .italic()
            .text_color(t.dim)
            .child(open ? "Thinking" : clip(it.text, 90)),
        )
        .child(icon(open ? "chevron-down" : "chevron-right", 11, t.dim)),
    )
    .when(open, el =>
      el.child(
        div()
          .pl(10)
          .border_l(2)
          .border_color(alpha(t.border, 1))
          .text_size(12)
          .italic()
          .line_height(1.55)
          .text_color(t.muted)
          .child(it.text),
      ),
    );
}

function output(t, it, key) {
  return v_flex()
    .id(key)
    .w_full()
    .gap(8)
    .p(12)
    .rounded(10)
    .bg(alpha(ok(t), 0.06))
    .border(1)
    .border_color(alpha(ok(t), 0.35))
    .child(
      h_flex()
        .gap(7)
        .items_center()
        .child(icon("circle-check", 13, ok(t)))
        .child(div().text_size(11.5).font_semibold().text_color(ok(t)).child("Returned")),
    )
    .child(codeBox(t, it.text, { bg: alpha(t.background, 0.7) }));
}

const KEEP = {
  all: () => true,
  messages: it => it.kind === "text" || it.kind === "output" || it.kind === "thinking",
  tools: it => it.kind === "tool" || it.kind === "result",
  errors: it => (it.kind === "tool" && it.result?.error) || (it.kind === "result" && it.error),
};

/**
 * `ui`: { expanded: Set, toggle(key, cx), filter, setFilter(id, cx), latestFirst, setOrder(bool, cx),
 * running, prefix, onExpand?(cx), wide? }.
 */
export function transcript(data, t, ui) {
  const items = data.items
    .map((it, i) => ({ it, key: `${ui.prefix}-${i}` }))
    .filter(x => KEEP[ui.filter ?? "all"](x.it));
  if (ui.latestFirst) items.reverse();
  const errors = data.items.filter(KEEP.errors).length;
  const tools = data.items.filter(i => i.kind === "tool").length;
  const start = data.startedAt;
  return v_flex()
    .w_full()
    .gap(12)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .flex_wrap()
        .child(
          seg(
            t,
            `${ui.prefix}-filter`,
            [
              { id: "all", label: "All" },
              { id: "messages", label: "Messages" },
              { id: "tools", label: `Tools ${tools}` },
              { id: "errors", label: errors ? `Errors ${errors}` : "Errors" },
            ],
            ui.filter ?? "all",
            ui.setFilter,
            { size: "sm" },
          ),
        )
        .child(div().flex_1())
        .child(
          h_flex()
            .id(`${ui.prefix}-expand`)
            .h(28)
            .px(9)
            .gap(6)
            .items_center()
            .rounded(8)
            .cursor_pointer()
            .bg(ui.expandAll ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.05))
            .on_click((_e, cx) => ui.setExpandAll(!ui.expandAll, cx))
            .child(icon(ui.expandAll ? "shrink" : "expand", 11, ui.expandAll ? t.accent : t.dim))
            .child(div().text_size(11).text_color(ui.expandAll ? t.accent : t.muted).child(ui.expandAll ? "Collapse all" : "Expand all")),
        )
        .child(
          seg(
            t,
            `${ui.prefix}-order`,
            [
              { id: "old", label: "Oldest", icon: "arrow-down" },
              { id: "new", label: "Latest", icon: "arrow-up" },
            ],
            ui.latestFirst ? "new" : "old",
            (id, cx) => ui.setOrder(id === "new", cx),
            { size: "sm" },
          ),
        ),
    )
    .child(
      div()
        .text_size(10.5)
        .text_color(t.dim)
        .child(
          `${data.items.length} events${data.truncated ? ` · the latest part of a ${compact(data.size)}B transcript` : ""}`,
        ),
    )
    .when(!items.length, el =>
      el.child(div().py(16).text_center().text_size(12).text_color(t.dim).child("Nothing to show with this filter.")),
    )
    .children(
      items.map(({ it, key }) =>
        it.kind === "text"
          ? message(t, it, key, start, data.cwd)
          : it.kind === "thinking"
            ? thinking(t, it, key, ui)
            : it.kind === "tool"
              ? toolCard(t, it, key, ui, start)
              : it.kind === "output"
                ? output(t, it, key)
                : codeBox(t, cut(it.text, 400), { color: it.error ? t.blocked : t.dim }),
      ),
    );
}
