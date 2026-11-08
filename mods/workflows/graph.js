// The run as lanes (phases) of nodes (units), joined through one hub between lanes.
// Left to right ("h"): lanes are columns, nodes stack down each. Top to bottom ("v"):
// lanes are rows with their header on the left, nodes side by side.

import { h_flex, v_flex } from "gpui-base";
import { div, PathBuilder } from "gpui-kit";
import { seg } from "./ui.js";
import { alpha, icon, kindColor, mix, mono, ok } from "./util.js";

export const G = {
  laneW: 276, gap: 120, nodeH: 68, nodeGap: 12, head: 64, pad: 28, spine: 22, r: 10,
  // Top to bottom only: the header column, node top to node top between rows, cards apart.
  headW: 220, rowGap: 96, colGap: 16,
};

const DIR_KEY = "graph-dir";
let dir = null;

/** "h" or "v", the person's pick, shared by the run view and the editor. */
export function graphDir() {
  if (!dir) dir = localStorage.getItem(DIR_KEY) === "v" ? "v" : "h";
  return dir;
}

function setGraphDir(d) {
  dir = d === "v" ? "v" : "h";
  localStorage.setItem(DIR_KEY, dir);
}

/** The two-icon switch between left-to-right and top-to-bottom. */
export function dirSwitch(t, id) {
  return seg(
    t,
    id,
    [
      { id: "h", label: "", icon: "flow", hint: "Left to right" },
      { id: "v", label: "", icon: "flow-down", hint: "Top to bottom" },
    ],
    graphDir(),
    (d, cx) => {
      setGraphDir(d);
      cx.notify();
    },
    { size: "sm" },
  );
}

/**
 * Places every lane and node. Each lane gets `box` (its frame, canvas coordinates),
 * `flowIn`/`flowOut` (where edges arrive at and leave its nodes, along the flow),
 * `mid` and `entry` (where a not-started lane's placeholder is met); each node gets
 * `x`, `y`, `cx`, `cy`, `cross` (its center across the flow), `pin` and `pout`.
 */
function place(lanes, d = "h") {
  const most = Math.max(1, ...lanes.map(l => l.nodes.length));
  if (d === "v") {
    const rowW = most * G.laneW + (most - 1) * G.colGap;
    const step = G.nodeH + G.rowGap;
    lanes.forEach((lane, i) => {
      const y = G.pad + 12 + i * step;
      const k = lane.nodes.length;
      // Rows are centered on the widest, so the flow reads down the middle.
      const x0 = G.pad + G.headW + (rowW - (k * G.laneW + Math.max(0, k - 1) * G.colGap)) / 2;
      lane.box = { x: G.pad, y: y - 12, w: G.headW + rowW + 12, h: G.nodeH + 24 };
      lane.slot = { x: G.headW, y: 12, w: rowW, h: G.nodeH };
      lane.x = lane.box.x;
      lane.flowIn = y;
      lane.flowOut = y + G.nodeH;
      lane.mid = G.pad + G.headW + rowW / 2;
      lane.entry = y;
      lane.nodes.forEach((n, j) => {
        n.x = x0 + j * (G.laneW + G.colGap);
        n.y = y;
        n.cx = n.x + G.laneW / 2;
        n.cy = y + G.nodeH / 2;
        n.cross = n.cx;
        n.pin = { x: n.cx, y: n.y };
        n.pout = { x: n.cx, y: n.y + G.nodeH };
      });
    });
    return {
      dir: d,
      width: G.pad * 2 + G.headW + rowW + 12,
      height: G.pad * 2 + Math.max(1, lanes.length) * step - G.rowGap + 24,
    };
  }
  const column = most * (G.nodeH + G.nodeGap) - G.nodeGap;
  const height = G.pad * 2 + G.head + column + 8;
  lanes.forEach((lane, i) => {
    lane.x = G.pad + i * (G.laneW + G.gap);
    lane.box = { x: lane.x - 12, y: G.pad - 8, w: G.laneW + 24, h: height - G.pad * 2 + 8 };
    lane.flowIn = lane.x;
    lane.flowOut = lane.x + G.laneW;
    lane.mid = G.pad + G.head + G.nodeH / 2;
    lane.entry = lane.x + 20;
    lane.nodes.forEach((n, j) => {
      n.x = lane.x;
      n.y = G.pad + G.head + j * (G.nodeH + G.nodeGap);
      n.cx = n.x + G.laneW / 2;
      n.cy = n.y + G.nodeH / 2;
      n.cross = n.cy;
      n.pin = { x: n.x, y: n.cy };
      n.pout = { x: n.x + G.laneW, y: n.cy };
    });
  });
  return {
    dir: d,
    width: G.pad * 2 + lanes.length * G.laneW + Math.max(0, lanes.length - 1) * G.gap,
    height,
  };
}

const edgeClass = look =>
  look.key === "done" ? "done" : look.key === "running" ? "live" : look.key === "failed" ? "failed" : "idle";

// Node → spine → hub, as an orthogonal bracket with rounded corners, in flow
// coordinates (u along the flow, v across it) that `T` turns into canvas ones. `d` 1
// leaves a node toward the hub; -1 arrives at a node from it. Shared spine runs overlap.
function bracket(pb, T, nu, nv, spineU, hu, hv, d) {
  const dv = hv - nv;
  if (Math.abs(dv) < 1) return pb.move_to(...T(nu, nv)).line_to(...T(hu, hv));
  const r = Math.min(G.r, Math.abs(dv) / 2);
  const s = Math.sign(dv);
  return pb
    .move_to(...T(nu, nv))
    .line_to(...T(spineU - d * r, nv))
    .curve_to(...T(spineU, nv + s * r), ...T(spineU, nv))
    .line_to(...T(spineU, hv - s * r))
    .curve_to(...T(spineU + d * r, hv), ...T(spineU, hv))
    .line_to(...T(hu, hv));
}

const ORDER = ["idle", "done", "failed", "live"];

function edges(all, t, size, palette) {
  // Ghost lanes and nodes (the editor's "add" cards) take space but no edges.
  const lanes = all.filter(l => !l.ghost).map(l => ({ ...l, nodes: l.nodes.filter(n => !n.ghost) }));
  const T = size.dir === "v" ? (u, v) => [v, u] : (u, v) => [u, v];
  const paths = {};
  const pen = cls => {
    if (!paths[cls])
      paths[cls] =
        cls === "idle" ? PathBuilder.stroke(1.25).dash_array([3, 5]) : PathBuilder.stroke(cls === "live" ? 2 : 1.5);
    return paths[cls];
  };
  const hubs = [];
  const hub = (u, v, look, i) => {
    const [x, y] = T(u, v);
    hubs.push({ x, y, look, id: `hub-${i}` });
  };
  for (let i = 0; i + 1 < lanes.length; i++) {
    const a = lanes[i];
    const b = lanes[i + 1];
    if (!a.nodes.length) continue;
    const u0 = a.flowOut;
    const uj = (u0 + b.flowIn) / 2;
    if (!b.nodes.length) {
      // The next phase hasn't started: dashed brackets into its placeholder.
      const vj = b.mid;
      for (const n of a.nodes) paths.idle = bracket(pen("idle"), T, u0 + 4, n.cross, u0 + G.spine, uj, vj, 1);
      paths.idle = pen("idle").move_to(...T(uj, vj)).line_to(...T(b.entry, vj));
      hub(uj, vj, b.look, i);
      continue;
    }
    const u1 = b.flowIn;
    // The hub faces the smaller lane, so fans open from it rather than float between.
    const small = a.nodes.length <= b.nodes.length ? a.nodes : b.nodes;
    const vj = (small[0].cross + small[small.length - 1].cross) / 2;
    for (const n of a.nodes) {
      const c = edgeClass(n.look);
      paths[c] = bracket(pen(c), T, u0 + 4, n.cross, u0 + G.spine, uj, vj, 1);
    }
    for (const n of b.nodes) {
      const c = edgeClass(n.look);
      paths[c] = bracket(pen(c), T, u1 - 4, n.cross, u1 - G.spine, uj, vj, -1);
    }
    hub(uj, vj, b.look, i);
  }
  const color = {
    done: alpha(ok(t), 0.6),
    live: t.working,
    failed: alpha(t.blocked, 0.75),
    idle: alpha(t.muted, 0.45),
    ...palette,
  };
  const layers = ORDER.filter(cls => paths[cls]).map(cls => {
    const el = window.paint_path(paths[cls].build(), color[cls]).absolute().left(0).top(0).w(size.width).h(size.height);
    return cls === "live" ? el.loop("opacity", { from: 0.35, to: 1, period: 1500 }) : el;
  });
  return { layers, hubs };
}

export function glyph(lk, t, size = 26) {
  const mark =
    lk.glyph === "spinner" ? icon("spinner", size * 0.52, lk.color).spin(900) : icon(lk.glyph, size * 0.5, lk.color);
  return div()
    .flex_none()
    .w(size)
    .h(size)
    .rounded_full()
    .bg(alpha(lk.color, 0.14))
    .border(1)
    .border_color(alpha(lk.color, 0.35))
    .flex()
    .items_center()
    .justify_center()
    .child(mark);
}

// ---- shared card and lane frames: the run view, the editor's design and a script's graph
// draw the same shells and differ only in what's inside.

/** The 3px bar down a card's left edge, `inset` from its top and bottom. */
function accentBar(color, inset, pulse) {
  return div()
    .absolute()
    .left(0)
    .top(inset)
    .w(3)
    .h(G.nodeH - inset * 2)
    .rounded_full()
    .bg(color)
    .when(!!pulse, el => el.loop("opacity", { from: 0.25, to: 1, period: 1200 }));
}

/**
 * A node's card, placed at the node: rounded, tinted and bordered in the accent when
 * selected, and clicked by the node's id. `o`: `id`, `selected`, `onSelect(id, cx)`, `body`;
 * optional `border` (the unselected border color), `dashed`, `shadow` (false: none unselected),
 * `tint` (how much accent a selected card takes), `hoverBg` (the unselected hover fill), and
 * `bar` `{ color, inset, pulse }` for the accent bar.
 */
export function cardShell(n, t, o) {
  const selected = o.selected;
  const tint = selected ? mix(t.background, t.accent, o.tint ?? 0.08) : t.background;
  return div()
    .id(o.id)
    .absolute()
    .left(n.x)
    .top(n.y)
    .w(G.laneW)
    .h(G.nodeH)
    .rounded(13)
    .bg(tint)
    .border(selected ? 1.5 : 1)
    .when(!!o.dashed, el => el.border_dashed())
    .border_color(selected ? t.accent : (o.border ?? t.border))
    .when(selected, el => el.shadow_lg())
    .when(!selected && o.shadow !== false, el => el.shadow_sm())
    .cursor_pointer()
    .hover(s => {
      const st = s.border_color(selected ? t.accent : alpha(t.accent, 0.55));
      return o.hoverBg ? st.bg(selected ? tint : o.hoverBg) : st;
    })
    .on_click((_e, cx) => o.onSelect(n.id, cx))
    .when(!!o.bar, el => el.child(accentBar(o.bar.color, o.bar.inset ?? 12, o.bar.pulse)))
    .child(o.body);
}

/** A card's two rows: the title line, and the line under it. */
export function cardRows(top, bottom) {
  return v_flex()
    .size_full()
    .pl(14)
    .pr(12)
    .py(10)
    .gap(6)
    .child(top)
    .child(bottom);
}

/** A card standing for many (a fan-out): two offset frames behind each of `nodes`. */
export function fanStacks(nodes, box, t) {
  return nodes.flatMap(n =>
    [8, 4].map(off =>
      div()
        .absolute()
        .left(n.x - box.x + off)
        .top(n.y - box.y + off)
        .w(G.laneW)
        .h(G.nodeH)
        .rounded(13)
        .border(1)
        .border_color(alpha(t.accent, off === 8 ? 0.18 : 0.3))
        .bg(t.background),
    ),
  );
}

/** A dashed outline `w`×`h` where a card would be, with `label` centered in it, if any. */
export function placeholder(t, w, h, radius, label) {
  return div()
    .w(w)
    .h(h)
    .rounded(radius)
    .border(1)
    .border_color(alpha(t.muted, 0.35))
    .border_dashed()
    .when(!!label, el =>
      el
        .flex()
        .items_center()
        .justify_center()
        .child(div().text_size(11).text_color(t.dim).child(label)),
    );
}

/**
 * A lane's frame and header: the index and title (then `o.trail`, its badges) over `o.rows`.
 * Left to right the header sits on top; top to bottom it's a column beside the row, so edges
 * reach node tops clear of it. `o`: `gap`, `pt` (the header's spacing), `indexColor`; optional
 * `id`, `selected`, `behind` (drawn under the header: stacks, arrows), `empty` (drawn last),
 * and `headId` with `onHead(cx)` to make the header clickable.
 */
export function laneShell(lane, size, t, o) {
  const v = size.dir === "v";
  const box = lane.box;
  let head = v_flex();
  if (o.headId) head = head.id(o.headId);
  head = head
    .px(14)
    .gap(o.gap)
    .when(!v, el => el.pt(o.pt))
    .when(v, el =>
      el
        .absolute()
        .left(0)
        .top(0)
        .w(G.headW)
        .h(box.h)
        .justify_center()
        .border_r(1)
        .border_color(alpha(t.border, 0.4)),
    )
    .when(!!o.onHead, el => el.cursor_pointer().on_click((_e, cx) => o.onHead(cx)))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(
          div()
            .font_family(mono())
            .text_size(10.5)
            .text_color(o.indexColor)
            .child(String(lane.index).padStart(2, "0")),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(13)
            .font_semibold()
            .text_color(t.foreground)
            .child(lane.title),
        )
        .children(o.trail ?? []),
    )
    .children(o.rows ?? []);
  let frame = div();
  if (o.id) frame = frame.id(o.id);
  return frame
    .absolute()
    .left(box.x)
    .top(box.y)
    .w(box.w)
    .h(box.h)
    .rounded(18)
    .bg(alpha(t.foreground, 0.022))
    .border(o.selected ? 1.5 : 1)
    .border_color(o.selected ? t.accent : alpha(t.border, 0.55))
    .children(o.behind ?? [])
    .child(head)
    .when(!!o.empty, el => el.child(o.empty));
}

function laneChrome(lane, size, t) {
  const total = lane.nodes.length || 1;
  const pct = n => `${Math.round((n / total) * 100)}%`;
  const v = size.dir === "v";
  const empty = !lane.nodes.length
    ? v
      ? placeholder(t, G.laneW - 40, G.nodeH, 13, "Not started")
          .absolute()
          .left(lane.slot.x + (lane.slot.w - (G.laneW - 40)) / 2)
          .top(lane.slot.y)
      : v_flex()
          .absolute()
          .left(0)
          .top(G.head + 8)
          .w_full()
          .items_center()
          .gap(8)
          .child(placeholder(t, G.laneW - 40, G.nodeH, 13))
          .child(div().text_size(11).text_color(t.dim).child("Not started"))
    : null;
  return laneShell(lane, size, t, {
    gap: 9,
    pt: 14,
    indexColor: lane.look.color,
    trail: [
      div()
        .font_family(mono())
        .text_size(10.5)
        .text_color(t.muted)
        .child(lane.nodes.length ? `${lane.done}/${lane.nodes.length}` : "—"),
    ],
    rows: [
      h_flex()
        .h(3)
        .w_full()
        .rounded_full()
        .overflow_hidden()
        .bg(alpha(t.foreground, 0.07))
        .child(
          div().h_full().w(pct(lane.done)).bg(ok(t)).transition("width", { duration: 400, easing: "ease-out" }),
        )
        .child(div().h_full().w(pct(lane.failed)).bg(t.blocked))
        .child(div().h_full().w(pct(lane.live)).bg(t.working).loop("opacity", { from: 0.4, to: 1, period: 1200 })),
    ],
    empty,
  });
}

function port(x, y, color, t, id) {
  return div()
    .id(id)
    .absolute()
    .left(x - 4)
    .top(y - 4)
    .w(8)
    .h(8)
    .rounded_full()
    .bg(t.background)
    .border(1.5)
    .border_color(color);
}

function pill(text, t) {
  return div()
    .flex_none()
    .px(6)
    .h(17)
    .rounded(5)
    .bg(alpha(t.foreground, 0.06))
    .font_family(mono())
    .text_size(10)
    .text_color(t.muted)
    .flex()
    .items_center()
    .child(text);
}

function nodeCard(n, t, selected, onSelect) {
  const lk = n.look;
  // One dot per session in its kind's color; a failed or live session shows its state instead.
  const dots = n.kinds.slice(-9).map((k, i) =>
    div()
      .id(`dot-${n.id}-${i}`)
      .w(7)
      .h(7)
      .rounded_full()
      .bg(k.look.key === "failed" || k.look.key === "running" ? k.look.color : kindColor(k.kind, t))
      .when(k.look.key === "running", el => el.loop("opacity", { from: 0.3, to: 1, period: 1000 })),
  );
  const kinds = [...new Set(n.kinds.map(k => k.kind.replace(/\d+$/, "")))].filter(k => k !== n.key);
  const border = selected
    ? t.accent
    : lk.key === "running"
      ? alpha(t.working, 0.6)
      : lk.key === "failed"
        ? alpha(t.blocked, 0.55)
        : t.border;
  return cardShell(n, t, {
    id: `node-${n.id}`,
    selected,
    onSelect,
    border,
    tint: 0.1,
    hoverBg: mix(t.background, t.foreground, 0.03),
    bar: lk.key === "running" ? { color: t.working, inset: 14, pulse: true } : null,
    body: h_flex()
      .size_full()
      .pl(13)
      .pr(12)
      .gap(11)
      .items_center()
      .child(glyph(lk, t, 28))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(7)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(13.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(n.title),
              )
              .when(n.sessions.length > 1, el => el.child(pill(`×${n.sessions.length}`, t))),
          )
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(h_flex().flex_none().gap(3).items_center().children(dots))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(kinds.length ? kinds.join(" · ") : n.cached ? "cached" : lk.label.toLowerCase()),
              )
              .when(n.models.length > 0, el =>
                el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(n.models.join(" · "))),
              ),
          ),
      ),
  });
}

/**
 * The whole canvas, sized to its lanes; scroll it in its parent. `opts.dir` overrides the
 * person's direction; `opts` lets the editor draw its own cards (`card`), lane frames
 * (`lane`, given the lane, the canvas size with its `dir`, and the theme) and edge colors (`palette`).
 */
export function graph(lanes, t, selectedId, onSelect, opts = {}) {
  const size = place(lanes, opts.dir ?? graphDir());
  const { layers, hubs } = edges(lanes, t, size, opts.palette);
  const card = opts.card ?? nodeCard;
  const frame = opts.lane ?? laneChrome;
  const real = lanes.map(l => (l.ghost ? { ...l, nodes: [] } : { ...l, nodes: l.nodes.filter(n => !n.ghost) }));
  const ports = [];
  lanes.forEach((lane, i) => {
    for (const n of real[i].nodes) {
      const c = n.portColor ?? (n.look.key === "done" ? alpha(ok(t), 0.8) : n.look.key === "running" ? t.working : alpha(t.muted, 0.6));
      if (i > 0 && real[i - 1].nodes.length) ports.push(port(n.pin.x, n.pin.y, c, t, `pin-${n.id}`));
      if (i + 1 < lanes.length && real[i + 1].nodes.length)
        ports.push(port(n.pout.x, n.pout.y, c, t, `pout-${n.id}`));
    }
  });
  return div()
    .id("canvas")
    .relative()
    .flex_none()
    .w(size.width)
    .h(size.height)
    .children(lanes.map(l => frame(l, size, t)))
    .children(layers)
    .children(lanes.flatMap(l => l.nodes.map(n => card(n, t, n.id === selectedId, onSelect))))
    .children(ports)
    .children(
      hubs.map(h =>
        div()
          .id(h.id)
          .absolute()
          .left(h.x - 7)
          .top(h.y - 7)
          .w(14)
          .h(14)
          .rounded_full()
          .bg(t.background)
          .border(2)
          .border_color(h.look.color)
          .flex()
          .items_center()
          .justify_center()
          .child(
            div()
              .w(4)
              .h(4)
              .rounded_full()
              .bg(h.look.color)
              .when(h.look.key === "running", el => el.loop("opacity", { from: 0.2, to: 1, period: 900 })),
          ),
      ),
    );
}
