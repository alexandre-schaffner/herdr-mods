"""Watches: what an agent waits on (CI, a merge, a reply, a long build) as records HQ reads,
instead of something it would have to guess from a transcript.

One registry for every org, data/hq/_watches/<id>.json, with two kinds:
- HQ's (`hq watch add`): HQ's autopilot runs the check every N minutes and sends the agent one
  `HQ WATCH:` line when it passes. Nothing is spent while it waits, and the watch outlives the
  agent's session. The check's exit code is the contract: 0 it happened, 1 not yet, anything
  else an error. Three errors in a row fire as well, so a broken check is fixed, not waited on.
- The agent's own: a background Bash command or a Monitor it starts itself. watch_hook.py (a
  PostToolUse hook) files it with its task id; Claude Code wakes the agent when it ends, as
  always. HQ counts a command while a process still writes its output file, and a monitor
  until it times out (a persistent one while its session lives).
"""

import os
import shlex
import subprocess
import uuid

CHECK_TIMEOUT = 60
EVERY_DEFAULT = 600
FOR_DEFAULT = 24 * 3600
MAX_ERRORS = 3
KEEP_MS = 24 * 3600_000      # ended, fired or cancelled records are dropped after this
DELIVERY_TRIES = 20          # about 20 minutes of autopilot retries, then the master hears of it
LIVE = ("watching", "fired")  # fired: the agent hasn't got the line yet


def reg_dir(H):
    return os.path.join(H.APP, "data", "hq", "_watches")


def org_of(H, repo):
    return os.path.basename(H.data_dir(repo))


def load_all(H):
    d = reg_dir(H)
    got = []
    for name in os.listdir(d) if os.path.isdir(d) else []:
        if name.endswith(".json"):
            w = H.claude.read_json(os.path.join(d, name))
            if isinstance(w, dict) and w.get("id"):
                got.append(w)
    return got


def save(H, w):
    os.makedirs(reg_dir(H), exist_ok=True)
    H.write_json(os.path.join(reg_dir(H), f"{w['id']}.json"), w)


def update(H, wid, **fields):
    """Re-reads the record before writing, so an edit made meanwhile (a cancel) isn't lost."""
    w = H.claude.read_json(os.path.join(reg_dir(H), f"{wid}.json"))
    if isinstance(w, dict):
        w.update(fields)
        save(H, w)
    return w


def seconds(text, what):
    """'90s', '10m', '2h', '1d' or plain seconds."""
    t = str(text or "").strip().lower()
    mult = {"s": 1, "m": 60, "h": 3600, "d": 86400}.get(t[-1:], 1)
    try:
        return int(float(t.rstrip("smhd")) * mult)
    except ValueError:
        raise RuntimeError(f"{what}: expected a duration like 10m, 2h or 1d, got '{text}'") from None


def span(sec):
    return f"{sec // 86400}d" if sec >= 86400 and sec % 86400 == 0 else f"{sec // 3600}h" if sec >= 3600 and sec % 3600 == 0 else f"{max(1, sec // 60)}m"


# ---- whose: an org's agents and the records that belong to them

def agents(H, repo):
    """[(agent id, terminal, session id)]: the master, then the managers still in the org."""
    mt, entry = H.master_terminal(repo)
    out = [("master", (mt or {}).get("address"), (entry or {}).get("sessionId"))]
    for m in H.org(repo)["managers"]:
        if m.get("status") != "retired":
            out.append((m["id"], m.get("terminal"), m.get("sessionId")))
    return out


def owner(w, org, ags):
    """The agent of this org a record belongs to, or None."""
    if w.get("kind") == "hq":
        return w.get("agent") if w.get("org") == org else None
    if w.get("org") and w["org"] != org:
        return None
    for aid, term, sid in ags:
        if (term and w.get("terminal") == term) or (sid and w.get("sessionId") == sid):
            return aid
    return None


# ---- the agent's own: still running?

def held_open(files):
    """The files a process still has open, or None when lsof can't tell."""
    if not files:
        return set()
    try:
        r = subprocess.run(["lsof", "-Fn", "--", *files], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return {line[1:] for line in r.stdout.splitlines() if line.startswith("n")}


def sweep_own(H, recs, alive_terminals):
    """Marks the agent's own watches that ended (output no longer written, monitor timed out,
    session gone). Returns the ones still running."""
    now = H.NOW()
    own = [w for w in recs if w.get("kind") == "own" and w.get("state") == "watching"]
    files = [w["output"] for w in own if w["tool"] == "bash" and w.get("output") and os.path.exists(w["output"])]
    held = held_open(files)
    live = []
    for w in own:
        gone = w.get("terminal") and alive_terminals is not None and w["terminal"] not in alive_terminals
        if w["tool"] == "bash":
            running = w.get("output") in files and (held is None or w["output"] in held)
        else:
            running = (w.get("expiresAt") or now + 1) > now
        if running and not gone:
            live.append(w)
        else:
            w.update(state="ended", endedAt=now)
            update(H, w["id"], state="ended", endedAt=now)
    return live


# ---- HQ's: run the check

def run_check(w):
    """(exit code, last line of output)."""
    try:
        r = subprocess.run(["/bin/bash", "-c", w["check"]], cwd=w.get("cwd") if w.get("cwd") and os.path.isdir(w["cwd"]) else None,
                           capture_output=True, text=True, timeout=CHECK_TIMEOUT)
    except subprocess.TimeoutExpired:
        return 124, f"the check took over {CHECK_TIMEOUT} s"
    except OSError as e:
        return 126, str(e)
    lines = [x.strip() for x in (r.stdout or "").splitlines() if x.strip()] or [x.strip() for x in (r.stderr or "").splitlines() if x.strip()]
    return r.returncode, (lines[-1][:300] if lines else "")


def judge(w, code, line, now):
    """The record's fields after one check, with firedWhy set when it fires."""
    f = {"lastCheckAt": now, "lastCode": code, "lastLine": line, "nextAt": now + w["everySec"] * 1000}
    if code == 0:
        f["firedWhy"] = "it happened"
    elif code == 1:
        f["errors"] = 0
    else:
        f["errors"] = (w.get("errors") or 0) + 1
        if f["errors"] >= MAX_ERRORS:
            f["firedWhy"] = f"the check failed {f['errors']} times in a row (exit {code})"
    if "firedWhy" not in f and w.get("untilAt") and now >= w["untilAt"]:
        f["firedWhy"] = f"it didn't happen within {span(int((w['untilAt'] - w['createdAt']) / 1000))}"
    if "firedWhy" in f:
        f.update(state="fired", firedAt=now)
    return f


def message(w):
    line = w.get("lastLine")
    return (f"HQ WATCH [{w['id']}]: {w['label']}: {w['firedWhy']}" + (f" ({line})" if line else "") + "."
            + (f" {w['note']}" if w.get("note") and w.get("lastCode") == 0 else " Fix the check or drop the watch." if w.get("lastCode") not in (0, 1) else ""))


def deliver(H, repo, w):
    term = H.asker_terminal(repo, {"from": {"role": w.get("agent"), "terminal": w.get("terminal")}})
    tries = (w.get("tries") or 0) + 1
    if term:
        code, so, se = H.hc(["send", term, message(w)], repo, timeout=25)
        if code == 0:
            update(H, w["id"], state="done", deliveredAt=H.NOW(), tries=tries, error=None)
            H.log_activity(repo, "watch", f"{w.get('agent')}'s watch fired: {w['label']} ({w['firedWhy']})", by="hq")
            return f"watch {w['id']} fired for {w.get('agent')}"
        err = (se or so).strip()[-160:]
    else:
        err = f"{w.get('agent')} isn't running"
    if tries >= DELIVERY_TRIES:
        update(H, w["id"], state="done", tries=tries, error=err)
        H.mbox.tell(H, repo, f"{w.get('agent')}'s watch '{w['label']}' fired ({w['firedWhy']}) but couldn't reach it: {err}", frm=H.HQ_FROM)
        return f"watch {w['id']} undeliverable, told the master"
    update(H, w["id"], tries=tries, error=err)
    return None


def autopilot(H, repo):
    """One pass for this org: run the HQ watches that are due (side by side), deliver what
    fired, close the agent's own watches that ended, drop old records."""
    org, now, did = org_of(H, repo), H.NOW(), []
    recs = load_all(H)
    due = [w for w in recs if w.get("kind") == "hq" and w.get("org") == org and w.get("state") == "watching" and (w.get("nextAt") or 0) <= now]
    if due:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(8, len(due))) as ex:
            results = list(ex.map(run_check, due))
        for w, (code, line) in zip(due, results):
            cur = H.claude.read_json(os.path.join(reg_dir(H), f"{w['id']}.json")) or {}
            if cur.get("state") != "watching":
                continue  # cancelled while the check ran
            cur.update(judge(cur, code, line, H.NOW()))
            save(H, cur)
    for w in load_all(H):
        if w.get("kind") == "hq" and w.get("org") == org and w.get("state") == "fired":
            got = deliver(H, repo, w)
            if got:
                did.append(got)
    ags = agents(H, repo)
    mine = [w for w in recs if owner(w, org, ags)]
    sweep_own(H, mine, {t["address"] for t in H.hc_ls()})
    for w in recs:
        ended = w.get("endedAt") or w.get("deliveredAt") or w.get("cancelledAt")
        # An own watch no org claims (its agent retired) is dropped after a week either way.
        stray = w.get("kind") == "own" and w.get("state") == "watching" and now - (w.get("createdAt") or now) > 7 * KEEP_MS
        if stray or (w.get("state") not in LIVE and ended and now - ended > KEEP_MS and (w.get("kind") == "own" or w.get("org") == org)):
            try:
                os.remove(os.path.join(reg_dir(H), f"{w['id']}.json"))
            except OSError:
                pass
    return did


# ---- what HQ shows and tells

def view(w):
    v = {k: w.get(k) for k in ("id", "label", "state", "createdAt", "expiresAt", "taskId", "lastCheckAt", "lastLine", "lastCode", "errors", "untilAt", "note")}
    v["kind"] = "hq" if w.get("kind") == "hq" else w.get("tool") or "bash"
    v["command"] = w.get("check") if w.get("kind") == "hq" else w.get("command")
    v["everySec"] = w.get("everySec")
    return v


def by_agent(H, repo, alive_terminals=None):
    """{agent: [view]}: each agent's live watches, newest first."""
    org, ags = org_of(H, repo), agents(H, repo)
    recs = [w for w in load_all(H) if owner(w, org, ags)]
    own_live = {w["id"] for w in sweep_own(H, recs, alive_terminals)}
    out = {}
    for w in sorted(recs, key=lambda x: x.get("createdAt") or 0, reverse=True):
        if (w.get("kind") == "hq" and w.get("state") in LIVE) or w["id"] in own_live:
            out.setdefault(owner(w, org, ags), []).append(view(w))
    return out


def describe(v, now):
    ago = lambda ms: f"{max(1, int((now - ms) / 60000))} min ago" if ms else "not yet"  # noqa: E731
    if v["kind"] == "hq":
        last = f"last check {ago(v.get('lastCheckAt'))}" + (f": {v['lastLine']}" if v.get("lastLine") else "")
        return f"[{v['id']}] {v['label']}: HQ checks every {span(v.get('everySec') or EVERY_DEFAULT)}, {last}"
    what = "your Monitor" if v["kind"] == "monitor" else "your background command"
    return f"[{v['id']}] {v['label']}: {what} (task {v.get('taskId')}), started {ago(v.get('createdAt'))}"


def tick_lines(H, repo, agent):
    ws = by_agent(H, repo).get(agent) or []
    if not ws:
        return []
    now = H.NOW()
    return ["Watching (each wakes you when it fires or ends; don't start a second one for the same thing):",
            *[f"- {describe(v, now)}" for v in ws]]


# ---- commands

HELP = """hq watch add "<what you wait for>" --check '<command>' [--every 10m] [--for 1d] [--note "<what to do then>"]
    HQ runs the check every --every (from your current folder) and sends you one HQ WATCH line when
    it exits 0 (it happened), or after 3 errors, or when --for runs out. Exit 1 means not yet.
    You spend nothing while it waits, and it outlives your session. e.g.
    --check 'gh pr view 5227 --json state -q .state | grep -qx MERGED'
hq watch [ls] [--all] [--json]     your watches (HQ's and your own background commands/Monitors)
hq watch cancel <id>               stop one of HQ's; stop your own with TaskStop <task id>"""


def flag(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise RuntimeError(f"{name} needs a value")
        val = args[i + 1]
        del args[i:i + 2]
        return val
    return default


def cancel(H, wid):
    w = H.claude.read_json(os.path.join(reg_dir(H), f"{wid}.json"))
    if not isinstance(w, dict):
        H.fail(f"no watch {wid}")
    if w.get("kind") != "hq":
        H.fail(f"{wid} is a background task of the agent's own: it stops it with TaskStop {w.get('taskId')}")
    return update(H, wid, state="cancelled", cancelledAt=H.NOW())


def cmd(H, repo, args):
    args = list(args)
    op = args.pop(0) if args and args[0] in ("add", "ls", "list", "cancel", "help") else "ls"
    if op == "help":
        return print(HELP)
    me = H.who_am_i(repo)
    if op == "add":
        check = flag(args, "--check")
        every = seconds(flag(args, "--every", "10m"), "--every")
        until = seconds(flag(args, "--for", "1d"), "--for")
        note = flag(args, "--note", "")
        agent = flag(args, "--agent") or me.get("role")
        label = " ".join(args).strip()
        if not check or not label:
            H.fail(HELP)
        if not agent:
            H.fail("hq watch add: run it from a master or manager session, or pass --agent <id>")
        every = max(120, min(6 * 3600, every))
        now = H.NOW()
        w = {"id": f"w{uuid.uuid4().hex[:6]}", "kind": "hq", "org": org_of(H, repo), "agent": agent, "terminal": me.get("terminal"),
             "label": label[:200], "check": check, "cwd": os.getcwd(), "everySec": every, "note": note[:500],
             "createdAt": now, "untilAt": now + max(every, until) * 1000, "state": "watching"}
        code, line = run_check(w)  # once now: a check that's already true or broken is said at once
        if code == 0:
            return print(f"Already true{f' ({line})' if line else ''}: nothing to watch. Carry on.")
        if code != 1:
            H.fail(f"the check failed (exit {code}{f': {line}' if line else ''}). It must exit 0 when it happened and 1 "
                   f"while not yet; `grep -q` and `test` do. Fix it and add again.")
        w.update(lastCheckAt=now, lastCode=code, lastLine=line, errors=0, nextAt=now + every * 1000)
        save(H, w)
        H.log_activity(repo, "watch", f"{agent} watches: {w['label']} (every {span(every)})", by=agent)
        return print(f"Watching [{w['id']}] every {span(every)} for up to {span(max(every, until))}"
                     f"{f' (now: {line})' if line else ''}. HQ sends you an HQ WATCH line when it fires; end your turn.")
    if op == "cancel":
        w = cancel(H, args[0] if args else H.fail("hq watch cancel <id>"))
        return print(f"Cancelled [{w['id']}] {w['label']}.")
    views = by_agent(H, repo)
    if "--json" in args:
        return H.out(views)
    now = H.NOW()
    rows = [(a, v) for a, vs in views.items() for v in vs if "--all" in args or a == me.get("role")]
    if not rows:
        return print("No watches." if "--all" in args else "You watch nothing. `hq watch help` to start one.")
    for a, v in rows:
        print(("" if a == me.get("role") else f"{a}: ") + describe(v, now) + (f" ({shlex.quote(v['command'])})" if v.get("command") and v["kind"] == "hq" else ""))

