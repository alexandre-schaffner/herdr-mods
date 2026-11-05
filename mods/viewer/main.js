// Viewer: images, videos, Markdown and PDFs, opened by other mods.
//
//   openOverlay({ mod: "viewer", kind: "dialog", width: 0.86, height: 0.9, props: { file, files } })
//   run("pane.split", { direction: "right", mod: "viewer", props: { file } })
//
// `file` is an absolute path; `files` (optional) are its neighbours, stepped through with
// ←/→ or [ and ]. Every file is staged by media.py before it is drawn (see there why).

import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { closeOverlay, home, nextCommand, notify, props, theme } from "herdr";
import { ImageView } from "./image.js";
import { MarkdownView } from "./markdown.js";
import { KIND_ICON, kindOf, media } from "./media.js";
import { PdfView } from "./pdf.js";
import { alpha, button, divider, icon, loading, mono, notice, openExternally, reveal } from "./ui.js";
import { VideoView } from "./video.js";

const VIEWS = { image: ImageView, video: VideoView, markdown: MarkdownView, pdf: PdfView };
const PRUNE_EVERY = 24 * 3600 * 1000;

const baseName = p => p.slice(p.lastIndexOf("/") + 1);
const dirName = p => p.slice(0, p.lastIndexOf("/")) || "/";
const tildify = p => (home() && p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);

/** `target` against `dir`, with `.` and `..` worked out. */
function resolvePath(target, dir) {
  const abs = target.startsWith("/") ? target : target.startsWith("~/") ? home() + target.slice(1) : `${dir}/${target}`;
  const out = [];
  for (const part of abs.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return "/" + out.join("/");
}

export default class Viewer extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.stageSize = { width: 900, height: 600 };
    this.back = []; // where links came from: { files, index }
    const p = props() ?? {};
    const files = (p.files?.length ? p.files : [p.file]).filter(Boolean);
    this.show(files, Math.max(0, files.indexOf(p.file)), cx);

    if (p.overlay) this.handle.focus();
    cx.spawn(async cx => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.handle.focus();
        cx.notify();
      }
    });
    this.pruneNow();
  }

  async close() {
    await this.view?.close?.();
  }

  /** The stage's size, for views that fit themselves to it. */
  stage() {
    return this.stageSize;
  }

  // ─── what's shown ──────────────────────────────────────────────────────

  show(files, index, cx) {
    this.view?.close?.();
    this.files = files;
    this.index = index;
    this.file = files[index] ?? null;
    this.kind = this.file ? kindOf(this.file) : null;
    this.error = null;
    this.view = null;
    this.ready = false;
    this.token = (this.token ?? 0) + 1;
    if (!this.file || !this.kind) return cx.notify();
    const token = this.token;
    const view = new VIEWS[this.kind](this.file, this);
    this.view = view;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await view.load();
      } catch (err) {
        if (token === this.token) this.error = err.message || String(err);
      }
      if (token !== this.token) return;
      this.ready = true;
      cx.notify();
    });
  }

  step(dir, cx) {
    if (this.files.length < 2) return;
    this.show(this.files, (this.index + dir + this.files.length) % this.files.length, cx);
  }

  goBack(cx) {
    const prev = this.back.pop();
    if (prev) this.show(prev.files, prev.index, cx);
  }

  /** A link inside a document: another viewable file opens here, anything else outside. */
  openLink(url, cx) {
    if (!url || url.startsWith("#")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) {
      openExternally(url);
      return;
    }
    const path = resolvePath(decodeURIComponent(url.replace(/^file:\/\//, "").replace(/[#?].*$/, "")), dirName(this.file));
    if (!kindOf(path)) {
      openExternally(path);
      return;
    }
    this.back.push({ files: this.files, index: this.index });
    this.show([path], 0, cx);
  }

  fail(message, cx) {
    this.error = message;
    cx.notify();
  }

  copyPath(cx) {
    cx.write_to_clipboard(this.file);
    notify({ title: "Path copied", body: tildify(this.file), level: "success", timeout: 1600 });
  }

  dismiss() {
    const p = props() ?? {};
    if (p.overlay) closeOverlay(p.overlay);
  }

  /** Old staged files go once a day, whoever opens the viewer. */
  pruneNow() {
    const last = Number(localStorage.getItem("pruned") || 0);
    if (Date.now() - last < PRUNE_EVERY) return;
    localStorage.setItem("pruned", String(Date.now()));
    media("prune").catch(() => {});
  }

  // ─── keys ──────────────────────────────────────────────────────────────

  onKey(e, cx) {
    if (e.modifiers?.platform || e.modifiers?.control) return;
    if (this.ready && !this.error && this.view?.key(e, cx)) return;
    const k = e.key;
    if (k === "left" || k === "[") this.step(-1, cx);
    else if (k === "right" || k === "]") this.step(1, cx);
    else if (k === "backspace" && this.back.length) this.goBack(cx);
  }

  // ─── look ──────────────────────────────────────────────────────────────

  header(t) {
    const overlay = !!props()?.overlay;
    const live = this.ready && !this.error && this.view;
    const subtitle = live ? this.view.subtitle() : this.kind ? "" : "Not a file the viewer knows";
    return h_flex()
      .flex_none()
      .h(52)
      .pl(14)
      .pr(10)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.8))
      .bg(t.surface)
      .when(this.back.length > 0, el => el.child(button(t, "back", "", cx => this.goBack(cx), { icon: "arrow-left", tip: "Back  ⌫" })))
      .child(
        div()
          .flex_none()
          .w(30)
          .h(30)
          .rounded(8)
          .bg(alpha(t.accent, 0.12))
          .flex()
          .items_center()
          .justify_center()
          .child(icon(KIND_ICON[this.kind] ?? "file-text", 15, t.accent)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(this.file ? baseName(this.file) : "Nothing to show"))
          .child(
            h_flex()
              .min_w(0)
              .gap(8)
              .text_size(11)
              .child(div().flex_none().text_color(t.muted).child(subtitle))
              .when(!!this.file, el => el.child(div().min_w(0).truncate().font_family(mono()).text_color(t.dim).child(tildify(dirName(this.file))))),
          ),
      )
      .when(this.files.length > 1, el =>
        el.child(
          h_flex()
            .flex_none()
            .gap(2)
            .items_center()
            .child(button(t, "prev-file", "", cx => this.step(-1, cx), { icon: "chevron-left", tip: "Previous file  [" }))
            .child(div().text_size(11.5).font_family(mono()).text_color(t.dim).child(`${this.index + 1}/${this.files.length}`))
            .child(button(t, "next-file", "", cx => this.step(1, cx), { icon: "chevron-right", tip: "Next file  ]" }))
            .child(divider(t)),
        ),
      )
      .when(!!live, el => el.child(h_flex().flex_none().gap(4).items_center().children(this.view.toolbar(t))).child(divider(t)))
      .when(!!this.file, el =>
        el
          .child(button(t, "reveal", "", () => reveal(this.file), { icon: "folder", tip: "Show in Finder" }))
          .child(button(t, "external", "", () => openExternally(this.file), { icon: "external", tip: "Open with the default app" }))
          .child(button(t, "copy-path", "", cx => this.copyPath(cx), { icon: "copy", tip: "Copy path" })),
      )
      .when(overlay, el => el.child(button(t, "close", "", () => this.dismiss(), { icon: "x", tip: "Close  esc" })));
  }

  body(t) {
    if (!this.file) return notice(t, "image", "Nothing to show", "Open an image, a video, a Markdown file or a PDF.");
    if (!this.kind)
      return notice(t, "file-text", `The viewer can't show .${baseName(this.file).split(".").pop()} files`, null,
        button(t, "open-other", "Open with the default app", () => openExternally(this.file), { icon: "external" }));
    if (this.error)
      return notice(t, "alert", "Couldn't open this file", this.error,
        button(t, "open-err", "Open with the default app", () => openExternally(this.file), { icon: "external" }));
    if (!this.ready) return loading(t, this.kind === "video" ? "Reading the video…" : this.kind === "pdf" ? "Rendering…" : null);
    return this.view.body(t);
  }

  render(_cx) {
    const t = theme();
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => {
        if (!this.view?.ownsFocus?.()) this.handle.focus();
      })
      .child(this.header(t))
      .child(
        div()
          .id("stage")
          .flex_1()
          .min_h(0)
          .flex()
          .flex_col()
          .on_size_change((size, cx) => {
            if (size.width === this.stageSize.width && size.height === this.stageSize.height) return;
            this.stageSize = size;
            cx.notify();
          })
          .child(this.body(t)),
      );
  }
}
