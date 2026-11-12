"""Each repository's master chats: one registry and one rule for finding them, shared by
master.py (which starts them) and hq.py (which watches them).

A repository has a main master (registry key: the repo key; its entry's `epic` names the epic it
runs) and may have one master per other epic (a worktree group in the sidebar): key
`<repo key>#<epic>`, name `<repo name> · <epic>`. `scope_of` turns a repo and an epic into that
scope, which every function here takes in place of a repo; the epics section below owns scopes.

The registry (claude.MASTERS) maps a repo key to {sessionId, terminal, path, name, startedAt}.
The master is the live terminal running Claude Code that carries the label
`herdr.master=<key>` or shows the registered session; a terminal started moments ago counts
before Claude Code shows in it. Finding it also repairs the registry: the session the terminal
runs now (after /clear, or a resume that forked) and its address are written back, and a lost
label is put back, so the two never drift apart.
"""

import fcntl
import json
import os
import subprocess
import time
from contextlib import contextmanager

import claude

LABEL = "herdr.master"
LOOP_PROMPT = "/loop master tick"
STARTING_MS = 90_000  # a master this fresh may not show as Claude Code yet


def load():
    return claude.masters()


def _save(masters):
    os.makedirs(os.path.dirname(claude.MASTERS), exist_ok=True)
    tmp = f"{claude.MASTERS}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(masters, f, indent=1)
    os.replace(tmp, claude.MASTERS)


_held = 0


@contextmanager
def lock():
    """Held across every read-modify-write of the registry, and across starting a master,
    so two clicks on Start can't make two masters. Re-entrant within a process."""
    global _held
    if _held:
        _held += 1
        try:
            yield
        finally:
            _held -= 1
        return
    os.makedirs(os.path.dirname(claude.MASTERS), exist_ok=True)
    with open(claude.MASTERS + ".lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        _held = 1
        try:
            yield
        finally:
            _held = 0
            fcntl.flock(f, fcntl.LOCK_UN)


def record(key, **fields):
    """Merges `fields` into one repo's entry, re-read under the lock."""
    with lock():
        masters = load()
        masters[key] = {**(masters.get(key) or {}), **fields}
        _save(masters)
        return masters[key]


def set_label(addr, key):
    """Labels `addr` as `key`'s master; True once the label reads back."""
    for _ in range(3):
        subprocess.run(["hc", "label", addr, f"{LABEL}={key}"], capture_output=True, timeout=15)
        got, _ = claude.hc_json("get", addr)
        if ((got or {}).get("labels") or {}).get(LABEL) == key:
            return True
        time.sleep(0.3)
    return False


def find(repo, stale=False, repair=True):
    """{terminal (as `hc get` has it) or None, entry, proc, stale}.

    Looks at the registered terminal first (the usual case: one `hc ls`, one `hc get`), then
    every other Claude Code terminal. `stale=True` also scans plain shells for labelled
    leftovers (slow: one `hc get` per terminal), for starting a master."""
    key = repo["key"]
    entry = load().get(key) or {}
    sid = entry.get("sessionId")
    proc = claude.sessions().get(sid) if sid else None
    listed, _ = claude.hc_json("ls")
    rows = [r for r in (listed or {}).get("terminals") or [] if r.get("state") == "live"]
    reg = entry.get("terminal")
    order = sorted(rows, key=lambda r: (r["address"] != reg, r.get("agent") != "claude-code"))
    fresh = time.time() * 1000 - (entry.get("startedAt") or 0) < STARTING_MS
    found, leftovers = None, []
    for r in order:
        addr = r["address"]
        if found and not stale:
            break
        if r.get("agent") != "claude-code" and not stale and not (addr == reg and fresh):
            continue
        got, _ = claude.hc_json("get", addr)
        if not isinstance(got, dict):
            continue
        labelled = (got.get("labels") or {}).get(LABEL) == key
        starting = addr == reg and fresh and got.get("state") == "live"
        if not found and ((claude.runs_claude(got) and (labelled or claude.shows_session(got, proc))) or (labelled and starting)):
            found = got
        elif labelled and not claude.runs_claude(got):
            leftovers.append({"address": addr, "idle": not claude.has_children(got.get("pid"))})
    if found and repair:
        entry = _repair(repo, entry, found)
    return {"terminal": found, "entry": entry, "proc": proc, "stale": leftovers}


def _repair(repo, entry, t):
    key, addr = repo["key"], t["address"]
    if (t.get("labels") or {}).get(LABEL) != key:
        set_label(addr, key)
    now = claude.session_of(claude.terminal_pids(t)) if claude.runs_claude(t) else None
    fields = {}
    if addr != entry.get("terminal"):
        fields["terminal"] = addr
    if now and now["sessionId"] != entry.get("sessionId"):
        fields["sessionId"] = now["sessionId"]
    if not fields:
        return entry
    try:
        return record(key, path=repo["path"], name=repo["name"], **fields)
    except OSError:
        return {**entry, **fields}

# ---- the loop runner: a cheap session per master that runs `/loop master tick`
#
# Its registry entry is the master's `runner` field: {terminal, sessionId, startedAt}. Its terminal
# carries `herdr.runner=<key>`. A runner is only ever found at its registered terminal (or, with
# scan=True, by its label anywhere), so HQ's minute-by-minute checks cost one `hc get`.

RUNNER_LABEL = "herdr.runner"


def find_runner(repo, scan=False):
    """The runner's terminal (as `hc get` has it) or None."""
    key = repo["key"]
    reg = ((load().get(key) or {}).get("runner") or {})
    fresh = time.time() * 1000 - (reg.get("startedAt") or 0) < STARTING_MS
    addrs = [reg["terminal"]] if reg.get("terminal") else []
    if scan:
        listed, _ = claude.hc_json("ls")
        addrs += [r["address"] for r in (listed or {}).get("terminals") or []
                  if r.get("state") == "live" and r.get("agent") == "claude-code" and r["address"] not in addrs]
    for addr in addrs:
        got, _ = claude.hc_json("get", addr)
        if not isinstance(got, dict) or got.get("state") != "live":
            continue
        labelled = (got.get("labels") or {}).get(RUNNER_LABEL) == key
        if labelled and (claude.runs_claude(got) or (addr == reg.get("terminal") and fresh)):
            if addr != reg.get("terminal"):
                record(key, runner={**reg, "terminal": addr})
            return got
    return None


# ---- epics: one master per worktree group
#
# A scope is a repo dict (repo_of's {key, name, path, ...}) plus `repoKey` and `repoName`, the
# repo's own key and name; an epic scope also has `epic`, and its own `key`/`name` (so its own HQ
# data folder). Every scope comes from scope_of/base_of: nothing else builds or parses one.

GROUPS = os.path.join(claude.APP_HOME, "data", "my-spaces", "groups.json")
MAIN = "-"  # HQ_EPIC for the main master and its managers: the repo's main scope, wherever they run


def parse_key(key):
    """A registry key as (repo key, epic or None)."""
    repo_key, _, epic = (key or "").partition("#")
    return repo_key, epic or None


def base_of(scope):
    """The repo's main scope, from the repo itself or any of its epic scopes."""
    if not scope:
        return scope
    key, name = scope.get("repoKey", scope["key"]), scope.get("repoName", scope["name"])
    return {**{k: v for k, v in scope.items() if k != "epic"}, "key": key, "name": name, "repoKey": key, "repoName": name}


def main_epic(scope):
    """The epic the repo's main master runs (its registry entry's `epic`), if it says."""
    return (load().get(base_of(scope)["key"]) or {}).get("epic")


def scope_of(repo, epic=None):
    """The master scope for `epic` of `repo`: the main scope for the main master's epic (or no
    epic), else that epic's own."""
    if not repo:
        return repo
    base = base_of(repo)
    if not epic or epic == main_epic(base):
        return base
    return {**base, "key": f"{base['key']}#{epic}", "name": f"{base['name']} · {epic}", "epic": epic}


def my_epic(scope):
    """The epic this scope's master runs: the scope's own, or the main master's."""
    return scope.get("epic") or main_epic(scope)


def groups(repo):
    """The person's worktree groups (epics) of this repo, from the sidebar: name -> worktree paths.
    A group's worktree belongs to the repo when it is one of Herdr's worktrees of the repo
    (~/.herdr/worktrees/<repo folder>/...) or a folder inside the repo itself, but not another
    repo's worktrees that happen to sit under it (as everything does under a home-folder repo)."""
    got = claude.read_json(GROUPS)
    root = repo["path"].rstrip("/")
    base = os.path.basename(root)
    out = {}
    for path, name in (got if isinstance(got, dict) else {}).items():
        if not isinstance(name, str) or not name.strip():
            continue
        p = path.rstrip("/")
        inside = p.startswith(root + "/") and "/.herdr/worktrees/" not in p[len(root):]
        if os.path.basename(os.path.dirname(p)) == base or inside:
            out.setdefault(name, []).append(p)
    return out


def epic_of_folder(repo, folder):
    """The repo's worktree group (epic) a folder is in, or None."""
    f = os.path.realpath(folder or "").rstrip("/")
    for name, wts in groups(repo).items():
        if any(f == p or f.startswith(p + "/") for p in wts):
            return name
    return None


def epic_masters(repo):
    """Every registered master of the repo, by the epic it runs ("" for a main master with no epic)."""
    base = base_of(repo)["key"]
    out = {}
    for k, v in load().items():
        rk, epic = parse_key(k)
        if rk == base:
            out[epic or v.get("epic") or ""] = {**v, "key": k}
    return out


def all_scopes(scope):
    """The repo's main scope, then each other epic master's scope."""
    base = base_of(scope)
    return [base] + [scope_of(base, e) for e, m in epic_masters(base).items() if parse_key(m["key"])[1]]


def owns(scope, epic):
    """Whether this scope's master runs `epic`: its own, or (the main master) one no master runs."""
    if epic == my_epic(scope):
        return True
    return not scope.get("epic") and epic not in epic_masters(scope)


def claude_env(scope):
    """The env prefix for a master's or manager's Claude session in this scope: its `hq` commands
    act in this scope wherever it `cd`s (HQ_REPO, HQ_EPIC), and its transcript is kept on disk (HQ
    reads it) even when launched from inside another Claude session (CLAUDE_CODE_CHILD_SESSION)."""
    return ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1",
            f"HQ_REPO={scope['path']}", f"HQ_EPIC={scope.get('epic') or MAIN}"]


def pop_flag(args, name):
    """Removes `--name value` from an argv list and returns the value (None when absent)."""
    if name not in args:
        return None
    i = args.index(name)
    val = args[i + 1] if i + 1 < len(args) else None
    del args[i:i + 2]
    return val
