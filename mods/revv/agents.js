// Handing work to coding agents, and starting the review status terminal.
//
// A fix goes to an agent that can reach Revv's MCP tools: one of the coding
// agents connected to the Revv account (`response.agents`). Either the space's
// own agent takes it (when it's idle, so nothing is interrupted), or a new tab
// starts one with the fix prompt as its first message.

import { agents, exec, hc, knownAgents, run, setShared, shared, terminals } from "herdr";

/** Revv provider → the herdr program keys that run it. */
export const PROVIDER_PROGRAMS = {
  "claude-code": ["claude", "claude-code"],
  codex: ["codex"],
  opencode: ["opencode"],
  cursor: ["cursor-agent", "cursor"],
};

export const PROVIDER_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
};

export function providerOf(programKey, app) {
  for (const [provider, keys] of Object.entries(PROVIDER_PROGRAMS)) {
    if (keys.includes(programKey) || keys.includes(app) || app === provider) return provider;
  }
  return null;
}

let knownCache = { at: 0, list: [] };

/** Installed agent programs Revv is connected to, in Revv's provider order. */
export async function launchables(connected) {
  if (Date.now() - knownCache.at > 60_000) {
    try {
      knownCache = { at: Date.now(), list: await knownAgents() };
    } catch {
      knownCache = { at: Date.now(), list: [] };
    }
  }
  const out = [];
  for (const provider of connected) {
    const program = knownCache.list.find(
      (p) => p.installed && PROVIDER_PROGRAMS[provider]?.includes(p.key),
    );
    if (program)
      out.push({
        provider,
        program,
        run: program.run,
        name: program.name || PROVIDER_NAMES[provider],
      });
  }
  return out;
}

export const cachedLaunchables = (connected) =>
  connected
    .map((provider) => {
      const program = knownCache.list.find(
        (p) => p.installed && PROVIDER_PROGRAMS[provider]?.includes(p.key),
      );
      return program
        ? { provider, program, run: program.run, name: program.name || PROVIDER_NAMES[provider] }
        : null;
    })
    .filter(Boolean);

/** Agents already running in a space that Revv can talk to, most useful first. */
export function residentAgents(spaceId, connected) {
  const rank = { idle: 0, done: 0, working: 1, blocked: 2 };
  return agents()
    .filter((a) => a.space === spaceId && !a.address.includes("/"))
    .map((a) => ({ ...a, provider: providerOf(a.program?.key, a.app) }))
    .filter((a) => a.provider && connected.includes(a.provider))
    .sort(
      (x, y) =>
        (rank[x.status] ?? 3) - (rank[y.status] ?? 3) || Number(y.focused) - Number(x.focused),
    );
}

export const preferredProvider = () => shared("revv.agent") ?? null;
export const rememberProvider = (provider) => setShared("revv.agent", provider);

/**
 * What the primary Fix button does here: hand it to an idle resident agent,
 * else start the preferred connected agent in a new tab.
 */
export function defaultTarget(spaceId, connected) {
  const resident = residentAgents(spaceId, connected);
  const preferred = preferredProvider();
  const free = resident.filter((a) => a.status === "idle" || a.status === "done");
  const send = free.find((a) => a.provider === preferred) ?? free[0];
  if (send)
    return {
      kind: "send",
      agent: send,
      provider: send.provider,
      label: send.program?.name ?? PROVIDER_NAMES[send.provider],
    };
  const options = cachedLaunchables(connected);
  const spawn = options.find((o) => o.provider === preferred) ?? options[0];
  if (spawn) return { kind: "spawn", launch: spawn, provider: spawn.provider, label: spawn.name };
  return null;
}

/** Sends `prompt` to an agent here, or starts one. Returns an error message or null. */
export async function handOff(target, { spaceId, prompt, tabName, folder }) {
  if (!target) return "Connect a coding agent in Revv → Settings → Integrations first.";
  if (target.kind === "send") {
    const r = await hc(["send", target.agent.address, prompt]);
    if (r.code !== 0) {
      let detail = r.stderr.trim();
      try {
        detail = JSON.parse(detail).error?.message ?? detail;
      } catch {
        // plain text error
      }
      return `Couldn't reach ${target.label}: ${detail || `hc exited ${r.code}`}`;
    }
    run("pane.focus", { pane: target.agent.pane });
    return null;
  }
  const args = { space: spaceId, name: tabName, argv: target.launch.run, task: prompt };
  if (folder) args.folder = folder;
  run("tab.new", args);
  return null;
}

export async function copyText(text) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "revv", text]);
}

// ── Review status terminal ──────────────────────────────────────────────────

/** The live status terminal for a run: by its label, or by its deterministic name. */
export function watcherFor(walkthroughId) {
  const name = watcherName(walkthroughId);
  return (
    terminals().find(
      (t) =>
        t.state === "live" && (t.labels?.["revv.walkthrough"] === walkthroughId || t.name === name),
    ) ?? null
  );
}

/** The terminal a space's review should hang under: its lead agent, else its first terminal. */
export function leadTerminal(space, allPanes) {
  const tabIds = new Set(space.tabs.map((tab) => tab.id));
  const own = allPanes.filter((p) => tabIds.has(p.tab) && p.terminal && !p.terminal.includes("/"));
  const active = space.tabs.find((tab) => tab.active)?.id;
  const byTab = (list) => list.find((p) => p.tab === active) ?? list[0];
  return (byTab(own.filter((p) => p.program?.agent)) ?? byTab(own))?.terminal ?? null;
}

export function watcherName(walkthroughId) {
  const tail =
    walkthroughId
      .replace(/[^0-9a-z]/gi, "")
      .toLowerCase()
      .slice(-6) || "review";
  return `revv-${tail}`;
}

export async function spawnWatcher({ account, walkthroughId, parent, cwd }) {
  if (!account.runtime || !account.watcher) return false;
  const r = await hc([
    "run",
    "--bg",
    "--json",
    "--no-notify",
    "--outlive-parent",
    "--rm",
    "--parent",
    parent,
    "--name",
    watcherName(walkthroughId),
    "--label",
    `revv.walkthrough=${walkthroughId}`,
    "--cwd",
    cwd,
    "--",
    "env",
    "BUN_BE_BUN=1",
    account.runtime,
    "run",
    account.watcher,
    account.path,
    walkthroughId,
  ]);
  return r.code === 0;
}
