# herdr-mods

My mods, layout and keys for Herdr. This repository lives at the root of Herdr's home
(`~/.config/herdr-app`), and the `.gitignore` tracks only these files, leaving out
Herdr's shipped mods, state and caches.

| Mod | What it is |
| --- | --- |
| `workflows` | Claude Code dynamic workflows as a live graph (left to right or top to bottom), each agent's shell as a terminal, the owning session's live terminal, run outputs, and a workflow editor and library (`cmd-shift-g`; `cmd-s` saves, `cmd-enter` generates) |
| `master` | `cmd-alt-m`: go to the repo's master chat, starting or resuming it in a pinned Master tab (`master.py`, prompt `master.md`, state in `data/master/masters.json`) |
| `claude-reader` | A Claude Code chat as a clean, live document, over or beside its terminal (`cmd-shift-m`) |
| `hq` | `cmd-shift-h`: HQ, the desk over the master chat and its org of managers, as a main view (the `center` stack in `my-main`): home update, live map, roster, loops, roadmap, next moves, merge queues, review inbox, chat, workflows, library, usage, memory and prompts. Agents drive it with `hq`. **Setup, use and customizing: [`mods/hq/README.md`](mods/hq/README.md)** |
| `proxy` | `cmd-shift-u`: what the local CLIProxyAPI pool did (requests, tokens, cache, plan limits) and its routing (strategy, account priority). `proxy.py` collects and reports |
| `claude-picker` | Account, model and effort for Claude: a dialog when starting a Claude tab, a popup to switch model and effort live, or the account (restarts Claude with `--resume`, same conversation). Accounts in `accounts.json` |
| `my-tabs` | Tabs, cloned from Herdr's `tabs`: per-panel widths, a Workflows panel button; its + opens `my-new-menu` |
| `my-new-menu` | The + menu, cloned from Herdr's `new-menu`: Claude goes through `claude-picker` |
| `my-pane` | Pane header, cloned from Herdr's `pane`: Claude panes show their account · model · effort, click to switch |
| `my-org` | Sidebar, per repository: the master, then each HQ manager with its worktrees and units, then workflow owners, then other spaces |

Layout: `layouts/my-main.json`. Keys: `keys.json`.

`shared/` holds what several mods use:
- `claude.py`, `repos.py`: Claude sessions (every account's), terminals and repositories; `masters.py`: finds each repo's master chat. Imported by
  `workflows/collect.py`, `master/master.py` and `claude-reader/read.py`.
- `icons/`: the one-color icons the mods draw (`shared/icons/<name>.svg`).
- `js/`: JavaScript several mods need. Mods can't import outside their own folder, so
  `shared/sync.sh` copies each file into `mods/<mod>/shared/`. Edit `shared/js`, then run it.
  `shared/sync.sh --check` fails while a copy is stale; run it as the pre-commit hook:
  `printf '#!/bin/sh\nexec shared/sync.sh --check\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`

## Install

```sh
git clone git@github.com:alexandre-schaffner/herdr-mods.git /tmp/herdr-mods
cp -R /tmp/herdr-mods/mods/* ~/.config/herdr-app/mods/
cp -R /tmp/herdr-mods/shared ~/.config/herdr-app/
cp /tmp/herdr-mods/layouts/my-main.json ~/.config/herdr-app/layouts/
# keys.json: merge its bindings into ~/.config/herdr-app/keys.json (or copy it if you have none)
```

Mods hot-reload; check one with `herdr-app check ~/.config/herdr-app/mods/<name>`.
`workflows`, `master` and `claude-reader` need `python3`, and Herdr's `hc` and `herdr-app` on the PATH.

Claude accounts (`claude-picker`): a plain `claude` uses the `ANTHROPIC_API_KEY` exported by
fish; Merkl is the subscription login in `~/.claude`; Personal is `~/.claude-personal`, its own
login with settings, skills, plugins, rules and projects symlinked to `~/.claude`. Each
account keeps its own `sessions/`; the mods read all of them.
