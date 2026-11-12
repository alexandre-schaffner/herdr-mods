// HQ's file viewer: a Markdown file or a picture opened from anywhere in HQ (links in the chat or
// in rendered Markdown, briefs, memory) shows in a pane on the right, beside the view it came
// from, instead of in another app. Markdown is rendered with its ```mermaid diagrams drawn
// (shared/rich.js). Web pages and everything else still open in their app (the browser).
//
// It takes files through shared/viewer-link.js's host hook, from click handlers that have no
// `cx`: state changes then redraw HQ through setShared (every mod redraws on a shared change).

import { div, image } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, home, readTextFile, setShared } from "herdr";

import { richMarkdown } from "./shared/claude-rows.js";
import { kindOf } from "./shared/media-kinds.js";
import { cacheImage, openRich, richImage } from "./shared/rich.js";
import { setViewerHost } from "./shared/viewer-link.js";
import { alpha, btn, drawer, icon, row, scrollY, SP, tildify, TYPE } from "./ui.js";

const SHOWS = new Set(["markdown", "image"]);
const WIDTH = 640;
const redraw = () => setShared("hq.viewer", Date.now());

export class Viewer {
  constructor() {
    this.file = null;
    this.open = new Set(); // diagrams whose code shows
    setViewerHost((file) => this.take(file));
  }

  /** Shows `file` when it's Markdown or a picture; false hands it to its app. */
  take(file) {
    const kind = kindOf(file);
    if (!SHOWS.has(kind)) return false;
    const at = Date.now();
    Object.assign(this, { file, kind, text: null, img: null, error: null, at });
    const done = (fn) => (v) => {
      if (this.at !== at) return;
      fn(v);
      redraw();
    };
    if (kind === "image") cacheImage(file).then(done((rel) => (rel ? (this.img = rel) : (this.error = "This picture couldn't be read."))));
    else
      readTextFile(file)
        .then(done((text) => (text == null ? (this.error = "The file is gone or too big to show (over 1 MB).") : (this.text = text))))
        .catch(done((e) => (this.error = String(e?.message ?? e))));
    redraw();
    return true;
  }

  close(cx) {
    this.file = null;
    this.at = 0;
    cx.notify();
  }

  get shown() {
    return !!this.file;
  }

  /** The right pane: the file's name and folder, ways out, and the file. */
  render(t, cx) {
    const file = this.file;
    const cut = file.lastIndexOf("/");
    const head = row()
      .flex_none()
      .px(SP.lg)
      .py(SP.md)
      .gap(SP.sm)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .child(icon(this.kind === "image" ? "image" : "file-text", 14, t.accent))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(file.slice(cut + 1)))
          .child(div().truncate().text_size(TYPE.meta).text_color(t.dim).child(tildify(file.slice(0, cut), home()))),
      )
      .child(btn(t, "view-app", "Open in app", () => exec("open", [file]).catch(() => {}), { size: "sm", icon: "external", kind: "ghost" }))
      .child(btn(t, "view-reveal", null, () => exec("open", ["-R", file]).catch(() => {}), { size: "sm", icon: "folder", kind: "ghost", tooltip: "Show in Finder" }));
    return drawer(t, {
      id: "viewer",
      width: WIDTH,
      title: this.kind === "image" ? "Picture" : "Markdown",
      onClose: (cx) => this.close(cx),
      body: v_flex().flex_1().min_h(0).child(head).child(this.body(t)),
    });
  }

  body(t) {
    const note = (text, tone) => v_flex().flex_1().items_center().justify_center().p(SP.xxl).child(div().text_size(TYPE.ui).text_color(tone ?? t.muted).child(text));
    if (this.error) return note(this.error, t.blocked);
    if (this.kind === "image") return this.img ? scrollY("view-scroll", v_flex().p(SP.lg).child(image(this.img).w_full())) : note("Reading…");
    if (this.text == null) return note("Reading…");
    const ctx = {
      cwd: this.file.slice(0, this.file.lastIndexOf("/")),
      colW: WIDTH - 2 * SP.xl,
      rich: (kind, code) => richImage(kind, code),
      openRich: (kind, code) => openRich(richImage(kind, code)),
      isOpen: (key, byDefault) => byDefault !== this.open.has(key),
      toggle: (key, cx) => {
        if (this.open.has(key)) this.open.delete(key);
        else this.open.add(key);
        cx.notify();
      },
    };
    return scrollY("view-scroll", v_flex().px(SP.xl).py(20).child(richMarkdown(`view-md-${this.at}`, this.text, t, TYPE.body, ctx)));
  }
}
