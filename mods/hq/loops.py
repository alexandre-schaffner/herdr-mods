"""Agent loops: what the master (and any manager given one) does on each tick, as data the
person edits in HQ > Org > Loops instead of prose baked into a prompt.

A loop is data/hq/<org>/loops/<agent>.json: ordered steps (a title, the instruction, a cadence:
every tick, only when something is new, or at most every N minutes), a heartbeat, and for the
master the wake triggers HQ's gate honours (mail.py). `hq tick` hands the agent the steps due
this tick, so an edit applies at its next tick with no respawn, and steps not due cost nothing.

HQ watches the loop live from the agent's transcript (`hq loops`): which tick it's in and what
started it, the steps done so far (a step's `match` pattern against the agent's tool calls, else
Jev picks the step its latest action belongs to), and the recent ticks with what each cost.
"""

import hashlib
import json
import os
import re
import uuid

MANAGER_LOOP = "/loop hq tick for your HQ loop"  # typed key by key: plain characters only
HISTORY = 12

MASTER_STEPS = [
    {"id": "digest", "title": "Read the digest", "locked": True, "when": "every", "match": r"\bhq tick\b",
     "body": "Run `hq tick` and read it whole: this list first, then what changed since your last tick."},
    {"id": "act", "title": "Act on what's new", "when": "news",
     "body": "Unblock what's stuck, answer what waits on you, rebalance work between managers, nudge, compact "
             "(`hq compact <t>`) or respawn a manager whose context has rotted, start the merge queue's next step. "
             "Prefer the smallest action that unblocks."},
    {"id": "status", "title": "Status headline", "when": "news", "match": r"\bhq status\b",
     "body": "`hq status \"<one line>\"`: what the org is doing right now, the way you'd tell the person in passing."},
    {"id": "handoff", "title": "Handoff file", "when": "news", "match": r"handoff\.md",
     "body": "Update the file `hq handoff` names: goal, state, managers and what each is on, open PRs and heads, "
             "decisions, pending questions, next steps. Short and true: you resume from it after a compaction."},
    {"id": "next", "title": "Next moves", "when": "interval", "everyMin": 60, "track": "todo", "match": r"\bhq todo\b",
     "body": "Close what's done, add what's next, follow the person's order and notes (`hq todo`)."},
    {"id": "home", "title": "Home update", "when": "interval", "everyMin": 30, "track": "home", "match": r"\bhq home set\b",
     "body": "Rewrite the person's Home update if anything moved (`hq home set <file>`; see 'Home' in your prompt)."},
    {"id": "map", "title": "Live map", "when": "interval", "everyMin": 45, "track": "lens", "match": r"\bhq lens set\b",
     "body": "Update the live map if the picture changed (`hq lens`)."},
    {"id": "roadmap", "title": "Roadmap", "when": "interval", "everyMin": 120, "track": "roadmap", "match": r"\bhq roadmap set\b",
     "body": "Update the phases that started, finished or got stuck (`hq roadmap`)."},
    {"id": "schedule", "title": "Schedule the heartbeat", "locked": True, "when": "every", "match": r"^ScheduleWakeup\b",
     "body": "ScheduleWakeup for the heartbeat: ≤ 270 s or ≥ 1200 s, never in between (the prompt cache lasts 5 min, so 300-1199 s re-reads your whole context for little). To wait on CI, a merge or a reply, `hq watch add` it rather than shortening the heartbeat."},
]

MANAGER_STEPS = [
    {"id": "digest", "title": "Read the digest", "locked": True, "when": "every", "match": r"\bhq tick\b",
     "body": "Run `hq tick` and read it whole: this list first, then your decisions, open asks and team since your last tick."},
    {"id": "team", "title": "Check on your team", "when": "every",
     "body": "Look at your units and subagents: unblock them, collect what finished, start the next wave when one ends."},
    {"id": "handoff", "title": "Update your handoff", "when": "news", "match": r"report\.md",
     "body": "Keep the `## Handoff` section of your report current: goal, state, open PRs and heads, team in flight, next steps."},
    {"id": "report", "title": "Report to the master", "when": "news", "match": r"\bhq tell\b",
     "body": "Finished a phase, changed plans or blocked? One `hq tell` (add --urgent when you're stopped). Otherwise skip."},
    {"id": "schedule", "title": "Schedule the heartbeat", "locked": True, "when": "every", "match": r"^ScheduleWakeup\b",
     "body": "ScheduleWakeup for the heartbeat: ≤ 270 s or ≥ 1200 s, never in between (the prompt cache lasts 5 min, so 300-1199 s re-reads your whole context for little). To wait on CI, a merge or a reply, `hq watch add` it rather than shortening the heartbeat."},
]

WAKE_DEFAULT = {"mail": True, "steering": True, "gone": True, "waiting": True}


# ---- definitions

def loops_dir(H, repo):
    return os.path.join(H.data_dir(repo), "loops")


def def_path(H, repo, agent):
    return os.path.join(loops_dir(H, repo), f"{agent}.json")


def state_path(H, repo, agent):
    return os.path.join(loops_dir(H, repo), f"{agent}.state.json")


def default(H, repo, agent):
    master = agent == "master"
    s = H.settings(repo)
    return {"agent": agent, "rev": 0, "updatedAt": None, "paused": False,
            "heartbeatSec": int(s["heartbeatSec"] if master else 1800),
            "wake": dict(WAKE_DEFAULT) if master else None,
            "steps": [dict(x, on=True, locked=bool(x.get("locked")), everyMin=x.get("everyMin")) for x in (MASTER_STEPS if master else MANAGER_STEPS)]}


def load(H, repo, agent):
    d = H.claude.read_json(def_path(H, repo, agent))
    if not isinstance(d, dict) or not isinstance(d.get("steps"), list):
        return default(H, repo, agent)
    base = default(H, repo, agent)
    for k, v in base.items():
        d.setdefault(k, v)
    return d


def saved(H, repo, agent):
    return os.path.exists(def_path(H, repo, agent))


def clean_steps(new, old):
    """Validates edited steps, keeps the internal fields (`match`, `track`) the UI doesn't edit,
    and pins the locked steps first and last."""
    keep = {s["id"]: s for s in old}
    out = []
    for raw in new:
        if not isinstance(raw, dict) or not str(raw.get("title") or "").strip():
            raise RuntimeError("every step needs a title")
        slug = lambda x: re.sub(r"[^a-z0-9-]+", "-", str(x or "").lower()).strip("-")  # noqa: E731
        sid = slug(raw.get("id")) or f"{slug(raw['title'])[:24]}-{uuid.uuid4().hex[:4]}"
        prev = keep.get(sid, {})
        when = raw.get("when") if raw.get("when") in ("every", "news", "interval") else "news"
        if prev.get("locked"):
            when = prev.get("when") or "every"  # the digest and the heartbeat run on every tick
        every = raw.get("everyMin")
        if when == "interval":
            try:
                every = max(5, min(24 * 60, int(every or 30)))
            except (TypeError, ValueError):
                raise RuntimeError(f"step '{raw['title']}': everyMin must be minutes") from None
        step = {"id": sid, "title": str(raw["title"]).strip()[:80], "body": str(raw.get("body") or "").strip()[:2000],
                "when": when, "everyMin": every if when == "interval" else None,
                "on": bool(raw.get("on", True)) or bool(prev.get("locked")), "locked": bool(prev.get("locked"))}
        for k in ("match", "track"):
            if prev.get(k):
                step[k] = prev[k]
        out.append(step)
    ids = [s["id"] for s in out]
    if len(set(ids)) != len(ids):
        raise RuntimeError("two steps share an id")
    locked = [s for s in old if s.get("locked")]
    for s in locked:  # a locked step can be edited, never dropped
        if s["id"] not in ids:
            out.append(dict(s))
    first, last = (locked[0]["id"], locked[-1]["id"]) if locked else (None, None)
    mid = [s for s in out if s["id"] not in (first, last)]
    return [s for s in out if s["id"] == first] + mid + [s for s in out if s["id"] == last]


def save(H, repo, agent, new):
    cur = load(H, repo, agent)
    if "rev" in new and int(new.get("rev") or 0) != int(cur.get("rev") or 0):
        raise RuntimeError(f"stale: the loop changed since you loaded it (rev {cur.get('rev')}); reload and edit again")
    d = dict(cur)
    if "steps" in new:
        d["steps"] = clean_steps(new["steps"], cur["steps"])
    if "heartbeatSec" in new:
        d["heartbeatSec"] = max(60, min(3600, int(new["heartbeatSec"])))  # ScheduleWakeup's own bounds
    if "paused" in new:
        d["paused"] = bool(new["paused"])
    if agent == "master" and isinstance(new.get("wake"), dict):
        d["wake"] = {k: bool(new["wake"].get(k, v)) for k, v in WAKE_DEFAULT.items()}
    d["rev"] = int(cur.get("rev") or 0) + 1
    d["updatedAt"] = H.NOW()
    H.write_json(def_path(H, repo, agent), d)
    return d


def wake_flags(H, repo):
    return load(H, repo, "master").get("wake") or dict(WAKE_DEFAULT)


# ---- the tick: which steps are due, as the agent's list for this tick

def track_at(H, repo, track):
    """When the page a built-in step keeps was last written."""
    if track == "home":
        return H.home_meta(repo).get("at")
    if track == "lens":
        return H.lens_meta(repo).get("at")
    if track == "todo":
        return H.todo_load(repo).get("updatedAt")
    if track == "roadmap":
        return max((p.get("at") or 0 for p in H.rmap.plans(H, repo).values()), default=0) or None
    return None


def due_steps(H, repo, d, news, st):
    """The steps due this tick: on ones whose cadence says so. An interval step is due once its
    minutes have passed since it was last done and something moved since (news now, or the
    person's or an agent's activity)."""
    now = H.NOW()
    due = []
    for s in d["steps"]:
        if not s.get("on") or s["id"] == "digest":
            continue
        if s["when"] == "every" or (s["when"] == "news" and news):
            due.append(s)
        elif s["when"] == "interval":
            last = track_at(H, repo, s.get("track")) if s.get("track") else (st.get("listed") or {}).get(s["id"])
            if not last:
                due.append(s)
            elif now - last >= (s.get("everyMin") or 30) * 60_000 and (
                    news or any(r.get("by") != "hq" for r in H.activity_since(repo, last))):
                due.append(s)
    return due


def tick_lines(H, repo, agent, news, consume):
    """The loop part of an agent's `hq tick`: its due steps, numbered, the heartbeat filled in.
    `consume` records them as this tick's (HQ's live view checks them off)."""
    d = load(H, repo, agent)
    st = H.claude.read_json(state_path(H, repo, agent)) or {}
    if d.get("paused"):
        return ["Your loop is paused in HQ: call ScheduleWakeup with stop: true and end the turn. The person resumes it from HQ."]
    due = due_steps(H, repo, d, news, st)
    # Not "Your loop this tick…" any more: masters trimmed the tick with `sed -n '1,/^Your loop this
    # tick/p'`, which now (loop first) would cut everything after this line.
    lines = ["Due this tick, your loop (the person edits it in HQ > Org > Loops; do the steps in order, skip one that has nothing to do; read this whole output, untrimmed):"]
    for i, s in enumerate(due, 1):
        body = s.get("body") or ""
        if s["id"] == "schedule":
            rest = re.sub(r"^ScheduleWakeup for the heartbeat[.;,]?\s*", "", body)
            body = f"ScheduleWakeup {d['heartbeatSec']}s." + (f" {rest[:1].upper()}{rest[1:]}" if rest else "")
            # Saved loops keep their own wording, so this rule rides on every heartbeat line: a turn
            # that ends on this call can't say anything after it, and thinking isn't shown.
            body += " Answering the person this turn? Write the answer as text before this call; your thinking isn't shown."
        lines.append(f"{i}. {s['title']}: {body}")
    if consume:
        listed = st.get("listed") or {}
        for s in due:
            listed[s["id"]] = H.NOW()
        st.update({"listed": listed, "tick": {"at": H.NOW(), "due": [s["id"] for s in due], "news": bool(news)}})
        H.write_json(state_path(H, repo, agent), st)
    return lines


def manager_tick(H, repo, mid):
    """`hq tick` from a manager: its loop, then its own digest (decisions on its asks, what still
    waits on the person, its team)."""
    H.ensure(repo)
    m = H.find_manager(repo, mid)[1]
    st = H.claude.read_json(state_path(H, repo, mid)) or {}
    since = (st.get("tick") or {}).get("at") or 0
    news = []
    for it in H.inbox_items(repo, include_closed=True):
        if (it.get("from") or {}).get("role") != mid:
            continue
        d = it.get("decision") or {}
        if (d.get("at") or 0) > since and not d.get("silent"):
            news.append(f"- Decision: {H.decision_text(it)}")
        elif it.get("state") == "open" and it["kind"] in ("approval", "question"):
            news.append(f"- Still waiting on the person: [{it['id']}] {H.clip(it['title'], 70)}")
    try:
        if since and os.path.getmtime(H.STYLE) * 1000 > since:
            news.append(f"- Communication style changed: re-read {H.STYLE} and follow it from now on.")
    except OSError:
        pass
    for u in H.unit_terminals(repo, m, None):
        if u.get("status") in ("blocked", "idle", "done"):
            news.append(f"- Unit {u['terminal']} ({H.clip(u.get('description'), 60)}) is {u.get('status')}.")
    me = H.who_am_i(repo)
    # The loop's steps first, so a trimmed read (head, sed) keeps them; the news follows.
    lines = [f"HQ tick for {mid} {H.time.strftime('%Y-%m-%d %H:%M')} (last {int((H.NOW() - since) / 60000) if since else '—'} min ago)",
             *tick_lines(H, repo, mid, bool(news), consume=me.get("role") == mid), *(["What changed:"] if news else []), *news,
             *H.guarded(H.watches.tick_lines, [], H, repo, mid)]
    if not news:
        lines.append("Nothing new from HQ. Check your team, then schedule the heartbeat.")
    print("\n".join(lines))


# ---- live: the agent's ticks, read from its transcript

def turn_starter(e):
    """(trigger, text) when this transcript entry starts a turn, else None."""
    if e.get("type") != "user" or e.get("isSidechain"):
        return None
    c = (e.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return None
    text = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
    text = (text or "").strip()
    if not text:
        return None
    if "<command-name>/loop</command-name>" in text:
        return "heartbeat", None
    if e.get("isMeta"):
        # Claude Code's own notes: the /loop skill's text, "[3 prior /loop wakeups found nothing
        # actionable; …]" beside a wakeup, and the like. Only a prompt of its own is a scheduled job.
        # A skill's text, loaded by the Skill tool ("Base directory for this skill: …"), is no job either.
        if text.startswith(("# /", "[", "<", "Caveat:", "Base directory for this skill")):
            return None
        return ("scheduled", text[:2000]) if not text.startswith("Another Claude session") else ("background", None)
    if text.startswith("HQ TICK"):
        return "hq", H_clip(text[len("HQ TICK:"):].strip())
    if text.startswith(("HQ LOOP", "HQ DECISION", "HQ WORKFLOW", "HQ WATCH", "HQ ESCALATION", "HQ:", "FYI ")):
        return "hq-message", H_clip(text)
    if text.startswith(("<task-notification", "<agent-message")):
        return "background", None
    if "<hc" in text[:80]:
        return "agent", H_clip(re.sub(r"<[^>]+>", " ", text))
    if text.startswith("<"):
        return None
    return "person", H_clip(text)


def H_clip(s, n=160):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def action_line(b):
    """One line for a tool call, as step patterns see it."""
    name, inp = b.get("name"), b.get("input") or {}
    if name == "Bash":
        return "Bash " + (inp.get("command") or "")
    if name in ("Write", "Edit", "Read", "NotebookEdit"):
        return f"{name} {inp.get('file_path') or ''}"
    return name or "tool"


def ticks_of(H, path, size):
    """The transcript's turns, oldest first: {startedAt, endedAt, trigger, triggerText, actions,
    lastText, calls, newTokens, cachedTokens}. A turn runs until the next one starts."""
    turns, cur = [], None
    for e in H.tail_lines(path, size) if path else []:
        if e.get("isSidechain"):
            continue
        start = turn_starter(e)
        if start and start[0] != "background":
            cur = {"startedAt": H.ts(e), "endedAt": None, "trigger": start[0], "triggerText": start[1],
                   "actions": [], "lastText": None, "calls": 0, "newTokens": 0, "cachedTokens": 0}
            turns.append(cur)
            continue
        if cur is None or e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        u = msg.get("usage") or {}
        if u:
            cur["calls"] += 1
            cur["newTokens"] += (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("output_tokens") or 0)
            cur["cachedTokens"] += u.get("cache_read_input_tokens") or 0
        cur["endedAt"] = H.ts(e)
        for b in msg.get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                cur["actions"].append(action_line(b))
            elif b.get("type") == "text" and b.get("text", "").strip():
                cur["lastText"] = b["text"].strip()
    return turns


def other_schedules(turns):
    """Recurring jobs (CronCreate, scheduled tasks) that tick this agent beside its loop: each
    one is a second loop spending turns. One row per job: its prompt, how often it fired, last."""
    jobs = {}
    for t in turns:
        if t["trigger"] == "scheduled" and t.get("triggerText"):
            key = t["triggerText"][:60]
            j = jobs.setdefault(key, {"key": hashlib.sha1(key.encode()).hexdigest()[:10], "text": H_clip(t["triggerText"], 200),
                                      "prompt": t["triggerText"], "count": 0,
                                      "lastAt": None, "newTokens": 0})
            j["count"] += 1
            j["lastAt"] = t["startedAt"]
            j["newTokens"] += t["newTokens"]
    return sorted(jobs.values(), key=lambda j: j["lastAt"] or 0, reverse=True)


def matched(steps, actions):
    """The ids of steps whose pattern one of these actions hits, in the order they were hit."""
    done = []
    for a in actions:
        bare = a[5:] if a.startswith("Bash ") else a
        for s in steps:
            pat = s.get("match")
            if pat and s["id"] not in done and (re.search(pat, bare) or re.search(pat, a)):
                done.append(s["id"])
    return done


def jev_step(H, d, turn, due_ids, cache):
    """Jev: which due step the agent's latest actions belong to. Cached per latest action."""
    opts = {s["id"]: f"{s['title']}: {s.get('body') or ''}"[:300] for s in d["steps"] if s["id"] in due_ids}
    if not opts or not turn["actions"]:
        return None
    key = hashlib.sha1(json.dumps([turn["actions"][-3:], sorted(opts)]).encode()).hexdigest()[:16]
    if key in cache:
        return cache[key]
    opts["other"] = "None of these: something else (answering someone, background work, housekeeping)."
    got = H.mbox.jev({"recent_actions": turn["actions"][-3:], "last_words": (turn.get("lastText") or "")[-600:]},
                     {"step": {"type": "choice",
                               "instructions": "An agent is working through a checklist on its periodic tick. Which "
                                               "checklist step are its `recent_actions` (latest last) part of?",
                               "criteria": opts}})
    a = (got or {}).get("step") or {}
    pick = a.get("choice") if (a.get("confidence") or 0) >= 0.4 and a.get("choice") != "other" else None
    if got is not None:
        cache[key] = pick
    return pick


def live_of(H, repo, agent, d, rec, path, size, watchers=()):
    """The live view of one agent's loop: state, the current or last tick checked off, history."""
    st = H.claude.read_json(state_path(H, repo, agent)) or {}
    loop = H.loop_state((rec.get("facts") or {}).get("loop"), rec.get("status")) if rec.get("terminal") else {"state": "gone"}
    state = "paused" if d.get("paused") and loop["state"] not in ("gone",) else loop["state"]
    turns = ticks_of(H, path, size) if loop["state"] not in ("unarmed", "gone") or agent == "master" else []
    watchers = watchers if loop["state"] != "gone" else []
    if state in ("unarmed", "stopped") and watchers:
        state = "watching"  # no HQ loop, but a watch (hq watch, or its own) wakes it: not off
    ticks = [t for t in turns if t["trigger"] in ("heartbeat", "hq", "scheduled")]
    in_tick = bool(ticks) and turns[-1] is ticks[-1]
    if state == "running" and not in_tick and loop.get("wakeAt"):
        # Busy, but with something else (the person, a message): between ticks, not mid-tick.
        state = "overdue" if H.NOW() > loop["wakeAt"] + H.LOOP_GRACE_MS else "waiting"
    due_now = [s["id"] for s in due_steps(H, repo, d, True, st)]
    live = {"state": state, "wakeAt": loop.get("wakeAt"), "reason": loop.get("reason"), "tick": None, "due": due_now,
            "busy": rec.get("status") in ("working", "blocked") and not in_tick,  # working, but not on a tick
            "others": other_schedules(turns), "watchers": list(watchers)}
    if ticks:
        t = ticks[-1]
        running = in_tick and rec.get("status") in ("working", "blocked")
        listed = st.get("tick") or {}
        due_ids = listed.get("due") if (listed.get("at") or 0) >= (t["startedAt"] or 0) else None
        done = matched(d["steps"], t["actions"])
        current, by = None, None
        if running:
            last = matched(d["steps"], t["actions"][-1:])
            if last:
                current, by = last[0], "signature"
            elif H.settings(repo)["jev"]:
                cache = st.setdefault("jev", {})
                current = jev_step(H, d, t, due_ids or [s["id"] for s in d["steps"]], cache)
                by = "jev" if current else None
                st["jev"] = dict(list(cache.items())[-100:])
                H.write_json(state_path(H, repo, agent), st)
        # A step without a pattern (e.g. "Act on what's new") can't be seen directly: once the tick
        # is over, it counts as done when the tick did anything no pattern explains.
        unexplained = any(not matched(d["steps"], [a]) for a in t["actions"])
        steps = {}
        for s in d["steps"]:
            sid = s["id"]
            if sid == current:
                steps[sid] = "current"
            elif sid in done:
                steps[sid] = "done"
            elif not s.get("on") or (due_ids is not None and sid not in due_ids and sid != "digest"):
                steps[sid] = "skipped"
            elif running:
                steps[sid] = "pending"
            else:
                steps[sid] = "done" if not s.get("match") and unexplained else "skipped"
        live["tick"] = {"startedAt": t["startedAt"], "endedAt": None if running else t["endedAt"], "trigger": t["trigger"],
                        "triggerText": H_clip(t["triggerText"]), "steps": steps, "current": current, "currentBy": by,
                        "lastAction": H_clip(t["actions"][-1], 120) if t["actions"] else None}
    history = []
    for t in reversed(ticks[-HISTORY:]):
        ids = matched(d["steps"], t["actions"])
        quiet = bool(re.search(r"Nothing new", t.get("lastText") or "")) or (len(t["actions"]) <= 3 and not set(ids) - {"digest", "schedule"})
        history.append({"startedAt": t["startedAt"], "endedAt": t["endedAt"], "trigger": t["trigger"], "triggerText": H_clip(t["triggerText"]),
                        "quiet": quiet, "calls": t["calls"], "newTokens": t["newTokens"], "cachedTokens": t["cachedTokens"], "steps": ids})
    return live, history


def snapshot(H, repo):
    """`hq loops`: every agent's loop, definition and live view. Light on purpose (HQ polls it
    while the Loops tab shows): one `hc ls`, small transcript tails for managers."""
    ls = {t["address"]: t for t in H.hc_ls()}
    watching = H.watches.by_agent(H, repo, set(ls))
    agents = []
    master = H.master_record(repo, facts=True)
    d = load(H, repo, "master")
    looper = master.get("runner") or master  # the runner's session carries the loop when one runs
    live, hist = live_of(H, repo, "master", d, {**master, "terminal": looper.get("terminal"), "status": looper.get("status"), "facts": master.get("loopFacts") or {}},
                         (master.get("loopFacts") or {}).get("transcript"), 3_000_000, watching.get("master", []))
    agents.append({"agent": "master", "label": "Master (loop runner)" if master.get("runner") else "Master", "kind": "master",
                   "terminal": looper.get("terminal"), "status": looper.get("status") or "gone", "loop": d, "live": live, "history": hist})
    for m in H.org(repo)["managers"]:
        if m.get("status") == "retired":
            continue
        t = ls.get(m.get("terminal"))
        status = (t.get("status") or t.get("state")) if t else "gone"
        status = status.get("state") if isinstance(status, dict) else status
        sid = m.get("sessionId")
        facts = H.session_facts(sid, (t or {}).get("cwd"), tail=600_000) if sid and t else {}
        rec = {"terminal": m.get("terminal") if t else None, "status": status, "facts": facts}
        d = load(H, repo, m["id"])
        live, hist = live_of(H, repo, m["id"], d, rec, facts.get("transcript"), 1_500_000, watching.get(m["id"], []))
        agents.append({"agent": m["id"], "label": m.get("name") or m["id"], "kind": m.get("kind") or "area",
                       "terminal": rec["terminal"], "status": status, "loop": d, "live": live, "history": hist})
    return {"now": H.NOW(), "agents": agents, "jev": bool(os.environ.get("TYPESAFE_API_KEY")) and H.settings(repo)["jev"]}


# ---- controls

def terminal_of(H, repo, agent):
    if agent == "master":
        # The master's loop runs in its loop runner when one runs (runner.py).
        rt = H.runner.terminal(H, repo)
        if rt:
            return rt["address"], H.status_of(rt)
        mt, _ = H.master_terminal(repo)
        return (mt or {}).get("address"), H.status_of(mt) if mt else None
    m = H.find_manager(repo, agent)[1]
    t = H.hc_get(m["terminal"]) if m.get("terminal") else None
    return (m.get("terminal") if t else None), H.status_of(t) if t else None


ACTION_GAP_MS = 90_000  # a second arm or run within this is a double press, not a new intent


def claim(H, repo, agent, op):
    """One arm or run per agent at a time: refuses a repeat of `op` (or the other) while the
    last one is younger than ACTION_GAP_MS, so a double press can't start two loops. A file lock
    serialises two HQ windows pressing at once."""
    path = state_path(H, repo, agent) + ".lock"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        H.fcntl.flock(f, H.fcntl.LOCK_EX)
        st = H.claude.read_json(state_path(H, repo, agent)) or {}
        last = st.get("action") or {}
        if H.NOW() - (last.get("at") or 0) < ACTION_GAP_MS:
            H.fail(f"{agent}: a {last.get('op')} was just sent {int((H.NOW() - last['at']) / 1000)} s ago; wait for it to land")
        st["action"] = {"op": op, "at": H.NOW()}
        H.write_json(state_path(H, repo, agent), st)


def live_loop(H, repo, agent):
    """The agent's loop as its transcript shows it: unarmed | stopped | running | waiting | overdue | gone."""
    if agent == "master":
        return H.master_record(repo, facts=True)["loop"]["state"]
    m = H.find_manager(repo, agent)[1]
    t = H.hc_get(m["terminal"]) if m.get("terminal") else None
    if not t:
        return "gone"
    sess = H.session_of_terminal(t)
    sid = (sess or {}).get("sessionId") or m.get("sessionId")
    facts = H.session_facts(sid, t.get("cwd"), tail=600_000) if sid else {}
    return H.loop_state(facts.get("loop"), H.status_of(t))["state"]


def arm(H, repo, agent, resume=False):
    """Starts the loop, unless one already runs: then a resume only clears the pause (the running
    loop picks it up at its next tick) and an arm says so. Never types /loop twice."""
    addr, st = terminal_of(H, repo, agent)
    if not addr:
        H.fail(f"{agent} isn't running")
    d = load(H, repo, agent)
    state = live_loop(H, repo, agent)
    if state in ("waiting", "running"):
        if d.get("paused"):
            save(H, repo, agent, {"paused": False})
            H.log_activity(repo, "loop", f"Resumed {agent}'s loop (it was still running)", by="person")
            return {"ok": True, "typed": False, "why": "its loop was still running: unpaused, it carries on at its next tick"}
        if resume:
            return {"ok": True, "typed": False, "why": "its loop is already running"}
        H.fail(f"{agent}'s loop is already running ({state}); use Run now for a tick")
    if st not in ("idle", "done"):
        H.fail(f"{agent} is {st}: start its loop once it's idle")
    claim(H, repo, agent, "arm")
    if d.get("paused") or not saved(H, repo, agent):
        save(H, repo, agent, {"paused": False})
    ok, err = H.type_text(addr, H.LOOP_PROMPT if agent == "master" else MANAGER_LOOP)
    if not ok:
        H.fail(err)
    H.log_activity(repo, "loop", f"Started {agent}'s loop", by="person")
    return {"ok": True, "typed": True}


def send(H, repo, agent, text, what):
    addr, st = terminal_of(H, repo, agent)
    if not addr:
        return {"ok": True, "sent": False, "why": f"{agent} isn't running"}
    if st not in ("idle", "done"):
        return {"ok": True, "sent": False, "why": f"{agent} is {st}: it {what} at its next tick"}
    code, so, se = H.hc(["send", addr, text], repo, timeout=25)  # status checked above; `--if idle` refuses `done`
    return {"ok": True, "sent": code == 0, "why": None if code == 0 else (se or so).strip()[-200:]}


def cmd(H, repo, args):
    if not args:
        return H.out(snapshot(H, repo))
    op, rest = args[0], args[1:]
    agent = rest[0] if rest else "master"
    if agent != "master":
        H.find_manager(repo, agent)  # fails on an unknown id
    if op == "show":
        d = load(H, repo, agent)
        print(f"{agent}'s loop: heartbeat {d['heartbeatSec']}s{' (paused)' if d.get('paused') else ''}")
        for i, s in enumerate(d["steps"], 1):
            cad = {"every": "every tick", "news": "when something is new"}.get(s["when"], f"every {s.get('everyMin')} min")
            print(f"{i}. {s['title']} [{cad}{'' if s.get('on') else ', off'}]: {s.get('body')}")
        return
    if op == "save":
        raw = rest[rest.index("--json") + 1] if "--json" in rest else H.read(rest[1], "")
        try:
            new = json.loads(raw or "")
        except ValueError:
            H.fail("loop save: --json must be a loop definition")
        return H.out({"ok": True, "loop": save(H, repo, agent, new)})
    if op == "reset":
        cur = load(H, repo, agent)
        d = default(H, repo, agent)
        d.update(rev=int(cur.get("rev") or 0) + 1, updatedAt=H.NOW(), paused=cur.get("paused", False))
        H.write_json(def_path(H, repo, agent), d)
        return H.out({"ok": True, "loop": d})
    if op in ("arm", "resume"):
        return H.out(arm(H, repo, agent, resume=op == "resume"))
    if op == "pause":
        save(H, repo, agent, {"paused": True})
        H.log_activity(repo, "loop", f"Paused {agent}'s loop", by="person")
        return H.out(send(H, repo, agent, "HQ LOOP: the person paused your loop in HQ. Call ScheduleWakeup with stop: true and end the turn.", "stops"))
    if op == "run":
        if live_loop(H, repo, agent) == "running":
            H.fail(f"{agent} is mid-tick already")
        claim(H, repo, agent, "run")
        r = send(H, repo, agent, "HQ TICK: the person asked for a tick now. Run `hq tick`.", "runs")
        if not r["sent"]:
            H.fail(r["why"])
        H.log_activity(repo, "loop", f"Ran a tick of {agent}'s loop now", by="person")
        return H.out(r)
    if op == "unwatch":
        # The person stops one of HQ's watches from Loops; the agent hears so it stops waiting on it.
        w = H.watches.cancel(H, rest[1] if len(rest) > 1 else H.fail("hq loop unwatch <agent> <watch id>"))
        H.log_activity(repo, "watch", f"Stopped {agent}'s watch: {w['label']}", by="person")
        sent = send(H, repo, agent, f"HQ WATCH [{w['id']}]: the person stopped your watch '{w['label']}' in HQ. "
                                    "Don't start it again unless they ask; end the turn if nothing else waits.", "hears of it")
        return H.out({"ok": True, **{k: v for k, v in sent.items() if k != "ok"}})
    if op == "absorb":
        # A cron beside the loop becomes a loop step; the agent is asked to delete the cron.
        key = rest[1] if len(rest) > 1 else None
        every = int(rest[rest.index("--every") + 1]) if "--every" in rest else 60
        d = load(H, repo, agent)
        if agent == "master":
            path = (H.master_record(repo, facts=True).get("loopFacts") or {}).get("transcript")
        else:
            m = H.find_manager(repo, agent)[1]
            path = H.claude.find_transcript(m["sessionId"]) if m.get("sessionId") else None
        job = next((j for j in other_schedules(ticks_of(H, path, 3_000_000)) if j["key"] == key), None)
        if not job:
            H.fail(f"no recurring job {key} on {agent}")
        title = H_clip(re.sub(r"\s*\(.*", "", job["text"]), 60) or "Recurring check"
        steps = d["steps"][:-1] + [{"title": title, "body": job["prompt"], "when": "interval", "everyMin": every}] + d["steps"][-1:]
        new = save(H, repo, agent, {"rev": d["rev"], "steps": steps})
        sent = send(H, repo, agent, f"HQ LOOP: the person folded your recurring job '{title}' into your loop (a step every "
                                    f"{every} min). Run CronList, CronDelete that job (and any other job that repeats your tick), "
                                    f"then end the turn: your loop covers it now.", "deletes it")
        H.log_activity(repo, "loop", f"Folded '{title}' into {agent}'s loop", by="person")
        return H.out({"ok": True, "loop": new, **{k: v for k, v in sent.items() if k != "ok"}})
    H.fail("hq loop [show|save|reset|arm|pause|resume|run|absorb|unwatch] <agent>")
