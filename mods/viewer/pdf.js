// PDFs: one page at a time, rendered by media.py, fit to the width or the whole page.
// One page at a time on purpose: Herdr keeps every image it has drawn until it quits,
// so only the pages someone actually looks at are ever drawn.

import { div, image } from "gpui-kit";
import { media } from "./media.js";
import { alpha, bytes, button, divider, facts, loading, notice, scroller, segmented } from "./ui.js";

const PAD = 28;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export class PdfView {
  constructor(file, host) {
    this.file = file;
    this.host = host;
    this.info = null;
    this.page = 1;
    this.pages = new Map(); // n → staged src
    this.failed = new Map(); // n → message
    this.fit = "width"; // "width" | "page"
    this.zoom = 1;
  }

  async load() {
    this.info = await media("pdf", this.file);
    await this.render(1);
  }

  async render(n) {
    if (this.pages.has(n) || this.failed.has(n)) return;
    try {
      this.pages.set(n, (await media("page", this.file, n)).src);
    } catch (err) {
      this.failed.set(n, err.message);
    }
  }

  go(n, cx) {
    const count = this.info?.pages ?? 1;
    const next = Math.max(1, Math.min(count, n));
    if (next === this.page) return;
    this.page = next;
    cx.notify();
    cx.spawn(async cx => {
      await this.render(next);
      cx.notify();
      if (next < count) this.render(next + 1); // ready on disk for the next press
    });
  }

  zoomBy(dir, cx) {
    const i = ZOOMS.indexOf(this.zoom);
    this.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    cx.notify();
  }

  subtitle() {
    const n = this.info?.pages;
    return facts("PDF", n ? `${n} page${n === 1 ? "" : "s"}` : "", bytes(this.info?.bytes));
  }

  toolbar(t) {
    const count = this.info?.pages ?? 1;
    return [
      button(t, "pdf-prev", "", cx => this.go(this.page - 1, cx), { icon: "chevron-left", disabled: this.page <= 1, tip: "Previous page  ←" }),
      div().flex_none().min_w(64).text_center().text_size(12).text_color(t.muted).child(`${this.page} / ${count}`),
      button(t, "pdf-next", "", cx => this.go(this.page + 1, cx), { icon: "chevron-right", disabled: this.page >= count, tip: "Next page  →" }),
      divider(t),
      segmented(
        t,
        "pdf-fit",
        [
          { id: "width", label: "Width", tip: "Fit the page's width" },
          { id: "page", label: "Page", tip: "Fit the whole page" },
        ],
        this.fit,
        (id, cx) => {
          this.fit = id;
          this.zoom = 1;
          cx.notify();
        },
      ),
      button(t, "pdf-out", "", cx => this.zoomBy(-1, cx), { icon: "minus", disabled: this.zoom === ZOOMS[0], tip: "Zoom out  −" }),
      button(t, "pdf-in", "", cx => this.zoomBy(1, cx), { icon: "plus", disabled: this.zoom === ZOOMS.at(-1), tip: "Zoom in  +" }),
    ];
  }

  body(t) {
    const src = this.pages.get(this.page);
    if (this.failed.has(this.page)) return notice(t, "alert", `Page ${this.page} didn't render`, this.failed.get(this.page));
    if (!src) return loading(t);
    const stage = this.host.stage();
    const ratio = (this.info?.height || 792) / (this.info?.width || 612);
    const byWidth = stage.width - PAD * 2;
    const base = this.fit === "width" ? byWidth : Math.min(byWidth, (stage.height - PAD * 2) / ratio);
    const w = Math.max(80, Math.round(base * this.zoom));
    const h = Math.round(w * ratio);
    const sheet = div()
      .flex()
      .justify_center()
      .items_start()
      .p(PAD)
      .min_w(Math.max(stage.width, w + PAD * 2))
      .min_h(stage.height)
      .bg(alpha(t.foreground, 0.025))
      .child(image(src).w(w).h(h).flex_none().rounded(2).shadow_md());
    // A scroll area per page and zoom: each opens at its top.
    return scroller(`pdf-${this.page}-${this.fit}-${this.zoom}`, "both", sheet);
  }

  key(e, cx) {
    const k = e.key;
    const count = this.info?.pages ?? 1;
    if (k === "left" || k === "pageup" || k === "k") this.go(this.page - 1, cx);
    else if (k === "right" || k === "pagedown" || k === "j" || k === "space") this.go(this.page + 1, cx);
    else if (k === "home") this.go(1, cx);
    else if (k === "end") this.go(count, cx);
    else if (k === "=" || k === "+") this.zoomBy(1, cx);
    else if (k === "-") this.zoomBy(-1, cx);
    else return false;
    return true;
  }
}
