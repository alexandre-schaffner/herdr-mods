# HQ

HQ is a desk for running a team of Claude Code agents on one repository from Herdr.

You talk to one long-lived Claude session per repository, the **master**. The master runs
**managers** (one per area of work, plus one merge-queue manager per epic), and each manager
runs its own **units** (subagents or extra sessions in sibling worktrees). HQ is the screen
where you watch all of that and make the calls only you can make.

The idea: agents do the chores, you keep the judgement. HQ puts in front of you what is
waiting for a yes (a merge, a deploy, a message to someone), what was finished for you to
look over, and a one-line answer to "what is going on right now".

```
you ──► HQ (⌘⇧H) ──► master chat (one per repo, never stops)
                       ├─ loop runner (cheap Haiku session that runs the master's routine tick)
                       ├─ merge-queue manager (one per epic: the only path to trunk)
                       └─ area managers (one per area of focus)
                            └─ units (subagents or sessions in sibling worktrees)
```

---

## 1. Set it up

### What you need

| Need | Why | Check |
| --- | --- | --- |
| Herdr with `herdr-app` and `hc` on your `PATH` | HQ is a Herdr mod, and drives terminals with `hc` | `which herdr-app hc` |
| Claude Code (`claude`) | the master, managers and units are Claude sessions | `claude --version` |
| `python3` | HQ's backend (`hq.py`) | `python3 --version` |
| `node` and `npm` | draws the live map (Org > Map) | `node --version` |
| `gh`, logged in | PRs, CI and the merge queue | `gh auth status` |
| The **pstack** Claude plugin | every master and manager starts in `/pstack:poteto-mode` | `/plugin` in Claude |

Optional:

- `~/agent-memory`: a git repo the master uses as its long-term memory (Mind > Memory shows it),
  with a "dream" script at `~/.local/share/agent-memory-dream/dream.sh` that tidies it.
  Without it, the Memory view is empty and the rest works.
- `TYPESAFE_API_KEY` in your environment: lets Jev (TypeSafe) judge which mail is urgent enough
  to wake the master. Without it, only mail marked `--urgent` wakes it.

### Install

HQ is not a standalone mod. It needs the `master` mod (which starts the master chat) and the
shared Python and icons in `shared/`. This repository is meant to live at Herdr's home,
`~/.config/herdr-app`, so the simplest install is a copy of the pieces:

```sh
git clone git@github.com:alexandre-schaffner/herdr-mods.git /tmp/herdr-mods
cd /tmp/herdr-mods

# 1. The mods and the shared code they import
cp -R mods/hq mods/master ~/.config/herdr-app/mods/
cp -R shared ~/.config/herdr-app/
# optional: my-tabs (adds an HQ button to the tab bar) and my-org (sidebar grouped by manager)
cp -R mods/my-tabs mods/my-org ~/.config/herdr-app/mods/

# 2. The `hq` command, which agents (and HQ itself) use
mkdir -p ~/.local/bin
cp mods/hq/setup/hq ~/.local/bin/hq && chmod +x ~/.local/bin/hq

# 3. The live map renderer
mkdir -p ~/.local/share/hq-lens
cp mods/hq/setup/lens/lens.mjs mods/hq/setup/lens/package.json ~/.local/share/hq-lens/
(cd ~/.local/share/hq-lens && npm install)

# 4. The `hq` skill, so any Claude session knows how to use HQ
mkdir -p ~/.claude/skills/hq
cp mods/hq/setup/skill/SKILL.md ~/.claude/skills/hq/
```

Make sure `~/.local/bin` is on your `PATH` (`which hq` should print it).

### Give it a key and a place in the layout

**Key.** Add these to `~/.config/herdr-app/keys.json`:

```json
"cmd-shift-h": "mod.open:hq",
"cmd-alt-m": "mod.open:master"
```

**Layout.** HQ works best as a *main view* that swaps with your workspace, rather than as a tab.
In your layout file, wrap your work area in a stack called `center` with two children: your
existing work area (id `workspace`) and an HQ block (id `hq`). `layouts/my-main.json` in this
repository is a full example:

```json
{
  "id": "center",
  "type": "stack",
  "active": "workspace",
  "children": [
    { "id": "workspace", "type": "column", "children": [ "...your tabs, panes, etc..." ] },
    { "id": "hq", "type": "block", "content": { "mod": "hq" } }
  ]
}
```

No `center` stack? It still works: ⌘⇧H opens HQ in a tab instead.

**Check it.** `herdr-app check ~/.config/herdr-app/mods/hq` should pass. Mods reload on their own.

### First run

1. Open a terminal inside the repository you want HQ to manage.
2. Press **⌘⌥M**. This starts the repo's master chat in a pinned "Master" tab (or brings it
   back). With the loop runner on (the default), a "Loop" tab with a small Haiku session
   appears beside it.
3. Press **⌘⇧H**. HQ opens for that repository.
4. Tell the master what you want, in its terminal or in HQ's Chat: *"Spin up a manager for the
   billing API"*, *"Add a merge queue for the auth epic, merging into main"*. It creates them
   with `hq manager-new ... --launch`, each in its own worktree, space and Claude session.
5. Press **Esc twice** to go back to your workspace.

HQ keeps each repository's state in `~/.config/herdr-app/data/hq/<repo>/` (not in git).
Nothing there needs hand-editing: HQ's views and the `hq` command write it.

---

## 2. Use it

### The views

The left rail groups the views. Press a key to jump straight to one.

| Group | View | Key | What it is for |
| --- | --- | --- | --- |
| Home | Home | `1` | The master's written update for you: read this first when you come back |
| Org | Map | `2` | Live graph of the org and the work in flight |
| | Roster | `6` | Every manager: status, context size, team, last words, handoff. Launch, respawn, retire |
| | Loops | `l` | Each agent's loop: its steps, how often each runs, its heartbeat. Edit them here |
| Plan | Roadmap | `t` | Each epic's plan, in phases |
| | Next | `3` | The master's next moves. Add notes to steer it |
| | Queue | `q` | Merge queues, one tab per epic: what is batched, green, landing |
| Review | Review | `4` | **What waits for you**: approvals (yes/no) and finished work to look over |
| Chat | Chat | `5` | Talk to the master or any manager, with full Claude Code parity |
| Work | Workflows | `w` | Your workflow runs, each with the owner session that runs it |
| | Library | `7` | Docs, pages and other artifacts the agents made for you |
| Pulse | Usage | `8` | Proxy and plan usage |
| | Pulse | `9` | What HQ noticed: quiet sessions, large contexts, managers waiting |
| Mind | Memory | | The master's memory (`~/agent-memory`) |
| | Prompts | | Every prompt and setting you can change (see [Customize](#3-customize-it)) |

Keys that work everywhere in HQ:

| Key | Does |
| --- | --- |
| `/` or `⌘K` | Command palette: jump anywhere, run any action |
| `c` | Show or hide the chat panel beside the current view |
| `g` | Refresh now (HQ also refreshes every 12 s) |
| `Esc` `Esc` | Leave HQ (the first Esc shows a hint) |

The status strip on top always shows the master's headline, whether its loop is running, and
how many items wait for you.

### A normal day

1. **Catch up.** Open HQ, read Home.
2. **Decide.** Go to Review (`4`). Approve or reject each approval card. The agent that asked
   gets an `HQ DECISION` line in its terminal and does exactly what you approved, nothing more.
   Look over the "done" items when you have time.
3. **Steer.** Add a note on a next move (`3`), edit the standing orders (Mind > Prompts), or
   just tell the master in Chat (`5`). The master re-reads your steering on every tick.
4. **Leave.** Esc Esc. HQ keeps running in the background.

### What needs your approval

By default, only actions that leave your machine or touch other people:

- merging into a shared branch, or running a merge batch,
- deploying, or changing production or a shared environment,
- messages to people (Slack, email, PR comments, review requests),
- anything destructive outside this machine (force pushes, deleting remote branches).

Everything else, the agents just do, then file it under Review as "done" so you can check it
after the fact. Change this list in Mind > Prompts > Approval policy.

### What HQ does on its own

Every minute, without spending tokens, HQ:

- wakes the master early for urgent mail, your steering, or a manager that is gone or waiting,
- types the master's loop back in if it lapsed (unless you paused it),
- compacts an idle master or manager whose context got large (only if its handoff is fresh),
- ends a manager's unit sessions that finished and sat idle (their worktree and report stay),
- delivers your decisions, retrying until they land,
- runs the checks agents asked it to watch (`hq watch`: CI, a merge, a reply) and pings them
  when one fires.

It also enforces two walls: managers write to the master through its **mailbox** (`hq tell`),
so the master's terminal stays your conversation, and `hc` into another org's terminals is
refused.

### The `hq` command

Agents use `hq`; you rarely need to. Run `hq` with no arguments for the full reference. The
ones worth knowing:

```sh
hq managers                       # who is in the org
hq todo                           # the next moves
hq status "<one line>"            # set the headline in the status strip
hq ask approval --title T --body B --action "<exact command>"   # wait for a yes
hq ask question --title T --body B                              # a call only you can make
hq done --title T --body B --link <url>                         # finished, please look
hq tell "<message>" [--urgent]    # a manager writes to the master's mailbox
hq tick                           # what changed, and the loop steps due now
hq files                          # where every editable file lives
```

Run it from inside the repository, or pass `--repo <folder>`.

---

## 3. Customize it

### Without touching code: Mind > Prompts

Everything below is editable in HQ (Mind > Prompts). Each file says when your change applies.

| Prompt | Controls | File |
| --- | --- | --- |
| Master system prompt | How the master thinks and works | `mods/master/master.md` |
| Loop runner prompt | What the Haiku runner does on each tick, and when it escalates | `mods/master/runner.md` |
| Communication style | How every agent writes, in every repo | `data/hq/communication.md` |
| Standing orders | Short, current instructions to the master (re-read every tick) | `data/hq/<repo>/standing-orders.md` |
| Approval policy | What needs your yes first | `data/hq/<repo>/policy.md` |
| Manager brief template | What every manager is told at launch | `data/hq/<repo>/manager-base.md` |
| Workflow owner brief | What a workflow run's owner session is told | `data/hq/<repo>/workflow-owner.md` |
| Master handoff | The master's notes to its next self (after a compaction) | `data/hq/<repo>/handoff.md` |
| Autopilot | The settings in the next table | `data/hq/<repo>/settings.json` |

Each manager also has its own **charter** (`data/hq/<repo>/managers/<id>/charter.md`), set with
`hq manager-set <id> --charter-file <file>` or in Org > Roster. It applies at the manager's
next launch or respawn.

### Autopilot settings

In Mind > Prompts > Autopilot, or in `data/hq/<repo>/settings.json`. Missing keys use these
defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `runner` | `true` | A cheap loop runner runs the master's tick and escalates only what needs judgement. `false`: the master loops itself |
| `runnerModel` | `"haiku"` | The runner's model (at its next start) |
| `heartbeatSec` | `3600` | How often an idle master ticks on its own |
| `wakeGate` | `true` | Wake an idle master early when something can't wait |
| `autoRearm` | `true` | Type the master's loop back in when it lapses |
| `autoCompactMaster` / `masterCompactAt` | `true` / `250000` | Compact an idle master above this many tokens |
| `autoCompactManagers` / `managerCompactAt` | `true` / `220000` | Same for managers (from their `## Handoff`) |
| `runnerCompactAt` | `140000` | Same for the runner |
| `managerWarnAt` | `180000` | A manager's card turns amber above this |
| `quietMinutes` | `25` | A working session with no output this long is flagged "quiet" |
| `idleMinutes` | `45` | A manager idle this long raises a signal |
| `freeUnits` / `unitIdleMinutes` | `true` / `30` | End finished unit sessions after this many idle minutes |
| `dreamEvery` | `10` | Memory commits before the master tidies its memory |
| `jev` / `jevThreshold` / `waitThreshold` | `true` / `0.6` / `0.7` | Let Jev judge urgency (needs `TYPESAFE_API_KEY`) |

A unit you want to keep alive: pin its tab or label its terminal `herdr.hq.keep`.

### Loops

Org > Loops (`l`) edits each agent's loop: which steps run on a tick, in what order, how
often, in what words, and the heartbeat. You can pause, resume or reset a loop there. The
master follows the list `hq tick` gives it, so your edits apply on its next tick.

### In the code

For deeper changes. HQ reloads when its files change (see the warning below).

| To change | Where |
| --- | --- |
| The master's model | `MODEL` in `mods/master/master.py` |
| The skill every session starts in (`/pstack:poteto-mode`) | `SKILL` in `mods/master/master.py`, `POTETO` in `mods/hq/hq.py` |
| A new manager's default team | `DEFAULT_ROSTER` in `mods/hq/hq.py` (or `--roster` per manager) |
| The merge queue's model | `MERGE_QUEUE_MODEL` in `mods/hq/hq.py` |
| Default prompts for a new repo | `DEFAULT_POLICY`, `DEFAULT_ORDERS`, `DEFAULT_BASE`, `DEFAULT_STYLE` in `mods/hq/hq.py` |
| Default autopilot settings | `DEFAULT_SETTINGS` in `mods/hq/hq.py` |
| The rail, view order, view keys | `VIEWS` and `GROUPS` in `mods/hq/main.js` |
| Refresh and autopilot timing | `REFRESH_MS`, `AUTOPILOT_MS` in `mods/hq/main.js` |
| The opening key | `keys.json` |

### Where the code is

| Part | Files |
| --- | --- |
| Backend and `hq` CLI | `hq.py`, plus `mail.py` (mailbox), `loops.py` (loops), `watches.py` (watches), `runner.py` (loop runner), `merge_queue.py`, `roadmap.py`, `workflow_owners.py` |
| Guards | `hcguard.py` + `bin/hc` (org walls and mail rerouting), `answer_guard.py` (Stop hook: a turn you started must end with an answer), `watch_hook.py` (records background commands for Loops) |
| UI | `main.js` (shell, keys, rail), one file per view (`home.js`, `map.js`, `org.js`, `loops.js`, `review.js`, `chat.js`, ...), `ui.js` (shared pieces) |
| Generated, don't edit | `shared/*.js` (copied from the repo's `shared/js/`), `wf/` (mirror of `mods/workflows`). Edit the source, then run `shared/sync.sh` |
| Setup files | `setup/` (the `hq` launcher, the live map renderer, the Claude skill) |

`PRODUCT.md` describes who HQ is for and its design principles: read it before changing the UI.

### Testing a change safely

Herdr's mod runtime runs out of memory after many hot reloads of a big mod like HQ. So:

1. Copy the mod outside `mods/`, edit the copy.
2. `herdr-app check <copy>` (it renders every view headlessly).
3. Copy all the changed files back at once: one reload, not ten.

If HQ shows "out of memory" or views say "could not be re-rendered" (`herdr-app status` tells
you), restart Herdr: `herdr-app do app.quit`, then `open -a Herdr`. Your terminals survive.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| ⌘⇧H does nothing | Check `keys.json`, then `herdr-app check ~/.config/herdr-app/mods/hq` |
| HQ is empty or says no master | Press ⌘⌥M in a terminal inside the repo first |
| `hq: command not found` | Install `setup/hq` into `~/.local/bin` and put it on your `PATH` |
| The Map is blank | Install the renderer (step 3 above), then ask the master to run `hq lens seed` |
| The master stopped ticking | Status strip shows the loop state. HQ re-arms it within a minute (`autoRearm`); with the runner on, check the Loop tab |
| A screenshot looks stale | `herdr-app shot` returns an old frame while the window is in the background |
