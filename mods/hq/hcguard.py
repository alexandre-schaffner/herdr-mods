"""The wall between HQ orgs: a terminal of one org cannot reach a terminal of another through hc.

Every master and manager carries the label `herdr.hq.org=<org folder name>` (data/hq/<org>) and
`HQ_ORG` in its env, and gets `bin/hc` first on PATH. That script and hq.py's own hc calls ask
`refusal` before a command that reaches into a terminal (send, keys, interrupt, kill, put, rm,
label); read-only commands pass. A master may still write to another org's master (never to
its managers), and terminals with no org label (the person's shells, unit sessions) are open.

`mailbox_target` is the other half of bin/hc: an org session's `hc send` to its master goes to
the master's mailbox (`hq tell`) instead of its terminal.
"""

import os
import json
import re
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "bin")
LABEL = "herdr.hq.org"
MASTER = "herdr.master"
RUNNER = "herdr.runner"  # a master's loop runner, labelled with its master's registry key
GUARDED = {"send", "keys", "interrupt", "kill", "put", "rm", "label"}
VALUED = {"--if", "--timeout"}  # hc flags that take a value
REAL_FALLBACK = os.path.expanduser("~/.local/share/herdr-core/current/Contents/MacOS/herdr-core")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "repo"


def org_name(scope):
    """The org a master scope is: its data folder's name (data/hq/<org>)."""
    return slugify(scope["name"])


def env(scope):
    """The env assignments that put a session in its org: HQ_ORG and the guard first on PATH."""
    return [f"HQ_ORG={org_name(scope)}", f"PATH={BIN}:{os.environ.get('PATH', '')}"]


def real_hc():
    """The hc binary, from PATH without our own bin dir (never this script), else the install."""
    me = os.path.realpath(os.path.join(BIN, "hc"))
    rest = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p and os.path.realpath(p) != os.path.realpath(BIN)]
    found = shutil.which("hc", path=os.pathsep.join(rest))
    if found and os.path.realpath(found) != me:
        return found
    return REAL_FALLBACK


def terminal(addr):
    """`hc get <addr>` as a dict, or None when hc doesn't know it."""
    try:
        r = subprocess.run([real_hc(), "get", "--json", addr], capture_output=True, text=True, timeout=15)
        got = json.loads(r.stdout or "null") if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        got = None
    return got if isinstance(got, dict) else None


def target_of(args):
    """The terminal an hc command addresses: its first positional argument."""
    return next(iter(positionals(args)), None)


def positionals(args):
    """An hc command's positional arguments, flags and their values skipped."""
    got, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in VALUED:
            skip = True
        elif not a.startswith("-"):
            got.append(a)
    return got


def mailbox_target(args):
    """For `hc send <a master> <text>` from an org session that isn't a master (a manager, a
    workflow owner, a unit): where `hq tell` files it instead, as {folder, epic, text}, so reports
    land in the master's mailbox (mail.py) rather than in the person's conversation with it.
    None otherwise: the person's own shells and HQ's chat carry no terminal id, masters write to
    each other directly, and a loop runner types into its own master (`hq escalate`). Filed as
    mail, an escalation would wake the runner itself, whose tick reads it, and never the master."""
    if not args or args[0] != "send":
        return None
    pos = positionals(args[1:])
    me = os.environ.get("HC_TERMINAL_ID") or os.environ.get("HERDR_TERMINAL")
    if len(pos) < 2 or not me:
        return None
    t = terminal(pos[0])
    key = ((t or {}).get("labels") or {}).get(MASTER)
    if not key or not t.get("cwd"):
        return None
    mine = (terminal(me) or {}).get("labels") or {}
    if MASTER in mine or mine.get(RUNNER) == key or not (os.environ.get("HQ_ORG") or mine.get(LABEL) or mine.get("herdr.hq.manager")):
        return None
    epic = key.partition("#")[2]
    return {"folder": t["cwd"], "epic": epic or "-", "text": " ".join(pos[1:])}


def refusal(args, fallback_org=None):
    """Why `hc <args>` may not run from here, or None. The caller's org is HQ_ORG, else its own
    terminal's label (HC_TERMINAL_ID), else `fallback_org` (the scope an hq command acts in)."""
    if not args or args[0] not in GUARDED:
        return None
    target = target_of(args[1:])
    t = terminal(target) if target else None
    if not t:
        return None  # the real hc reports a missing terminal itself
    org = (t.get("labels") or {}).get(LABEL)
    if not org:
        return None
    me = os.environ.get("HC_TERMINAL_ID") or os.environ.get("HERDR_TERMINAL")
    mine = (terminal(me) or {}).get("labels") or {} if me else {}
    caller_org = os.environ.get("HQ_ORG") or mine.get(LABEL) or fallback_org
    if not caller_org or caller_org == org:
        return None
    if MASTER in mine and MASTER in (t.get("labels") or {}):
        return None
    return f"hc: {t.get('address') or target} belongs to the org {org}; this terminal is in {caller_org}. Write to that org's master instead."
