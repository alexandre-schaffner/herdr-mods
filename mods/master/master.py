"""The master chat: one long-lived Claude Code session per repository, the person's proxy.

  master.py plan <folder>                    the repo's master: its session and the terminal showing it
  master.py open <folder> [space] [task]     show it, starting or resuming it first; type `task` into it

The master's session id is chosen up front (`--session-id`) and kept in claude.MASTERS, so
a master that exited comes back with `claude --resume <id>`: same session, same runs. Its
terminal carries the label `herdr.master=<repo key>` and is pinned, in a tab called Master.
The label outlives the session (Herdr leaves a shell in the terminal when claude exits), so
a labelled terminal only counts while it runs Claude Code; a leftover idle shell is closed.
"""

import json
import os
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "shared"))
import claude  # noqa: E402
from repos import repo_of  # noqa: E402

MASTERS = claude.MASTERS
PROMPT = os.path.join(HERE, "master.md")
LABEL = "herdr.master"
MODEL = "opus[1m]"
SKILL = "/pstack:poteto-mode"
FIRST = "You are this repository's master chat. Read your memory, then wait for my first request."


def load():
    return claude.masters()


def save(masters):
    os.makedirs(os.path.dirname(MASTERS), exist_ok=True)
    tmp = MASTERS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(masters, f, indent=1)
    os.replace(tmp, MASTERS)


def herdr(*args):
    r = subprocess.run(["herdr-app", *args], capture_output=True, text=True, timeout=30)
    try:
        out = json.loads(r.stdout or "null")
    except ValueError:
        out = None
    if r.returncode != 0 or (isinstance(out, dict) and out.get("error")):
        raise RuntimeError(f"herdr-app {' '.join(args[:2])}: " + ((out or {}).get("error") if isinstance(out, dict) else (r.stderr or r.stdout).strip()[-300:]))
    return out


def cmd_plan(folder):
    repo = repo_of(os.path.realpath(os.path.expanduser(folder)))
    if not repo:
        return {"error": "no folder given"}
    m = load().get(repo["key"]) or {}
    sid = m.get("sessionId")
    proc = claude.sessions().get(sid) if sid else None
    alive = bool(proc and proc["alive"])
    terminal, stale = None, []
    for t in claude.terminals():
        if t.get("state") != "live":
            continue
        labelled = (t.get("labels") or {}).get(LABEL) == repo["key"]
        if claude.shows_session(t, proc) or (labelled and claude.runs_claude(t)):
            terminal = claude.terminal_brief(t)
        elif labelled:
            stale.append(t)
    return {"repo": repo, "sessionId": sid, "alive": alive, "pid": (proc or {}).get("pid"), "terminal": terminal,
            "stale": [{"address": t["address"], "idle": not claude.has_children(t.get("pid"))} for t in stale]}


def retire(stale):
    """A labelled terminal whose master exited: close it when it is only an idle shell,
    else just take the label off (something else runs there now)."""
    for t in stale:
        if t["idle"]:
            try:
                herdr("do", "terminal.kill", "--terminal", t["address"])
                continue
            except RuntimeError:
                pass
        subprocess.run(["hc", "label", t["address"], f"{LABEL}="], capture_output=True, timeout=15)


def home_space(repo, fallback):
    """The space to start the master in: one already working in the repo's main checkout,
    else `fallback` (the person's), else none (a new space)."""
    cwds = {t["address"]: t.get("cwd") or "" for t in (claude.hc_json("ls")[0] or {}).get("terminals") or []}
    inside = lambda c: c == repo["path"] or c.startswith(repo["path"].rstrip("/") + "/")
    for s in herdr("ls").get("spaces") or []:
        if s.get("machine"):
            continue
        for tab in s.get("tabs") or []:
            if any(inside(cwds.get(t.get("terminal"), "")) for t in tab.get("terminals") or []):
                return s["id"]
    return fallback or ""


def start(repo, space, task):
    masters = load()
    m = masters.get(repo["key"]) or {}
    sid = m.get("sessionId")
    resume = bool(sid and claude.find_transcript(sid))
    if not resume:
        sid = str(uuid.uuid4())
    argv = ["claude", "--model", MODEL, "--name", f"master · {repo['name']}", "--append-system-prompt-file", PROMPT,
            *(["--resume", sid] if resume else ["--session-id", sid])]
    first = task if resume else f"{SKILL} {task or FIRST}"
    space = home_space(repo, space)
    args = ["--folder", repo["path"], "--argv", json.dumps(argv), *(["--task", first] if first else [])]
    made = (herdr("do", "tab.new", "--space", space, "--name", "Master", *args) if space
            else herdr("do", "space.new", "--name", repo["name"], "--tab", "Master", *args))
    addr = made.get("terminal")
    if not addr:
        raise RuntimeError("herdr made no terminal: " + json.dumps(made))
    masters[repo["key"]] = {"sessionId": sid, "path": repo["path"], "name": repo["name"], "startedAt": int(time.time() * 1000)}
    save(masters)
    subprocess.run(["hc", "label", addr, f"{LABEL}={repo['key']}"], capture_output=True, timeout=15)
    try:
        herdr("do", "tab.move", "--id", made.get("tab") or "", "--index", "0")
    except RuntimeError:
        pass  # cosmetic: the master works out of place
    pin(addr)
    return {"address": addr, "sessionId": sid, "resumed": resume, "typed": first}


def pin(addr):
    """Pins the master to the top of the agent lists. A pin sent while the terminal is still
    starting doesn't stick, so it is repeated until the label shows (cosmetic if it never does)."""
    for _ in range(20):
        try:
            herdr("do", "terminal.pin", "--terminal", addr, "--pinned", "true")
        except RuntimeError:
            pass
        got, _ = claude.hc_json("get", addr)
        if ((got or {}).get("labels") or {}).get("herdr.pinned"):
            return True
        time.sleep(0.5)
    return False


def cmd_open(folder, space="", task=""):
    plan = cmd_plan(folder)
    if plan.get("error"):
        return plan
    t = plan["terminal"]
    if not t:
        if plan["alive"]:
            return {"error": f"the master session is running outside Herdr (pid {plan['pid']}); close it or open it there"}
        retire(plan["stale"])
        started = start(plan["repo"], space, task)
        return {"ok": True, "started": True, **started, "repo": plan["repo"]}
    if task:
        if t.get("state") == "blocked":
            return {"error": f"the master ({t['address']}) is waiting on you; answer it first", "terminal": t}
        r = subprocess.run(["hc", "send", t["address"], task], capture_output=True, text=True, timeout=25)
        if r.returncode != 0:
            return {"error": f"hc send {t['address']}: " + (r.stderr or r.stdout).strip()[-300:]}
    try:
        herdr("do", "agent.focus", "--terminal", t["address"])
    except RuntimeError:
        pass
    return {"ok": True, "started": False, "address": t["address"], "sessionId": plan["sessionId"], "typed": task, "repo": plan["repo"]}


def main(argv):
    cmd, a = (argv[1] if len(argv) > 1 else ""), argv[2:]
    try:
        if cmd == "plan" and a:
            out = cmd_plan(a[0])
        elif cmd == "open" and a:
            out = cmd_open(a[0], a[1] if len(a) > 1 else "", a[2] if len(a) > 2 else "")
        else:
            out = {"error": "usage: master.py plan <folder> | open <folder> [space] [task]"}
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        out = {"error": str(e)}
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv)
