// Library: the artifacts the person asked the master to make (`hq artifact add`), kept with what
// was asked, versioned, and previewed in place: Markdown rendered, images shown, code and data in a
// read-only editor; HTML, PDFs, slides and links open where they belong.

import { Editor, EditorState, h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, image } from "gpui-kit";
import { appHome, exec, readTextFile, settings } from "herdr";

import { ago, alpha, btn, chip, clip, drawer, frame, icon, mdBlock, mono, ok, pane, row, scrollY, SP, TYPE } from "./ui.js";

const KIND = {
  markdown: { icon: "file-md", word: "Document" },
  html: { icon: "code", word: "Web page" },
  image: { icon: "image", word: "Image" },
  pdf: { icon: "file-pdf", word: "PDF" },
  video: { icon: "film", word: "Video" },
  data: { icon: "braces", word: "Data" },
  code: { icon: "code", word: "Code" },
  text: { icon: "file-text", word: "Text" },
  slides: { icon: "layers", word: "Slides" },
  doc: { icon: "file-text", word: "Document" },
  sheet: { icon: "list", word: "Spreadsheet" },
  link: { icon: "external", word: "Link" },
  folder: { icon: "folder", word: "Folder" },
  file: { icon: "file-text", word: "File" },
};
const LANG = { js: "javascript", mjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "javascript", py: "python", rs: "rust", go: "go", sh: "bash", sql: "sql", css: "css", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", html: "html", swift: "swift", java: "java", rb: "ruby" };
const TEXT_KINDS = new Set(["markdown", "code", "data", "text"]);
const TEXT_KEEP = 6;

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.sel = null;
    this.ver = null;
    this.kind = "all";
    this.q = "";
    this.text = {}; // path -> text
    this.confirmRm = false;
    this.focus = false;
    this.search = InputState.new({ placeholder: "Search the library" });
    this.search.on("change", (_e, cx) => ((this.q = this.search.value().trim().toLowerCase()), cx.notify()));
    this.search.on("focus", (_e, cx) => ((this.focus = true), cx.notify()));
    this.search.on("blur", (_e, cx) => ((this.focus = false), cx.notify()));
    this.code = EditorState.new({ language: "markdown", value: "", readonly: true, soft_wrap: true, font_family: settings()?.font_family || "JetBrains Mono", font_size: 12.5 });
  }

  typing() {
    return this.focus;
  }

  items() {
    return this.app.data?.artifacts ?? [];
  }

  shown() {
    return this.items().filter(
      a =>
        (this.kind === "all" || a.kind === this.kind) &&
        (!this.q || [a.title, a.summary, a.request, ...(a.tags ?? [])].join(" ").toLowerCase().includes(this.q)),
    );
  }

  current() {
    return this.items().find(a => a.id === this.sel) ?? null;
  }

  version(a) {
    return a.versions?.find(v => v.v === this.ver) ?? a.versions?.[a.versions.length - 1];
  }

  /** Absolute path of a version's main file, or null for links. */
  pathOf(a, v) {
    return v?.main && a.dir ? `${a.dir}/${v.main}` : null;
  }

  select(id, cx) {
    this.sel = this.sel === id ? null : id;
    this.ver = null;
    this.confirmRm = false;
    const a = this.current();
    if (a) this.load(a, cx);
    cx.notify();
  }

  load(a, cx) {
    const v = this.version(a);
    const p = this.pathOf(a, v);
    if (!p || !TEXT_KINDS.has(a.kind)) return;
    const ext = p.split(".").pop().toLowerCase();
    cx.spawn(async cx => {
      const text = this.text[p] ?? (await readTextFile(p).catch(() => null)) ?? "";
      // Keep the last few files read, not every one opened.
      delete this.text[p];
      this.text[p] = text;
      for (const old of Object.keys(this.text).slice(0, -TEXT_KEEP)) delete this.text[old];
      if (a.kind !== "markdown") {
        this.code.release?.();
        this.code = EditorState.new({ language: LANG[ext] ?? "text", value: text, readonly: true, soft_wrap: a.kind === "text", font_family: settings()?.font_family || "JetBrains Mono", font_size: 12.5 });
      }
      cx.notify();
    });
  }

  open(a, v) {
    const p = this.pathOf(a, v);
    // The detail pane already shows Markdown and pictures: Open is for the app (a page: the browser).
    exec("open", [p ?? a.url]).catch(() => {});
  }

  onKey(e, cx) {
    const list = this.shown();
    const i = list.findIndex(a => a.id === this.sel);
    if (e.key === "j" || e.key === "down") return list[i + 1] && this.select(list[i + 1].id, cx), true;
    if (e.key === "k" || e.key === "up") return i > 0 && this.select(list[i - 1].id, cx), true;
    if (e.key === "enter" && this.current()) return this.open(this.current(), this.version(this.current())), true;
    if (e.key === "escape" && this.sel) return (this.sel = null), cx.notify(), true;
    return false;
  }

  render(t, cx) {
    const a = this.current();
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.list(t))
      .when(!!a, el =>
        el.child(
          drawer(t, {
            id: "lib-drawer",
            title: KIND[a.kind]?.word ?? "Artifact",
            width: a.kind === "markdown" || a.kind === "code" || a.kind === "data" ? 680 : 560,
            onClose: cx => ((this.sel = null), cx.notify()),
            body: this.detail(t, a),
          }),
        ),
      );
  }

  list(t) {
    const d = this.app.data;
    const all = this.items();
    const rows = this.shown();
    const kinds = ["all", ...new Set(all.map(a => a.kind))];
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        row()
          .flex_none()
          .px(SP.xl)
          .py(SP.md)
          .gap(SP.md)
          .items_center()
          .border_b(1)
          .border_color(alpha(t.border, 0.6))
          .child(
            v_flex()
              .flex_none()
              .gap(2)
              .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Library"))
              .child(div().text_size(TYPE.meta).text_color(t.muted).child(`${all.length} artifact${all.length === 1 ? "" : "s"} the master made for you`)),
          )
          .child(div().w(SP.md))
          .child(div().flex_1().max_w(340).min_w(160).child(frame(t, Input.new(this.search).w_full(), this.focus)))
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .overflow_hidden()
              .children(
                kinds.map(k =>
                  div()
                    .id(`lib-kind-${k}`)
                    .flex_none()
                    .h(24)
                    .px(9)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .text_size(TYPE.meta)
                    .when(this.kind === k, el => el.bg(alpha(t.accent, 0.14)).text_color(t.accent).font_medium())
                    .when(this.kind !== k, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
                    .on_click((_e, cx) => ((this.kind = k), cx.notify()))
                    .child(k === "all" ? "All" : (KIND[k]?.word ?? k)),
                ),
              ),
          ),
      )
      .child(
        all.length === 0
          ? v_flex()
              .flex_1()
              .items_center()
              .justify_center()
              .gap(SP.sm)
              .child(icon("folder", 24, t.muted))
              .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Nothing in the library yet"))
              .child(
                div()
                  .max_w(480)
                  .text_center()
                  .text_size(TYPE.ui)
                  .line_height(1.5)
                  .text_color(t.muted)
                  .child("Ask the master for a document, a diagram, a page or a deck. It stores what it makes here with what you asked for, and keeps every version."),
              )
          : scrollY(
              "lib-list",
              v_flex()
                .px(SP.lg)
                .py(SP.sm)
                .gap(2)
                .children(rows.length ? rows.map(a => this.row(t, a, d.now)) : [div().p(SP.lg).text_size(TYPE.ui).text_color(t.muted).child("Nothing matches.")]),
            ),
      );
  }

  row(t, a, now) {
    const on = this.sel === a.id;
    const k = KIND[a.kind] ?? KIND.file;
    const nv = a.versions?.length ?? 1;
    return row()
      .id(`lib-${a.id}`)
      .px(SP.md)
      .py(10)
      .gap(SP.md)
      .items_start()
      .rounded(8)
      .cursor_pointer()
      .when(on, el => el.bg(alpha(t.accent, 0.08)).border(1).border_color(alpha(t.accent, 0.4)))
      .when(!on, el => el.border(1).border_color(alpha(t.border, 0)).hover(s => s.bg(alpha(t.foreground, 0.04))))
      .on_click((_e, cx) => this.select(a.id, cx))
      .child(
        div()
          .flex_none()
          .w(34)
          .h(34)
          .rounded(8)
          .bg(alpha(t.foreground, 0.06))
          .flex()
          .items_center()
          .justify_center()
          .child(icon(k.icon, 16, t.muted)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).truncate().text_size(TYPE.body).font_medium().text_color(t.foreground).child(a.title))
              .when(nv > 1, el => el.child(chip(t, `v${nv}`, t.muted))),
          )
          .when(!!(a.summary || a.request), el => el.child(div().text_size(TYPE.ui).line_height(1.4).text_color(t.muted).child(clip(a.summary || `You asked: ${a.request}`, 160))))
          .when((a.tags ?? []).length > 0, el => el.child(h_flex().gap(4).flex_wrap().children(a.tags.slice(0, 5).map(x => chip(t, x, t.muted))))),
      )
      .child(
        v_flex()
          .flex_none()
          .items_end()
          .gap(2)
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(k.word))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(ago(a.updatedAt, now))),
      );
  }

  detail(t, a) {
    const d = this.app.data;
    const v = this.version(a);
    const p = this.pathOf(a, v);
    const rel = p && p.startsWith(appHome() + "/") ? p.slice(appHome().length + 1) : null;
    const text = p ? this.text[p] : null;
    let preview = null;
    if (a.kind === "image" && rel) preview = div().w_full().rounded(8).overflow_hidden().border(1).border_color(alpha(t.border, 0.7)).child(image(rel).w_full());
    else if (a.kind === "markdown") preview = text == null ? div().text_size(TYPE.ui).text_color(t.muted).child("Reading…") : mdBlock(t, `lib-md-${a.id}-${v?.v}`, text, { maxW: 640, cwd: p.slice(0, p.lastIndexOf("/")) });
    else if (TEXT_KINDS.has(a.kind)) preview = div().h(420).rounded(8).overflow_hidden().border(1).border_color(alpha(t.border, 0.7)).bg(t.background).child(Editor.new(this.code).size_full());
    else
      preview = row()
        .p(SP.lg)
        .gap(SP.md)
        .items_center()
        .rounded(10)
        .bg(alpha(t.foreground, 0.04))
        .child(icon(KIND[a.kind]?.icon ?? "file-text", 22, t.muted))
        .child(
          div()
            .flex_1()
            .text_size(TYPE.ui)
            .text_color(t.muted)
            .child(a.kind === "link" ? "A published page. Open it in your browser." : `${KIND[a.kind]?.word ?? "This file"} opens in its own app.`),
        );
    const versions = [...(a.versions ?? [])].reverse();
    return pane(
      `lib-detail-${a.id}`,
      v_flex()
        .gap(SP.lg)
        .child(
          v_flex()
            .gap(6)
            .child(div().text_size(TYPE.heading).font_semibold().text_color(t.foreground).child(a.title))
            .child(
              div()
                .text_size(TYPE.meta)
                .text_color(t.muted)
                .child(`${KIND[a.kind]?.word ?? "File"} · v${v?.v ?? 1} · ${a.by ? `by ${a.by} · ` : ""}${ago(v?.at ?? a.updatedAt, d.now)}`),
            )
            .when(!!a.request, el =>
              el.child(
                row()
                  .gap(SP.sm)
                  .items_start()
                  .p(SP.sm)
                  .rounded(8)
                  .bg(alpha(t.accent, 0.06))
                  .child(icon("user", 12, t.accent))
                  .child(div().flex_1().text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child(`You asked: ${a.request}`)),
              ),
            )
            .when(!!a.summary, el => el.child(div().text_size(TYPE.ui).line_height(1.5).text_color(t.foreground).child(a.summary))),
        )
        .child(
          h_flex()
            .gap(SP.sm)
            .flex_wrap()
            .child(btn(t, "lib-open", a.kind === "link" ? "Open link" : "Open", () => this.open(a, v), { kind: "primary", size: "sm", icon: "external", kbd: "↵" }))
            .when(!!p, el =>
              el
                .child(btn(t, "lib-reveal", "Show in Finder", () => exec("open", ["-R", p]).catch(() => {}), { size: "sm", icon: "folder" }))
                .child(btn(t, "lib-copy", "Copy path", () => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", p]).catch(() => {}), { size: "sm", kind: "ghost", icon: "copy" })),
            )
            .when(!!a.url && a.kind !== "link", el => el.child(btn(t, "lib-url", "Published page", () => exec("open", [a.url]).catch(() => {}), { size: "sm", kind: "ghost", icon: "external" })))
            .child(div().flex_1())
            .child(
              btn(
                t,
                "lib-rm",
                this.confirmRm ? "Confirm delete" : "Delete",
                cx => {
                  if (!this.confirmRm) {
                    this.confirmRm = true;
                    cx.notify();
                    return;
                  }
                  this.app.act(cx, `lib-rm-${a.id}`, ["artifact", "rm", a.id], { done: `Deleted ${a.title}`, then: (_r, cx) => ((this.sel = null), cx.notify()) });
                },
                { size: "sm", kind: this.confirmRm ? "danger" : "ghost", icon: "trash" },
              ),
            ),
        )
        .child(preview)
        .when(versions.length > 1, el =>
          el.child(
            v_flex()
              .gap(4)
              .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child(`Versions · ${versions.length}`))
              .children(
                versions.map(x =>
                  row()
                    .id(`lib-v-${a.id}-${x.v}`)
                    .px(SP.sm)
                    .py(6)
                    .gap(SP.sm)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(x.v === v?.v, e2 => e2.bg(alpha(t.accent, 0.08)))
                    .hover(s => s.bg(alpha(t.foreground, 0.05)))
                    .on_click((_e, cx) => {
                      this.ver = x.v;
                      this.load(a, cx);
                      cx.notify();
                    })
                    .child(div().w(28).text_size(TYPE.meta).font_semibold().text_color(x.v === v?.v ? t.accent : t.muted).child(`v${x.v}`))
                    .child(div().flex_1().min_w(0).truncate().text_size(TYPE.meta).text_color(t.foreground).child(x.note || (x.main ?? x.url ?? "").split("/").pop()))
                    .child(div().text_size(TYPE.meta).text_color(t.muted).child(ago(x.at, d.now))),
                ),
              ),
          ),
        )
        .when(!!p, el => el.child(div().text_size(TYPE.meta).font_family(mono()).text_color(t.muted).child(p.replace(/^\/Users\/[^/]+/, "~")))),
    );
  }
}
