// Videos: a poster, a storyboard to start from any point, and the facts. Playback runs
// in ffplay's own window (picture and sound), started and stopped from here: Herdr has
// no video element, and drawing frames as images would keep every one in memory.

import { div, image } from "gpui-kit";
import { exec } from "herdr";
import { h_flex, v_flex } from "gpui-base";
import { media } from "./media.js";
import { alpha, bytes, button, clock, dims, facts, icon, mono, notice, openExternally } from "./ui.js";

const PAD = 24;
const STRIP_GAP = 6;

export class VideoView {
  constructor(file, host) {
    this.file = file;
    this.host = host;
    this.info = null;
    this.pid = null;
    this.from = 0;
  }

  async load() {
    this.info = await media("video", this.file);
  }

  subtitle() {
    const i = this.info;
    if (!i) return "";
    const v = i.video;
    const a = i.audio;
    return facts(
      v?.codec?.toUpperCase(),
      dims(v?.width, v?.height),
      v?.fps ? `${v.fps} fps` : "",
      clock(i.duration),
      a ? a.codec?.toUpperCase() : "no sound",
      bytes(i.bytes),
    );
  }

  play(from, cx) {
    this.from = from;
    cx.spawn(async cx => {
      await this.stop();
      if (!this.info?.player) {
        await openExternally(this.file);
        return;
      }
      let pid;
      try {
        pid = (await media("play", this.file, from)).pid;
      } catch (err) {
        this.host.fail(err.message, cx);
        return;
      }
      this.pid = pid;
      cx.notify();
      // ffplay quits at the end or when its window closes; follow it until then.
      while (this.pid === pid && (await this.alive(pid))) await cx.sleep(1000);
      if (this.pid === pid) this.pid = null;
      cx.notify();
    });
  }

  async alive(pid) {
    try {
      await exec("kill", ["-0", String(pid)]);
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    const pid = this.pid;
    this.pid = null;
    if (pid) await exec("kill", [String(pid)]).catch(() => {});
  }

  close() {
    return this.stop();
  }

  toolbar(t) {
    if (!this.info?.video) return [];
    if (this.pid)
      return [
        div().flex_none().text_size(11.5).text_color(t.dim).child(`Playing from ${clock(this.from)} in its own window`),
        button(t, "vid-stop", "Stop", cx => cx.spawn(async cx => { await this.stop(); cx.notify(); }), { icon: "square", tip: "Stop  space" }),
      ];
    return [
      button(t, "vid-play", this.from ? `Play from ${clock(this.from)}` : "Play", cx => this.play(this.from, cx), {
        icon: "play",
        primary: true,
        tip: this.info.player ? "Play with sound in a window  space" : "Open in the default player",
      }),
    ];
  }

  body(t) {
    const i = this.info;
    if (!i.video) return notice(t, "film", "No picture in this file", i.audio ? "It only holds sound." : null);
    const stage = this.host.stage();
    const board = i.board;
    const tileW = board ? Math.floor((stage.width - PAD * 2 - STRIP_GAP * (board.times.length - 1)) / board.times.length) : 0;
    const tileH = board ? Math.round((tileW * board.tile[1]) / board.tile[0]) : 0;
    const stripH = board ? tileH + 30 : 0;

    const ratio = i.video.height / i.video.width || 9 / 16;
    const maxW = stage.width - PAD * 2;
    const maxH = stage.height - PAD * 2 - stripH;
    const w = Math.max(120, Math.round(Math.min(maxW, maxH / ratio)));
    const h = Math.round(w * ratio);

    const poster = div()
      .id("vid-poster")
      .relative()
      .flex_none()
      .w(w)
      .h(h)
      .rounded(10)
      .overflow_hidden()
      .shadow_md()
      .bg("#000000")
      .cursor_pointer()
      .on_click((_e, cx) => (this.pid ? null : this.play(this.from, cx)))
      .when(!!i.poster, el => el.child(image(i.poster).w(w).h(h)))
      .child(
        div()
          .absolute()
          .inset_0()
          .flex()
          .items_center()
          .justify_center()
          .bg(alpha("#000000", this.pid ? 0.55 : 0.18))
          .hover(s => s.bg(alpha("#000000", this.pid ? 0.55 : 0.3)))
          .child(
            this.pid
              ? v_flex().items_center().gap(8)
                  .child(icon("film", 26, "#ffffff"))
                  .child(div().text_size(12.5).text_color("#ffffff").child("Playing in its own window"))
              : div().w(64).h(64).rounded_full().bg(alpha("#000000", 0.55)).border(1).border_color(alpha("#ffffff", 0.35))
                  .flex().items_center().justify_center().child(icon("play", 26, "#ffffff")),
          ),
      )
      .child(
        div().absolute().right(10).bottom(10).px(7).py(2).rounded(5).bg(alpha("#000000", 0.65))
          .font_family(mono()).text_size(11).text_color("#ffffff").child(clock(i.duration)),
      );

    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .gap(PAD - 6)
      .p(PAD)
      .bg(alpha(t.foreground, 0.025))
      .child(poster)
      .when(!!board, el => el.child(this.strip(t, board, tileW, tileH)));
  }

  /** The storyboard: one sheet of tiles, each shown through its own window onto it. */
  strip(t, board, tileW, tileH) {
    const sheetW = tileW * board.cols;
    const sheetH = tileH * board.rows;
    return h_flex()
      .flex_none()
      .gap(STRIP_GAP)
      .children(
        board.times.map((at, k) => {
          const col = k % board.cols;
          const row = Math.floor(k / board.cols);
          const on = this.from === at;
          return v_flex()
            .id(`vid-tile-${k}`)
            .gap(4)
            .items_center()
            .cursor_pointer()
            .tooltip(`Play from ${clock(at)}`)
            .on_click((_e, cx) => this.play(at, cx))
            .child(
              div()
                .relative()
                .w(tileW)
                .h(tileH)
                .rounded(5)
                .overflow_hidden()
                .border(on ? 2 : 1)
                .border_color(on ? t.accent : alpha(t.border, 0.8))
                .hover(s => s.border_color(t.accent))
                .child(image(board.src).absolute().left(-col * tileW).top(-row * tileH).w(sheetW).h(sheetH)),
            )
            .child(div().font_family(mono()).text_size(10).text_color(on ? t.accent : t.dim).child(clock(at)));
        }),
      );
  }

  key(e, cx) {
    if (e.key !== "space" && e.key !== "enter") return false;
    if (this.pid) cx.spawn(async cx => { await this.stop(); cx.notify(); });
    else this.play(this.from, cx);
    return true;
  }
}
