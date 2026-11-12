// Generated from mods/workflows/output.js by shared/sync.sh: edit it there.

// A finished run's Output: the files its result names (a video up front, then a gallery),
// and the rest of the result as facts and notes. Data comes from collect.py's `output`.

import { h_flex, TextView, v_flex } from "gpui-base";
import { div, image } from "gpui-kit";
import { btn, badge } from "./ui.js";
import { ago, alpha, clip, icon, mix, mono, ok, tildify } from "./util.js";

const LOOK = {
  video: { icon: "film", color: t => t.ansi5 ?? t.accent, word: "Video" },
  image: { icon: "image", color: t => t.ansi4 ?? t.accent, word: "Image" },
  audio: { icon: "play", color: t => t.ansi6 ?? t.accent, word: "Audio" },
  pdf: { icon: "file-pdf", color: t => t.ansi1 ?? t.blocked, word: "PDF" },
  markdown: { icon: "file-md", color: t => t.ansi2 ?? t.accent, word: "Markdown" },
  subtitles: { icon: "file-text", color: t => t.ansi3 ?? t.accent, word: "Subtitles" },
  web: { icon: "eye", color: t => t.ansi6 ?? t.accent, word: "Web page" },
  data: { icon: "braces", color: t => t.ansi3 ?? t.accent, word: "Data" },
  doc: { icon: "file-text", color: t => t.muted, word: "Document" },
  archive: { icon: "layers", color: t => t.muted, word: "Archive" },
  folder: { icon: "folder", color: t => t.ansi4 ?? t.accent, word: "Folder" },
  code: { icon: "code", color: t => t.muted, word: "Code" },
  other: { icon: "file-text", color: t => t.muted, word: "File" },
};
const look = (f, t) => {
  const l = LOOK[f.kind] ?? LOOK.other;
  return { icon: l.icon, color: l.color(t), word: l.word };
};

/** The run has something worth an Output view. */
export const hasOutput = run => {
  const o = run?.output;
  return !!o && (o.files.length > 0 || o.notes.length > 0 || o.facts.length > 0);
};

const bytes = n => {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

/** An image scaled into a box: "contain" shows it whole, "cover" fills the box and crops. */
function fitted(src, w, h, bw, bh, mode) {
  if (!w || !h) return image(src).w(bw).h(bh);
  const s = mode === "cover" ? Math.max(bw / w, bh / h) : Math.min(bw / w, bh / h);
  return div()
    .absolute()
    .inset_0()
    .flex()
    .items_center()
    .justify_center()
    .overflow_hidden()
    .child(image(src).flex_none().w(Math.round(w * s)).h(Math.round(h * s)));
}

const clock = s => {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

const factValue = f => {
  const v = f.value;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" && /sec(onds)?$|Sec$|_s$/.test(f.key)) return clock(v);
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : String(Math.round(v * 100) / 100);
  return String(v);
};
const factLabel = f => f.label.replace(/\s+(sec|seconds|s)$/i, "");

/**
 * `ui`: { thumb(file) → { src, width, height, duration } | null (asks for it), open(file, files),
 *   reveal(file), system(file), copy(text, cx), home, now, expanded: Set, toggle(key, cx) }.
 */
export function outputView(t, run, ui) {
  const o = run.output;
  const files = o.files;
  const viewable = files.filter(f => f.exists && ["video", "image", "pdf", "markdown"].includes(f.kind));
  const hero = files.find(f => f.exists && (f.kind === "video" || f.kind === "image"));
  const rest = files.filter(f => f !== hero);
  const okFact = o.facts.find(f => f.key === "ok" && typeof f.value === "boolean");
  const facts = o.facts.filter(f => f !== okFact);
  const missing = files.filter(f => !f.exists).length;

  return v_flex()
    .w_full()
    .items_center()
    .child(
      v_flex()
        .w_full()
        .max_w(1040)
        .px(28)
        .pt(22)
        .pb(40)
        .gap(26)
        .when(!!okFact || facts.length > 0, el => el.child(summary(t, okFact, facts, missing)))
        .when(!!hero, el => el.child(heroCard(t, hero, viewable, ui)))
        .when(rest.length > 0, el =>
          el.child(
            section(
              t,
              `Files`,
              `${rest.length}`,
              h_flex()
                .w_full()
                .flex_wrap()
                .gap(14)
                .children(rest.map((f, i) => fileCard(t, f, i, viewable, ui))),
            ),
          ),
        )
        .when(!files.length, el =>
          el.child(
            h_flex()
              .gap(10)
              .px(14)
              .py(12)
              .rounded(10)
              .bg(alpha(t.foreground, 0.035))
              .child(icon("file-text", 14, t.dim))
              .child(div().text_size(12.5).text_color(t.muted).child("This run returned no files. Its result is below.")),
          ),
        )
        .children(o.notes.map((n, i) => noteSection(t, n, i, run, ui)))
        .when(o.data.length > 0, el =>
          el.child(
            section(
              t,
              "Other data",
              `${o.data.length}`,
              v_flex().w_full().gap(8).children(o.data.map((d, i) => dataBlock(t, d, i, ui))),
            ),
          ),
        ),
    );
}

function summary(t, okFact, facts, missing) {
  const good = okFact?.value;
  const color = okFact ? (good ? ok(t) : (t.ansi3 ?? t.working)) : t.muted;
  return h_flex()
    .w_full()
    .gap(10)
    .flex_wrap()
    .items_center()
    .when(!!okFact, el =>
      el.child(
        h_flex()
          .h(30)
          .px(11)
          .gap(7)
          .items_center()
          .rounded(8)
          .bg(alpha(color, 0.12))
          .border(1)
          .border_color(alpha(color, 0.3))
          .child(icon(good ? "circle-check" : "alert", 13, color))
          .child(div().text_size(12).font_medium().text_color(color).child(good ? "Finished cleanly" : "Finished with issues")),
      ),
    )
    .children(
      facts.slice(0, 8).map(f =>
        h_flex()
          .h(30)
          .px(11)
          .gap(8)
          .items_center()
          .rounded(8)
          .bg(alpha(t.foreground, 0.045))
          .child(div().text_size(11.5).text_color(t.dim).child(factLabel(f)))
          .child(div().font_family(mono()).text_size(12).text_color(t.foreground).child(clip(factValue(f), 48))),
      ),
    )
    .when(missing > 0, el => el.child(badge(t, `${missing} missing`, t.blocked)));
}

function section(t, title, count, body) {
  return v_flex()
    .w_full()
    .gap(12)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .when(!!count, el => el.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(count))),
    )
    .child(body);
}

function meta(t, f, thumb) {
  const parts = [];
  if (thumb?.duration) parts.push(clock(thumb.duration));
  if (thumb?.width && thumb?.height) parts.push(`${thumb.width}×${thumb.height}`);
  if (f.size != null) parts.push(bytes(f.size));
  return parts.join("  ·  ");
}

/** The first video or image, large: click to play or look closer in the viewer. */
function heroCard(t, f, viewable, ui) {
  const th = ui.thumb(f);
  const l = look(f, t);
  const video = f.kind === "video";
  const ratio = th?.width && th?.height ? th.height / th.width : 9 / 16;
  const w = Math.max(320, Math.min(984, (ui.width ?? 1040) - 56));
  const h = Math.round(Math.min(w * ratio, 560));
  const stage = div()
    .id("out-hero")
    .relative()
    .w_full()
    .h(h)
    .rounded_t(12)
    .overflow_hidden()
    .bg(mix(t.background, "#000000", 0.55))
    .cursor_pointer()
    .on_click(() => ui.open(f, viewable))
    .child(
      th?.src
        ? fitted(th.src, th.width, th.height, w, h, "contain")
        : div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(f.exists ? icon("spinner", 20, alpha("#ffffff", 0.5)).spin(900) : icon(l.icon, 30, alpha("#ffffff", 0.4))),
    )
    .when(video, el =>
      el.child(
        div()
          .absolute()
          .inset_0()
          .flex()
          .items_center()
          .justify_center()
          .child(
            div()
              .w(64)
              .h(64)
              .rounded_full()
              .bg(alpha("#000000", 0.55))
              .border(1)
              .border_color(alpha("#ffffff", 0.35))
              .flex()
              .items_center()
              .justify_center()
              .hover(s => s.bg(alpha("#000000", 0.7)))
              .child(div().pl(4).child(icon("play", 26, "#ffffff"))),
          ),
      ),
    )
    .when(!!th?.duration, el =>
      el.child(
        div()
          .absolute()
          .right(12)
          .bottom(12)
          .px(7)
          .py(2)
          .rounded(6)
          .bg(alpha("#000000", 0.65))
          .font_family(mono())
          .text_size(11)
          .text_color("#ffffff")
          .child(clock(th.duration)),
      ),
    );
  return v_flex()
    .w_full()
    .rounded(12)
    .border(1)
    .border_color(alpha(t.border, 0.9))
    .bg(t.background)
    .shadow_md()
    .child(stage)
    .child(
      h_flex()
        .px(16)
        .py(12)
        .gap(12)
        .items_center()
        .border_t(1)
        .border_color(alpha(t.border, 0.7))
        .child(
          div()
            .flex_none()
            .w(32)
            .h(32)
            .rounded(8)
            .bg(alpha(l.color, 0.14))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(l.icon, 15, l.color)),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(f.name))
                .when(!!f.label && f.label.toLowerCase() !== l.word.toLowerCase(), el =>
                  el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(f.label)),
                ),
            )
            .child(
              div()
                .truncate()
                .font_family(mono())
                .text_size(11)
                .text_color(t.dim)
                .child([meta(t, f, th), tildify(f.path, ui.home)].filter(Boolean).join("  ·  ")),
            ),
        )
        .child(btn(t, "out-hero-play", video ? "Play" : "View", () => ui.open(f, viewable), { icon: video ? "play" : "eye", kind: "primary", size: "sm" }))
        .child(btn(t, "out-hero-reveal", "Show in Finder", () => ui.reveal(f), { icon: "folder", size: "sm" }))
        .child(btn(t, "out-hero-open", "", () => ui.system(f), { icon: "external", size: "sm", tooltip: "Open with the default app" }))
        .child(btn(t, "out-hero-copy", "", cx => ui.copy(f.path, cx), { icon: "copy", size: "sm", tooltip: "Copy path" })),
    );
}

function fileCard(t, f, i, viewable, ui) {
  const l = look(f, t);
  const th = f.exists && (f.kind === "video" || f.kind === "image") ? ui.thumb(f) : null;
  const ext = (f.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toUpperCase();
  const preview = th?.src
    ? div()
        .relative()
        .w_full()
        .h(118)
        .overflow_hidden()
        .bg(mix(t.background, "#000000", 0.5))
        .child(fitted(th.src, th.width, th.height, 230, 118, f.kind === "video" ? "cover" : "contain"))
        .when(f.kind === "video", el =>
          el
            .child(
              div().absolute().inset_0().flex().items_center().justify_center().child(
                div().w(34).h(34).rounded_full().bg(alpha("#000000", 0.55)).flex().items_center().justify_center().child(div().pl(2).child(icon("play", 14, "#ffffff"))),
              ),
            )
            .when(!!th.duration, x =>
              x.child(div().absolute().right(7).bottom(7).px(5).rounded(4).bg(alpha("#000000", 0.65)).font_family(mono()).text_size(10).text_color("#ffffff").child(clock(th.duration))),
            ),
        )
    : div()
        .relative()
        .w_full()
        .h(118)
        .bg(alpha(l.color, f.exists ? 0.07 : 0.03))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(8)
        .child(
          (f.exists && (f.kind === "video" || f.kind === "image")) && th === undefined
            ? icon("spinner", 16, alpha(l.color, 0.6)).spin(900)
            : icon(l.icon, 26, alpha(l.color, f.exists ? 0.9 : 0.4)),
        )
        .when(!!ext, el => el.child(div().font_family(mono()).text_size(10).text_color(alpha(l.color, 0.8)).child(ext)));
  return v_flex()
    .id(`out-file-${i}`)
    .w(230)
    .rounded(10)
    .overflow_hidden()
    .border(1)
    .border_color(f.exists ? alpha(t.border, 0.9) : alpha(t.blocked, 0.3))
    .bg(t.background)
    .when(!f.exists, el => el.opacity(0.6))
    .when(f.exists, el =>
      el
        .cursor_pointer()
        .hover(s => s.border_color(alpha(t.accent, 0.6)).shadow_md())
        .on_click(() => ui.open(f, viewable))
        .on_mouse_down("right", (_e, cx) => ui.copy(f.path, cx)),
    )
    .child(preview)
    .child(
      v_flex()
        .px(11)
        .py(9)
        .gap(3)
        .border_t(1)
        .border_color(alpha(t.border, 0.6))
        .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(f.name))
        .child(
          div()
            .truncate()
            .text_size(11)
            .text_color(f.exists ? t.dim : t.blocked)
            .child(
              f.exists
                ? [f.label || l.word, meta(t, f, th) || null, f.mtime ? ago(f.mtime, ui.now) : null].filter(Boolean).join("  ·  ")
                : `Missing · ${tildify(f.path, ui.home)}`,
            ),
        ),
    );
}

function noteSection(t, n, i, run, ui) {
  const md = (id, text) =>
    div()
      .w_full()
      .text_size(12.5)
      .line_height(1.6)
      .text_color(t.foreground)
      .child(TextView.markdown(id, text).on_link_click((url, _cx) => ui.link(url, run.cwd)));
  const body = n.items
    ? v_flex().w_full().gap(8).children(
        n.items.map((item, k) =>
          h_flex()
            .w_full()
            .gap(10)
            .items_start()
            .child(div().flex_none().mt(8).w(5).h(5).rounded_full().bg(alpha(t.foreground, 0.35)))
            .child(div().flex_1().min_w(0).child(md(`note-${i}-${k}`, item))),
        ),
      )
    : md(`note-${i}`, n.text);
  return section(
    t,
    n.title,
    n.items ? `${n.items.length}` : null,
    div().w_full().px(16).py(14).rounded(10).bg(alpha(t.foreground, 0.03)).border(1).border_color(alpha(t.border, 0.6)).child(body),
  );
}

function dataBlock(t, d, i, ui) {
  const key = `data-${i}`;
  const open = ui.expanded.has(key);
  return v_flex()
    .w_full()
    .rounded(9)
    .border(1)
    .border_color(alpha(t.border, 0.7))
    .overflow_hidden()
    .child(
      h_flex()
        .id(`out-${key}`)
        .h(34)
        .px(12)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .hover(s => s.bg(alpha(t.foreground, 0.03)))
        .on_click((_e, cx) => ui.toggle(key, cx))
        .child(icon(open ? "chevron-down" : "chevron-right", 11, t.dim))
        .child(icon("braces", 12, t.dim))
        .child(div().text_size(12).text_color(t.foreground).child(d.title)),
    )
    .when(open, el =>
      el.child(
        div()
          .px(14)
          .py(10)
          .border_t(1)
          .border_color(alpha(t.border, 0.6))
          .bg(alpha(t.foreground, 0.025))
          .font_family(mono())
          .text_size(11)
          .line_height(1.55)
          .text_color(t.muted)
          .child(d.json),
      ),
    );
}
