// What a file is, and the bridge to media.py, which stages files for drawing.

import { appHome, exec } from "herdr";

const EXT = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "tif", "tiff", "ico", "avif"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  markdown: ["md", "markdown", "mdx"],
  pdf: ["pdf"],
};
const KIND = new Map(Object.entries(EXT).flatMap(([kind, exts]) => exts.map(e => [e, kind])));

export const extOf = path => (String(path).match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();

/** "image" | "video" | "markdown" | "pdf" | null. Other mods keep a copy of this list in their viewer.js. */
export const kindOf = path => KIND.get(extOf(path)) ?? null;

export const KIND_ICON = { image: "image", video: "film", markdown: "file-md", pdf: "file-pdf" };

/** Runs one media.py command; resolves with its JSON, rejects with its message. */
export async function media(command, ...args) {
  const script = `${appHome()}/mods/viewer/media.py`;
  const r = await exec("python3", ["-I", script, command, ...args.map(String)]);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error((r.stderr || r.stdout || "media.py failed").trim().split("\n").pop());
  }
  if (out.error) throw new Error(out.error);
  return out;
}
