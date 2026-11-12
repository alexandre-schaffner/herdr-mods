"""Merges and merge queues: the repo's merged PRs per day (Home's chart), PR titles, and each
epic's merge queue summarised from its engine's state.json (HQ > Queue). hq.py calls in here;
`H` is the hq module (its helpers: data_dir, run, write_json, clip, pull_url, ...).

GitHub data is repo-wide, so one cache serves every epic scope: data/hq/<repo>/merges.json
(counts per day) and pr-titles.json (open and recently merged PRs' titles), both refreshed by one
background `hq merges-refresh` when stale (gh takes seconds; the snapshot never waits on it).
"""

from __future__ import annotations

import calendar
import glob
import json
import os
import re
import subprocess
import sys
import time

import masters as registry

MERGES_TTL = 300_000
MERGES_DAYS = 14
LOCK_MS = 120_000  # a refresh holding the lock longer than this is presumed dead
LIVE = ("ci", "green", "red", "error", "stale", "trunk-check")  # a batch still in flight
RECENT = 12
HOME = os.path.expanduser("~")


# ---- the repo-wide GitHub cache

def cache_path(H, scope, name):
    return os.path.join(H.data_dir(registry.base_of(scope)), name)


def refresh(H, scope):
    """Counts merged PRs per local day (14 days) and keeps open and merged PRs' titles."""
    counts, titles = cache_path(H, scope, "merges.json"), cache_path(H, scope, "pr-titles.json")
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - (MERGES_DAYS - 1) * 86400))
    code, so, se = H.run(["gh", "pr", "list", "--state", "merged", "--search", f"merged:>={since}", "--limit", "2000",
                          "--json", "number,mergedAt,title"], timeout=60, cwd=scope["path"])
    if code != 0:
        prev = H.claude.read_json(counts) or {}
        H.write_json(counts, {**prev, "at": H.NOW(), "error": (se or so).strip()[-200:]})
        return
    prs = json.loads(so or "[]")
    names = {str(p["number"]): p.get("title") or "" for p in prs}
    c2, so2, _ = H.run(["gh", "pr", "list", "--state", "open", "--limit", "400", "--json", "number,title"], timeout=60, cwd=scope["path"])
    if c2 == 0:
        names.update({str(p["number"]): p.get("title") or "" for p in json.loads(so2 or "[]")})
    days = {time.strftime("%Y-%m-%d", time.localtime(time.time() - k * 86400)): 0 for k in range(MERGES_DAYS - 1, -1, -1)}
    for pr in prs:
        try:
            ts = calendar.timegm(time.strptime(pr["mergedAt"], "%Y-%m-%dT%H:%M:%SZ"))
        except (KeyError, TypeError, ValueError):
            continue
        day = time.strftime("%Y-%m-%d", time.localtime(ts))
        if day in days:
            days[day] += 1
    H.write_json(titles, names)
    H.write_json(counts, {"at": H.NOW(), "days": [{"date": d, "count": n} for d, n in days.items()]})


def cmd_refresh(H, scope):
    try:
        refresh(H, scope)
    finally:
        try:
            os.remove(cache_path(H, scope, "merges.json") + ".lock")
        except OSError:
            pass


def merges_snapshot(H, scope):
    """The cached counts; a stale cache starts a background refresh."""
    path = cache_path(H, scope, "merges.json")
    m = H.claude.read_json(path) or {}
    lock = path + ".lock"
    busy = os.path.exists(lock) and time.time() * 1000 - os.path.getmtime(lock) * 1000 < LOCK_MS
    if H.NOW() - (m.get("at") or 0) > MERGES_TTL and not busy:
        os.makedirs(os.path.dirname(lock), exist_ok=True)
        H.write(lock, str(os.getpid()))
        subprocess.Popen([sys.executable, "-I", H.__file__, "--repo", scope["path"], "--epic", scope.get("epic") or registry.MAIN, "merges-refresh"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return m


# ---- the merge queues

def iso_ms(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return int(calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) * 1000)
    except ValueError:
        return None


def engine_state(folder):
    hit = glob.glob(os.path.join(folder, ".audit", "*", "queue", "state.json")) if folder else []
    return hit[0] if hit else None


def loose_state(repo):
    """A queue engine's state anywhere in the repo's worktrees (the newest), for a queue no manager runs."""
    base = os.path.basename(repo["path"].rstrip("/"))
    found = glob.glob(os.path.join(HOME, ".herdr", "worktrees", base, "*", ".audit", "*", "queue", "state.json"))
    found += glob.glob(os.path.join(repo["path"], ".audit", "*", "queue", "state.json"))
    return max(found, key=os.path.getmtime) if found else None


def queues_snapshot(H, scope, managers, inbox):
    """One summary per merge-queue manager of this scope (its epic's queue). Only the main scope
    also shows a queue running with no manager; an epic sees only its own."""
    queues = [m for m in managers if m.get("kind") == "merge-queue" and m.get("status") != "retired"]
    approvals = [i for i in inbox if i.get("state") == "open" and i.get("kind") == "approval"]
    out = []
    for m in queues:
        path = engine_state(m.get("worktree"))
        q = summarise(H, scope, path, approvals, m.get("group") if len(queues) > 1 else None) if path else None
        out.append({**(q or {"missing": True}), "epic": m.get("group"), "manager": m["id"], "terminal": m.get("terminal"),
                    "status": m.get("status"), "trunk": m.get("trunk")})
    if not out and not scope.get("epic"):
        path = loose_state(scope)
        q = summarise(H, scope, path, approvals, None) if path else None
        if q:
            out.append({**q, "epic": None, "manager": None})
    return out


def approval_for(approvals, n, epic):
    """The open approval asking to merge batch `n` (by its title, "Merge batch N: ..."); with
    several queues in one scope, the one that also names this queue's epic."""
    hits = [a for a in approvals if re.search(rf"\bbatch {n}\b", a.get("title") or "", re.I)]
    if epic and len(hits) > 1:  # ambiguous unless the title names the epic too
        hits = [a for a in hits if epic.lower() in (a.get("title") or "").lower()]
    return hits[0]["id"] if hits else None


def summarise(H, scope, path, approvals, epic):
    st = H.claude.read_json(path)
    if not isinstance(st, dict):
        return None
    titles = H.claude.read_json(cache_path(H, scope, "pr-titles.json")) or {}
    seen = st.get("seen") or {}
    closed = set(st.get("closed") or [])
    queued, rejected, held = st.get("queued") or {}, st.get("rejected") or {}, st.get("held") or {}
    owners, after, priority = st.get("owners") or {}, st.get("after") or {}, st.get("priority") or []
    lt = time.localtime()
    midnight = int(time.mktime(lt[:3] + (0, 0, 0) + lt[6:])) * 1000
    want = set()

    def member(m):
        want.add(str(m.get("pr")))
        return {"pr": m.get("pr"), "owner": m.get("owner"), "seen": iso_ms(seen.get(f"{m.get('pr')}:{m.get('sha')}")),
                "parent": m.get("stack_parent")}

    def batch(b):
        out = {"n": b.get("n"), "status": b.get("status"), "trunk": b.get("trunk"), "failing": b.get("failing"),
               "reruns": b.get("reruns", 0), "created": iso_ms(b.get("created")), "ciEnd": iso_ms(b.get("ci_end")),
               "merged": iso_ms(b.get("merged")), "pr": b.get("pr"), "members": [member(m) for m in b.get("members") or []]}
        if out["status"] == "green":
            out["approval"] = approval_for(approvals, out["n"], epic)
        return out

    batches = [b for b in st.get("batches") or [] if isinstance(b, dict)]
    live = [batch(b) for b in batches if b.get("status") in LIVE]
    recent = [batch(b) for b in batches if b.get("status") in ("done", "released")][-RECENT:][::-1]
    # Waiting: READY lines the scanner has seen whose PR is open and not yet queued, rejected or in a live batch.
    in_live = {m["pr"] for b in live for m in b["members"]}
    waiting = {}
    for k, at in seen.items():
        pr_s = k.partition(":")[0]
        if not pr_s.isdigit():
            continue
        pr = int(pr_s)
        if pr in closed or pr in in_live or k in queued or k in rejected:
            continue
        since = iso_ms(at) or 0
        if pr not in waiting or since > waiting[pr]["since"]:
            waiting[pr] = {"pr": pr, "since": since, "owner": owners.get(pr_s), "held": held.get(k),
                           "after": after.get(pr_s), "priority": pr in priority}
    want.update(str(pr) for pr in waiting)
    # Today: batches merged since midnight (the one list the header, the column and its count read).
    landed = [b for b in recent if b["status"] == "done" and (b["merged"] or 0) >= midnight]
    failed = sum(1 for b in batches if (iso_ms(b.get("created")) or 0) >= midnight and (b.get("status") == "released" or b.get("failing")))
    ci = sorted((b["ciEnd"] - b["created"]) / 60000 for b in map(batch, batches[-RECENT:]) if b["ciEnd"] and b["created"])
    waits = sorted((b["merged"] - (m["seen"] or b["created"])) / 60000 for b in landed for m in b["members"] if b["created"])
    median = lambda xs: xs[len(xs) // 2] if xs else None  # noqa: E731
    rej = []
    for k, why in list(rejected.items())[-4:][::-1]:
        pr_s = k.partition(":")[0]
        if pr_s.isdigit():
            want.add(pr_s)
            rej.append({"pr": int(pr_s), "why": H.clip(str(why), 220)})
    return {
        "at": int(os.path.getmtime(path) * 1000), "prBase": H.pull_url(scope),
        "live": live, "recent": recent, "waiting": sorted(waiting.values(), key=lambda w: w["since"]),
        "rules": {"after": after, "apart": [p for p in st.get("apart") or [] if isinstance(p, list) and len(p) == 2]},
        "rejected": rej, "throughput": st.get("throughput"),
        "today": {"landed": landed, "prs": sum(len(b["members"]) for b in landed), "failed": failed,
                  "ciMin": median(ci), "waitMin": median(waits)},
        "titles": {k: titles[k] for k in want if k in titles},
    }
