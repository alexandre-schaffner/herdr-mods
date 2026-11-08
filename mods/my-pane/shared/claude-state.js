// Generated from shared/js/claude-state.js by shared/sync.sh: edit it there.

// A Claude terminal's account, model and effort, for claude-picker and the my-pane header.
// cfg: mods/claude-picker/accounts.json ({accounts, plain, models, efforts}).

import { appHome, readTextFile } from "herdr";

export const ACCOUNTS_FILE = () => `${appHome()}/mods/claude-picker/accounts.json`;

export async function loadConfig() {
  const c = JSON.parse((await readTextFile(ACCOUNTS_FILE())) ?? "{}");
  return { accounts: c.accounts ?? [], plain: c.plain, models: c.models ?? [], efforts: c.efforts ?? [] };
}

export const isClaude = p => p?.program?.key === "claude" || p?.app === "claude-code";

/** The account `id`, else the one a plain `claude` runs as, else the first. */
export const account = (cfg, id) => cfg.accounts.find(a => a.id === id) ?? cfg.accounts.find(a => a.id === cfg.plain) ?? cfg.accounts[0];

// Labels keep "default"/"auto" rather than removing the key, so a live switch back to the
// default wins over a --model flag the terminal started with.
export const modelLabel = v => v || "default";
export const effortLabel = v => v || "auto";

/** Account, model and effort ("" = Claude's default): the terminal's claude.* labels, else
 *  the flags it started with (`argv`: its foreground argv). */
export function stateOf(cfg, labels, argv) {
  const l = labels ?? {};
  const fg = argv ?? [];
  const flag = n => {
    const i = fg.indexOf(n);
    if (i >= 0) return fg[i + 1] ?? "";
    return fg.find(a => a.startsWith(n + "="))?.slice(n.length + 1) ?? "";
  };
  const model = l["claude.model"] ?? flag("--model");
  const effort = l["claude.effort"] ?? flag("--effort");
  return {
    account: l["claude.account"] ?? cfg.plain,
    model: model === "default" ? "" : model,
    effort: effort === "auto" ? "" : effort,
  };
}

/** "Merkl · Opus · High", leaving out defaults. */
export function summary(cfg, state) {
  const name = (list, v) => (v ? list.find(x => x.value === v)?.name ?? v : "");
  return [account(cfg, state.account)?.name, name(cfg.models, state.model), name(cfg.efforts, state.effort)].filter(Boolean).join(" · ");
}
