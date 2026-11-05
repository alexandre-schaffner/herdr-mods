# herdr-mods

My mods and layout for Herdr. This repository lives at the root of
Herdr's home (`~/.config/herdr-app`), and the `.gitignore` tracks only these files,
leaving out Herdr's shipped mods, state and caches.

| Mod | What it is |
| --- | --- |
| `workflows` | Claude Code dynamic workflows as a live graph (left to right or top to bottom), each agent's shell as a terminal, the owning session's live terminal, run outputs, and a workflow editor and library |
| `claude-reader` | A Claude Code chat as a clean, live document, over or beside its terminal |
| `viewer` | Images, videos, Markdown and PDFs, opened from other mods |
| `my-tabs` | Tabs, cloned from Herdr's `tabs` |

Layout: `layouts/my-main.json`.

## Install

```sh
git clone git@github.com:alexandre-schaffner/herdr-mods.git /tmp/herdr-mods
cp -R /tmp/herdr-mods/mods/* ~/.config/herdr-app/mods/
cp /tmp/herdr-mods/layouts/my-main.json ~/.config/herdr-app/layouts/
```

Mods hot-reload; check one with `herdr-app check ~/.config/herdr-app/mods/<name>`.
The `workflows` mod needs `python3` and Herdr's `hc` on the PATH.
