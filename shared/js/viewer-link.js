// The link to the `viewer` mod (images, videos, Markdown and PDFs): which files it takes,
// how to open one, links in rendered Markdown that may point at one, and thumbnails.

import { appHome, exec, home, openOverlay } from "herdr";
import { kindOf } from "./media-kinds.js";

export const viewable = path => typeof path === "string" && path.startsWith("/") && kindOf(path) !== null;

/** Opens `file` in the viewer; `files` (with `file` among them) can be stepped through there. */
export function openViewer(file, files) {
  openOverlay({ mod: "viewer", kind: "dialog", width: 0.86, height: 0.9, props: { file, files: files?.length ? files : [file] } });
}

/** A link's local file, if it names one: absolute, `~/`, `file://`, or relative to `cwd`. */
function localPath(url, cwd) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) return null;
  let p = decodeURIComponent(url.replace(/^file:\/\//, "").replace(/[#?].*$/, ""));
  if (p.startsWith("~/")) p = home() + p.slice(1);
  else if (!p.startsWith("/")) p = cwd ? `${cwd}/${p}` : null;
  return p && p.replace(/\/\.\//g, "/");
}

/** For `TextView.on_link_click`: viewable files open in the viewer, the rest as the system would. */
export function openLink(url, cwd) {
  if (!url || url.startsWith("#")) return;
  const path = localPath(url, cwd);
  if (viewable(path)) openViewer(path);
  else exec("open", [path ?? url]).catch(() => exec("xdg-open", [path ?? url]).catch(() => {}));
}

/**
 * A thumbnail for `file` through the viewer's own staging (media.py): `{ src, width, height }`
 * for an image, `{ src, width, height, duration }` (src: the poster) for a video. Null when
 * the viewer isn't installed or can't read it.
 */
export async function stage(kind, file) {
  const r = await exec("python3", ["-I", `${appHome()}/mods/viewer/media.py`, kind, file]);
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
