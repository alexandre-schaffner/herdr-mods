// Markdown: rendered in a reading column, or the source with line numbers. Links to
// other files open in the viewer; web links open in the browser.

import { div } from "gpui-kit";
import { Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, theme } from "herdr";
import { alpha, bytes, facts, mono, scroller, segmented } from "./ui.js";

const COLUMN = 860;
const MAX_CHARS = 2_000_000;

export class MarkdownView {
  constructor(file, host) {
    this.file = file;
    this.host = host;
    this.text = "";
    this.clipped = false;
    this.mode = "rendered";
    this.source = null;
  }

  async load() {
    const text = await readTextFile(this.file);
    this.clipped = text.length > MAX_CHARS;
    this.text = this.clipped ? text.slice(0, MAX_CHARS) : text;
  }

  subtitle() {
    const lines = this.text ? this.text.replace(/\n$/, "").split("\n").length : 0;
    const words = this.text.match(/\S+/g)?.length ?? 0;
    return facts("Markdown", `${lines} lines`, `${words.toLocaleString()} words`, bytes(this.text.length), this.clipped ? "clipped" : "");
  }

  toolbar(t) {
    return [
      segmented(
        t,
        "md-mode",
        [
          { id: "rendered", label: "Preview", icon: "eye", tip: "Rendered  p" },
          { id: "source", label: "Source", icon: "code", tip: "Source  s" },
        ],
        this.mode,
        (id, cx) => this.setMode(id, cx),
      ),
    ];
  }

  setMode(mode, cx) {
    if (mode === "source") this.makeSource();
    this.mode = mode;
    cx.notify();
  }

  /** The source view's state: made on the first switch to it (never while rendering). */
  makeSource() {
    if (!this.source) {
      const t = theme();
      this.source = EditorState.new({
        language: "markdown",
        value: this.text,
        readonly: true,
        soft_wrap: true,
        font_family: mono(),
        syntax: {
          keyword: t.ansi5 ?? t.accent,
          string: t.ansi2 ?? t.foreground,
          comment: t.dim,
          function: t.ansi4 ?? t.accent,
          type: t.ansi3 ?? t.foreground,
          number: t.ansi3 ?? t.foreground,
          constant: t.ansi6 ?? t.foreground,
          punctuation: t.muted,
        },
      });
    }
  }

  body(t) {
    if (this.mode === "source") return div().size_full().bg(t.background).child(Editor.new(this.source));
    const page = div()
      .w_full()
      .flex()
      .justify_center()
      .child(
        div()
          .w_full()
          .max_w(COLUMN)
          .px(40)
          .pt(28)
          .pb(56)
          .text_size(14)
          .line_height(1.7)
          .text_color(t.foreground)
          .child(TextView.markdown("md-text", this.text).selectable(true).on_link_click((url, cx) => this.host.openLink(url, cx))),
      );
    return div().size_full().bg(alpha(t.foreground, 0.012)).flex().flex_col().child(scroller("md-scroll", "y", page));
  }

  /** The source editor keeps the keyboard while it's shown (selection, copy). */
  ownsFocus() {
    return this.mode === "source";
  }

  key(e, cx) {
    if (e.key === "p") this.setMode("rendered", cx);
    else if (e.key === "s") this.setMode("source", cx);
    else return false;
    return true;
  }

  close() {
    this.source?.release();
  }
}
