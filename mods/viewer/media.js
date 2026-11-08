// What a file is, and the bridge to media.py, which stages files for drawing.

import { appHome, exec } from "herdr";

export { extOf, kindOf, KIND_ICON } from "./shared/media-kinds.js";

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
