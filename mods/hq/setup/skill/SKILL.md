---
name: hq
description: Herdr HQ, the person's desk over the master chat and its org. Use whenever the person asks to create, change, launch, respawn or retire a manager; add, reorder or close a to-do / next move; file something for their approval or review; update the live map or the status headline; or asks what HQ shows. Also for managers filing approvals, questions and finished work.
---

# HQ

HQ is a Herdr view (⌘⇧H) where the person supervises the org of agents working on a repository: a **master chat** (perpetual, `/loop master tick`; an epic can have its own), **one merge-queue manager per epic**, and **one manager per area of focus**, each running its own team (subagents, unit sessions). HQ shows: **Home** (the master's written update), the **Map** (the org and work in flight), **Next** (the master's next moves), **Review** (approvals and work to look over), **Chat**, **Org** (the roster), **Brief**, **Usage** (proxy and plan limits), **Pulse**, **Memory**, **Library** (artifacts made for the person), **Workflows** (the person's workflow runs, each with its owner session) and **Prompts**.

Everything goes through the `hq` command (`~/.local/bin/hq`), run from inside the repository (or pass `--repo <folder>`). `hq` with no arguments prints the full reference. Act through it rather than editing HQ's files.

## When the person asks for something

| They say | You run |
|---|---|
| "Create / spin up a manager for X" | `hq manager-new --id x --area "<one sentence: what it owns>" --charter "<how>" --launch` (merge queue: `--kind merge-queue --group <epic> --trunk <branch>`; one per epic) |
| "Change X's charter / area / model" | `hq manager-set x --charter-file <file>` (or `--area`, `--model`, `--base`); applies at its next launch or respawn |
| "Restart X fresh" / its context rotted | `hq manager-respawn x` (only when idle; it continues from its report's `## Handoff`) |
| "Retire X" / "bring t49 into the org" | `hq manager-retire x` / `hq adopt t49 <id> area` |
| "Who's in the org?" | `hq managers` |
| "Add a to-do / next move" | `hq todo add --title "<the move>" --owner <manager-id\|master\|person> --why "<one line>" [--link <pr>] [--at top]` |
| "That's done / drop it / it's blocked" | `hq todo done <id>` / `hq todo drop <id>` / `hq todo block <id> <what it waits on>` |
| "What's next?" | `hq todo` |
| "Make me a doc / plan / diagram / page / deck…" | make it, then `hq artifact add <file\|folder> --title "…" --summary "…" --request "<their words>"` (or `--url <link>`); revise with the same `--id` for a new version |
| "What have you made for me?" | `hq artifact list` |
| "Run workflow X" / an `HQ WORKFLOW REQUEST [<id>]` message | `hq workflow-launch <id> [--note "<context>"]` for a request; `hq workflow-launch --name X [--args-json '{...}'] [--folder F]` otherwise. It spawns an owner session that runs it and reports back |
| "How's that workflow doing?" | `hq workflows`, `hq workflow-show <id>` |

After an org change, file `hq done --title ... --body ...` so the person can review it later (the master's approval policy: only outward-facing actions need a yes first).

## Asking the person

- An outward-facing action (merging to a shared branch, deploying, messaging people, anything destructive outside this machine): `hq ask approval --title "<what>" --body "<why, evidence, risk>" --action "<the exact command>" --link <pr>`. Then wait for the `HQ DECISION <id> ...` message and do exactly what was approved.
- A judgement only they can make: `hq ask question --title ... --body "<options and your recommendation>"`.
- Work worth a look after the fact: `hq done --title ... --body "<what changed, how to check>" --link ...`.
- Never ask in chat what belongs in the inbox: the person reviews in batches.
- Write every `--body` as Markdown a person can scan: short paragraphs, the options as a numbered list ("1. …"), your recommendation on its own line. For anything over two sentences, write the body to a file and pass `--body-file` (shell quotes lose line breaks). When something you filed is settled elsewhere (in chat, by another agent) or moot, close it at once with `hq resolve <id> "how it was settled"`; it must not sit in the person's inbox.

## Keeping the picture current (the master)

- `hq status "<one line>"`: the headline in HQ's status strip, when your loop's status step is due.
- `hq home set <file>`: the update HQ opens on, in plain sentences: how things stand, merged today, in testing, next in line, being built, housekeeping, waiting on you (the master's prompt has the shape).
- `hq todo`: the next moves, a handful, in the order you'll do them; the person's reorders, vetoes and notes arrive via `hq tick` and win.
- `hq lens`: the live map. `hq lens seed` drafts it from the org, `hq lens set <file>` publishes (invalid documents are refused with every issue listed). Node kinds draw differently: agents `service`/`job`, PRs `package` ("#5329 title"), processes `queue`/`datastore`/`external`, files `module` with `files`.
- `hq tick`: the loop's steps due now first, then what changed since the last tick. Read it whole, never trimmed. `hq handoff`: the master's handoff file.
- When each page is updated (Home, Next, the roadmap, the live map) is the loop's business: the person sets each step's cadence in HQ > Org > Loops.

## The loop runner

By default each master has a **loop runner**: a Haiku session in a "Loop" tab beside it that runs `/loop master tick`, keeps status, Home, map, roadmap and next moves current, and hands judgment to the master with `hq escalate --title "<bottom line>" --body-file F [--urgent]` (BLUF, then SBAR). The master then has no loop: it acts on `HQ ESCALATION` lines, the person, decisions and watches, and keeps its handoff current. HQ wakes and re-arms the runner, not the master. `hq runner` shows it, `hq runner start` starts one, `hq escalations` lists what it sent. Off per repository with `runner: false` in the org's settings.json.

## Workflow owners

Each of the person's workflow runs is owned by its own Claude session, spawned by the master with `hq workflow-launch`. The owner starts the run from its brief, resumes it when it stalls (at most twice), files approvals and questions like anyone else, and ends with `hq workflow-report <id> --status completed|partial|failed --body-file <file>`, which stores the report in HQ and sends the master a one-line summary. The master relays the result to the person, then closes the owner with `hq workflow-close <id>` (the report stays). An owner takes no other work.

## Managers

Managers file approvals, questions and finished work with the same `hq ask` / `hq done`; they don't change the org or the master's next moves. They report to the master with `hq tell "..."` (`--urgent` when stopped), never by typing into its terminal: an `hc send` to the master is rerouted to its mailbox anyway. Their unit sessions report to them, not to the master or the person.

## What HQ does on its own

- Wakes an idle master with an `HQ TICK: <why>` line (urgent mail, the person's steering, a manager gone or waiting), and types `/loop master tick` back in when a loop lapses, unless the person paused it.
- Delivers the person's verdicts as `HQ DECISION <id> ...` lines typed into the asker's terminal; `HQ:` and `HQ LOOP:` lines are HQ's own notes and loop changes.
- Compacts an idle master that has grown large, only from a fresh handoff (so keep it true).
- Ends a manager's unit sessions once they have finished and sat idle a while, and a retired manager's session.
- Keeps each epic's org walled: `hc` into another org's terminals is refused (masters may write to each other).
- Holds the person's messages typed while an agent works and sends them as one when its turn ends; a Stop hook makes sure a turn the person started ends with a written answer.
- The person's own texts (messages, standing orders, loop steps, policy) win over any prompt.

## Don't

- Don't edit `~/.config/herdr-app/data/hq/**` by hand (org.json, todo.json, inbox): `hq` validates and logs every change.
- Don't merge, deploy or message people without an approved `hq ask approval`.
