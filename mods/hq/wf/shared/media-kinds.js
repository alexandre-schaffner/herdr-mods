// Generated from mods/workflows/shared/media-kinds.js by shared/sync.sh: edit it there.

// Generated from shared/js/media-kinds.js by shared/sync.sh: edit it there.

// Which files the `viewer` mod shows, by extension.

const EXT = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "tif", "tiff", "ico", "avif"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  markdown: ["md", "markdown", "mdx"],
  html: ["html", "htm"],
  pdf: ["pdf"],
};
const KIND = new Map(Object.entries(EXT).flatMap(([kind, exts]) => exts.map(e => [e, kind])));

export const extOf = path => (String(path).match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();

/** "image" | "video" | "markdown" | "html" | "pdf" | null. */
export const kindOf = path => KIND.get(extOf(path)) ?? null;

export const KIND_ICON = { image: "image", video: "film", markdown: "file-md", html: "code", pdf: "file-pdf" };
