// The Map's geometry, free of any drawing: the lens doc built into a tree, laid out top-down or
// left to right and fitted to the canvas, and the shapes of the links drawn over it (layout units).

// Layout units at zoom 1 (px): a card, the gap between siblings, the gap between generations, and
// the height of a lane heading (a branch for a lane whose work has no card of its own above it).
const U = { pad: 32, cardW: 212, cardH: 92, sib: 28, gen: 64, sibR: 18, genR: 76, headH: 46 };
export const ZMIN = 0.35;
export const ZMAX = 2;

/** The lens doc as a tree. Each card's parent is the card that owns it (an edge into it from its
 *  own lane, else any edge that isn't a dependency or a queue hand-off); cards with no owner hang
 *  off the master, under a lane heading when their lane has several. The rest of the edges are
 *  cross links, drawn over the tree. */
export function buildTree(doc) {
  const lanes = [...(doc.lanes ?? [])].map((l, i) => ({ ...l, i })).sort((a, b) => (a.order ?? 1e3 + a.i) - (b.order ?? 1e3 + b.i));
  const laneAt = Object.fromEntries(lanes.map((l, i) => [l.id, i]));
  const byId = Object.fromEntries(doc.nodes.map(n => [n.id, n]));
  const order = Object.fromEntries(doc.nodes.map((n, i) => [n.id, i]));
  const edges = (doc.edges ?? []).filter(e => byId[e.from] && byId[e.to] && e.from !== e.to);
  const root = byId.master ? "master" : doc.nodes[0].id;
  const structural = e => !["dependency", "queue"].includes(e.kind);
  const parent = {};
  const tree = new Set();
  const climbs = (from, to) => { for (let x = from; x; x = parent[x]) if (x === to) return true; return false; };
  for (const pass of [e => byId[e.from].lane === byId[e.to].lane, () => true])
    for (const e of edges)
      if (e.to !== root && !parent[e.to] && structural(e) && pass(e) && !climbs(e.from, e.to)) {
        parent[e.to] = e.from;
        tree.add(e.id ?? `${e.from}>${e.to}`);
      }
  const groups = {};
  const perLane = {};
  for (const n of doc.nodes) if (n.id !== root && !parent[n.id]) (perLane[n.lane] ??= []).push(n);
  for (const [laneId, ns] of Object.entries(perLane)) {
    if (ns.length > 1) {
      const l = lanes.find(x => x.id === laneId) ?? { id: laneId, label: laneId };
      const gid = `lane:${laneId}`;
      groups[gid] = { id: gid, lane: laneId, label: l.label, subtitle: l.subtitle, delta: l.delta };
      parent[gid] = root;
      for (const n of ns) parent[n.id] = gid;
    } else parent[ns[0].id] = root;
  }
  const kids = {};
  for (const [c, p] of Object.entries(parent)) (kids[p] ??= []).push(c);
  const laneOf = id => byId[id]?.lane ?? groups[id]?.lane;
  const rank = id => [laneAt[laneOf(id)] ?? 99, groups[id] ? -1 : order[id] ?? 999];
  for (const k of Object.values(kids)) k.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
  return { doc, lanes, byId, edges, root, kids, groups, tree, parent };
}

/** The tree laid out top-down ("down") or left to right ("right"): leaves take consecutive
 *  slots across, each parent centred over its children, one generation per row (column). */
export function layout(base, o) {
  const down = o === "down";
  const across = down ? U.cardW + U.sib : U.cardH + U.sibR;
  const deep = down ? U.cardH + U.gen : U.cardW + U.genR;
  const at = {};
  let next = 0;
  let maxDepth = 0;
  const place = (id, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const ks = base.kids[id] ?? [];
    if (!ks.length) at[id] = { c: next++, depth };
    else {
      ks.forEach(k => place(k, depth + 1));
      at[id] = { c: (at[ks[0]].c + at[ks[ks.length - 1]].c) / 2, depth };
    }
  };
  place(base.root, 0);
  const pos = {};
  for (const [id, a] of Object.entries(at)) {
    const head = !!base.groups[id];
    const x0 = U.pad + (down ? a.c * across : a.depth * deep);
    const y0 = U.pad + (down ? a.depth * deep : a.c * across);
    const h = head ? U.headH : U.cardH;
    pos[id] = { x: x0, y: down ? y0 : y0 + (U.cardH - h) / 2, w: U.cardW, h, depth: a.depth, head };
  }
  const W = U.pad * 2 + (down ? next * across - U.sib : (maxDepth + 1) * deep - U.genR);
  const H = U.pad * 2 + (down ? (maxDepth + 1) * deep - U.gen : next * across - U.sibR);
  return { ...base, pos, W, H, orient: o };
}

/** Of a tree's `layouts` (one per direction, the first winning a tie), the direction that fits a
 *  canvas of `size` at the larger zoom, and that zoom (floored, so the fitted map never overflows
 *  by a rounding pixel). */
export function fitted(layouts, size) {
  let best = null;
  for (const g of layouts) {
    const z = Math.min(size.width / g.W, size.height / g.H);
    if (!best || z > best.z + 0.001) best = { o: g.orient, z };
  }
  return { o: best.o, z: Math.max(ZMIN, Math.min(1.25, Math.floor(best.z * 100) / 100)) };
}

/** A branch from parent `a` to child `b`, in layout units: out of the parent's far side, to the
 *  middle of the gap between the generations, across to the child's line, then in. Siblings
 *  share the first two segments, which draws the trunk. */
export function branch(a, b, down) {
  if (down) {
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    const my = a.y + a.h + (b.y - (a.y + a.h)) / 2;
    if (Math.abs(ax - bx) < 1) return { pts: [[ax, a.y + a.h], [bx, b.y]], label: 0 };
    return { pts: [[ax, a.y + a.h], [ax, my], [bx, my], [bx, b.y]], label: 2 };
  }
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  const mx = a.x + a.w + (b.x - (a.x + a.w)) / 2;
  if (Math.abs(ay - by) < 1) return { pts: [[a.x + a.w, ay], [b.x, by]], label: 0 };
  return { pts: [[a.x + a.w, ay], [mx, ay], [mx, by], [b.x, by]], label: 2 };
}

/** A cross link (a stacked PR, a queue hand-off): an S-curve between the facing sides of the two
 *  cards: its four points (start, two controls, end); the label rides the controls' segment. */
export function cross(a, b, down) {
  const cx = p => p.x + p.w / 2;
  const cy = p => p.y + p.h / 2;
  let s, t, bend;
  if (down) {
    if (b.y > a.y + a.h) [s, t] = [[cx(a), a.y + a.h], [cx(b), b.y]];
    else if (b.y + b.h < a.y) [s, t] = [[cx(a), a.y], [cx(b), b.y + b.h]];
    else [s, t] = b.x > a.x ? [[a.x + a.w, cy(a)], [b.x, cy(b)]] : [[a.x, cy(a)], [b.x + b.w, cy(b)]];
    bend = Math.abs(s[1] - t[1]) > 1 ? "v" : "h";
  } else {
    if (b.x > a.x + a.w) [s, t] = [[a.x + a.w, cy(a)], [b.x, cy(b)]];
    else if (b.x + b.w < a.x) [s, t] = [[a.x, cy(a)], [b.x + b.w, cy(b)]];
    else [s, t] = b.y > a.y ? [[cx(a), a.y + a.h], [cx(b), b.y]] : [[cx(a), a.y], [cx(b), b.y + b.h]];
    bend = Math.abs(s[0] - t[0]) > 1 ? "h" : "v";
  }
  const m = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2];
  const c1 = bend === "v" ? [s[0], m[1]] : [m[0], s[1]];
  const c2 = bend === "v" ? [t[0], m[1]] : [m[0], t[1]];
  return { pts: [s, c1, c2, t], curve: true, label: 1 };
}

/** Where a label sits on its segment: the free spot nearest the middle, stepping along it a few
 *  units at a time, so it never covers a box in `taken` (cards, lane titles, labels) nor leaves the
 *  map's box `W` × `H`. Takes its box. */
export function labelSpot([x1, y1], [x2, y2], w, taken, W, H) {
  const n = Math.max(1, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 6));
  const fs = Array.from({ length: n + 1 }, (_, i) => i / n).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));
  const at = f => ({ x: Math.max(w / 2, Math.min(W - w / 2, x1 + (x2 - x1) * f)), y: Math.max(9, Math.min(H - 9, y1 + (y2 - y1) * f)) });
  const box = s => ({ x: s.x - w / 2, y: s.y - 9, w, h: 18 });
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const spot = fs.map(at).find(s => !taken.some(o => hits(box(s), o))) ?? at(0.5);
  taken.push(box(spot));
  return spot;
}

/** A polyline with its corners rounded (radius r, clipped to half of each segment). */
export function roundedPolyline(pb, pts, r) {
  pb = pb.move_to(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    const [x, y] = pts[k];
    if (k === pts.length - 1) {
      pb = pb.line_to(x, y);
      break;
    }
    const [px, py] = pts[k - 1];
    const [nx, ny] = pts[k + 1];
    const d1 = Math.hypot(x - px, y - py);
    const d2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) {
      pb = pb.line_to(x, y);
      continue;
    }
    const ax = x - ((x - px) / d1) * rr;
    const ay = y - ((y - py) / d1) * rr;
    const bx = x + ((nx - x) / d2) * rr;
    const by = y + ((ny - y) / d2) * rr;
    pb = pb.line_to(ax, ay).curve_to(bx, by, x, y);
  }
  return pb;
}

/** A label chip's width in layout units, from its (clipped) text. Generous: small zooms draw text
 *  wider than it scales, and the pill truncates rather than grow past this box. */
export function labelW(text) {
  return Math.min(40, (text ?? "").length) * 6.8 + 16;
}
