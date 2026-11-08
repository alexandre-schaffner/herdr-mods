// How to start Claude in an account. What a running one is (labels, flags, names) is in
// ./shared/claude-state.js, shared with the my-pane header.
import { account, effortLabel, modelLabel } from "./shared/claude-state.js";

export { account, effortLabel, loadConfig, modelLabel, stateOf } from "./shared/claude-state.js";

const quote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
const value = v => (v.startsWith("~/") ? '"$HOME"/' + quote(v.slice(2)) : quote(v));

/** argv for tab.new: label the terminal with the choice, then exec claude in that account. */
export function launchArgv(cfg, base, { account: id, model, effort }) {
  const a = account(cfg, id);
  const env = [
    ...(a.unset ?? []).flatMap(k => ["-u", quote(k)]),
    ...Object.entries(a.env ?? {}).map(([k, v]) => `${quote(k)}=${value(v)}`),
  ];
  const flags = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  const label = `hc label "$HC_TERMINAL_ID" claude.account=${quote(a.id)} claude.model=${quote(modelLabel(model))} claude.effort=${quote(effortLabel(effort))}`;
  const script = `[ -n "$HC_TERMINAL_ID" ] && command -v hc >/dev/null 2>&1 && ${label} >/dev/null 2>&1\n`
    + `exec env ${[...env, ...[...base, ...flags].map(quote)].join(" ")}`;
  return ["sh", "-c", script];
}
