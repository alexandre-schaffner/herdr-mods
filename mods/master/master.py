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
import masters  # noqa: E402
from repos import repo_of  # noqa: E402
sys.path.insert(1, os.path.join(os.path.dirname(HERE), "hq"))
import hcguard  # noqa: E402
import answer_guard  # noqa: E402

PROMPT = os.path.join(HERE, "master.md")
RUNNER_PROMPT = os.path.join(HERE, "runner.md")
LABEL = masters.LABEL
MODEL = "claude-fable-5-2"  # Fable 5.2, 1M context natively
RUNNER_MODEL = "haiku"  # the loop runner: routine ticks, escalates judgment to the master
SKILL = "/pstack:poteto-mode"
FIRST = "You are this repository's master chat. Read your memory, then wait for my first request."
# A new master starts in poteto mode and perpetual (see "Poteto mode" and "The tick" in master.md).
START = "You are this repository's master chat. Read your memory, then start your perpetual tick: invoke the loop skill with 'master tick' (self-paced)."
# With a loop runner (HQ settings: runner), the master doesn't loop: the runner ticks and escalates.
START_RUNNER = "You are this repository's master chat. Read your memory and your handoff (`hq handoff`), then end the turn: the loop runner runs the tick and sends you `HQ ESCALATION` lines; you act on those, on decisions and on the person."
# A resumed master lost its loop with its process: it re-arms from its handoff.
RESUMED = "You were restarted. Read your handoff (`hq handoff`), then restart your perpetual tick: invoke the loop skill with 'master tick' (self-paced)."
RESUMED_RUNNER = "You were restarted. Read your handoff (`hq handoff`), then end the turn: the loop runner runs the tick and sends you `HQ ESCALATION` lines."


def herdr(*args):
    r = subprocess.run(["herdr-app", *args], capture_output=True, text=True, timeout=30)
    try:
        out = json.loads(r.stdout or "null")
    except ValueError:
        out = None
    if r.returncode != 0 or (isinstance(out, dict) and out.get("error")):
        why = out.get("error") if isinstance(out, dict) else (r.stderr or r.stdout).strip()[-300:]
        raise RuntimeError(f"herdr-app {' '.join(args[:2])}: {why}")
    return out


def cmd_plan(folder, epic=None):
    repo = masters.scope_of(repo_of(os.path.realpath(os.path.expanduser(folder))), epic)
    if not repo:
        return {"error": "no folder given"}
    f = masters.find(repo, stale=True)
    proc = f["proc"]
    return {"repo": repo, "sessionId": f["entry"].get("sessionId"), "alive": bool(proc and proc["alive"]),
            "pid": (proc or {}).get("pid"), "terminal": f["terminal"] and claude.terminal_brief(f["terminal"]),
            "stale": f["stale"]}


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
    m = masters.load().get(repo["key"]) or {}
    sid = m.get("sessionId")
    resume = bool(sid and claude.find_transcript(sid))
    if not resume:
        sid = str(uuid.uuid4())
    epic = repo.get("epic")
    argv = [*masters.claude_env(repo), *hcguard.env(repo), "claude", "--model", MODEL, "--name", f"master · {repo['name']}", "--append-system-prompt-file", PROMPT,
            "--settings", answer_guard.settings(), *(["--resume", sid] if resume else ["--session-id", sid])]
    who = (f"You are the master chat for the epic '{epic}' of this repository (HQ_EPIC={epic}): your managers, merge queue, "
           f"roadmap, inbox and to-dos are this epic's alone, and its worktrees are the '{epic}' group in the sidebar. ") if epic else ""
    ran = runner_on(repo)
    first = (f"{SKILL} {who}{RESUMED_RUNNER if ran else RESUMED}{' ' + task if task else ''}" if resume
             else f"{SKILL} {who}{task or (START_RUNNER if ran else START)}")
    tab = f"Master · {epic}" if epic else "Master"
    # An epic's master gets a space of its own; the main master starts where the repo is worked on.
    space = space if epic else home_space(repo, space)
    args = ["--folder", repo["path"], "--argv", json.dumps(argv), *(["--task", first] if first else [])]
    made = (herdr("do", "tab.new", "--space", space, "--name", tab, *args) if space
            else herdr("do", "space.new", "--name", epic or repo["name"], "--tab", tab, *args))
    addr = made.get("terminal")
    if not addr:
        raise RuntimeError("herdr made no terminal: " + json.dumps(made))
    masters.record(repo["key"], sessionId=sid, terminal=addr, path=repo["path"], name=repo["name"], startedAt=int(time.time() * 1000))
    labelled = masters.set_label(addr, repo["key"])
    subprocess.run(["hc", "label", addr, f"{hcguard.LABEL}={hcguard.org_name(repo)}"], capture_output=True, timeout=15)
    try:
        herdr("do", "tab.move", "--id", made.get("tab") or "", "--index", "0")
    except RuntimeError:
        pass  # cosmetic: the master works out of place
    pin(addr)
    return {"address": addr, "sessionId": sid, "resumed": resume, "typed": first, "labelled": labelled}


def runner_on(repo):
    """The org's HQ setting `runner` (default on): a loop runner runs the master's tick."""
    got = claude.read_json(os.path.join(claude.APP_HOME, "data", "hq", hcguard.org_name(repo), "settings.json"))
    return not (isinstance(got, dict) and got.get("runner") is False)


def runner_model(repo):
    got = claude.read_json(os.path.join(claude.APP_HOME, "data", "hq", hcguard.org_name(repo), "settings.json"))
    return (got.get("runnerModel") if isinstance(got, dict) else None) or RUNNER_MODEL


def master_space(addr):
    """(space id, tab id) of the terminal `addr`, from herdr's layout."""
    for sp in herdr("ls").get("spaces") or []:
        for tab in sp.get("tabs") or []:
            if any(t.get("terminal") == addr for t in tab.get("terminals") or []):
                return sp["id"], tab.get("id")
    return None, None


def cmd_runner(folder, epic=None):
    """Starts the master's loop runner beside it (a tab 'Loop' in the master's space), unless one
    runs. A fresh session each time: its state lives in HQ (tick, handoff, loop), not in it."""
    repo = masters.scope_of(repo_of(os.path.realpath(os.path.expanduser(folder))), epic)
    if not repo:
        return {"error": "no folder given"}
    with masters.lock():
        got = masters.find_runner(repo, scan=True)
        if got:
            return {"ok": True, "started": False, "address": got["address"]}
        mt = masters.find(repo)["terminal"]
        if not mt:
            return {"error": "the master isn't running: start it first"}
        space, _ = master_space(mt["address"])
        sid = str(uuid.uuid4())
        name = f"loop · {repo['name']}"
        argv = [*masters.claude_env(repo), *hcguard.env(repo), "claude", "--model", runner_model(repo), "--name", name,
                "--append-system-prompt-file", RUNNER_PROMPT, "--settings", answer_guard.settings(), "--session-id", sid]
        tab = f"Loop · {repo['epic']}" if repo.get("epic") else "Loop"
        args = ["--folder", repo["path"], "--argv", json.dumps(argv), "--task", masters.LOOP_PROMPT]
        made = (herdr("do", "tab.new", "--space", space, "--name", tab, *args) if space
                else herdr("do", "space.new", "--name", repo.get("epic") or repo["name"], "--tab", tab, *args))
        addr = made.get("terminal")
        if not addr:
            return {"error": "herdr made no terminal: " + json.dumps(made)}
        masters.record(repo["key"], runner={"terminal": addr, "sessionId": sid, "startedAt": int(time.time() * 1000)})
        for label in (f"{masters.RUNNER_LABEL}={repo['key']}", f"{hcguard.LABEL}={hcguard.org_name(repo)}"):
            subprocess.run(["hc", "label", addr, label], capture_output=True, timeout=15)
        return {"ok": True, "started": True, "address": addr, "sessionId": sid}


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


def cmd_open(folder, space="", task="", epic=None):
    # One open at a time: a second click waits, then finds the master the first one started.
    with masters.lock():
        return _open(folder, space, task, epic)


def _open(folder, space, task, epic=None):
    plan = cmd_plan(folder, epic)
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
    epic = masters.pop_flag(a, "--epic")
    try:
        if cmd == "plan" and a:
            out = cmd_plan(a[0], epic)
        elif cmd == "runner" and a:
            out = cmd_runner(a[0], epic)
        elif cmd == "open" and a:
            out = cmd_open(a[0], a[1] if len(a) > 1 else "", a[2] if len(a) > 2 else "", epic)
        else:
            out = {"error": "usage: master.py plan <folder> [--epic E] | open <folder> [space] [task] [--epic E] | runner <folder> [--epic E]"}
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        out = {"error": str(e)}
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv)
