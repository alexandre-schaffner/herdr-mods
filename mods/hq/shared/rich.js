// Generated from shared/js/rich.js by shared/sync.sh: edit it there.

// Mermaid diagrams drawn to images, for mods that have no web view: drawn by the system's Chrome
// (mods/claude-reader/render/render.mjs) once per diagram and kept in data/rich-render. Shared by
// every view of a mod: the chat's ```mermaid blocks, HQ's Markdown (its viewer, library, briefs).
//
//   const r = richImage("mermaid", code)        { status: "busy" | "done" | "error", src, width, height, error }
//   pumpRich(cx)                                 draws what's queued, one at a time (call from a timer)
//   openRich(r)                                  the diagram's image, in the image viewer
//   cacheImage(file) → Promise<src | null>       a picture anywhere on disk, as an image() path

import { appHome, exec, readTextFile, writeTextFile } from "herdr";
import { dark } from "./look.js";

const RENDER = () => `${appHome()}/mods/claude-reader/render/render.mjs`;
const DIR = "data/rich-render"; // under the app's home: image() paths are relative to it
const RICH = new Map();
const queue = [];
let drawing = false;

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
};

/** A drawing of Mermaid `code`, queued the first time it's asked for. `o.width`: the width it
 *  is laid out at (CSS px, default 760); `o.maxHeight`: where a tall one is cut. */
export function richImage(kind, code, o = {}) {
  const width = o.width ?? 760;
  const maxHeight = o.maxHeight ?? 2400;
  const key = `${kind}-${dark() ? "d" : "l"}-${width}-${maxHeight}-${fnv(code)}`;
  let r = RICH.get(key);
  if (!r) {
    r = { key, kind, code, width: null, height: null, pageWidth: width, maxHeight, status: "busy" };
    RICH.set(key, r);
    queue.push(r);
  }
  return r;
}

/** Draws the next queued drawing (each launches Chrome for a second or two), then redraws. */
export function pumpRich(cx) {
  if (drawing || !queue.length) return;
  const r = queue.shift();
  drawing = true;
  cx.spawn(async (cx) => {
    try {
      const base = `${appHome()}/${DIR}/${r.key}`;
      const src = `${base}.mmd`;
      await exec("mkdir", ["-p", `${appHome()}/${DIR}`]);
      await writeTextFile(src, r.code, await readTextFile(src));
      const args = [RENDER(), r.kind, src, `${base}.png`, "--width", String(r.pageWidth), "--max-height", String(r.maxHeight), ...(dark() ? ["--dark"] : [])];
      const res = await exec("node", args, { timeout: 90_000 });
      let out = {};
      try {
        out = JSON.parse(res.stdout || "{}");
      } catch {
        out = { error: res.stderr.trim().split("\n").pop() || "It couldn't be drawn." };
      }
      if (out.error || !out.width) Object.assign(r, { status: "error", error: out.error ?? "It couldn't be drawn." });
      else Object.assign(r, { status: "done", src: `${DIR}/${r.key}.png`, file: src, width: out.width, height: out.height });
    } catch (e) {
      Object.assign(r, { status: "error", error: String(e?.message ?? e) });
    }
    drawing = false;
    cx.notify();
  });
}

/** Opens a drawn diagram's image in the image viewer. */
export function openRich(r) {
  if (r.src) exec("open", [`${appHome()}/${r.src}`]).catch(() => {});
}

/** A picture anywhere on disk, copied under the app's home (image() reads only there): its path. */
export async function cacheImage(file) {
  if (file.startsWith(appHome() + "/")) return file.slice(appHome().length + 1);
  const ext = (/\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? "png").toLowerCase();
  const rel = `${DIR}/img-${fnv(file)}.${ext}`;
  await exec("mkdir", ["-p", `${appHome()}/${DIR}`]);
  const r = await exec("cp", ["-f", file, `${appHome()}/${rel}`]);
  return r.code === 0 ? rel : null;
}
