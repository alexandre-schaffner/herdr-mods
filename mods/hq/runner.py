"""The loop runner: a cheap session (Haiku by default) beside each master that runs
`/loop master tick` in its place. It does the routine steps (status, Home, the map, the roadmap,
the to-dos) and hands what needs judgment to the master with `hq escalate`, so the master's big
context is only read when there is real work. Off with the org setting `runner: false`; while no
runner runs, the master ticks itself as before.

  hq escalate --title T [--body-file F | --body B] [--urgent]
                                   (the runner) wake the master with work only it can do
  hq escalations [--all]           what the runner escalated, delivered or waiting
  hq runner [start]                the runner's terminal and loop; `start` starts one now
"""

import json
import os
import subprocess
import uuid

ESC_TRIES = 30  # about half an hour of autopilot retries while the master is busy
START_GAP_MS = 5 * 60_000  # never start runners faster than this (one failed start, not a storm)


def on(H, repo):
    return H.settings(repo).get("runner") is not False


def terminal(H, repo):
    """The runner's terminal as `hc get` has it, or None. Looked up once per command."""
    cache = H._runners
    if repo["key"] not in cache:
        cache[repo["key"]] = H.registry.find_runner(repo) if on(H, repo) else None
    return cache[repo["key"]]


def record(H, repo, facts=False, **opts):
    """{terminal, status, sessionId, facts} of the live runner, or None."""
    t = terminal(H, repo)
    if not t:
        return None
    sess = H.session_of_terminal(t)
    sid = (sess or {}).get("sessionId") or ((H.registry.load().get(repo["key"]) or {}).get("runner") or {}).get("sessionId")
    rec = {"terminal": t["address"], "status": H.status_of(t), "sessionId": sid, "facts": {}}
    if facts and sid:
        rec["facts"] = H.session_facts(sid, repo["path"], **opts)
    return rec


# ---- escalations: the runner's way to the master

def esc_dir(H, repo):
    return os.path.join(H.paths(repo)["dir"], "escalations")


def esc_items(H, repo):
    d = esc_dir(H, repo)
    out = []
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if name.endswith(".json"):
            it = H.claude.read_json(os.path.join(d, name))
            if isinstance(it, dict):
                out.append(it)
    return out


def esc_line(H, repo, it):
    p = H.paths(repo)["handoff"]
    big = os.path.getsize(p) if os.path.exists(p) else 0
    tail = f" Your handoff is {big // 1000} kB: rewrite it under {H.HANDOFF_MAX // 1000} kB (state now, not history)." if big > H.HANDOFF_MAX else ""
    return (f"HQ ESCALATION [{it['id']}]{' (urgent)' if it.get('urgent') else ''}: {H.clip(it['title'], 160)}. "
            f"The loop runner needs you: read {os.path.join(esc_dir(H, repo), it['id'] + '.md')}, act, update your handoff, then end the turn.{tail}")


def deliver(H, repo, it):
    """Types the escalation's one line into the master when it is idle; else it waits for the
    autopilot's next try. Returns True once delivered."""
    mt, _ = H.master_terminal(repo)
    st = H.status_of(H.hc_get(mt["address"])) if mt else None
    if not mt:
        it["error"] = "the master isn't running"
    elif st not in ("idle", "done"):  # `hc send --if idle` refuses `done` (a finished turn), so check here
        it["error"] = f"the master is {st}"
    else:
        code, so, se = H.hc(["send", mt["address"], esc_line(H, repo, it)], repo, timeout=25)
        if code == 0:
            it.update(deliveredAt=H.NOW(), error=None)
        else:
            it["error"] = (se or so).strip()[-200:] or "the master is busy"
    it["tries"] = it.get("tries", 0) + 1
    H.write_json(os.path.join(esc_dir(H, repo), it["id"] + ".json"), it)
    return bool(it.get("deliveredAt"))


def cmd_escalate(H, repo, args):
    o, i = {}, 0
    while i < len(args):
        a = args[i]
        if a == "--urgent":
            o["urgent"] = True
            i += 1
        elif a in ("--title", "--body", "--body-file") and i + 1 < len(args):
            o[a[2:]] = args[i + 1]
            i += 2
        else:
            H.fail(f"hq escalate: unknown argument {a}")
    if not o.get("title"):
        H.fail("hq escalate --title T [--body-file F | --body B] [--urgent]")
    body = H.read(o["body-file"], None) if o.get("body-file") else o.get("body", "")
    if body is None:
        H.fail(f"no file {o['body-file']}")
    os.makedirs(esc_dir(H, repo), exist_ok=True)
    eid = H.time.strftime("%m%d-%H%M") + "-" + uuid.uuid4().hex[:4]
    H.write(os.path.join(esc_dir(H, repo), eid + ".md"), f"# {o['title']}\n\n{body.strip()}\n")
    it = {"id": eid, "title": o["title"], "urgent": bool(o.get("urgent")), "at": H.NOW(),
          "from": H.who_am_i(repo).get("terminal")}
    sent = deliver(H, repo, it)
    H.log_activity(repo, "escalate", o["title"], by="runner")
    H.out({"ok": True, "id": eid, "delivered": sent,
           "note": None if sent else "the master is busy: HQ types it in once it is idle (or it reads `hq escalations`)"})


def cmd_escalations(H, repo, args):
    rows = esc_items(H, repo)
    if "--all" not in args:
        rows = [r for r in rows if not r.get("deliveredAt")] + [r for r in rows if r.get("deliveredAt")][-5:]
    for r in rows:
        st = "delivered" if r.get("deliveredAt") else f"waiting ({r.get('error') or 'not tried'})"
        print(f"[{r['id']}] {st}: {r['title']}  {os.path.join(esc_dir(H, repo), r['id'] + '.md')}")
    if not rows:
        print("No escalations.")


def cmd_runner(H, repo, args):
    if args[:1] == ["start"]:
        return H.out(start(H, repo, force=True))
    r = record(H, repo, facts=True)
    loop = H.loop_state((r or {}).get("facts", {}).get("loop"), (r or {}).get("status")) if r else {"state": "gone"}
    H.out({"on": on(H, repo), "model": H.settings(repo).get("runnerModel"), "runner": r and {k: v for k, v in r.items() if k != "facts"},
           "context": (r or {}).get("facts", {}).get("context"), "loop": loop})


# ---- autopilot

def start(H, repo, force=False):
    """Starts a runner via master.py (the master must be running), at most once per START_GAP_MS."""
    reg = (H.registry.load().get(repo["key"]) or {}).get("runner") or {}
    if not force and H.NOW() - max(reg.get("startedAt") or 0, reg.get("triedAt") or 0) < START_GAP_MS:
        return {"ok": False, "why": "a start was tried moments ago"}
    H.registry.record(repo["key"], runner={**reg, "triedAt": H.NOW()})
    argv = ["python3", H.MASTER_PY, "runner", repo["path"], *(["--epic", repo["epic"]] if repo.get("epic") else [])]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=90)
        got = json.loads(r.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        return {"ok": False, "why": str(e)}
    H._runners.pop(repo["key"], None)
    return got


def autopilot(H, repo, master, s):
    """Keeps the runner going: starts one beside a live master, re-delivers waiting escalations,
    compacts an idle runner over runnerCompactAt (its state lives in HQ, so no handoff gate)."""
    if not on(H, repo) or not master.get("terminal"):
        return []
    did = []
    if not terminal(H, repo):
        got = start(H, repo)
        if got.get("started"):
            did.append(f"started the loop runner ({got.get('address')})")
            H.log_activity(repo, "runner", f"Started the loop runner ({got.get('address')}, {s.get('runnerModel')})", by="hq")
        return did
    for it in esc_items(H, repo):
        if not it.get("deliveredAt") and it.get("tries", 0) < ESC_TRIES and deliver(H, repo, it):
            did.append(f"delivered escalation {it['id']}")
    r = record(H, repo, facts=True)
    facts = r["facts"]
    quiet = H.NOW() - (facts.get("lastAt") or H.NOW())
    if r["status"] in ("idle", "done") and (facts.get("context") or 0) > s["runnerCompactAt"] and quiet > 60_000:
        ok, _ = H.type_text(r["terminal"], "/compact")
        if ok:
            did.append("compacted the loop runner")
            H.log_activity(repo, "compact", f"Compacted the loop runner at {(facts.get('context') or 0) // 1000}k tokens", by="hq")
    return did


COMMANDS = {"escalate": cmd_escalate, "escalations": cmd_escalations, "runner": cmd_runner}
