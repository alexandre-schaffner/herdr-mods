// Images: fit to the stage, or zoomed and scrolled.

import { div, image } from "gpui-kit";
import { media } from "./media.js";
import { alpha, bytes, button, dims, divider, facts, scroller } from "./ui.js";

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const PAD = 24;

export class ImageView {
  constructor(file, host) {
    this.file = file;
    this.host = host;
    this.info = null;
    this.zoom = null; // null: fit
  }

  async load() {
    this.info = await media("image", this.file);
  }

  /** The image's own size: its pixels, or an SVG's declared size. */
  natural() {
    const [w, h] = this.info?.natural ?? [0, 0];
    return w && h ? { w, h } : { w: 800, h: 600 };
  }

  /** Fit never enlarges a bitmap; vectors fill the stage. */
  fitScale() {
    const { w, h } = this.natural();
    const s = this.host.stage();
    const fit = Math.min((s.width - PAD * 2) / w, (s.height - PAD * 2) / h);
    return this.file.toLowerCase().endsWith(".svg") ? fit : Math.min(1, fit);
  }

  scale() {
    return this.zoom ?? this.fitScale();
  }

  step(dir, cx) {
    const now = this.scale();
    const next = dir > 0 ? STEPS.find(z => z > now + 0.001) : [...STEPS].reverse().find(z => z < now - 0.001);
    this.zoom = next ?? now;
    cx.notify();
  }

  set(zoom, cx) {
    this.zoom = zoom;
    cx.notify();
  }

  subtitle() {
    const [w, h] = this.info?.natural ?? [];
    const ext = this.file.slice(this.file.lastIndexOf(".") + 1).toUpperCase();
    return facts(ext, dims(w, h), bytes(this.info?.bytes));
  }

  toolbar(t) {
    const pct = `${Math.round(this.scale() * 100)}%`;
    return [
      button(t, "img-out", "", cx => this.step(-1, cx), { icon: "minus", tip: "Zoom out  −" }),
      button(t, "img-pct", pct, cx => this.set(this.zoom === null ? 1 : null, cx), { tip: "Toggle fit and actual size" }),
      button(t, "img-in", "", cx => this.step(1, cx), { icon: "plus", tip: "Zoom in  +" }),
      divider(t),
      button(t, "img-fit", "Fit", cx => this.set(null, cx), { icon: "fit", active: this.zoom === null, tip: "Fit  0" }),
      button(t, "img-1x", "1:1", cx => this.set(1, cx), { active: this.zoom === 1, tip: "Actual size  1" }),
    ];
  }

  body(t) {
    const { w, h } = this.natural();
    const s = this.scale();
    const dw = Math.max(1, Math.round(w * s));
    const dh = Math.max(1, Math.round(h * s));
    const stage = this.host.stage();
    const picture = image(this.info.src)
      .w(dw)
      .h(dh)
      .flex_none()
      .shadow_md()
      .id("img-picture")
      .on_click((e, cx) => {
        if (e.click_count === 2) this.set(this.zoom === null ? 1 : null, cx);
      });
    const fits = dw + PAD * 2 <= stage.width && dh + PAD * 2 <= stage.height;
    const canvas = div()
      .flex()
      .items_center()
      .justify_center()
      .p(PAD)
      .min_w(fits ? stage.width : dw + PAD * 2)
      .min_h(fits ? stage.height : dh + PAD * 2)
      .bg(alpha(t.foreground, 0.025))
      .on_scroll_wheel((e, cx) => {
        if (!(e.modifiers?.platform || e.modifiers?.control)) return;
        cx.stop_propagation();
        this.step(e.delta.y > 0 ? 1 : -1, cx);
      })
      .child(picture);
    return scroller(`img-scroll-${this.zoom === null ? "fit" : "zoom"}`, "both", canvas);
  }

  key(e, cx) {
    const k = e.key;
    if (k === "=" || k === "+") this.step(1, cx);
    else if (k === "-") this.step(-1, cx);
    else if (k === "0") this.set(null, cx);
    else if (k === "1") this.set(1, cx);
    else return false;
    return true;
  }
}
