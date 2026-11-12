// Media files from other mods (images, videos, Markdown and PDFs): which files count,
// how to open one (the system's default app), links in rendered Markdown that may point
// at one, and thumbnails (shared/media.py).

import { appHome, exec, home } from "herdr";
import { kindOf } from "./media-kinds.js";

export const viewable = path => typeof path === "string" && path.startsWith("/") && kindOf(path) !== null;

// A mod that shows files itself (HQ's file viewer) registers here; it returns true when it took
// the file. Each mod has its own copy of this module, so a host only sees its own mod's links.
let host = null;
export function setViewerHost(fn) {
  host = fn;
}

/** Opens `file`: in the host's viewer when it takes it, else the system's default app (`files` is accepted and ignored). */
export function openViewer(file, _files) {
  if (host?.(file)) return;
  exec("open", [file]).catch(() => exec("xdg-open", [file]).catch(() => {}));
}

/** A link's local file, if it names one: absolute, `~/`, `file://`, or relative to `cwd`. */
function localPath(url, cwd) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) return null;
  let p = decodeURIComponent(url.replace(/^file:\/\//, "").replace(/[#?].*$/, ""));
  if (p.startsWith("~/")) p = home() + p.slice(1);
  else if (!p.startsWith("/")) p = cwd ? `${cwd}/${p}` : null;
  return p && p.replace(/\/\.\//g, "/");
}

/** For `TextView.on_link_click`: local files and URLs open as the system would. */
export function openLink(url, cwd) {
  if (!url || url.startsWith("#")) return;
  const path = localPath(url, cwd);
  if (viewable(path)) openViewer(path);
  else exec("open", [path ?? url]).catch(() => exec("xdg-open", [path ?? url]).catch(() => {}));
}

/**
 * A thumbnail for `file` through shared/media.py: `{ src, width, height }`
 * for an image, `{ src, width, height, duration }` (src: the poster) for a video. Null when
 * it can't be read.
 */
export async function stage(kind, file) {
  const r = await exec("python3", ["-I", `${appHome()}/shared/media.py`, kind, file]);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (out.error) return null;
  if (kind === "image") return { src: out.src, width: out.width, height: out.height };
  if (!out.poster) return null;
  return { src: out.poster, width: out.video?.width, height: out.video?.height, duration: out.duration };
}
