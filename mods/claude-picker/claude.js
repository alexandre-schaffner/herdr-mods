// How to start Claude in an account. What a running one is (labels, flags, names) is in
// ./shared/claude-state.js, shared with the my-pane header.
import { exec, home, readTextFile } from "herdr";
import { account, effortLabel, modelLabel } from "./shared/claude-state.js";

export { account, effortLabel, loadConfig, modelLabel, stateOf } from "./shared/claude-state.js";

const quote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
const value = v => (v.startsWith("~/") ? '"$HOME"/' + quote(v.slice(2)) : quote(v));

/** `env` arguments that put Claude in account `a`, then `cmd` with the model and effort flags.
 *  Reads the same in sh and fish. */
function envLine(a, cmd, { model, effort }) {
  const env = [
    ...(a.unset ?? []).flatMap(k => ["-u", quote(k)]),
    ...Object.entries(a.env ?? {}).map(([k, v]) => `${quote(k)}=${value(v)}`),
  ];
  const flags = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  return `env ${[...env, ...[...cmd, ...flags].map(quote)].join(" ")}`;
}

/** The terminal's claude.* labels for a choice, as `hc label` arguments. */
export const labelArgs = (cfg, { account: id, model, effort }) =>
  [`claude.account=${account(cfg, id).id}`, `claude.model=${modelLabel(model)}`, `claude.effort=${effortLabel(effort)}`];

/** argv for tab.new: label the terminal with the choice, then exec claude in that account. */
export function launchArgv(cfg, base, choice) {
  const label = `hc label "$HC_TERMINAL_ID" ${labelArgs(cfg, choice).map(quote).join(" ")}`;
  const script = `[ -n "$HC_TERMINAL_ID" ] && command -v hc >/dev/null 2>&1 && ${label} >/dev/null 2>&1\n`
    + `exec ${envLine(account(cfg, choice.account), account(cfg, choice.account).command ?? base, choice)}`;
  return ["sh", "-c", script];
}

/** The shell line that reopens session `sessionId` in the choice's account, model and effort. */
export function resumeLine(cfg, choice, sessionId) {
  const a = account(cfg, choice.account);
  return envLine(a, [...(a.command ?? ["claude"]), "--resume", sessionId], choice);
}

/** The Claude session running at `pid` or just under it (a shell wrapper in between):
 *  `<config>/sessions/<pid>.json` in ~/.claude or any account's CLAUDE_CONFIG_DIR. */
export async function sessionAt(cfg, pid) {
  const h = home();
  const dirs = new Set([`${h}/.claude`, ...cfg.accounts.map(a => a.env?.CLAUDE_CONFIG_DIR).filter(Boolean)
    .map(d => (d.startsWith("~/") ? `${h}/${d.slice(2)}` : d))]);
  const ps = (await exec("ps", ["-A", "-o", "pid=,ppid="]).catch(() => ({ stdout: "" }))).stdout;
  const kids = ps.split("\n").map(l => l.trim().split(/\s+/)).filter(([, pp]) => pp === String(pid)).map(([p]) => p);
  for (const p of [String(pid), ...kids])
    for (const d of dirs) {
      try {
        const s = JSON.parse((await readTextFile(`${d}/sessions/${p}.json`)) ?? "null");
        if (s?.sessionId) return s;
      } catch {}
    }
  return null;
}
