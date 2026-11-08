"""Workflow runs: where they are, their agents, liveness and owner, and the list/run views."""

import glob
import json
import os
import re
import time

import claude
from claude import read_json
from jsonl import head_lines, one_line, parse_line, tail_lines, ts_ms
from outputs import outputs
from repos import repo_of


# Transcripts of every account (the accounts' projects/ link to ~/.claude/projects).
ROOT = claude.PROJECTS


# Liveness is judged on evidence, not on how recently a file changed: an agent writes
# nothing while a tool runs (a 10 min cargo build), so silence alone means nothing.
# QUIET_S: with the owning session alive and no tool call pending, the model itself is
# working. One turn, even a long extended-thinking answer with API retries, stays well
# under 20 minutes, so silence past that with nothing pending means the run is stuck.
QUIET_S = 20 * 60


# A tool call that has been pending this long is taken as abandoned (Bash caps at 10 min;
# background waits re-poll), so a transcript cut off mid-call can't look live forever.
PENDING_MAX_S = 3 * 3600


# A record is from an earlier attempt when the run dir changed this long after it.
RESUMED_SLACK_S = 5


def run_dirs():
    out = {}
    for d in glob.glob(os.path.join(ROOT, "*", "*", "subagents", "workflows", "wf_*")):
        out[os.path.basename(d)] = d
    return out


def session_of(run_dir):
    return run_dir.split(os.sep + "subagents" + os.sep)[0]


def newest_mtime(run_dir):
    best = 0
    for e in os.scandir(run_dir):
        try:
            best = max(best, e.stat().st_mtime)
        except OSError:
            pass
    return best


def script_path(session, run_id):
    hits = glob.glob(os.path.join(session, "workflows", "scripts", "*-" + run_id + ".js"))
    return hits[0] if hits else None


def script_for(session, run_id):
    path = script_path(session, run_id)
    if not path:
        return None
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None

# Sessions folders to read instead of every account's (collect.py --sessions, for tests).
SESSION_DIRS = None


def session_procs():
    """sessionId → its session file, with `alive` and `configDir` (claude.sessions)."""
    return claude.sessions(SESSION_DIRS)


def master_sessions():
    return {m.get("sessionId") for m in claude.masters().values() if isinstance(m, dict)}


def session_id_of(run_dir):
    return os.path.basename(session_of(run_dir))


def journal_of(run_dir):
    """The run's journal: agents with a result, and killed attempts a later agent restarted."""
    results, starts = set(), {}
    try:
        with open(os.path.join(run_dir, "journal.jsonl"), "rb") as f:
            for raw in f:
                d = parse_line(raw)
                if not isinstance(d, dict) or not d.get("agentId"):
                    continue
                if d.get("type") == "started":
                    starts.setdefault(d.get("key"), []).append(d["agentId"])
                elif d.get("type") == "result":
                    results.add(d["agentId"])
    except OSError:
        pass
    superseded = {i for ids in starts.values() for i in ids[:-1] if i not in results}
    return {"results": results, "superseded": superseded}


def pending_tool(tail):
    """The tool call the agent's last assistant message is waiting on: {name, description, since}."""
    calls, last_msg = {}, None
    for line in tail:
        kind, msg = line.get("type"), line.get("message")
        if kind not in ("assistant", "user") or not isinstance(msg, dict) or not isinstance(msg.get("content"), list):
            continue
        if kind == "assistant":
            last_msg = msg.get("id") or last_msg
        for b in msg["content"]:
            if not isinstance(b, dict):
                continue
            if kind == "assistant" and b.get("type") == "tool_use" and b.get("name") != "StructuredOutput":
                calls[b.get("id")] = (msg.get("id"), b, ts_ms(line.get("timestamp")))
            elif kind == "user" and b.get("type") == "tool_result":
                calls.pop(b.get("tool_use_id"), None)
    open_calls = [(b, ts) for mid, b, ts in calls.values() if mid == last_msg]
    if not open_calls:
        return None
    b, ts = open_calls[-1]
    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    desc = inp.get("description") if isinstance(inp.get("description"), str) else None
    return {"tool": b.get("name"), "description": one_line(desc, 140) if desc else None,
            "summary": tool_summary(b.get("name"), inp), "since": ts, "count": len(open_calls)}


def fmt_s(seconds):
    s = int(max(0, seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    return f"{s // 3600}h {(s % 3600) // 60:02d}m"


def liveness(run_dir, agents, mtime):
    """Whether a run without a current record still runs, and why: {status, reason, text, ...}.
    The run belongs to the session in its path; it can only run while a process holds that
    session. Then it runs while an agent waits on a tool call, or while something changed
    in the last QUIET_S."""
    now = time.time()
    sid = session_id_of(run_dir)
    proc = session_procs().get(sid)
    who = (proc or {}).get("name") or sid[:8]
    out = {"sessionId": sid, "pid": (proc or {}).get("pid"), "sessionName": (proc or {}).get("name"),
           "sessionAlive": bool(proc and proc["alive"]), "quietMs": int((now - mtime) * 1000), "waiting": []}
    if not out["sessionAlive"]:
        out.update(status="stalled", reason="gone",
                   text=(f"Session gone: {who} (pid {proc['pid']}) has exited" if proc
                         else f"Session gone: no Claude Code process holds session {sid[:8]}")
                   + f"; last change {fmt_s(now - mtime)} ago")
        return out
    waiting = [dict(a["waiting"], agentId=a["agentId"], label=a["label"]) for a in agents if a.get("waiting")]
    out["waiting"] = waiting
    if waiting:
        w = min(waiting, key=lambda x: x.get("since") or 0)
        more = f" (+{len(waiting) - 1} more)" if len(waiting) > 1 else ""
        age = fmt_s(now - w["since"] / 1000) if w.get("since") else "a while"
        out.update(status="running", reason="waiting",
                   text=f"{w['label']} waiting on {w['tool']} for {age}: {w.get('description') or w.get('summary') or ''}".rstrip(": ") + more)
    elif now - mtime < QUIET_S:
        out.update(status="running", reason="active", text=f"Active {fmt_s(now - mtime)} ago in session {who}")
    else:
        out.update(status="stalled", reason="quiet",
                   text=f"Quiet for {fmt_s(now - mtime)}: session {who} is alive but no agent has a tool call pending")
    return out


STR = r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)"""


def meta_from_script(script):
    if not script:
        return {}
    m = re.search(r"export\s+const\s+meta\s*=\s*\{", script)
    if not m:
        return {}
    body = script[m.end():m.end() + 6000]
    out = {}
    for key in ("name", "description"):
        hit = re.search(r"""["']?\b""" + key + r"""["']?\s*:\s*""" + STR, body)
        if hit:
            out[key] = next(g for g in hit.groups() if g is not None)
    ph = re.search(r"""["']?\bphases["']?\s*:\s*\[(.*?)\]\s*,?\s*\}?""", body, re.S)
    if ph:
        out["phases"] = [next(g for g in t.groups() if g is not None)
                         for t in re.finditer(r"""["']?\btitle["']?\s*:\s*""" + STR, ph.group(1))]
    return out


def session_cwd(run_dir):
    """Where the session that started a run was working (its own transcript's cwd)."""
    for line in head_lines(session_of(run_dir) + ".jsonl", 64 * 1024):
        if line.get("cwd"):
            return line["cwd"]
    return None


def cwd_of(run_dir):
    for p in sorted(glob.glob(os.path.join(run_dir, "agent-*.jsonl")))[:3]:
        for line in head_lines(p, 32 * 1024):
            if line.get("cwd"):
                return line["cwd"]
    return None


# ---- one agent, live -------------------------------------------------------

def tool_summary(name, inp):
    if not isinstance(inp, dict):
        return ""
    for key in ("command", "description", "file_path", "pattern", "path", "url", "query", "prompt", "skill"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            return one_line(v, 140)
    return one_line(json.dumps(inp), 140)


def live_agent(path, meta, session_alive, journal):
    """One agent of a run without a current record. States: done (a result or a final
    answer), killed (an attempt a resume restarted), progress (waiting on a tool, or active
    within QUIET_S), stalled (its session is gone, or quiet past QUIET_S)."""
    tail = tail_lines(path, 96 * 1024)
    head = head_lines(path, 16 * 1024)
    started = next((ts_ms(l.get("timestamp")) for l in head if l.get("timestamp")), None)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    last_tool = None
    finished = False
    tokens = None
    last_ts = next((ts_ms(l.get("timestamp")) for l in reversed(tail) if l.get("timestamp")), None)
    for line in tail:
        msg = line.get("message")
        if line.get("type") != "assistant" or not isinstance(msg, dict):
            continue
        u = msg.get("usage") or {}
        if u:
            tokens = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens",
                                                       "cache_creation_input_tokens", "output_tokens"))
        for block in msg.get("content") or []:
            if block.get("type") == "tool_use":
                last_tool = (block.get("name"), tool_summary(block.get("name"), block.get("input")))
                if block.get("name") == "StructuredOutput":
                    finished = True
        if msg.get("stop_reason") == "end_turn":
            finished = True
    agent_id = os.path.basename(path)[len("agent-"):-len(".jsonl")]
    now = time.time()
    waiting = None
    if agent_id in journal["results"] or finished:
        state = "done"
    elif agent_id in journal["superseded"]:
        state = "killed"
    elif not session_alive:
        state = "stalled"
    else:
        waiting = pending_tool(tail)
        if waiting and waiting.get("since") and now - waiting["since"] / 1000 > PENDING_MAX_S:
            waiting = None
        if waiting:
            state = "progress"
            last_tool = (waiting["tool"], waiting.get("description") or waiting["summary"])
        else:
            state = "progress" if now - mtime < QUIET_S else "stalled"
    return {
        "agentId": agent_id,
        "waiting": waiting,
        "label": meta.get("description") or "agent",
        "phaseTitle": meta.get("workflowPhase"),
        "model": meta.get("model"),
        "agentType": meta.get("agentType"),
        "state": state,
        "startedAt": started,
        "lastProgressAt": last_ts or int(mtime * 1000),
        "durationMs": ((last_ts or int(mtime * 1000)) - started) if started and state == "done" else None,
        "lastToolName": last_tool[0] if last_tool else None,
        "lastToolSummary": last_tool[1] if last_tool else None,
        "tokens": tokens,
    }


# ---- runs ------------------------------------------------------------------

def current_record(run_id, run_dir):
    """(record, resumed). A resume reuses the run id and dir and leaves the earlier attempt's
    record (`status: killed`) in place until it ends; anything in the run dir written after
    the record means the record describes an earlier attempt."""
    path = os.path.join(session_of(run_dir), "workflows", run_id + ".json")
    doc = read_json(path)
    if not doc:
        return None, False
    try:
        written = os.path.getmtime(path)
    except OSError:
        return doc, False
    return doc, newest_mtime(run_dir) > written + RESUMED_SLACK_S


def live_agents(run_dir, session_alive):
    journal = journal_of(run_dir)
    out = []
    for m in glob.glob(os.path.join(run_dir, "agent-*.meta.json")):
        out.append(live_agent(m[: -len(".meta.json")] + ".jsonl", read_json(m) or {}, session_alive, journal))
    return out


def owner_of(run_dir):
    """The session that owns a run (every run has one: the session whose Workflow call
    started it): its id and name, whether it still runs, and whether it is a master chat."""
    sid = session_id_of(run_dir)
    proc = session_procs().get(sid) or {}
    return {"sessionId": sid, "name": proc.get("name"), "pid": proc.get("pid"), "alive": bool(proc.get("alive")),
            "master": sid in master_sessions()}


def record_error(doc):
    """The record's error as its message, without the runtime's stack frames. Stopping a run
    records `Workflow aborted`, which `status: killed` already says."""
    lines = [l for l in str(doc.get("error") or "").splitlines() if not l.strip().startswith("at ")]
    msg = "\n".join(lines).strip()
    msg = msg[len("Error: "):] if msg.startswith("Error: ") else msg
    if not msg or (doc.get("status") == "killed" and msg == "Workflow aborted"):
        return None
    return msg


def resume_fields(run_id, run_dir, doc):
    session = session_of(run_dir)
    return {"sessionId": session_id_of(run_dir), "owner": owner_of(run_dir),
            "scriptPath": (doc or {}).get("scriptPath") or script_path(session, run_id)}


def summarize(run_id, run_dir, with_agents=False):
    session = session_of(run_dir)
    doc, resumed = current_record(run_id, run_dir)
    mtime = newest_mtime(run_dir)
    if doc and not resumed:
        agents = [e for e in doc.get("workflowProgress") or [] if e.get("type") == "workflow_agent"]
        start = doc.get("startTime")
        return {
            **resume_fields(run_id, run_dir, doc),
            "id": run_id,
            "name": doc.get("workflowName") or run_id,
            "description": doc.get("summary") or "",
            "status": doc.get("status") or "completed",
            "startedAt": start,
            "endedAt": (start + doc.get("durationMs", 0)) if start else int(mtime * 1000),
            "agents": len(agents),
            "done": sum(1 for a in agents if a.get("state") == "done"),
            "failed": sum(1 for a in agents if a.get("state") == "error"),
            "tokens": doc.get("totalTokens"),
            "toolCalls": doc.get("totalToolCalls"),
            "phases": [p.get("title") for p in doc.get("phases") or []],
            "cwd": (doc.get("args") or {}).get("repo") or cwd_of(run_dir),
            "error": record_error(doc),
        }
    meta = meta_from_script(script_for(session, run_id))
    if doc:  # resumed: the record names the run, the run dir says how it is doing now
        meta = {"name": doc.get("workflowName"), "description": doc.get("summary"),
                "phases": [p.get("title") for p in doc.get("phases") or []], **{k: v for k, v in meta.items() if v}}
    proc = session_procs().get(session_id_of(run_dir))
    agents = live_agents(run_dir, bool(proc and proc["alive"]))
    lv = liveness(run_dir, agents, mtime)
    live = lv["status"] == "running"
    metas = glob.glob(os.path.join(run_dir, "agent-*.meta.json"))
    starts = [os.path.getmtime(m) for m in metas] or [mtime]
    out = {
        **resume_fields(run_id, run_dir, doc),
        "id": run_id,
        "name": meta.get("name") or run_id,
        "description": meta.get("description") or "",
        "status": lv["status"],
        "liveness": lv,
        "resumed": resumed,
        "startedAt": int(((doc or {}).get("startTime") or min(starts) * 1000)),
        "endedAt": None if live else int(mtime * 1000),
        "agents": len(metas),
        "done": sum(1 for a in agents if a["state"] == "done"),
        "failed": None,
        "tokens": None,
        "toolCalls": None,
        "phases": meta.get("phases") or [],
        "cwd": cwd_of(run_dir),
        "error": None,
        "logs": (doc or {}).get("logs") or [],
    }
    if with_agents:
        out["agentList"] = agents
    return out


def cmd_list(here=None):
    runs = []
    for run_id, d in run_dirs().items():
        try:
            r = summarize(run_id, d)
            r["repo"] = repo_of(session_cwd(d) or r.get("cwd"))
            runs.append(r)
        except Exception as e:  # one unreadable run must not hide the others
            runs.append({"id": run_id, "name": run_id, "status": "unreadable", "error": str(e),
                         "startedAt": int(newest_mtime(d) * 1000), "phases": [], "agents": 0})
    runs.sort(key=lambda r: (r["status"] == "running", r.get("endedAt") or r.get("startedAt") or 0), reverse=True)
    return {"now": int(time.time() * 1000), "runs": runs, "here": repo_of(here) if here else None}


def cmd_run(run_id):
    run_dir = run_dirs().get(run_id)
    if not run_dir:
        return {"error": "no such run: " + run_id}
    summary = summarize(run_id, run_dir, with_agents=True)
    doc, resumed = current_record(run_id, run_dir)
    if doc and not resumed:
        agents = []
        for e in doc.get("workflowProgress") or []:
            if e.get("type") != "workflow_agent":
                continue
            a = {k: e.get(k) for k in ("agentId", "label", "phaseIndex", "phaseTitle", "model", "agentType",
                                       "state", "startedAt", "lastProgressAt", "durationMs", "lastToolName",
                                       "lastToolSummary", "tokens", "toolCalls", "attempt", "cached", "error")}
            a["promptPreview"] = one_line(e.get("promptPreview") or "", 600)
            a["resultPreview"] = (e.get("resultPreview") or "")[:900]
            if doc.get("status") == "killed" and a["state"] in ("progress", "start"):
                a["state"] = "killed"
            agents.append(a)
        logs = doc.get("logs") or []
    else:
        agents = summary.pop("agentList")
        agents.sort(key=lambda a: a.get("startedAt") or 0)
        titles = list(summary["phases"])
        for a in agents:
            t = a.get("phaseTitle")
            if t and t not in titles:
                titles.append(t)
        summary["phases"] = titles
        for a in agents:
            t = a.get("phaseTitle")
            a["phaseIndex"] = titles.index(t) + 1 if t in titles else 0
        summary["done"] = sum(1 for a in agents if a["state"] == "done")
        summary["failed"] = sum(1 for a in agents if a["state"] == "error")
        logs = summary.get("logs") or []
    summary["logs"] = logs[-40:]
    summary["agentList"] = agents
    if doc and not resumed and doc.get("result") is not None:
        summary["output"] = outputs(doc.get("result"), summary.get("cwd"))
    return summary


# Runs in these states can be resumed (resume.py).
RESUMABLE = ("stalled", "killed", "failed")
