// The mod's one door to the machine: collect.py for reads and moves, temp files for drafts.

import { appHome, exec, writeTextFile } from "herdr";

export async function collect(args) {
  const r = await exec("python3", ["-I", `${appHome()}/mods/workflows/collect.py`, ...args]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `collect.py exited ${r.code}`);
  const out = JSON.parse(r.stdout);
  if (out.error && out.error !== "exists") throw new Error(out.error);
  return out;
}

let n = 0;
/** A new file under the mod's data folder (writeTextFile only creates fresh paths here). */
export async function tempFile(name, text) {
  const path = `${appHome()}/data/workflows/tmp/${Date.now().toString(36)}-${(n++).toString(36)}-${name}`;
  await exec("mkdir", ["-p", path.slice(0, path.lastIndexOf("/"))]);
  await writeTextFile(path, text, null);
  return path;
}

export async function jobDir() {
  const dir = `${appHome()}/data/workflows/jobs/${Date.now().toString(36)}${(n++).toString(36)}`;
  await exec("mkdir", ["-p", dir]);
  return dir;
}

/** The repo's master chat (master.py): `["plan", folder]` or `["open", folder, space, task]`. */
export async function master(args) {
  const r = await exec("python3", ["-I", `${appHome()}/mods/master/master.py`, ...args]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `master.py exited ${r.code}`);
  const out = JSON.parse(r.stdout);
  if (out.error) throw new Error(out.error);
  return out;
}
