// The `viewer` mod shows images, videos, Markdown and PDFs. This is the whole link to it:
// which files it takes (kept in step with mods/viewer/media.js), how to open one, and
// links in rendered Markdown that may point at one.

import { exec, home, openOverlay } from "herdr";

const VIEWABLE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?|ico|avif|mp4|m4v|mov|webm|mkv|avi|md|markdown|mdx|pdf)$/i;

export const viewable = path => typeof path === "string" && path.startsWith("/") && VIEWABLE.test(path);

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
