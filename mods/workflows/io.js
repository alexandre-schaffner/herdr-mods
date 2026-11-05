// The mod's one door to the machine: collect.py for reads and moves, temp files for drafts.

import { appHome, exec, readTextFile, writeTextFile } from "herdr";

/** Test data: `data/workflows/test-roots.json` {projects, sessions, claude} points collect.py
 *  at fake folders. The mod shows a banner while it exists; delete it to read the real ones. */
export let testRoots = null;

async function overrides() {
  const text = await readTextFile(`${appHome()}/data/workflows/test-roots.json`).catch(() => null);
  testRoots = text ? JSON.parse(text) : null;
  if (!testRoots) return [];
  const out = [];
  if (testRoots.projects) out.push("--root", testRoots.projects);
  if (testRoots.sessions) out.push("--sessions", testRoots.sessions);
  if (testRoots.claude) out.push("--claude", testRoots.claude);
  return out;
}

export async function collect(args) {
  const r = await exec("python3", ["-I", `${appHome()}/mods/workflows/collect.py`, ...(await overrides()), ...args]);
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
