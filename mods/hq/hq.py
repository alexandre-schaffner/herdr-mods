"""HQ: the master chat's desk in Herdr. The org (managers and their teams), the review inbox,
the next moves, the live map, and what's going on now. `hq` is for agents; the HQ mod calls it
too. The repository is the one the current folder belongs to unless `--repo <folder>` says so.

The person (talk to the master):
  hq ask approval --title T --body B --action "<exact command>" [--link URL]...
                                   an outward-facing action that waits for a yes (HQ > Review)
  hq ask question --title T --body B   a decision only the person can make
  hq done --title T --body B [--link URL]...   finished work to look over after the fact

The org:
  hq managers                      the managers: id, kind, status, terminal, area
  hq manager-new --id ID [--kind area|merge-queue] [--name N] [--area "<one sentence>"]
      [--base main] [--model opus] [--group G] [--charter "<text>" | --charter-file F]
      [--roster "<count x role (model, effort): notes>; ..."] [--launch]
                                   add a manager (and start it: worktree, space, Claude session)
  hq manager-set ID [--name N] [--area A] [--base B] [--model M] [--group G]
      [--charter T | --charter-file F]   change one (used at its next launch or respawn)
  hq manager-launch ID | manager-respawn ID | manager-retire ID
  hq adopt <terminal> <id> [area|merge-queue]   bring a running session into the org
  hq discover                      running sessions in this repo that could be adopted
  hq brief ID                      the brief a manager gets (template + charter + team)

Next moves (HQ > Next; the master keeps them, the person steers):
  hq todo                          the plan, with the person's notes
  hq todo add --title T [--owner ID|master|person] [--why W] [--link URL] [--status next|doing|blocked] [--at top]
  hq todo start|done|drop ID       hq todo block ID <what it waits on>
  hq todo set ID [--title T] [--owner O] [--why W] [--status S]

Keeping the picture current:
  hq status "<one line>"           the headline in HQ's status strip
  hq tick                          what changed since the last tick (decisions, steering, signals)
  hq lens | lens seed | lens set <file>   the live map (PR Lens graph) shown in HQ > Map
  hq handoff                       the master's handoff file (path)
  hq compact <terminal>            /compact an idle Claude session
  hq dream                         start a Dreaming pass over ~/agent-memory

Files the person edits in HQ > Prompts: `hq files` prints their paths (approval policy,
standing orders, manager brief template, handoff, autopilot settings).
"""

from __future__ import annotations

import calendar
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(APP, "shared"))
import claude  # noqa: E402
from repos import repo_of  # noqa: E402

HOME = os.path.expanduser("~")
MEMORY = os.path.join(HOME, "agent-memory")
DREAM_SH = os.path.join(HOME, ".local/share/agent-memory-dream/dream.sh")
DREAM_LOG = os.path.join(HOME, ".local/state/agent-memory-dream/dream.log")
MASTER_PROMPT = os.path.join(APP, "mods", "master", "master.md")
GROUPS = os.path.join(APP, "data", "my-spaces", "groups.json")
WORKTREES = os.path.join(HOME, ".herdr", "worktrees")
MASTER_LABEL = "herdr.master"
MANAGER_LABEL = "herdr.hq.manager"
LOOP_PROMPT = "/loop master tick"
POTETO = "/pstack:poteto-mode"  # every manager session starts in poteto mode
TAIL = 3_000_000
NOW = lambda: int(time.time() * 1000)  # noqa: E731

DEFAULT_SETTINGS = {
    "autoRearm": True,          # type the loop back in when the master's loop has lapsed
    "autoCompactMaster": True,  # /compact the master when idle and over the line below
    "masterCompactAt": 600_000,
    "managerWarnAt": 400_000,   # context size a manager's card turns amber at
    "quietMinutes": 25,         # working with no transcript write for this long: quiet
    "idleMinutes": 45,          # a manager idle this long with a handoff: idle signal
    "dreamEvery": 10,           # memory commits since the last Dream before the master dreams
}

DEFAULT_POLICY = """# What needs the person's approval

The person approves only outward-facing actions. File `hq ask approval` and wait for the
`HQ DECISION` message before doing any of these:

- Merging a PR into a shared branch (trunk, release branches), or running a merge batch.
- Deploying, restarting, or changing anything in production or a shared environment.
- Messages to people: Slack, email, PR or issue comments addressed to someone, review requests.
- Anything destructive or irreversible outside this machine (force pushes, deleting remote
  branches, closing other people's PRs).

Everything else you just do, then file `hq done` so the person can review it after the
fact: starting, re-briefing, respawning or retiring managers, prompt and charter edits,
memory edits, pushing work branches, opening draft PRs, re-running CI, compacting sessions.
"""

DEFAULT_ORDERS = """# Standing orders

Short, current instructions from the person. You re-read this file on every tick, so edits
apply at once. Keep the org lean: one merge-queue manager, one manager per area of focus.
"""

DEFAULT_BASE = """You are a manager in {repo}'s org. The master chat ({master}) oversees you; the
person reviews your work through Herdr's HQ panel (the `hq` skill explains it: run `hq` for the
reference). Use `hq ask` / `hq done` to reach the person; changing the org or the master's next
moves is the master's job.

## Poteto mode, always
You run in poteto mode for the whole life of your session. Load the `pstack:poteto-mode` skill
(the Skill tool) at the start, after every compaction or resume, and whenever it is no longer in
your context, then follow it in everything: planning, briefing your team, verifying, reporting.
Where it differs from this brief, this brief's rules on approvals, memory and the master win.
Code work goes to `pstack:poteto-agent` subagents or unit sessions started with
`/pstack:poteto-mode` as their first message.

## How you work
- You own your area end to end: plan, run your team, verify, and land work through the merge
  queue manager (post `READY: <pr url> <head sha>` lines in your report).
- Run your team as subagents or as unit sessions in sibling worktrees
  (`~/.herdr/worktrees/{repo_dir}/{id}-<unit>`); label unit terminals
  `hc label <t> {label}={id}` so HQ shows them under you.
- Keep a `## Handoff` section at the top of `.audit/{id}/report.md` (goal, state, open PRs and
  heads, team in flight, next steps, decisions, pending questions). Update it at each wave end,
  each READY and before each long wait. If your session is replaced, the next one starts from it.
- Outward-facing actions need the person's approval: read {policy} and file
  `hq ask approval --title ... --body ... --action ...`; wait for the `HQ DECISION` message.
  Questions only the person can answer: `hq ask question`. Finished work worth a look:
  `hq done --title ... --body ... --link <pr>`.
- Report to the master with `hc send {master} "<message>"` when you are blocked, change
  plans, or finish a phase. Send `LESSON: ({id}, <date>) ...` lines as you learn them.

## Memory
Read `~/agent-memory/MEMORY.md` and `~/agent-memory/projects/{repo_dir}.md` at the start and
before each wave. They are read-only for you: the master is the only writer.
"""

DEFAULT_ROSTER = [
    {"role": "implementer", "model": "sonnet", "effort": "high", "count": 4,
     "notes": "Builds and compiles only; no individual test runs."},
    {"role": "advisor", "model": "opus", "effort": "xhigh", "count": 1,
     "notes": "Briefs the wave, runs all tests in one batch once every implementer is back, fixes failures itself."},
    {"role": "verifier", "model": "opus", "effort": "xhigh", "count": 1,
     "notes": "Fresh eyes on the three-dot diff; every safety claim backed by a test."},
]


# ---- small helpers

def out(obj):
    json.dump(obj, sys.stdout, separators=(",", ":"))


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def write_json(path, obj):
    write(path, json.dumps(obj, indent=1))


def run(argv, timeout=30, cwd=None):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return r.returncode, r.stdout, r.stderr
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)


def herdr(*args):
    code, so, se = run(["herdr-app", *args])
    try:
        o = json.loads(so or "null")
    except ValueError:
        o = None
    if code != 0 or (isinstance(o, dict) and o.get("error")):
        raise RuntimeError(f"herdr-app {' '.join(args[:2])}: " + (o.get("error") if isinstance(o, dict) else (se or so).strip()[-300:]))
    return o


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-") or "repo"


def fail(msg):
    out({"error": msg})
    sys.exit(1)


# ---- the repository and its folder of HQ state

def repo_for(folder=None):
    """`auto:<cwd>`: the repo of that folder when it has a master chat, else the repo of the
    most recently started master (HQ as a main view follows the space you're in)."""
    if folder and folder.startswith("auto:"):
        cwd = os.path.realpath(os.path.expanduser(folder[5:] or HOME))
        r = repo_of(cwd)
        masters = claude.masters()
        # The focused space's repo when its master runs, else the newest master that runs,
        # else the newest master at all.
        order = sorted(masters.values(), key=lambda m: m.get("startedAt") or 0, reverse=True)
        cands = ([r] if r and r["key"] in masters else []) + [repo_of(m["path"]) for m in order if m.get("path")]
        cands = [c for c in cands if c]
        for c in cands:
            if master_terminal(c)[0]:
                return c
        return (cands or [r])[0] or fail("no repository here")
    folder = os.path.realpath(os.path.expanduser(folder or os.getcwd()))
    r = repo_of(folder)
    if not r:
        fail("no repository here")
    return r


def data_dir(repo):
    return os.path.join(APP, "data", "hq", slugify(repo["name"]))


def paths(repo):
    d = data_dir(repo)
    return {
        "dir": d,
        "org": os.path.join(d, "org.json"),
        "inbox": os.path.join(d, "inbox"),
        "status": os.path.join(d, "status.json"),
        "settings": os.path.join(d, "settings.json"),
        "policy": os.path.join(d, "policy.md"),
        "orders": os.path.join(d, "standing-orders.md"),
        "base": os.path.join(d, "manager-base.md"),
        "handoff": os.path.join(d, "handoff.md"),
        "activity": os.path.join(d, "activity.jsonl"),
        "tick": os.path.join(d, "tick.json"),
        "managers": os.path.join(d, "managers"),
        "master": MASTER_PROMPT,
    }


def ensure(repo):
    p = paths(repo)
    os.makedirs(p["inbox"], exist_ok=True)
    os.makedirs(p["managers"], exist_ok=True)
    for key, text in (("policy", DEFAULT_POLICY), ("orders", DEFAULT_ORDERS), ("base", DEFAULT_BASE)):
        if not os.path.exists(p[key]):
            write(p[key], text)
    if not os.path.exists(p["handoff"]):
        write(p["handoff"], "# Master handoff\n\n(The master keeps this current at the end of every tick.)\n")
    return p


def settings(repo):
    s = dict(DEFAULT_SETTINGS)
    got = claude.read_json(paths(repo)["settings"])
    if isinstance(got, dict):
        s.update(got)
    return s


def org(repo):
    o = claude.read_json(paths(repo)["org"])
    if not isinstance(o, dict):
        o = {}
    o.setdefault("managers", [])
    o.setdefault("base", "")
    return o


def save_org(repo, o):
    write_json(paths(repo)["org"], o)


def log_activity(repo, kind, text, **extra):
    line = json.dumps({"at": NOW(), "kind": kind, "text": text, **extra})
    p = paths(repo)["activity"]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as f:
        f.write(line + "\n")


def activity(repo, n=60):
    text = read(paths(repo)["activity"], "")
    rows = []
    for line in text.splitlines()[-n:]:
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows[::-1]


# ---- terminals: one `hc ls`, then `hc get` only for the few we look at

_LS = None


def hc_ls():
    global _LS
    if _LS is None:
        got, _ = claude.hc_json("ls")
        _LS = (got or {}).get("terminals") or []
    return _LS


def hc_get(addr):
    got, _ = claude.hc_json("get", addr)
    return got if isinstance(got, dict) else None


def status_of(t):
    st = (t or {}).get("status")
    if isinstance(st, dict):
        return st.get("state")
    return st


def master_terminal(repo):
    """The master's terminal: labelled for the repo and still running Claude Code."""
    m = claude.masters().get(repo["key"]) or {}
    # No live session process for this repo's master: nothing to look for (fast path).
    sess = claude.sessions().get(m.get("sessionId")) if m.get("sessionId") else None
    if not sess or not sess.get("alive"):
        return None, m
    cache = os.path.join(data_dir(repo), "master-terminal")
    is_master = lambda got: bool(got) and (got.get("labels") or {}).get(MASTER_LABEL) == repo["key"] and status_of(got)
    live = {t["address"] for t in hc_ls() if t.get("agent") == "claude-code"}
    cached = (read(cache, "") or "").strip()
    if cached in live:
        got = hc_get(cached)
        if is_master(got):
            return got, m
    for addr in live:
        got = hc_get(addr)
        if is_master(got):
            write(cache, addr)
            return got, m
    return None, m


def session_of_terminal(t):
    return claude.session_of(claude.terminal_pids(t)) if t else None


# ---- transcripts: context size, what it is doing, the loop

def tail_lines(path, size=TAIL):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            end = f.tell()
            f.seek(max(0, end - size))
            data = f.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if end > size:
        lines = lines[1:]
    outl = []
    for l in lines:
        try:
            outl.append(json.loads(l))
        except ValueError:
            pass
    return outl


def ts(entry):
    """A transcript entry's time (UTC ISO) in ms."""
    t = entry.get("timestamp")
    try:
        return calendar.timegm(time.strptime(t[:19], "%Y-%m-%dT%H:%M:%S")) * 1000 if t else None
    except ValueError:
        return None


def clip(s, n=160):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_line(name, inp):
    inp = inp or {}
    if name == "Bash":
        return clip(inp.get("description") or inp.get("command"), 120)
    if name in ("Read", "Edit", "Write"):
        return f"{name} {os.path.basename(inp.get('file_path') or '')}"
    if name in ("Agent", "Task"):
        return f"Agent: {clip(inp.get('description'), 100)}"
    if name == "Workflow":
        return "Workflow run"
    if name == "ScheduleWakeup":
        return "Waiting for the next tick"
    if name == "Monitor":
        return f"Monitor: {clip(inp.get('description') or inp.get('command'), 100)}"
    return name


HC_FROM = re.compile(r'<hc from="([^"]+)">(.*?)(?:</hc>|$)', re.S)
HC_SEND = re.compile(r'''\bhc send\s+([\w/]+)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))''')


def session_facts(session_id, cwd=None, comms=False, tail=TAIL, keep=40):
    """From a transcript's tail: context tokens, model, what it last said and did, the loop,
    and (comms) the messages it got from other terminals and sent to them."""
    path = claude.find_transcript(session_id, cwd) if session_id else None
    facts = {"transcript": path, "context": None, "model": None, "said": None, "doing": None,
             "lastAt": None, "loop": None, "compactedAt": None, "comms": []}
    if not path:
        return facts
    try:
        facts["lastAt"] = int(os.path.getmtime(path) * 1000)
    except OSError:
        pass
    pending = {}
    for e in tail_lines(path, tail):
        if e.get("isSidechain"):
            continue
        if e.get("type") == "system" and e.get("subtype") == "compact_boundary":
            facts["compactedAt"] = ts(e)
        if e.get("isCompactSummary"):
            facts["compactedAt"] = ts(e)
        msg = e.get("message") or {}
        if e.get("type") == "assistant":
            u = msg.get("usage") or {}
            tot = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
            if tot:
                facts["context"] = tot + (u.get("output_tokens") or 0)
            facts["model"] = msg.get("model") or facts["model"]
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    facts["said"] = clip(b["text"], 220)
                elif b.get("type") == "tool_use":
                    facts["doing"] = tool_line(b.get("name"), b.get("input"))
                    if comms and b.get("name") == "Bash":
                        for hit in HC_SEND.finditer((b.get("input") or {}).get("command") or ""):
                            facts["comms"].append({"dir": "out", "peer": hit.group(1), "at": ts(e),
                                                   "text": clip(hit.group(2) or hit.group(3) or hit.group(4) or "", 400)})
                    pending[b.get("id")] = facts["doing"]
                    if b.get("name") == "ScheduleWakeup":
                        inp = b.get("input") or {}
                        at = ts(e)
                        facts["loop"] = {"stopped": bool(inp.get("stop")), "at": at,
                                         "wakeAt": (at + int(inp.get("delaySeconds") or 0) * 1000) if at and not inp.get("stop") else None,
                                         "reason": inp.get("reason")}
        elif e.get("type") == "user":
            for b in msg.get("content") if isinstance(msg.get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    pending.pop(b.get("tool_use_id"), None)
            if comms:
                c = msg.get("content")
                text = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
                for hit in HC_FROM.finditer(text or ""):
                    facts["comms"].append({"dir": "in", "peer": hit.group(1), "at": ts(e), "text": clip(hit.group(2), 400)})
                if text and "<hc from=" not in text and not text.startswith("<") and e.get("userType") == "external" and not e.get("isMeta"):
                    if not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in (c if isinstance(c, list) else [])):
                        facts["comms"].append({"dir": "in", "peer": "person", "at": ts(e), "text": clip(text, 400)})
            if isinstance(msg.get("content"), str) and msg["content"].startswith("/loop"):
                facts["loop"] = facts["loop"] or {"stopped": False, "at": ts(e), "wakeAt": None, "reason": "loop started"}
    if pending:
        facts["doing"] = list(pending.values())[-1]
    facts["comms"] = facts["comms"][-keep:][::-1]
    return facts


def subagents_of(session_id, cwd=None):
    """A session's own subagents (Agent tool) and workflow runs, newest first."""
    path = claude.find_transcript(session_id, cwd) if session_id else None
    if not path:
        return []
    base = path[:-len(".jsonl")]
    rows = []
    for meta_p in glob.glob(os.path.join(base, "subagents", "agent-*.meta.json")):
        meta = claude.read_json(meta_p) or {}
        jl = meta_p.replace(".meta.json", ".jsonl")
        try:
            mt = int(os.path.getmtime(jl) * 1000)
        except OSError:
            mt = None
        rows.append({"kind": "agent", "id": os.path.basename(jl)[6:-6], "type": meta.get("agentType"),
                     "description": meta.get("description"), "model": meta.get("pickedEffortModel"),
                     # a meta never marked finished goes stale when its session died mid-run
                     "finished": bool(meta.get("finished")) or not mt or NOW() - mt > 30 * 60_000, "lastAt": mt})
    for wf in glob.glob(os.path.join(base, "subagents", "workflows", "wf_*")):
        try:
            mt = int(max(os.path.getmtime(p) for p in [wf, *glob.glob(os.path.join(wf, "*"))]) * 1000)
        except (OSError, ValueError):
            mt = None
        rows.append({"kind": "workflow", "id": os.path.basename(wf), "description": "Workflow run", "lastAt": mt,
                     "finished": bool(mt and NOW() - mt > 15 * 60_000)})
    rows.sort(key=lambda r: r.get("lastAt") or 0, reverse=True)
    day = NOW() - 24 * 3600_000
    return [r for r in rows if not r["finished"] or (r.get("lastAt") or 0) > day][:30]


def handoff_of(report_path):
    text = read(report_path, "") if report_path else ""
    m = re.search(r"^##\s+Handoff\s*\n(.*?)(?=^##\s|\Z)", text, re.S | re.M)
    goal = re.search(r"\*\*Goal\.?\*\*\s*(.+)", m.group(1) if m else text)
    full = goal.group(1).strip() if goal else None
    return {"text": (m.group(1).strip() if m else "")[:6000], "goal": clip(full, 260) if full else None, "goalFull": full,
            "updatedAt": int(os.path.getmtime(report_path) * 1000) if report_path and os.path.exists(report_path) else None}


# ---- inbox

def inbox_items(repo, include_closed=False):
    items = []
    for p in glob.glob(os.path.join(paths(repo)["inbox"], "*.json")):
        it = claude.read_json(p)
        if isinstance(it, dict) and (include_closed or it.get("state") == "open" or not (it.get("decision") or {}).get("delivered", True)):
            items.append(it)
    items.sort(key=lambda i: i.get("createdAt") or 0, reverse=True)
    return items


def new_id():
    return time.strftime("%y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]


def who_am_i(repo):
    """The terminal this command runs in (HERDR_TERMINAL or the lineage), and its role."""
    addr = os.environ.get("HC_TERMINAL") or os.environ.get("HERDR_TERMINAL")
    if not addr:
        mine = set(claude.lineage(os.getpid()))
        for t in hc_ls():
            got = hc_get(t["address"]) if t.get("agent") == "claude-code" else None
            if got and claude.terminal_pids(got) & mine:
                addr = t["address"]
                break
    role = None
    if addr:
        mt, _ = master_terminal(repo)
        if mt and mt.get("address") == addr:
            role = "master"
        for m in org(repo)["managers"]:
            if m.get("terminal") == addr:
                role = m["id"]
    return {"terminal": addr, "role": role}


def cmd_ask(repo, kind, args):
    p = ensure(repo)
    title, body, action, links = None, "", None, []
    i = 0
    while i < len(args):
        a = args[i]
        v = args[i + 1] if i + 1 < len(args) else None
        if a == "--title":
            title = v
        elif a == "--body":
            body = v or ""
        elif a == "--body-file":
            body = read(v, "")
        elif a == "--action":
            action = v
        elif a == "--link":
            links.append(v)
        else:
            i -= 1
        i += 2
    if not title:
        fail("--title is required")
    it = {"id": new_id(), "kind": kind, "title": title, "body": body, "action": action, "links": links,
          "from": who_am_i(repo), "createdAt": NOW(), "state": "open", "decision": None}
    write_json(os.path.join(p["inbox"], it["id"] + ".json"), it)
    log_activity(repo, kind, title, id=it["id"], by=it["from"].get("role") or it["from"].get("terminal"))
    print(f"{it['id']}  (filed for the person; {'wait for the HQ DECISION message' if kind != 'done' else 'no reply needed'})")


VERDICTS = {"approve": "APPROVED", "reject": "REJECTED", "answer": "ANSWERED", "ack": "ACKNOWLEDGED", "reopen": "REOPENED"}


def cmd_decide(repo, item_id, verdict, note=""):
    if verdict not in VERDICTS:
        fail(f"verdict must be one of {', '.join(VERDICTS)}")
    path = os.path.join(paths(repo)["inbox"], item_id + ".json")
    it = claude.read_json(path)
    if not isinstance(it, dict):
        fail(f"no inbox item {item_id}")
    silent = verdict == "ack" and not note.strip()
    it["state"] = "decided"
    it["decision"] = {"verdict": verdict, "note": note, "at": NOW(), "delivered": silent, "silent": silent}
    write_json(path, it)
    log_activity(repo, "decision", f"{VERDICTS[verdict].title()}: {it['title']}", id=item_id, by="person")
    if not silent:
        deliver_one(repo, it, path)
    out({"ok": True, "item": claude.read_json(path)})


def decision_text(it):
    d = it["decision"]
    asked = (it.get("from") or {}).get("role") or (it.get("from") or {}).get("terminal") or "?"
    head = f"HQ DECISION {it['id']} ({it['kind']} from {asked}: {it['title']}): {VERDICTS[d['verdict']]}."
    if it.get("action") and d["verdict"] == "approve":
        head += f" Action as filed: {it['action']}"
    if d.get("note"):
        head += f" The person says: {d['note']}"
    return head


def deliver_one(repo, it, path):
    """Sends a decision to whoever asked (and a one-line copy to the master when that was a
    manager). A terminal showing a question dialog refuses messages: retried later."""
    mt, _ = master_terminal(repo)
    master_addr = (mt or {}).get("address")
    asker = (it.get("from") or {}).get("terminal")
    targets = [a for a in [asker or master_addr] if a]
    if asker and master_addr and asker != master_addr:
        targets.append(master_addr)
    if not targets:
        it["decision"]["error"] = "no master terminal to tell"
        write_json(path, it)
        return
    text = decision_text(it)
    errors = []
    for i, addr in enumerate(targets):
        msg = text if i == 0 else f"FYI {text} (sent to {asker})"
        code, so, se = run(["hc", "send", addr, msg], timeout=25)
        if code != 0:
            errors.append(f"{addr}: {(se or so).strip()[-160:]}")
    it["decision"]["delivered"] = not errors or len(errors) < len(targets) and asker not in [e.split(":")[0] for e in errors]
    it["decision"]["error"] = "; ".join(errors) or None
    if it["decision"]["delivered"]:
        it["decision"]["deliveredAt"] = NOW()
    write_json(path, it)


def cmd_deliver(repo):
    n = 0
    for it in inbox_items(repo, include_closed=True):
        d = it.get("decision") or {}
        if it.get("state") == "decided" and not d.get("delivered"):
            deliver_one(repo, it, os.path.join(paths(repo)["inbox"], it["id"] + ".json"))
            n += 1
    return n


# ---- the org

def manager_dir(repo, mid):
    return os.path.join(paths(repo)["managers"], mid)


def charter_path(repo, mid):
    return os.path.join(manager_dir(repo, mid), "charter.md")


def worktree_for(repo, mid):
    return os.path.join(WORKTREES, os.path.basename(repo["path"].rstrip("/")), mid)


def find_manager(repo, mid):
    o = org(repo)
    for m in o["managers"]:
        if m["id"] == mid:
            return o, m
    fail(f"no manager {mid}")


def cmd_manager_save(repo, file):
    """Adds or updates a manager from a JSON file: {id, kind, name, area, base, model, roster,
    charter (text, saved to its charter.md), group}. One merge-queue manager at most."""
    ensure(repo)
    m = claude.read_json(file)
    if not isinstance(m, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", m.get("id") or ""):
        fail("a manager needs an id: lowercase letters, digits and dashes")
    o = org(repo)
    kind = m.get("kind") or "area"
    if kind == "merge-queue" and any(x["kind"] == "merge-queue" and x["id"] != m["id"] and x.get("status") != "retired" for x in o["managers"]):
        fail("there is already a merge-queue manager; retire it first")
    if kind == "area" and m.get("area") and any(x["kind"] == "area" and x["id"] != m["id"] and x.get("status") != "retired"
                                               and (x.get("area") or "").strip().lower() == m["area"].strip().lower() for x in o["managers"]):
        fail(f"another manager already owns the area '{m['area']}'")
    charter = m.pop("charter", None)
    cur = next((x for x in o["managers"] if x["id"] == m["id"]), None)
    if cur:
        cur.update({k: v for k, v in m.items() if k not in ("terminal", "sessionId")})
        msg = f"Updated manager {m['id']}"
    else:
        m.setdefault("roster", DEFAULT_ROSTER)
        m.setdefault("status", "planned")
        m.setdefault("createdAt", NOW())
        m["kind"] = kind
        o["managers"].append(m)
        msg = f"Added manager {m['id']}"
    if charter is not None:
        write(charter_path(repo, m["id"]), charter)
    save_org(repo, o)
    log_activity(repo, "org", msg, by="person")
    out({"ok": True})


def parse_roster(text):
    """'4 x implementer (sonnet, high): notes; 1 x advisor (opus)' -> roster entries."""
    rows = []
    for part in re.split(r"[;\n]", text or ""):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(?:(\d+)\s*[x×*]\s*)?([^(:]+?)\s*(?:\(([^)]*)\))?\s*(?::\s*(.*))?$", part)
        if not m:
            continue
        model, _, effort = (m.group(3) or "").partition(",")
        rows.append({"role": m.group(2).strip(), "count": int(m.group(1) or 1), "model": model.strip() or None,
                     "effort": effort.strip() or None, "notes": (m.group(4) or "").strip()})
    return rows


MANAGER_FLAGS = ("id", "kind", "name", "area", "base", "model", "group", "charter", "charter-file", "roster")


def manager_flags(args):
    o, i, flags = {}, 0, set()
    while i < len(args):
        a = args[i]
        if a == "--launch":
            flags.add("launch")
            i += 1
            continue
        if a.startswith("--") and a[2:] in MANAGER_FLAGS and i + 1 < len(args):
            o[a[2:]] = args[i + 1]
            i += 2
            continue
        fail(f"unknown or incomplete option {a}; run `hq` for help")
    if "charter-file" in o:
        o["charter"] = read(o.pop("charter-file"), "") or ""
    if "roster" in o:
        o["roster"] = parse_roster(o["roster"])
    return o, flags


def cmd_manager_new(repo, args):
    o, flags = manager_flags(args)
    if not o.get("id"):
        fail("hq manager-new --id ID [--kind area|merge-queue] [--name N] [--area A] ... [--launch]")
    if any(m["id"] == o["id"] for m in org(repo)["managers"]):
        fail(f"there is already a manager {o['id']}; change it with `hq manager-set {o['id']} ...`")
    o.setdefault("kind", "area")
    o.setdefault("name", o["id"].replace("-", " ").title() if o["kind"] == "area" else "Merge queue")
    tmp = os.path.join(paths(repo)["dir"], f"new-{o['id']}.json")
    write_json(tmp, o)
    try:
        quiet(cmd_manager_save, repo, tmp)
    finally:
        os.unlink(tmp)
    print(f"Added manager {o['id']} ({o['kind']}).")
    if "launch" in flags:
        cmd_manager_launch(repo, o["id"])
        print()
    else:
        print(f"Saved as planned. Start it with `hq manager-launch {o['id']}`.")


def cmd_manager_set(repo, mid, args):
    find_manager(repo, mid)
    o, _ = manager_flags(args)
    o["id"] = mid
    tmp = os.path.join(paths(repo)["dir"], f"set-{mid}.json")
    write_json(tmp, o)
    try:
        quiet(cmd_manager_save, repo, tmp)
    finally:
        os.unlink(tmp)
    print(f"Updated {mid}. Charter and roster go into its brief at its next launch or respawn.")


def quiet(fn, *args):
    """Runs one of the mod's JSON commands for a CLI caller, without its JSON line."""
    import io
    keep, sys.stdout = sys.stdout, io.StringIO()
    try:
        fn(*args)
    finally:
        sys.stdout = keep


def cmd_managers(repo):
    s = settings(repo)
    o = org(repo)
    if not o["managers"]:
        print("No managers yet. Add one with `hq manager-new --id ... --area ... --launch`.")
    live = {t["address"]: t for t in hc_ls()}
    for m in sorted(o["managers"], key=lambda x: (x.get("status") == "retired", x["kind"] != "merge-queue", x["id"])):
        t = live.get(m.get("terminal"))
        st = "retired" if m.get("status") == "retired" else (t.get("status") if t else ("planned" if m.get("status") == "planned" else "gone"))
        print(f"{m['id']:16} {m['kind']:12} {st or '-':8} {m.get('terminal') or '-':6} {clip(m.get('area') or '', 90)}")


def cmd_manager_retire(repo, mid):
    o, m = find_manager(repo, mid)
    m["status"] = "retired"
    m["retiredAt"] = NOW()
    save_org(repo, o)
    log_activity(repo, "org", f"Retired manager {mid}", by="person")
    out({"ok": True})


def compose_brief(repo, m):
    p = ensure(repo)
    mt, _ = master_terminal(repo)
    repo_dir = os.path.basename(repo["path"].rstrip("/"))
    base = read(p["base"], DEFAULT_BASE)
    try:
        base = base.format(repo=repo["name"], repo_dir=repo_dir, id=m["id"], master=(mt or {}).get("address") or "the master",
                           label=MANAGER_LABEL, policy=p["policy"])
    except (KeyError, IndexError, ValueError):
        pass
    kind = "the merge queue" if m.get("kind") == "merge-queue" else f"the area: {(m.get('area') or m.get('name') or '').rstrip('.')}"
    roster = m.get("roster") or []
    team = "\n".join(f"- {r.get('count', 1)} × {r.get('role')} ({r.get('model')}{', ' + r['effort'] if r.get('effort') else ''})"
                     + (f": {r['notes']}" if r.get("notes") else "") for r in roster) or "- (no fixed team: size it per task)"
    charter = read(charter_path(repo, m["id"]), "").strip() or "(No charter yet: ask the master what to work on.)"
    return (f"# Manager brief: {m.get('name') or m['id']}\n\nYou are `{m['id']}`, the manager of {kind}.\n\n"
            f"## Charter\n{charter}\n\n## Your team\n{team}\n\n{base.strip()}\n")


def cmd_brief(repo, mid):
    _, m = find_manager(repo, mid)
    out({"text": compose_brief(repo, m)})


def space_for_folder(folder):
    cwds = {t["address"]: t.get("cwd") or "" for t in hc_ls()}
    for s in herdr("ls").get("spaces") or []:
        for tab in s.get("tabs") or []:
            if any(cwds.get(t.get("terminal")) == folder for t in tab.get("terminals") or []):
                return s["id"]
    return None


def file_group(folder, group):
    if not group:
        return
    g = claude.read_json(GROUPS)
    g = g if isinstance(g, dict) else {}
    if g.get(folder) != group:
        g[folder] = group
        write_json(GROUPS, g)


def start_manager_tab(repo, m, folder, first):
    """A new tab running the manager's Claude session in its worktree's space."""
    argv = ["claude", "--permission-mode", "auto", "--name", f"{m['id']} · manager"]
    if m.get("model"):
        argv[1:1] = ["--model", m["model"]]
    space = space_for_folder(folder)
    args = ["--folder", folder, "--argv", json.dumps(argv), "--task", first]
    made = (herdr("do", "tab.new", "--space", space, "--name", m["id"], *args) if space
            else herdr("do", "space.new", "--name", m["id"], "--tab", m["id"], *args))
    addr = made.get("terminal")
    if not addr:
        raise RuntimeError("herdr made no terminal")
    run(["hc", "label", addr, f"{MANAGER_LABEL}={m['id']}"])
    return addr, made.get("tab")


def cmd_manager_launch(repo, mid, base_override=None):
    o, m = find_manager(repo, mid)
    folder = m.get("worktree") or worktree_for(repo, mid)
    if not os.path.isdir(folder):
        base = base_override or m.get("base") or "main"
        code, _, se = run(["git", "-C", repo["path"], "fetch", "-q", "origin", base], timeout=120)
        code, _, se = run(["git", "-C", repo["path"], "worktree", "add", "--detach", folder, f"origin/{base}"], timeout=300)
        if code != 0:
            fail(f"git worktree add: {se.strip()[-300:]}")
    audit = os.path.join(folder, ".audit", mid)
    write(os.path.join(audit, "brief.md"), compose_brief(repo, m))
    first = (f"{POTETO} Read .audit/{mid}/brief.md in full and run your area from it, autonomously. "
             f"If .audit/{mid}/report.md has a ## Handoff, continue from it.")
    try:
        addr, tab = start_manager_tab(repo, m, folder, first)
    except RuntimeError as e:
        fail(str(e))
    file_group(folder, m.get("group"))
    m.update({"worktree": folder, "terminal": addr, "tab": tab, "status": "active", "report": os.path.join(audit, "report.md"),
              "launchedAt": NOW()})
    save_org(repo, o)
    log_activity(repo, "org", f"Launched manager {mid} in {addr}", by="person")
    out({"ok": True, "terminal": addr})


def cmd_manager_respawn(repo, mid):
    """A fresh session for a manager whose context has rotted: same worktree, its brief
    rewritten, told to continue from its report's handoff; the old tab is closed once the
    new one is up. Only when the old session is idle (not mid-turn)."""
    o, m = find_manager(repo, mid)
    old = hc_get(m["terminal"]) if m.get("terminal") else None
    if old and status_of(old) in ("working", "blocked"):
        fail(f"{m['terminal']} is {status_of(old)}; respawn it once it is idle")
    folder = m.get("worktree") or (old or {}).get("cwd")
    if not folder or not os.path.isdir(folder):
        fail("the manager has no worktree")
    audit = os.path.join(folder, ".audit", mid)
    write(os.path.join(audit, "brief.md"), compose_brief(repo, m))
    report = m.get("report") or os.path.join(audit, "report.md")
    first = (f"{POTETO} You replace a manager session whose context grew too long. Read .audit/{mid}/brief.md in full, then the "
             f"## Handoff at the top of {os.path.relpath(report, folder)}, and continue from there. Re-arm any watcher it "
             f"names. The old session was {m.get('terminal')}.")
    try:
        addr, tab = start_manager_tab(repo, m, folder, first)
    except RuntimeError as e:
        fail(str(e))
    old_tab = ((old or {}).get("labels") or {}).get("herdr.tab")
    if old_tab and old_tab != tab:
        try:
            herdr("do", "tab.close", "--id", old_tab, "--confirmed", "true")
        except RuntimeError:
            pass
    m.update({"terminal": addr, "tab": tab, "status": "active", "respawnedAt": NOW(), "report": report})
    save_org(repo, o)
    log_activity(repo, "org", f"Respawned manager {mid}: {addr} replaces {old and old.get('address')}", by="person")
    out({"ok": True, "terminal": addr})


def cmd_discover(repo):
    """Claude sessions in this repo's worktrees that look like managers (a .audit/<x>/report.md
    with a Handoff) and aren't in the org yet."""
    o = org(repo)
    known = {m.get("terminal") for m in o["managers"]}
    mt, _ = master_terminal(repo)
    found = []
    for t in hc_ls():
        if t.get("agent") != "claude-code" or t["address"] in known or (mt and t["address"] == mt.get("address")):
            continue
        cwd = t.get("cwd") or ""
        r = repo_of(cwd) if cwd else None
        if not r or r["key"] != repo["key"]:
            continue
        reports = sorted(glob.glob(os.path.join(cwd, ".audit", "*", "report.md")), key=os.path.getmtime, reverse=True)
        h = handoff_of(reports[0]) if reports else {"text": "", "goal": None}
        name = os.path.basename(os.path.dirname(reports[0])) if reports else os.path.basename(cwd)
        found.append({"terminal": t["address"], "cwd": cwd, "status": t.get("status"), "turn": t.get("turn"),
                      "suggestedId": slugify(name), "report": reports[0] if reports else None, "goal": h.get("goal"),
                      "hasHandoff": bool(h.get("text")), "kind": "merge-queue" if "merge-queue" in name else "area"})
    found.sort(key=lambda f: (not f["hasHandoff"], -(f.get("turn") or 0)))
    out({"candidates": found})


def first_sentence(text, limit=160):
    """A one-line area of focus: the goal's first sentence, cut at a word, never mid-word."""
    t = re.sub(r"\s+", " ", text or "").strip()
    m = re.match(r"(.+?[.!?])(\s|$)", t)
    t = m.group(1) if m else t
    if len(t) > limit:
        t = t[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return t


def adopted_charter(brief, goal):
    return f"{(goal or '').strip()}\n\nAdopted from a running session; its original brief is {brief}.\n"


def cmd_repair_adopted(repo):
    """Rewrites adopted managers' area and charter from their report's full goal (an earlier
    adopt clipped them)."""
    o = org(repo)
    fixed = []
    for m in o["managers"]:
        if not m.get("adopted") or not m.get("report"):
            continue
        h = handoff_of(m["report"])
        if not h.get("goalFull"):
            continue
        cp = charter_path(repo, m["id"])
        cur = read(cp, "") or ""
        if cur.startswith("(Adopted from a running session.") or "…" in cur:
            write(cp, adopted_charter(os.path.join(os.path.dirname(m["report"]), "brief.md"), h["goalFull"]))
        m["area"] = first_sentence(h["goalFull"])
        fixed.append(m["id"])
    save_org(repo, o)
    out({"fixed": fixed})


def cmd_adopt(repo, addr, mid, kind):
    """Brings a running session into the org as a manager, keeping it as it is."""
    o = org(repo)
    if any(m["id"] == mid for m in o["managers"]):
        fail(f"there is already a manager {mid}")
    if kind == "merge-queue" and any(m["kind"] == "merge-queue" and m.get("status") != "retired" for m in o["managers"]):
        fail("there is already a merge-queue manager")
    t = hc_get(addr)
    if not t:
        fail(f"no terminal {addr}")
    cwd = t.get("cwd")
    reports = sorted(glob.glob(os.path.join(cwd, ".audit", "*", "report.md")), key=os.path.getmtime, reverse=True)
    h = handoff_of(reports[0]) if reports else {}
    groups = claude.read_json(GROUPS) or {}
    m = {"id": mid, "kind": kind, "name": mid.replace("-", " ").title() if kind == "area" else "Merge queue",
         "area": first_sentence(h.get("goalFull")), "worktree": cwd, "terminal": addr, "report": reports[0] if reports else None,
         "status": "active", "roster": DEFAULT_ROSTER, "group": groups.get(cwd), "createdAt": NOW(), "adopted": True}
    o["managers"].append(m)
    save_org(repo, o)
    if reports and not os.path.exists(charter_path(repo, mid)):
        brief = os.path.join(os.path.dirname(reports[0]), "brief.md")
        write(charter_path(repo, mid), adopted_charter(brief, h.get("goalFull")))
    run(["hc", "label", addr, f"{MANAGER_LABEL}={mid}"])
    log_activity(repo, "org", f"Adopted {addr} as manager {mid}", by="person")
    out({"ok": True})


# ---- live picture

def unit_terminals(repo, m, ls_by_addr):
    """Unit sessions working for a manager: labelled for it, started by it, or in a sibling
    worktree named after its own (`hooks-records` for `hooks`)."""
    wt = os.path.basename((m.get("worktree") or "").rstrip("/"))
    rows = []
    for t in hc_ls():
        if t["address"] == m.get("terminal") or t.get("agent") != "claude-code":
            continue
        cwd = t.get("cwd") or ""
        sib = wt and os.path.basename(os.path.dirname(cwd)) == os.path.basename(os.path.dirname(m.get("worktree") or "")) \
            and os.path.basename(cwd).startswith(wt + "-")
        if sib:
            rows.append({"kind": "unit", "id": t["address"], "description": os.path.basename(cwd), "status": t.get("status"),
                         "terminal": t["address"], "turn": t.get("turn")})
    return rows


def manager_view(repo, m, s):
    t = None
    for x in hc_ls():
        if x["address"] == m.get("terminal"):
            t = x
    got = hc_get(m["terminal"]) if t else None
    sess = session_of_terminal(got) if got else None
    sid = (sess or {}).get("sessionId") or m.get("sessionId")
    facts = session_facts(sid, (got or {}).get("cwd")) if sid else {}
    if sid and sid != m.get("sessionId"):
        m["sessionId"] = sid
    h = handoff_of(m.get("report")) if m.get("report") else {"text": "", "goal": None, "updatedAt": None}
    team = (subagents_of(sid, (got or {}).get("cwd")) if sid else []) + unit_terminals(repo, m, None)
    return {**m, "live": bool(t), "status": (t or {}).get("status") if t else ("retired" if m.get("status") == "retired" else "gone"),
            "where": (t or {}).get("where"), "turn": (t or {}).get("turn"), "facts": facts, "handoff": h, "team": team,
            "charterPath": charter_path(repo, m["id"])}


def signals_for(repo, master, managers, items, s):
    now = NOW()
    sig = []

    def add(level, who, text, terminal=None, action=None):
        sig.append({"level": level, "who": who, "text": text, "terminal": terminal, "action": action})

    if not master.get("terminal"):
        add("alert", "master", "The master chat isn't running.", action="open-master")
    else:
        loop = (master.get("facts") or {}).get("loop")
        st = master.get("status")
        if not loop or loop.get("stopped"):
            add("warn", "master", "The master's loop isn't armed: it only acts when spoken to.", master["terminal"], "loop-arm")
        elif loop.get("wakeAt") and now > loop["wakeAt"] + 5 * 60_000 and st in ("idle", "done"):
            add("warn", "master", f"The master's tick is {int((now - loop['wakeAt']) / 60000)} min overdue.", master["terminal"], "loop-arm")
        ctx = (master.get("facts") or {}).get("context") or 0
        if ctx > s["masterCompactAt"]:
            add("warn", "master", f"Master context at {ctx // 1000}k tokens.", master["terminal"], "compact")
        if st == "blocked":
            add("alert", "master", "The master is waiting on you in its terminal.", master["terminal"], "focus")
    mq = [m for m in managers if m["kind"] == "merge-queue" and m.get("status") != "retired"]
    if not mq:
        add("info", "org", "No merge-queue manager yet.", action="new-manager")
    for m in managers:
        if m.get("status") == "retired":
            continue
        f = m.get("facts") or {}
        who = m["id"]
        if not m["live"]:
            add("alert", who, "Its session is gone.", action="launch")
            continue
        if m["status"] == "blocked":
            add("alert", who, "Waiting on a question in its terminal.", m["terminal"], "focus")
        quiet = now - (f.get("lastAt") or now)
        if m["status"] == "working" and quiet > s["quietMinutes"] * 60_000:
            add("warn", who, f"Working but silent for {quiet // 60000} min (a long wait, or stuck).", m["terminal"], "peek")
        if m["status"] in ("idle", "done") and quiet > s["idleMinutes"] * 60_000:
            add("info", who, f"Idle for {quiet // 60000} min.", m["terminal"], "peek")
        if (f.get("context") or 0) > s["managerWarnAt"]:
            idle = m["status"] in ("idle", "done")
            add("warn", who, f"Context at {(f.get('context') or 0) // 1000}k tokens: compact or respawn{'' if idle else ' once it is idle'}.",
                m["terminal"], "compact" if idle else "peek")
        for u in m.get("team") or []:
            if u.get("kind") == "unit" and u.get("status") == "blocked":
                add("alert", who, f"Unit {u['terminal']} ({u['description']}) waits on a question.", u["terminal"], "focus")
    for it in items:
        if it.get("state") == "open" and it["kind"] in ("approval", "question"):
            age = (now - it["createdAt"]) // 60000
            if age >= 10:
                add("warn" if age < 60 else "alert", "you", f"'{it['title']}' has waited {age} min for you.", action="review:" + it["id"])
        d = it.get("decision") or {}
        if it.get("state") == "decided" and not d.get("delivered"):
            add("warn", "hq", f"Decision on '{it['title']}' not delivered yet: {d.get('error') or 'retrying'}.")
    order = {"alert": 0, "warn": 1, "info": 2}
    sig.sort(key=lambda x: order[x["level"]])
    return sig


def cmd_snapshot(repo):
    p = ensure(repo)
    s = settings(repo)
    mt, minfo = master_terminal(repo)
    msess = session_of_terminal(mt) if mt else None
    msid = (msess or {}).get("sessionId") or minfo.get("sessionId")
    master = {"terminal": (mt or {}).get("address"), "status": status_of(mt), "sessionId": msid,
              "where": ((mt or {}).get("labels") or {}).get("where"), "turn": (mt or {}).get("turn"),
              "facts": session_facts(msid, repo["path"], comms=True) if msid else {},
              "team": subagents_of(msid, repo["path"]) if msid else []}
    o = org(repo)
    managers = [manager_view(repo, m, s) for m in o["managers"]]
    save_org(repo, o)  # learned session ids
    managers.sort(key=lambda m: (m.get("status") == "retired", m["kind"] != "merge-queue", m["id"]))
    items = inbox_items(repo, include_closed=True)
    open_items = [i for i in items if i.get("state") == "open"]
    st = claude.read_json(p["status"]) or {}
    live = [m for m in managers if m.get("status") != "retired"]
    counts = {
        "working": sum(1 for m in live if m["status"] == "working"),
        "blocked": sum(1 for m in live if m["status"] == "blocked"),
        "idle": sum(1 for m in live if m["status"] in ("idle", "done")),
        "gone": sum(1 for m in live if not m["live"]),
        "units": sum(1 for m in live for u in m["team"] if u["kind"] == "unit"),
        "subagents": sum(1 for m in live for u in m["team"] if u["kind"] != "unit" and not u.get("finished")),
        "approvals": sum(1 for i in open_items if i["kind"] == "approval"),
        "questions": sum(1 for i in open_items if i["kind"] == "question"),
        "done": sum(1 for i in open_items if i["kind"] == "done"),
    }
    todo = todo_load(repo)
    lens = lens_meta(repo)
    doc = claude.read_json(os.path.join(lens_dir(repo), "org.json")) if lens.get("at") else None
    lens["doc"] = doc or lens_seed_body(repo, managers, mt)
    lens["auto"] = not doc
    out({"repo": repo, "now": NOW(), "paths": p, "settings": s, "master": master, "managers": managers, "lens": lens, "todo": todo,
         "status": st, "counts": counts, "signals": signals_for(repo, master, managers, items, s),
         "inbox": items[:200], "activity": activity(repo)})


# ---- the master's tick digest

def file_hash(path):
    return hashlib.sha1((read(path, "") or "").encode()).hexdigest()[:12]


def cmd_tick(repo):
    """What changed since the last tick, in a few lines, so the master spends its context on
    decisions instead of on looking around."""
    p = ensure(repo)
    s = settings(repo)
    prev = claude.read_json(p["tick"]) or {}
    now = NOW()
    since = prev.get("at") or 0
    lines = [f"HQ tick {time.strftime('%Y-%m-%d %H:%M')} (last {int((now - since) / 60000) if since else '—'} min ago)"]
    for key, label in (("orders", "Standing orders"), ("policy", "Approval policy")):
        h = file_hash(p[key])
        if prev.get(key) and prev[key] != h:
            lines.append(f"- {label} changed: re-read {p[key]}")
        prev[key] = h
    items = inbox_items(repo, include_closed=True)
    for it in items:
        d = it.get("decision") or {}
        if d.get("at", 0) > since and not d.get("silent"):
            lines.append(f"- Decision: {decision_text(it)}")
        if it.get("createdAt", 0) > since and (it.get("from") or {}).get("role") != "master":
            lines.append(f"- Filed by {(it.get('from') or {}).get('role') or (it.get('from') or {}).get('terminal')}: [{it['kind']}] {it['title']}")
    waiting = [i for i in items if i.get("state") == "open" and i["kind"] in ("approval", "question")]
    if waiting:
        lines.append(f"- Waiting on the person: {len(waiting)} ({', '.join(clip(i['title'], 50) for i in waiting[:4])})")
    o = org(repo)
    mt, minfo = master_terminal(repo)
    master = {"terminal": (mt or {}).get("address"), "status": status_of(mt), "facts": {}}
    managers = [manager_view(repo, m, s) for m in o["managers"]]
    for sg in signals_for(repo, master, managers, [], s):
        if sg["who"] in ("master", "hq", "you"):
            continue
        lines.append(f"- {sg['level'].upper()} {sg['who']}{' (' + sg['terminal'] + ')' if sg.get('terminal') else ''}: {sg['text']}")
    for m in managers:
        if m.get("status") == "retired" or not m["live"]:
            continue
        f = m.get("facts") or {}
        lines.append(f"- {m['id']} {m['terminal']} {m['status']}: {clip(f.get('doing') or f.get('said') or '', 110)}")
    code, so, _ = run(["git", "-C", MEMORY, "log", "--format=%s", "-200"])
    if code == 0:
        subjects = so.splitlines()
        n = next((i for i, x in enumerate(subjects) if x.startswith("Dream")), len(subjects))
        if n >= s["dreamEvery"] and not dream_running():
            lines.append(f"- Memory: {n} commits since the last Dream. Run `hq dream` when you're not mid-edit.")
    if dream_running():
        lines.append("- A Dream is running: hold memory edits until it finishes.")
    td = todo_load(repo)
    steer = [(it, n) for it in td["items"] for n in it.get("notes", []) if not n.get("seen") and n.get("at", 0) > since]
    for it, n in steer:
        lines.append(f"- Person on to-do [{it['id']}] '{clip(it['title'], 60)}': {n['text']}")
    live_todo = [it for it in td["items"] if it["status"] in ("doing", "next", "blocked")]
    if not live_todo:
        lines.append("- Next moves: empty. Write the next steps with `hq todo add` (see 'Next moves' in your prompt).")
    elif td.get("updatedAt") and NOW() - td["updatedAt"] > 60 * 60_000:
        lines.append(f"- Next moves: unchanged for {int((NOW() - td['updatedAt']) / 60000)} min. Close what's done, add what's next (`hq todo`).")
    lm = lens_meta(repo)
    if not lm.get("at"):
        lines.append("- Live map: not published yet. `hq lens` explains it; publish one this tick.")
    elif NOW() - lm["at"] > 45 * 60_000:
        lines.append(f"- Live map: last published {int((NOW() - lm['at']) / 60000)} min ago. Update it if the picture changed (`hq lens`).")
    prev["at"] = now
    write_json(p["tick"], prev)
    print("\n".join(lines))


def cmd_status(repo, text):
    p = ensure(repo)
    text = clip(text, 200)
    prev = (claude.read_json(p["status"]) or {}).get("text")
    write_json(p["status"], {"text": text, "at": NOW()})
    if text and text != prev:  # the headlines' history, for the Brief
        log_activity(repo, "status", text, by="master")
    print("ok")


# ---- the Brief: what happened since the person last looked

PR_REF = re.compile(r"(?:/pull/|#)(\d{3,6})\b")
LANDED = re.compile(r"\b(merged|MERGED|QUEUED-GREEN|landed)\b")
LESSON = re.compile(r"\bLESSON:\s*(.*)", re.S)
# "READY:", trunk merged into a branch, and merges still to come aren't landings.
NOT_LANDED = re.compile(r"\bREADY:|\bre-?merged?\b|\bmerged? (?:in )?(?:trunk|the base|main|merkl-turbo)\b|"
                        r"\btrunk (?:\w+ )?merged\b|"
                        r"(?:\b(?:once|when|until|if|after|before|will|would|should|can|to be|not)\b|n't)[^.;]*\bmerged\b", re.I)


def activity_since(repo, since):
    rows = []
    for line in (read(paths(repo)["activity"], "") or "").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if (r.get("at") or 0) >= since:
            rows.append(r)
    return rows


def pr_url_base(repo):
    code, so, _ = run(["git", "-C", repo["path"], "config", "--get", "remote.origin.url"], timeout=5)
    url = so.strip()
    m = re.match(r"https?://(?:[^@/]+@)?([^/]+)/(.+?)(?:\.git)?$", url) or re.match(r"(?:ssh://)?(?:[\w.-]+@)?([^:/]+)[:/](.+?)(?:\.git)?$", url)
    return f"https://{m.group(1)}/{m.group(2)}/pull/" if m else None


def trunk_log(repo, since, trunk=None):
    """The trunk's first-parent commits since then: settings' "trunk" (e.g. "merkl-turbo"), else
    origin/HEAD. Local refs only (no fetch), so it is as fresh as the last fetch in the checkout."""
    ref = f"origin/{trunk}" if trunk else None
    if not ref:
        code, so, _ = run(["git", "-C", repo["path"], "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], timeout=5)
        ref = so.strip() if code == 0 and so.strip() else None
    if not ref:
        return None
    code, so, _ = run(["git", "-C", repo["path"], "log", f"--since=@{since // 1000}", "--first-parent", "-30",
                       "--format=%H%x1f%ct%x1f%s", ref], timeout=10)
    if code != 0:
        return None
    commits = []
    for line in so.splitlines():
        sha, ct, subj = (line.split("\x1f", 2) + ["", ""])[:3]
        commits.append({"sha": sha, "at": int(ct or 0) * 1000, "subject": subj})
    return {"ref": ref, "commits": commits}


def cmd_recap(repo, since=None):
    p = ensure(repo)
    s = settings(repo)
    now = NOW()
    since = int(since) if since else now - 12 * 3600_000
    mt, minfo = master_terminal(repo)
    msess = session_of_terminal(mt) if mt else None
    msid = (msess or {}).get("sessionId") or minfo.get("sessionId")
    mfacts = session_facts(msid, repo["path"], comms=True, tail=12_000_000, keep=4000) if msid else {}
    comms = [c for c in (mfacts.get("comms") or []) if (c.get("at") or 0) >= since]
    acts = activity_since(repo, since)
    items = inbox_items(repo, include_closed=True)
    base = pr_url_base(repo)

    # A PR landed when a clause names it next to "merged" (or QUEUED-GREEN: green, about to land).
    # READY lines and "merged trunk into the branch" are not landings.
    landed = {}
    for src in [*({"at": c["at"], "text": c["text"], "who": c["peer"]} for c in comms),
                *({"at": a["at"], "text": a.get("text") or "", "who": a.get("by")} for a in acts)]:
        text = src["text"]
        for clause in re.split(r"(?<=[.;:!?])\s+|,\s+|\n", text):
            hit = LANDED.search(clause)
            if not hit or NOT_LANDED.search(clause):
                continue
            state = "green" if hit.group(1) == "QUEUED-GREEN" else "merged"
            for n in dict.fromkeys(PR_REF.findall(clause)):
                cur = landed.get(n)
                if cur and (cur["state"] == "merged" and state == "green" or cur["at"] >= src["at"]):
                    continue
                landed[n] = {"pr": int(n), "state": state, "at": src["at"], "text": clip(clause.strip(), 220),
                             "who": src["who"], "url": (base + n) if base else None}
    landed = sorted(landed.values(), key=lambda x: x["at"], reverse=True)

    lessons = []
    for c in comms:
        m = LESSON.search(c["text"])
        if m and c["dir"] == "in":
            lessons.append({"at": c["at"], "peer": c["peer"], "text": clip(m.group(1), 400)})
    code, so, _ = run(["git", "-C", MEMORY, "log", f"--since=@{since // 1000}", "--format=%H%x1f%ct%x1f%s", "-60"], timeout=10)
    memory = []
    for line in so.splitlines() if code == 0 else []:
        sha, ct, subj = (line.split("\x1f", 2) + ["", ""])[:3]
        memory.append({"sha": sha, "at": int(ct or 0) * 1000, "subject": subj, "dream": subj.startswith("Dream")})

    o = org(repo)
    master = {"terminal": (mt or {}).get("address"), "status": status_of(mt), "sessionId": msid, "facts": mfacts, "team": []}
    views = [manager_view(repo, m, s) for m in o["managers"]]
    managers = [{"id": m["id"], "name": m.get("name") or m["id"], "kind": m["kind"], "status": m["status"], "live": m["live"],
                 "terminal": m.get("terminal"), "goal": m.get("area") or first_sentence((m.get("handoff") or {}).get("goalFull")),
                 "doing": (m.get("facts") or {}).get("doing"), "said": (m.get("facts") or {}).get("said"),
                 "lastAt": (m.get("facts") or {}).get("lastAt"), "context": (m.get("facts") or {}).get("context")}
                for m in views if m.get("status") != "retired"]
    pick = lambda i: {k: i.get(k) for k in ("id", "kind", "title", "from", "createdAt", "decision", "links")}
    out({
        "since": since, "now": now,
        "headline": claude.read_json(p["status"]) or {},
        "headlines": [{"at": a["at"], "text": a["text"]} for a in acts if a.get("kind") == "status"],
        "needsYou": [pick(i) for i in items if i.get("state") == "open" and i["kind"] in ("approval", "question")],
        "decided": [pick(i) for i in items if i.get("state") != "open" and ((i.get("decision") or {}).get("at") or 0) >= since],
        "done": [pick(i) for i in items if i["kind"] == "done" and (i.get("createdAt") or 0) >= since],
        "landed": landed[:40],
        "trunk": trunk_log(repo, since, s.get("trunk")),
        "lessons": lessons[:40],
        "memory": memory,
        "managers": managers,
        "signals": signals_for(repo, master, views, items, s),
        "loop": mfacts.get("loop"),
        "master": {"terminal": master["terminal"], "status": master["status"], "said": mfacts.get("said"),
                   "doing": mfacts.get("doing"), "context": mfacts.get("context"), "lastAt": mfacts.get("lastAt")},
        "messages": len(comms),
    })


# ---- sessions: compact, loop, typing

def type_text(addr, text):
    """Types text key by key (`hc send` arrives as a message and can't run slash commands)."""
    keys = []
    for ch in text:
        keys.append("space" if ch == " " else ch)
    code, so, se = run(["hc", "keys", addr, *keys, "enter"], timeout=30)
    return code == 0, (se or so).strip()


def cmd_compact(addr):
    t = hc_get(addr)
    if not t:
        fail(f"no terminal {addr}")
    if status_of(t) not in ("done", "idle"):
        fail(f"{addr} is {status_of(t)}: compact it once it's idle")
    ok, err = type_text(addr, "/compact")
    if not ok:
        fail(err)
    out({"ok": True})


def cmd_loop_arm(repo):
    mt, _ = master_terminal(repo)
    if not mt:
        fail("the master isn't running")
    if status_of(mt) not in ("done", "idle"):
        fail(f"the master is {status_of(mt)}; arm the loop once it's idle")
    ok, err = type_text(mt["address"], LOOP_PROMPT)
    if not ok:
        fail(err)
    log_activity(repo, "loop", "Armed the master's loop", by="hq")
    out({"ok": True})


def cmd_send(addr, text):
    code, so, se = run(["hc", "send", addr, text], timeout=25)
    if code != 0:
        fail((se or so).strip()[-300:] or "hc send failed")
    out({"ok": True})


def cmd_autopilot(repo):
    """The chores HQ does on its own each minute while it's open: deliver decisions, keep the
    master's loop armed, compact the master when it's idle and large. One copy at a time."""
    p = ensure(repo)
    lock = os.path.join(p["dir"], "autopilot.lock")
    try:
        if time.time() - os.path.getmtime(lock) < 45:
            out({"skipped": True})
            return
    except OSError:
        pass
    write(lock, str(os.getpid()))
    s = settings(repo)
    did = []
    n = cmd_deliver(repo)
    if n:
        did.append(f"retried {n} decision(s)")
    mt, minfo = master_terminal(repo)
    if mt and status_of(mt) in ("idle", "done"):
        sess = session_of_terminal(mt)
        facts = session_facts((sess or {}).get("sessionId") or minfo.get("sessionId"), repo["path"])
        loop = facts.get("loop")
        quiet = NOW() - (facts.get("lastAt") or NOW())
        # Only a loop that was running and lapsed is re-armed; arming one for the first time
        # is the person's call (the Arm button), since it changes how the master behaves.
        lapsed = bool(loop and not loop.get("stopped") and loop.get("wakeAt") and NOW() > loop["wakeAt"] + 3 * 60_000)
        if s["autoRearm"] and lapsed and quiet > 3 * 60_000:
            ok, _ = type_text(mt["address"], LOOP_PROMPT)
            if ok:
                did.append("re-armed the master's loop")
                log_activity(repo, "loop", "Re-armed the master's loop (it had lapsed)", by="hq")
        elif s["autoCompactMaster"] and (facts.get("context") or 0) > s["masterCompactAt"] and quiet > 60_000:
            # Compact only from a handoff the master really wrote, recently and since its last compaction.
            h_at = int(os.path.getmtime(p["handoff"]) * 1000)
            written = "(The master keeps this current" not in (read(p["handoff"], "") or "")
            if written and NOW() - h_at < 3 * 3600_000 and h_at > (facts.get("compactedAt") or 0):
                ok, _ = type_text(mt["address"], "/compact")
                if ok:
                    did.append("compacted the master")
                    log_activity(repo, "compact", f"Compacted the master at {(facts.get('context') or 0) // 1000}k tokens", by="hq")
    out({"did": did})


# ---- next moves: the master's to-do list, steered by the person

TODO_STATES = ("doing", "next", "blocked", "done", "dropped")


def todo_path(repo):
    return os.path.join(paths(repo)["dir"], "todo.json")


def todo_load(repo):
    d = claude.read_json(todo_path(repo))
    return d if isinstance(d, dict) and isinstance(d.get("items"), list) else {"items": [], "updatedAt": None}


def todo_save(repo, d, by):
    d["updatedAt"] = NOW()
    d["updatedBy"] = by
    write_json(todo_path(repo), d)


def todo_find(d, tid):
    for it in d["items"]:
        if it["id"] == tid:
            return it
    fail(f"no to-do {tid}")


def todo_opts(args):
    o, rest, i = {}, [], 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and i + 1 < len(args):
            k = a[2:]
            if k == "link":
                o.setdefault("links", []).append(args[i + 1])
            else:
                o[k] = args[i + 1]
            i += 2
        else:
            rest.append(a)
            i += 1
    return o, rest


def todo_print(d):
    live = [it for it in d["items"] if it["status"] in ("doing", "next", "blocked")]
    if not live:
        print("Next moves: empty. Add the next steps with `hq todo add --title ... --owner ...`.")
    for st in ("doing", "next", "blocked"):
        for it in [x for x in live if x["status"] == st]:
            notes = "".join(f"\n    person ({time.strftime('%H:%M', time.localtime(n['at'] / 1000))}): {n['text']}" for n in it.get("notes", []) if not n.get("seen"))
            print(f"[{it['id']}] {st:7} {it.get('owner') or '-':12} {it['title']}" + (f" (blocked on: {it['blockedOn']})" if it.get("blockedOn") else "") + notes)


def cmd_todo(repo, args):
    """The master's next moves. `hq todo` lists them; the master adds, updates and closes;
    the person (HQ) reorders, vetoes or attaches notes, which the master sees in `hq tick`."""
    ensure(repo)
    d = todo_load(repo)
    who = who_am_i(repo)
    by = who.get("role") or who.get("terminal") or "person"
    sub = args[0] if args else "list"
    o, rest = todo_opts(args[1:])
    if sub == "list":
        return todo_print(d)
    if sub == "json":
        return out(d)
    if sub == "add":
        if not o.get("title"):
            fail("hq todo add --title T [--owner manager-id|master|person] [--why W] [--status next|doing|blocked] [--link URL]")
        it = {"id": uuid.uuid4().hex[:6], "title": clip(o["title"], 160), "owner": o.get("owner"), "why": o.get("why", ""),
              "status": o.get("status", "next"), "links": o.get("links", []), "createdAt": NOW(), "updatedAt": NOW(), "by": by, "notes": []}
        if it["status"] not in TODO_STATES:
            fail(f"status must be one of {', '.join(TODO_STATES)}")
        pos = o.get("at")
        items = d["items"]
        idx = next((i for i, x in enumerate(items) if x["status"] == "next"), len(items)) if pos == "top" else len(items)
        items.insert(idx, it)
        todo_save(repo, d, by)
        print(f"{it['id']}  added")
        return
    if sub in ("set", "done", "drop", "start", "block"):
        tid = rest[0] if rest else fail("which to-do? give its id")
        it = todo_find(d, tid)
        if sub == "done":
            o["status"] = "done"
        elif sub == "drop":
            o["status"] = "dropped"
        elif sub == "start":
            o["status"] = "doing"
        elif sub == "block":
            o["status"] = "blocked"
            if rest[1:]:
                o["blockedOn"] = " ".join(rest[1:])
        for k in ("title", "owner", "why", "status", "blockedOn"):
            if k in o:
                it[k] = o[k]
        if "links" in o:
            it["links"] = o["links"]
        if it["status"] not in TODO_STATES:
            fail(f"status must be one of {', '.join(TODO_STATES)}")
        if it["status"] in ("done", "dropped"):
            it["closedAt"] = NOW()
        it["updatedAt"] = NOW()
        for n in it.get("notes", []):
            n["seen"] = True  # the master acted on the item: its notes are read
        todo_save(repo, d, by)
        print("ok")
        return
    if sub == "move":  # the person reorders: move <id> up|down|top
        tid, where = rest[0], (rest[1] if len(rest) > 1 else "up")
        items = d["items"]
        i = next(k for k, x in enumerate(items) if x["id"] == tid)
        it = items.pop(i)
        same = [k for k, x in enumerate(items) if x["status"] == it["status"]]
        if where == "top":
            j = same[0] if same else i
        else:
            before = [k for k in same if k < i]
            after = [k for k in same if k >= i]
            j = (before[-1] if before else i) if where == "up" else ((after[0] + 1) if after else i)
        items.insert(j, it)
        it.setdefault("notes", []).append({"at": NOW(), "text": f"moved {where}", "kind": "move"})
        todo_save(repo, d, "person")
        log_activity(repo, "todo", f"Moved '{it['title']}' {where}", by="person")
        return out({"ok": True})
    if sub == "note":  # the person attaches a note for the master
        it = todo_find(d, rest[0])
        text = " ".join(rest[1:]).strip()
        if not text:
            fail("a note needs text")
        it.setdefault("notes", []).append({"at": NOW(), "text": text, "kind": "note"})
        todo_save(repo, d, "person")
        log_activity(repo, "todo", f"Note on '{it['title']}': {clip(text, 80)}", by="person")
        return out({"ok": True})
    if sub == "veto":  # the person drops a move; the master sees why
        it = todo_find(d, rest[0])
        text = " ".join(rest[1:]).strip()
        it["status"] = "dropped"
        it["closedAt"] = NOW()
        it["vetoed"] = True
        it.setdefault("notes", []).append({"at": NOW(), "text": "Vetoed" + (f": {text}" if text else ""), "kind": "veto"})
        todo_save(repo, d, "person")
        log_activity(repo, "todo", f"Vetoed '{it['title']}'" + (f": {clip(text, 80)}" if text else ""), by="person")
        return out({"ok": True})
    fail("hq todo [list | add | set <id> | start <id> | block <id> [on what] | done <id> | drop <id>]")


# ---- the live map: a PR Lens graph of the org and its work, kept by the master

LENS_HOME = os.path.join(HOME, ".local/share/hq-lens")
LENS_GUIDE = """The live map is a PR Lens graph document (schema 0.2) of the org and the work in flight. You keep it
current: `hq lens set <file.json>` validates, renders and publishes it (an invalid file is refused
with every issue listed; fix and retry). `hq lens seed` prints a starting document built from the org.

Write the body only (no schemaVersion/kind/provenance). Shape:
  {"title": "<= 120 chars", "lenses": ["architecture"],
   "lanes": [{"id", "label", "subtitle"?, "order"?}],               one per area, plus master and merge queue
   "nodes": [{"id", "label", "kind", "delta", "lane", "subtitle"?, "summary"?, "badges"?: [<=6 labels]}],
   "edges": [{"id", "from", "to", "kind", "delta", "label"?, "emphasis"?: "normal|hero|muted", "animated"?}],
   "flows": [], "views": [], "stats"?: {"chips": [{"label", "value", "tone"?}]}}
kind: service app module function route job queue datastore cache external ui config test package other
edge kind: call http rpc event queue data dependency render other
delta, relative to the previous map you published: added (new since), modified (changed state),
removed (finished or landed since; drop it on the next update), unchanged (context).
Each node type draws differently in HQ: agents (round avatar with a live status ring), pull requests
(number first, tinted by state), processes (machine panel: CI, instances, batches, trunk, the queue)
and files (dashed outline with the path). So pick kinds by what a node IS:
Use: agent sessions (managers, outside sessions) as `service`, unit sessions and subagent waves as `job`,
a merge-queue batch as `job` labelled "Batch N: ...", PRs as `package` (label
"#5329 chain selector", badges like "READY", "in CI", "green", "blocked"), the merge queue as `queue`,
trunk as `datastore`, an instance or outage as `external`, a file as `module` with "files": [{"path"}]. Edges: master -> manager (call, "directs"), unit -> PR (data), PR -> merge queue
(queue, "READY"), merge queue -> trunk (data, "merges"); one `hero` edge for what matters most right now,
`animated` on edges that are moving this tick. Badges carry live state ("working", "needs you", "421k ctx").
Ids: lowercase letters, digits, dashes. Labels <= 120 chars."""


def lens_dir(repo):
    return os.path.join(paths(repo)["dir"], "lens")


def lens_meta(repo):
    meta = claude.read_json(os.path.join(lens_dir(repo), "lens.json")) or {}
    if meta.get("lenses"):
        rel = os.path.relpath(lens_dir(repo), APP)
        for l in meta["lenses"].values():
            for th in ("light", "dark"):
                if l.get(th):
                    l[th + "Path"] = f"{rel}/{l[th]}"
    return meta


def lens_render(repo, src):
    code, so, se = run(["node", os.path.join(LENS_HOME, "lens.mjs"), src, lens_dir(repo)], timeout=60, cwd=LENS_HOME)
    try:
        return json.loads(so.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "issues": [{"path": "", "message": (se or so).strip()[-400:] or f"lens.mjs exited {code}"}]}


def cmd_lens_set(repo, src):
    ensure(repo)
    body = read(src)
    if body is None:
        fail(f"no file {src}")
    r = lens_render(repo, src)
    if not r.get("ok"):
        print("The live map was NOT updated. Fix these and run hq lens set again:")
        for i in r.get("issues") or []:
            print(f"- {i.get('path') or '(document)'}: {i.get('message')}")
        sys.exit(1)
    write(os.path.join(lens_dir(repo), "org.json"), body)
    who = who_am_i(repo)
    meta = {**r, "at": NOW(), "by": who.get("role") or who.get("terminal")}
    write_json(os.path.join(lens_dir(repo), "lens.json"), meta)
    log_activity(repo, "map", f"Live map updated: {r.get('title')}", by=meta["by"])
    print(f"ok: live map published ({r['hash']}), shown in HQ > Org > Live map")


def cmd_lens_seed(repo):
    """A starting map from the org as it is now, for the master to curate."""
    print(json.dumps(lens_seed_body(repo), indent=1))


def lens_seed_body(repo, managers=None, mt=None):
    s = settings(repo)
    if managers is None:
        mt, _ = master_terminal(repo)
        managers = [manager_view(repo, m, s) for m in org(repo)["managers"]]
    managers = [m for m in managers if m.get("status") != "retired"]
    lanes = [{"id": "master", "label": "Master", "order": 0}]
    nodes = [{"id": "master", "label": "Master", "kind": "service", "delta": "unchanged", "lane": "master",
              "subtitle": (mt or {}).get("address") or "not running", "badges": [status_of(mt) or "gone"]}]
    edges = []
    mq = next((m for m in managers if m["kind"] == "merge-queue"), None)
    if mq:
        lanes.append({"id": "merge-queue", "label": "Merge queue", "order": 1})
        nodes.append({"id": "merge-queue", "label": "Merge queue", "kind": "queue", "delta": "unchanged", "lane": "merge-queue",
                      "subtitle": mq.get("terminal") or "", "badges": [mq["status"] if mq["live"] else "gone"]})
        nodes.append({"id": "trunk", "label": "Trunk", "kind": "datastore", "delta": "unchanged", "lane": "merge-queue", "badges": []})
        edges.append({"id": "mq-trunk", "from": "merge-queue", "to": "trunk", "kind": "data", "delta": "unchanged", "label": "merges"})
    for i, m in enumerate(x for x in managers if x["kind"] != "merge-queue"):
        lid = f"area-{m['id']}"
        lanes.append({"id": lid, "label": m.get("name") or m["id"], "order": 2 + i})
        f = m.get("facts") or {}
        badges = [m["status"] if m["live"] else "gone"]
        if (f.get("context") or 0) > s["managerWarnAt"]:
            badges.append(f"{(f.get('context') or 0) // 1000}k ctx")
        nodes.append({"id": m["id"], "label": m.get("name") or m["id"], "kind": "service", "delta": "unchanged", "lane": lid,
                      "subtitle": m.get("terminal") or "", "summary": clip(f.get("doing") or f.get("said") or "", 1900) or None,
                      "badges": badges})
        edges.append({"id": f"master-{m['id']}", "from": "master", "to": m["id"], "kind": "call", "delta": "unchanged", "label": "directs"})
        for u in (m.get("team") or [])[:6]:
            if u.get("finished"):
                continue
            uid = re.sub(r"[^a-z0-9-]", "-", f"{m['id']}-{u['kind']}-{u['id']}".lower())[:60]
            nodes.append({"id": uid, "label": clip(u.get("description") or u["id"], 110), "kind": "job", "delta": "unchanged",
                          "lane": lid, "badges": [u.get("status") or ("running" if not u.get("finished") else "done")]})
            edges.append({"id": f"{m['id']}-{uid}", "from": m["id"], "to": uid, "kind": "call", "delta": "unchanged"})
        if mq:
            edges.append({"id": f"{m['id']}-mq", "from": m["id"], "to": "merge-queue", "kind": "queue", "delta": "unchanged", "label": "READY PRs"})
    for n in nodes + lanes:
        for k in [k for k, v in n.items() if v is None]:
            del n[k]
    return {"title": f"{repo['name']}: the org and its work", "lenses": ["architecture"], "lanes": lanes,
            "nodes": nodes, "edges": edges, "flows": [], "views": []}


def cmd_lens_status(repo):
    meta = lens_meta(repo)
    if meta.get("at"):
        print(f"Live map: \"{meta.get('title')}\", published {int((NOW() - meta['at']) / 60000)} min ago by {meta.get('by')}; "
              f"its document is {os.path.join(lens_dir(repo), 'org.json')}")
    else:
        print("Live map: not published yet. Start from `hq lens seed > /tmp/map.json`, curate it, then `hq lens set /tmp/map.json`.")
    print()
    print(LENS_GUIDE)


# ---- memory

def parse_entries(text):
    rows = []
    for i, line in enumerate(text.splitlines()):
        m = re.match(r"^\s*-\s+(.*)$", line)
        if not m:
            continue
        body = m.group(1)
        tag = re.search(r"\[(added:[^\]]*)\]\s*$", body)
        meta = {}
        if tag:
            for part in tag.group(1).split(";"):
                if ":" in part:
                    k, v = part.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = body[: tag.start()].rstrip()
        rows.append({"line": i + 1, "text": body, **meta})
    return rows


def dream_running():
    code, so, _ = run(["pgrep", "-f", "agent-memory-dream/dream.sh"])
    return code == 0 and bool(so.strip())


def cmd_memory():
    files = []
    for path in [os.path.join(MEMORY, "MEMORY.md"), *sorted(glob.glob(os.path.join(MEMORY, "projects", "*.md")))]:
        text = read(path, "")
        files.append({"path": path, "name": os.path.relpath(path, MEMORY), "text": text, "entries": parse_entries(text),
                      "bytes": len(text.encode())})
    code, so, _ = run(["git", "-C", MEMORY, "log", "--format=%H%x1f%ct%x1f%s", "--shortstat", "-80"])
    log = []
    cur = None
    for line in so.splitlines():
        if "\x1f" in line:
            sha, ct, subj = line.split("\x1f", 2)
            cur = {"sha": sha, "at": int(ct) * 1000, "subject": subj, "stat": "", "dream": subj.startswith("Dream")}
            log.append(cur)
        elif line.strip() and cur:
            cur["stat"] = line.strip()
    last_dream = next((c for c in log if c["dream"]), None)
    since = next((i for i, c in enumerate(log) if c["dream"]), len(log))
    dlog = read(DREAM_LOG, "") or ""
    blocks = dlog.split("\n== ")
    last_block = blocks[-1].strip() if dlog.strip() else ""
    pending = sorted(glob.glob(os.path.join(os.path.dirname(DREAM_LOG), "pending-*.patch")))
    out({"root": MEMORY, "files": files, "log": log, "dream": {
        "running": dream_running(), "lastCommit": last_dream, "commitsSince": since, "lastLog": last_block[-3000:],
        "schedule": "daily at 12:47 (launchd local.alex.agent-memory-dream)", "pending": pending,
        "dirty": bool(run(["git", "-C", MEMORY, "status", "--porcelain"])[1].strip())}})


def cmd_memory_show(sha):
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        fail("bad sha")
    code, so, se = run(["git", "-C", MEMORY, "show", "--format=%H%n%an %ad%n%s%n%n%b", "--date=format:%Y-%m-%d %H:%M", "--word-diff=plain", sha])
    if code != 0:
        fail(se.strip())
    out({"text": so[:400_000]})


def cmd_dream(repo):
    if dream_running():
        fail("a Dream is already running")
    if run(["git", "-C", MEMORY, "status", "--porcelain"])[1].strip():
        fail("~/agent-memory has uncommitted edits; a Dream would skip. Commit them first.")
    code, so, se = run(["hc", "run", "--bg", "--json", "--cwd", MEMORY, "--label", "herdr.hq=dream", "--", "bash", DREAM_SH], timeout=20)
    if code != 0:
        fail((se or so).strip()[-300:])
    try:
        addr = json.loads(so).get("address")
    except ValueError:
        addr = None
    log_activity(repo, "dream", f"Started a Dream{' in ' + addr if addr else ''}", by="hq")
    out({"ok": True, "terminal": addr})


# ---- entry

def main(argv):
    args = argv[1:]
    folder = None
    if "--repo" in args:
        i = args.index("--repo")
        folder = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    if not args:
        print(__doc__)
        return
    cmd, a = args[0], args[1:]
    try:
        if cmd in ("compact",):
            return cmd_compact(a[0])
        if cmd == "send":
            return cmd_send(a[0], " ".join(a[1:]))
        if cmd == "memory":
            return cmd_memory()
        if cmd == "memory-show":
            return cmd_memory_show(a[0])
        repo = repo_for(folder)
        if cmd == "ask":
            if not a or a[0] not in ("approval", "question"):
                fail("hq ask approval|question --title T --body B")
            return cmd_ask(repo, a[0], a[1:])
        if cmd == "done":
            return cmd_ask(repo, "done", a)
        if cmd == "status":
            return cmd_status(repo, " ".join(a))
        if cmd == "tick":
            return cmd_tick(repo)
        if cmd == "note":
            log_activity(repo, a[0], " ".join(a[1:]), by="person")
            return out({"ok": True})
        if cmd == "handoff":
            print(ensure(repo)["handoff"])
            return
        if cmd == "files":
            return out(ensure(repo))
        if cmd == "snapshot":
            return cmd_snapshot(repo)
        if cmd == "inbox":
            return out({"items": inbox_items(repo, include_closed="--all" in a)})
        if cmd == "decide":
            return cmd_decide(repo, a[0], a[1], " ".join(a[2:]))
        if cmd == "deliver":
            return out({"delivered": cmd_deliver(repo)})
        if cmd == "org":
            return out(org(repo))
        if cmd == "manager-save":
            return cmd_manager_save(repo, a[0])
        if cmd == "managers":
            return cmd_managers(repo)
        if cmd == "manager-new":
            return cmd_manager_new(repo, a)
        if cmd == "manager-set":
            return cmd_manager_set(repo, a[0], a[1:])
        if cmd == "manager-retire":
            return cmd_manager_retire(repo, a[0])
        if cmd == "manager-launch":
            return cmd_manager_launch(repo, a[0])
        if cmd == "manager-respawn":
            return cmd_manager_respawn(repo, a[0])
        if cmd == "brief":
            # `brief <manager id>`: that manager's composed brief; `brief [--since ms]`: the recap.
            if a and a[0] != "--since":
                return cmd_brief(repo, a[0])
            return cmd_recap(repo, a[1] if len(a) > 1 else None)
        if cmd == "discover":
            return cmd_discover(repo)
        if cmd == "todo":
            return cmd_todo(repo, a)
        if cmd == "lens":
            if not a:
                return cmd_lens_status(repo)
            if a[0] == "set":
                return cmd_lens_set(repo, a[1])
            if a[0] == "seed":
                return cmd_lens_seed(repo)
            if a[0] == "meta":
                return out(lens_meta(repo))
            fail("hq lens [set <file> | seed | meta]")
        if cmd == "repair-adopted":
            return cmd_repair_adopted(repo)
        if cmd == "adopt":
            return cmd_adopt(repo, a[0], a[1], a[2] if len(a) > 2 else "area")
        if cmd == "loop-arm":
            return cmd_loop_arm(repo)
        if cmd == "autopilot":
            return cmd_autopilot(repo)
        if cmd == "dream":
            return cmd_dream(repo)
        fail(f"unknown command {cmd}; run `hq` for help")
    except IndexError:
        fail(f"{cmd}: missing arguments; run `hq` for help")
    except RuntimeError as e:
        fail(str(e))


if __name__ == "__main__":
    main(sys.argv)
