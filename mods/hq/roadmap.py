"""The roadmap: each epic's plan in phases, kept by the master that runs the epic, and the one
list of epics HQ shows (each epic's group, master and plan). hq.py calls in here; `H` is the
hq module (its helpers: paths, data_dir, write_json, who_am_i, hc_ls, ...).

One file per epic, repo-wide: data/hq/<repo>/roadmap/<epic>.json, {group, goal, status, note?,
phases, at, by}. A master publishes only the epics it runs (its own; the main master also those
no master runs), so two masters never write the same plan and nothing has to pick a winner.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

import masters as registry

PHASE_STATUS = ("done", "doing", "next", "later", "blocked")
ITEM_STATUS = ("done", "doing", "todo")
EPIC_STATUS = ("on track", "at risk", "blocked", "paused", "done")
MAX_ITEMS = 12
STALE_MS = 3 * 3600_000  # the tick reminds a master whose plans haven't moved in this long

GUIDE = """The roadmap is each epic's plan, in phases. An epic is one of the person's worktree groups
(the my-spaces sidebar groups worktrees into epics); each gets its own page in HQ > Roadmap, the
phases drawn left to right, phases that can run at the same time stacked side by side.

You keep the plans of the epics you run: your own epic, and if you're the repository's main master,
every epic that has no master of its own. Another master's epic is theirs to plan.
`hq roadmap set <file.json>` checks and publishes the epics in the file (a bad file is refused
with every problem listed; fix and retry); epics you leave out keep their plan.
`hq roadmap seed` prints a start: each of your epics with its worktrees as hints and its current
plan. `hq roadmap drop <epic>` removes a plan.

Shape:
  {"epics": [{"group": "<the group's name, exactly>", "goal": "<one plain sentence: what done looks like>",
              "status": "on track|at risk|blocked|paused|done", "note"?: "<one line: what to know now>",
              "phases": [{"id": "<lowercase-dashes>", "title": "<= 60 chars", "summary": "<= 160 chars",
                          "status": "done|doing|next|later|blocked", "after"?: ["<phase id>", ...],
                          "owner"?: "<manager id or person>", "eta"?: "<short, like 'this week'>",
                          "items"?: [{"label": "<= 80 chars", "status": "done|doing|todo", "link"?: "<url>"}]}]}]}

`after` lists the phases that must finish first. Phases with the same `after` run in parallel. No
`after` means it can start now. Keep 3 to 8 phases per epic and up to 12 items per phase (PRs,
units, decisions; 6 or fewer reads best). Write like you talk to the person: plain words, no
jargon, no internal codenames they wouldn't know. Say what each phase gets them, not how. Update
it when a phase starts, finishes or gets stuck, and when the plan changes."""


# ---- storage

def plan_dir(H, scope):
    return os.path.join(H.data_dir(registry.base_of(scope)), "roadmap")


def plan_path(H, scope, epic):
    return os.path.join(plan_dir(H, scope), H.slugify(epic) + ".json")


def plans(H, scope):
    """Every epic's plan in the repo: epic name -> plan."""
    d = plan_dir(H, scope)
    if not os.path.isdir(d):
        migrate(H, scope)
    out = {}
    for path in glob.glob(os.path.join(d, "*.json")):
        p = H.claude.read_json(path)
        if isinstance(p, dict) and isinstance(p.get("group"), str) and isinstance(p.get("phases"), list):
            out[p["group"]] = p
    return out


def migrate(H, scope):
    """Once: the old one-file-per-scope roadmap.json files become one file per epic (an epic's own
    master's copy wins, as it did when they were merged on read)."""
    os.makedirs(plan_dir(H, scope), exist_ok=True)
    got = {}
    for sc in registry.all_scopes(scope):
        old = os.path.join(H.paths(sc)["dir"], "roadmap.json")
        doc = H.claude.read_json(old)
        if not isinstance(doc, dict) or not isinstance(doc.get("epics"), list):
            continue
        mine = registry.my_epic(sc)
        for e in doc["epics"]:
            if isinstance(e, dict) and isinstance(e.get("group"), str) and (e["group"] == mine or e["group"] not in got):
                got[e["group"]] = {**e, "at": doc.get("at"), "by": doc.get("by")}
        os.replace(old, old + ".migrated")
    for epic, p in got.items():
        H.write_json(plan_path(H, scope, epic), p)


def mine(H, scope, known=None):
    """The epics this scope's master plans: its own and, for the main master, every epic (group or
    published plan) no other master runs."""
    names = set(registry.groups(scope)) | set(known if known is not None else plans(H, scope))
    return sorted(e for e in names | {registry.my_epic(scope)} if e and registry.owns(scope, e))


# ---- the document a master publishes

def check(doc):
    issues = []
    add = lambda where, what: issues.append(f"{where}: {what}")  # noqa: E731
    if not isinstance(doc, dict) or not isinstance(doc.get("epics"), list):
        return ["(document): needs {\"epics\": [...]}"]
    seen = set()
    for i, e in enumerate(doc["epics"]):
        w = f"epics[{i}]"
        if not isinstance(e, dict):
            add(w, "must be an object")
            continue
        g = e.get("group")
        if not isinstance(g, str) or not g.strip():
            add(w, "needs a group (the worktree group's name)")
            continue
        w = f"epic '{g}'"
        if g in seen:
            add(w, "listed twice")
        seen.add(g)
        if e.get("status", "on track") not in EPIC_STATUS:
            add(w, f"status must be one of {', '.join(EPIC_STATUS)}")
        for k, n in (("goal", 200), ("note", 200)):
            if e.get(k) is not None and (not isinstance(e[k], str) or len(e[k]) > n):
                add(w, f"{k} must be text of at most {n} chars")
        phases = e.get("phases") or []
        if not isinstance(phases, list):
            add(w, "phases must be a list")
            continue
        ids = {}
        for k, ph in enumerate(phases):
            pw = f"{w} phase {k + 1}"
            if not isinstance(ph, dict):
                add(pw, "must be an object")
                continue
            pid = ph.get("id")
            if not isinstance(pid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", pid):
                add(pw, "id must be lowercase letters, digits and dashes")
                continue
            if pid in ids:
                add(pw, f"id '{pid}' used twice")
            ids[pid] = ph
            for key, n, need in (("title", 60, True), ("summary", 160, False), ("owner", 60, False), ("eta", 40, False)):
                v = ph.get(key)
                if v is None and not need:
                    continue
                if not isinstance(v, str) or (need and not v.strip()):
                    add(pw, f"needs a {key}" if need else f"{key} must be text")
                elif len(v) > n:
                    add(pw, f"{key} is longer than {n} chars")
            if ph.get("status") not in PHASE_STATUS:
                add(pw, f"status must be one of {', '.join(PHASE_STATUS)}")
            after = ph.get("after") or []
            if not isinstance(after, list) or not all(isinstance(a, str) for a in after):
                add(pw, "after must be a list of phase ids")
                ph["after"] = after = []
            items = ph.get("items") or []
            if not isinstance(items, list) or len(items) > MAX_ITEMS:
                add(pw, f"items must be a list of at most {MAX_ITEMS}")
                continue
            for j, it in enumerate(items):
                iw = f"{pw} item {j + 1}"
                if not isinstance(it, dict) or not isinstance(it.get("label"), str) or not it["label"].strip():
                    add(iw, "needs a label")
                elif it.get("status", "todo") not in ITEM_STATUS:
                    add(iw, f"status must be one of {', '.join(ITEM_STATUS)}")
                elif len(it["label"]) > 80:
                    add(iw, "label is longer than 80 chars")
                elif it.get("link") is not None and not isinstance(it["link"], str):
                    add(iw, "link must be text")
        for pid, ph in ids.items():
            for a in ph.get("after") or []:
                if a not in ids:
                    add(f"{w} phase '{pid}'", f"after names '{a}', which isn't a phase of this epic")
        state = {}  # no loops in `after`

        def visit(pid, trail):
            if state.get(pid) == 2:
                return
            if state.get(pid) == 1:
                add(w, "phases wait on each other in a loop: " + " -> ".join(trail + [pid]))
                return
            state[pid] = 1
            for a in ids.get(pid, {}).get("after") or []:
                if a in ids:
                    visit(a, trail + [pid])
            state[pid] = 2

        for pid in ids:
            visit(pid, [])
    return issues


# ---- commands

def cmd_status(H, scope):
    print(GUIDE)
    have = plans(H, scope)
    groups = registry.groups(scope)
    own = mine(H, scope, have)
    others = registry.epic_masters(scope)
    print()
    print("Epics of this repo:" if groups or have else "This repo has no worktree groups yet: nothing to plan.")
    for g in sorted(set(groups) | set(have)):
        p = have.get(g)
        state = (f"{sum(1 for x in p['phases'] if x.get('status') == 'done')}/{len(p['phases'])} phases done, "
                 f"{p.get('status', 'on track')}") if p else f"no plan yet ({len(groups.get(g, []))} worktrees)"
        whose = "yours" if g in own else f"run by {others.get(g, {}).get('terminal') or 'its own master'}"
        print(f"- {g}: {state} ({whose})")


def cmd_seed(H, scope):
    have = plans(H, scope)
    groups = registry.groups(scope)
    epics = []
    for g in mine(H, scope, have):
        e = {k: v for k, v in (have.get(g) or {"group": g, "goal": "", "status": "on track", "phases": []}).items() if k not in ("at", "by")}
        e["_worktrees"] = sorted(os.path.basename(p) for p in groups.get(g, []))
        epics.append(e)
    print(json.dumps({"epics": epics}, indent=1))


def cmd_set(H, scope, src):
    text = H.read(src)
    if text is None:
        H.fail(f"no file {src}")
    try:
        doc = json.loads(text)
    except ValueError as e:
        print(f"The roadmap was NOT updated: {src} isn't valid JSON ({e}).")
        sys.exit(1)
    issues = check(doc)
    if not issues:
        names = {e["group"] for e in doc["epics"]}
        own = set(mine(H, scope, set(plans(H, scope)) | names))
        issues = [f"epic '{g}': another master runs it; leave it out (write to that master instead)" for g in sorted(names - own)]
    if issues:
        print("The roadmap was NOT updated. Fix these and run hq roadmap set again:")
        for i in issues:
            print(f"- {i}")
        sys.exit(1)
    who = H.who_am_i(scope)
    by = who.get("role") or who.get("terminal")
    for e in doc["epics"]:
        e.pop("_worktrees", None)
        H.write_json(plan_path(H, scope, e["group"]), {**e, "at": H.NOW(), "by": by})
    names = [e["group"] for e in doc["epics"]]
    H.log_activity(scope, "roadmap", f"Roadmap updated: {', '.join(names) or 'nothing'}", by=by)
    print(f"ok: published {len(names)} epic plan(s), shown in HQ > Roadmap")
    unknown = sorted(set(names) - set(registry.groups(scope)))
    if unknown:
        print(f"note: no worktree group named {', '.join(unknown)}; those epics still show, marked 'No worktree group'.")


def cmd_drop(H, scope, epic):
    if not registry.owns(scope, epic):
        H.fail(f"another master runs '{epic}'; only it can drop its plan")
    path = plan_path(H, scope, epic)
    if not os.path.exists(path):
        H.fail(f"no plan for '{epic}'")
    os.remove(path)
    H.log_activity(scope, "roadmap", f"Roadmap: dropped the plan for {epic}", by=H.who_am_i(scope).get("role"))
    print(f"ok: dropped the plan for {epic}")


def cmd(H, scope, args):
    if not args:
        return cmd_status(H, scope)
    if args[0] == "set" and len(args) > 1:
        return cmd_set(H, scope, args[1])
    if args[0] == "seed":
        return cmd_seed(H, scope)
    if args[0] == "drop" and len(args) > 1:
        return cmd_drop(H, scope, args[1])
    H.fail("hq roadmap [set <file> | seed | drop <epic>]")


# ---- the master's tick and HQ's snapshot

def tick_lines(H, scope):
    have = plans(H, scope)
    own = mine(H, scope, have)
    missing = [g for g in own if g not in have and g in registry.groups(scope)]
    if missing:
        return [f"- Roadmap: no plan yet for {', '.join(missing[:4])}{'…' if len(missing) > 4 else ''}. `hq roadmap` explains it."]
    last = max((have[g].get("at") or 0 for g in own if g in have), default=0)
    if last and H.NOW() - last > STALE_MS:
        return [f"- Roadmap: your plans last moved {int((H.NOW() - last) / 3600000)} h ago. Update phases that moved (`hq roadmap`)."]
    return []


def epics_snapshot(H, scope):
    """The repo's epics, one row each: its worktree group, its master (address, state) and plan.
    Epics with a plan but no group are listed too (`orphan`). `current` is the scope shown."""
    regs = registry.epic_masters(scope)
    rows = {t["address"]: t for t in H.hc_ls()}
    groups = registry.groups(scope)
    have = plans(H, scope)
    current = registry.my_epic(scope)
    out = []
    if "" in regs:  # a main master that names no epic: a row of its own, so the bar can go back to it
        reg = regs[""]
        t = rows.get(reg.get("terminal"))
        out.append({"name": registry.MAIN, "label": "Main", "key": reg["key"], "current": not scope.get("epic"),
                    "master": reg.get("terminal") if t else None, "status": t.get("status") if t else "gone",
                    "worktrees": 0, "orphan": False, "plan": None, "main": True})
    for g in sorted(set(groups) | set(have) | {e for e in regs if e}):
        reg = regs.get(g)
        t = rows.get((reg or {}).get("terminal"))
        fresh = H.NOW() - ((reg or {}).get("startedAt") or 0) < registry.STARTING_MS  # Claude Code may not show yet
        claude_runs = bool(t) and (t.get("agent") == "claude-code" or fresh)
        out.append({"name": g, "key": (reg or {}).get("key"), "current": g == current,
                    "master": reg["terminal"] if claude_runs else None,
                    "status": t.get("status") if claude_runs else ("gone" if reg else None),
                    "worktrees": len(groups.get(g, [])), "orphan": g not in groups and g not in regs,
                    "plan": have.get(g)})
    return out
