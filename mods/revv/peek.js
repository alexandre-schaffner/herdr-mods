// The code a finding points at, in a floating window: the flagged lines lit,
// a little context around them.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { closeOverlay, exec, props, readTextFile } from "herdr";
import { iconBtn } from "./ui.js";
import { alpha, checkoutFile, icon, mono, palette, SEVERITY } from "./util.js";

const BEFORE = 8;
const AFTER = 24;

export class PeekState {
  constructor(cx, given = props() ?? {}) {
    const { root, filePath } = given;
    this.lines = null;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const file = checkoutFile(root, filePath);
        if (!file) {
          this.error = "This finding points outside the checkout, so it isn't shown.";
          cx.notify();
          return;
        }
        const text = await readTextFile(file);
        if (text === null)
          this.error =
            "This file isn't in your checkout (it may have moved, or the branch differs).";
        else if (text.includes("\0")) this.error = "Binary file, no preview.";
        else this.lines = text.split("\n");
      } catch {
        this.error = "Couldn't read this file.";
      }
      cx.notify();
    });
  }
}

export function renderPeek(state, t, given = props() ?? {}) {
  const { filePath, startLine, endLine, title, severity, overlay, root } = given;
  const p = palette(t);
  const color = p[severity] ?? t.accent;
  const start = Math.max(1, startLine ?? 1);
  const end = Math.max(start, endLine ?? start);
  const from = Math.max(1, start - BEFORE);
  const to = state.lines ? Math.min(state.lines.length, end + AFTER) : 0;
  const rows = [];
  for (let n = from; state.lines && n <= to; n++) {
    const lit = startLine != null && n >= start && n <= end;
    rows.push(
      h_flex()
        .w_full()
        .h(19)
        .flex_none()
        .when(lit, (el) => el.bg(alpha(color, 0.12)))
        .child(
          div()
            .w(3)
            .h_full()
            .flex_none()
            .when(lit, (el) => el.bg(color)),
        )
        .child(
          div()
            .w(46)
            .pr(12)
            .flex_none()
            .text_right()
            .text_color(lit ? color : t.dim)
            .child(String(n)),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_color(lit ? t.foreground : t.muted)
            .child((state.lines[n - 1] ?? "").replace(/\t/g, "  ") || " "),
        ),
    );
  }
  return v_flex()
    .size_full()
    .bg(t.background)
    .rounded(12)
    .overflow_hidden()
    .child(
      h_flex()
        .h(44)
        .flex_none()
        .px(14)
        .gap(9)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(icon(SEVERITY[severity]?.icon ?? "file", 14, color))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              div()
                .truncate()
                .text_size(12.5)
                .font_semibold()
                .text_color(t.foreground)
                .child(title ?? filePath),
            )
            .child(
              div()
                .truncate()
                .text_size(10.5)
                .font_family(mono())
                .text_color(t.dim)
                .child(
                  `${filePath}${startLine != null ? `:${start}${end !== start ? `–${end}` : ""}` : ""}`,
                ),
            ),
        )
        .child(
          iconBtn(
            t,
            "peek-open",
            "external",
            () => {
              // `-t`: the default text editor. A bare `open` would run a
              // `.command`, `.app` or `.tool` a hostile PR named.
              const file = checkoutFile(root, filePath);
              if (file) void exec("open", ["-t", file]);
            },
            "Open in your editor",
          ),
        )
        .child(iconBtn(t, "peek-close", "x", () => closeOverlay(overlay), "Close")),
    )
    .child(
      v_flex()
        .id("peek-code")
        .flex_1()
        .min_h(0)
        .py(8)
        .overflow_y_scrollbar()
        .font_family(mono())
        .text_size(12)
        .when(Boolean(state.error), (el) =>
          el.child(div().p(14).text_size(12).text_color(t.muted).child(state.error)),
        )
        .when(!state.error && !state.lines, (el) =>
          el.child(div().p(14).text_color(t.dim).child("Loading…")),
        )
        .children(rows),
    );
}
