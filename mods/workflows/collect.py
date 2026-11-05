"""Reads Claude Code workflow runs for the herdr `workflows` mod.

  collect.py list                  every run, newest activity first
  collect.py run <runId>           one run: phases and agents
  collect.py agent <runId> <id>    one agent session: prompt, transcript tail, result
  collect.py shell <runId> <id>    one agent session as a terminal: its commands and their output
  collect.py script <runId>        the script a run executed
  collect.py library <folder>...   saved workflows: ~/.claude/workflows and each folder's repo
  collect.py save <src> <dest> [replace] | delete <path>
  collect.py agents | gen-start <job> <cwd> <agent> [model] | gen-poll <job> | gen-cancel <job>
  collect.py resume-plan <runId>   who owns a stopped run, and which terminal holds that session
  collect.py resume <runId> [t]    type the resume request into that session's terminal (or t)
  collect.py resume-open <runId> [space]   session gone: open `claude --resume` in a new terminal
  --root <dir>                     read another projects folder (tests)
  --sessions <dir>                 read another ~/.claude/sessions (tests)
  --claude <bin>                   the claude that resume-open types (tests)

A finished run has `<session>/workflows/<runId>.json` (a resumed run keeps the
earlier attempt's record until it ends; see current_record). A live run has no JSON
yet, so it is rebuilt from its script (`workflows/scripts/*-<runId>.js`), each
agent's `.meta.json` and the head/tail of each transcript. Transcripts can
reach hundreds of MB, so they are never read whole.
"""

import base64
import calendar
import glob
import hashlib
import json
import os
import re
import sys
import time

ROOT = os.path.expanduser("~/.claude/projects")
SESSIONS = os.path.expanduser("~/.claude/sessions")
CLAUDE = "claude"
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
HEAD = 256 * 1024
TAIL = 1024 * 1024
IMAGES = os.path.expanduser("~/.cache/herdr-workflows/images")
IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


def run_dirs():
    out = {}
    for d in glob.glob(os.path.join(ROOT, "*", "*", "subagents", "workflows", "wf_*")):
        out[os.path.basename(d)] = d
    return out


def session_of(run_dir):
    return run_dir.split(os.sep + "subagents" + os.sep)[0]


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def head_lines(path, size=HEAD):
    try:
        with open(path, "rb") as f:
            data = f.read(size)
    except OSError:
        return []
    lines = data.split(b"\n")
    if len(data) == size:
        lines = lines[:-1]
    return [x for x in (parse_line(l) for l in lines) if x]


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
    return [x for x in (parse_line(l) for l in lines) if x]


def parse_line(raw):
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def ts_ms(value):
    if not value:
        return None
    try:
        return calendar.timegm(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
    except ValueError:
        return None


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


# ---- liveness: who owns a run, and is anything still happening -------------

_SESSION_FILES = None


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False
    return True


def session_procs():
    """sessionId → its `~/.claude/sessions/<pid>.json`, with `alive`; a live one wins."""
    global _SESSION_FILES
    if _SESSION_FILES is None:
        _SESSION_FILES = {}
        for p in glob.glob(os.path.join(SESSIONS, "*.json")):
            d = read_json(p)
            if not isinstance(d, dict) or not d.get("sessionId") or not isinstance(d.get("pid"), int):
                continue
            d["alive"] = pid_alive(d["pid"])
            prev = _SESSION_FILES.get(d["sessionId"])
            if not prev or (d["alive"] and not prev["alive"]):
                _SESSION_FILES[d["sessionId"]] = d
    return _SESSION_FILES


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


_REPOS = {}


def repo_of(path):
    """The repository a folder belongs to, the same for every worktree of it:
    {key: git common dir, name, path: main checkout}. A deleted folder is
    judged by its nearest existing parent; a folder outside git is its own repo."""
    if not path:
        return None
    probe = path
    while probe and not os.path.isdir(probe):
        parent = os.path.dirname(probe)
        probe = parent if parent != probe else ""
    if probe in _REPOS:
        return _REPOS[probe]
    import subprocess

    def git(*args):
        try:
            r = subprocess.run(["git", "-C", probe, *args], capture_output=True, text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""

    common = git("rev-parse", "--path-format=absolute", "--git-common-dir") if probe else ""
    if common:
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        url = git("config", "--get", "remote.origin.url")
        name = re.sub(r"\.git$", "", re.split(r"[:/]", url)[-2] + "/" + re.split(r"[:/]", url)[-1]) if url.count("/") or ":" in url else ""
        repo = {"key": os.path.realpath(common), "name": name or os.path.basename(main), "path": main}
    else:
        ws = re.search(r"/conductor/workspaces/([^/]+)/", path + "/")
        if ws:  # a removed Conductor workspace still belongs to its repository
            repo = {"key": "conductor:" + ws.group(1), "name": ws.group(1), "path": path[: ws.end(1)]}
        else:
            repo = {"key": path, "name": os.path.basename(path.rstrip("/")) or path, "path": path}
    _REPOS[probe] = repo
    return repo


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


def one_line(text, n):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


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


def resume_fields(run_id, run_dir, doc):
    session = session_of(run_dir)
    return {"sessionId": session_id_of(run_dir),
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
            "error": doc.get("error"),
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


# ---- outputs: what a finished run produced ----------------------------------

KIND_EXT = {
    "video": "mp4 m4v mov webm mkv avi",
    "image": "png jpg jpeg gif webp bmp svg heic heif tif tiff avif ico",
    "audio": "mp3 wav m4a aac flac ogg opus aiff",
    "pdf": "pdf",
    "markdown": "md markdown mdx",
    "subtitles": "srt vtt ass",
    "web": "html htm",
    "data": "json jsonl csv tsv yaml yml xml parquet sqlite db",
    "doc": "txt log docx pptx xlsx key pages rtf",
    "archive": "zip tar gz tgz 7z dmg",
    "code": "ts tsx js jsx mjs py rs go rb java kt swift c cc cpp h hpp cs sh sql css scss toml lua",
}
KIND_OF = {e: k for k, exts in KIND_EXT.items() for e in exts.split()}
KIND_RANK = ["video", "image", "audio", "pdf", "web", "markdown", "subtitles", "doc", "data", "archive", "folder", "code", "other"]
PATH_IN_TEXT = re.compile(r"(?<![\w/.~-])((?:~/|/)[^\s`'\"<>|*?()\[\]{},;]+)")
PATHISH = re.compile(r"^(?:~/|/|\./|\.\./)?[^\s`'\"<>|*?]+\.[A-Za-z0-9]{1,8}/?$")


def humanize(key):
    k = re.sub(r"(Path|File|Dir|Url|_path|_file|_dir)$", "", str(key))
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", k).replace("_", " ").replace("-", " ").strip()
    return (words[:1].upper() + words[1:].lower()) if words else ""


def kind_of(path, is_dir):
    if is_dir:
        return "folder"
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    return KIND_OF.get(ext, "other")


def resolve_path(raw, cwd):
    p = raw.strip().rstrip(".,:;)")
    if p.startswith("~/"):
        p = os.path.expanduser(p)
    elif not p.startswith("/"):
        if not cwd:
            return None
        p = os.path.normpath(os.path.join(cwd, p))
    return p.rstrip("/") or "/"


def outputs(result, cwd):
    """Files a run's result names: whole-string fields (`videoPath`) and absolute paths
    inside text. Each with whether it exists now; plus the rest of the result as facts
    (short scalars), notes (lists of text, long text) and data (anything else)."""
    files, seen, used = [], set(), set()

    def add(raw, label, source):
        p = resolve_path(raw, cwd)
        if not p or p in seen or len(files) >= 80:
            return False
        try:
            st = os.stat(p)
        except OSError:
            st = None
        if st is None and source == "text":
            return False  # a path mentioned in prose that isn't there is noise
        seen.add(p)
        is_dir = bool(st) and os.path.isdir(p)
        files.append({
            "path": p, "name": os.path.basename(p) or p, "label": label, "source": source,
            "kind": kind_of(p, is_dir), "exists": st is not None,
            "size": (st.st_size if st and not is_dir else None),
            "mtime": int(st.st_mtime * 1000) if st else None,
        })
        return True

    def walk(v, key, ctx):
        if isinstance(v, str):
            s = v.strip()
            if "\n" not in s and len(s) < 600 and PATHISH.match(s) and (s.startswith(("/", "~/", "./", "../")) or "/" in s):
                if add(s, humanize(key) or ctx, "field"):
                    used.add(id(v))
                return
            for m in PATH_IN_TEXT.finditer(v):
                add(m.group(1), ctx or ("Mentioned in " + humanize(key).lower() if humanize(key) else "Mentioned"), "text")
        elif isinstance(v, dict):
            name = next((v[k] for k in ("id", "name", "title", "label") if isinstance(v.get(k), str)), None)
            for k, x in v.items():
                walk(x, k, name or ctx)
        elif isinstance(v, list):
            for x in v:
                walk(x, key, ctx)

    walk(result, "", "")
    files.sort(key=lambda f: (not f["exists"], KIND_RANK.index(f["kind"]), f["source"] != "field"))

    facts, notes, data = [], [], []

    def clip(text, n):
        return text if len(text) <= n else text[: n - 1] + "…"

    def note_of(title, v):
        if isinstance(v, str):
            if v.strip():
                notes.append({"title": title, "text": clip(v.strip(), 12000)})
        elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            notes.append({"title": title, "items": [clip(x, 3000) for x in v[:60]]})
        elif isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            for x in v[:30]:
                name = next((x[k] for k in ("id", "name", "title", "label", "lane") if isinstance(x.get(k), str)), title)
                body = next((x[k] for k in ("result", "summary", "text", "verdict") if isinstance(x.get(k), str)), None)
                if body:
                    notes.append({"title": name, "text": clip(body, 6000)})
                else:
                    data.append({"title": name, "json": clip(json.dumps(x, indent=2), 6000)})
        elif v is not None:
            data.append({"title": title, "json": clip(json.dumps(v, indent=2), 6000)})

    if isinstance(result, dict):
        for k, v in result.items():
            if id(v) in used or v is None:
                continue
            if isinstance(v, bool) or isinstance(v, (int, float)) or (isinstance(v, str) and len(v) <= 80 and "\n" not in v):
                facts.append({"key": k, "label": humanize(k), "value": v})
            else:
                note_of(humanize(k), v)
    elif result is not None:
        note_of("Result", result)
    return {"files": files, "facts": facts, "notes": notes, "data": data}


# ---- one session -----------------------------------------------------------

FRAMING = re.compile(r"^\[Workflow harness[^\]]*\]")


def user_text(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if b.get("type") == "text")
    return ""


def unframe(text):
    """Drops the harness preamble and the indentation it adds to relayed text."""
    if not FRAMING.match(text):
        return text
    parts = text.split("\n", 1)
    body = parts[1] if len(parts) > 1 else parts[0]
    lines = body.split("\n")
    indents = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
    cut = min(indents) if indents else 0
    return "\n".join(l[cut:] for l in lines).strip()


def tool_result_text(block):
    c = block.get("content")
    if isinstance(c, list):
        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    return str(c or "")


def save_image(block):
    """An image block's picture as a file (named by its content, written once), or None."""
    src = block.get("source") or {}
    data = src.get("data")
    if src.get("type") != "base64" or not isinstance(data, str):
        return None
    path = os.path.join(IMAGES, hashlib.sha1(data.encode()).hexdigest()[:20] + IMAGE_EXT.get(src.get("media_type"), ".png"))
    if not os.path.exists(path):
        try:
            os.makedirs(IMAGES, exist_ok=True)
            with open(path + ".part", "wb") as f:
                f.write(base64.b64decode(data))
            os.replace(path + ".part", path)
        except (OSError, ValueError):
            return None
    return path


def tool_result_images(block):
    """Files for the images a tool returned (screenshots, an image it read)."""
    c = block.get("content")
    if not isinstance(c, list):
        return []
    files = (save_image(x) for x in c if isinstance(x, dict) and x.get("type") == "image")
    return [f for f in files if f]


def clip_text(v, n):
    v = "" if v is None else str(v)
    return v if len(v) <= n else v[:n] + "…"


def tool_detail(name, inp):
    """The input fields a transcript card shows for this tool, clipped."""
    if not isinstance(inp, dict):
        return {}
    if name in ("Edit", "MultiEdit"):
        edits = inp.get("edits") or [{"old_string": inp.get("old_string"), "new_string": inp.get("new_string")}]
        return {"file": inp.get("file_path"),
                "edits": [{"old": clip_text(e.get("old_string"), 1500), "new": clip_text(e.get("new_string"), 1500)}
                          for e in edits[:4]]}
    if name == "Write":
        return {"file": inp.get("file_path"), "content": clip_text(inp.get("content"), 1500)}
    if name == "Bash":
        return {"command": clip_text(inp.get("command"), 2000), "description": inp.get("description")}
    if name == "Read":
        return {"file": inp.get("file_path"), "offset": inp.get("offset"), "limit": inp.get("limit")}
    if name in ("Grep", "Glob"):
        return {"pattern": inp.get("pattern"), "path": inp.get("path"), "glob": inp.get("glob")}
    if name in ("Agent", "Task"):
        return {"description": inp.get("description"), "prompt": clip_text(inp.get("prompt"), 1500)}
    return {"input": clip_text(json.dumps(inp, indent=2), 1500)}


def items_from(lines):
    """Transcript events; a tool result is folded into the call it answers."""
    items = []
    calls = {}
    for line in lines:
        kind = line.get("type")
        msg = line.get("message")
        if kind not in ("assistant", "user") or not isinstance(msg, dict):
            continue
        ts = ts_ms(line.get("timestamp"))
        content = msg.get("content")
        if kind == "assistant":
            for b in content or []:
                t = b.get("type")
                if t == "text" and b.get("text", "").strip():
                    items.append({"kind": "text", "text": b["text"][:8000], "ts": ts})
                elif t == "thinking" and (b.get("thinking") or "").strip():
                    items.append({"kind": "thinking", "text": b["thinking"][:4000], "ts": ts})
                elif t == "tool_use":
                    name = b.get("name")
                    inp = b.get("input") or {}
                    if name == "StructuredOutput":
                        items.append({"kind": "output", "text": json.dumps(inp, indent=2)[:8000], "ts": ts})
                        continue
                    item = {"kind": "tool", "id": b.get("id"), "name": name, "text": tool_summary(name, inp),
                            "detail": tool_detail(name, inp), "ts": ts, "result": None}
                    calls[b.get("id")] = item
                    items.append(item)
        elif isinstance(content, list):
            for b in content:
                if b.get("type") != "tool_result":
                    continue
                res = {"error": bool(b.get("is_error")), "text": tool_result_text(b)[:2400], "ts": ts,
                       "files": tool_result_images(b)}
                call = calls.get(b.get("tool_use_id"))
                if call is not None:
                    call["result"] = res
                else:
                    items.append(dict(res, kind="result"))
    return items


def cmd_agent(run_id, agent_id):
    run_dir = run_dirs().get(run_id)
    if not run_dir:
        return {"error": "no such run: " + run_id}
    path = os.path.join(run_dir, "agent-" + agent_id + ".jsonl")
    if not os.path.exists(path):
        return {"error": "no transcript yet"}
    size = os.path.getsize(path)
    head = head_lines(path)
    prompt = ""
    started = None
    for line in head:
        msg = line.get("message")
        if started is None and line.get("timestamp"):
            started = ts_ms(line.get("timestamp"))
        if line.get("type") == "user" and isinstance(msg, dict):
            text = user_text(msg)
            if text.startswith("[Workflow harness — computed task]") or (text and not FRAMING.match(text)):
                prompt = unframe(text)
                break
    lines = tail_lines(path) if size > TAIL else head_lines(path, TAIL)
    items = items_from(lines)
    return {
        "path": path,
        "cwd": next((l["cwd"] for l in head if l.get("cwd")), None),
        "size": size,
        "truncated": size > TAIL,
        "startedAt": started,
        "prompt": prompt[:12000],
        "items": items[-200:],
    }


# ---- shell: one agent's commands, as a terminal shows them ------------------

SHELL_TAIL = 4 * 1024 * 1024
SHELL_OUT_LINES = 400
SHELL_OUT_CHARS = 48 * 1024
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r(?!\n)")


def shell_output(text):
    """A command's output as the terminal's last lines: escapes dropped, tail kept."""
    text = ANSI.sub("", str(text or "")).replace("\r\n", "\n").replace("\t", "    ")
    lines = text.rstrip("\n").split("\n") if text.strip() else []
    cut = max(0, len(lines) - SHELL_OUT_LINES)
    lines = lines[cut:]
    out = "\n".join(lines)
    if len(out) > SHELL_OUT_CHARS:
        dropped = out[: len(out) - SHELL_OUT_CHARS].count("\n")
        out = out[-SHELL_OUT_CHARS:].split("\n", 1)[-1]
        cut += dropped + 1
    return out, cut


def cmd_shell(run_id, agent_id):
    """Every tool call of one agent in order, Bash ones with their command, folder and
    output; the others as one-line summaries. A call without a result yet is pending."""
    run_dir = run_dirs().get(run_id)
    if not run_dir:
        return {"error": "no such run: " + run_id}
    path = os.path.join(run_dir, "agent-" + agent_id + ".jsonl")
    if not os.path.exists(path):
        return {"error": "no transcript yet"}
    size = os.path.getsize(path)
    lines = tail_lines(path, SHELL_TAIL) if size > SHELL_TAIL else head_lines(path, SHELL_TAIL)
    entries, calls = [], {}
    cwd = None
    for line in lines:
        cwd = line.get("cwd") or cwd
        msg = line.get("message")
        kind = line.get("type")
        if kind not in ("assistant", "user") or not isinstance(msg, dict):
            continue
        ts = ts_ms(line.get("timestamp"))
        content = msg.get("content")
        if kind == "assistant":
            for b in content or []:
                if b.get("type") != "tool_use" or b.get("name") == "StructuredOutput":
                    continue
                name, inp = b.get("name"), b.get("input") or {}
                e = {"id": b.get("id"), "name": name, "ts": ts, "cwd": cwd, "pending": True}
                if name == "Bash" and isinstance(inp, dict):
                    e.update(kind="bash", command=str(inp.get("command") or "")[:8000],
                             description=inp.get("description"), background=bool(inp.get("run_in_background")))
                else:
                    e.update(kind="tool", summary=tool_summary(name, inp))
                calls[b.get("id")] = e
                entries.append(e)
        elif isinstance(content, list):
            for b in content:
                if b.get("type") != "tool_result":
                    continue
                e = calls.get(b.get("tool_use_id"))
                if e is None:
                    continue
                e["pending"] = False
                e["endTs"] = ts
                e["error"] = bool(b.get("is_error"))
                if e["kind"] == "bash":
                    e["output"], e["clipped"] = shell_output(tool_result_text(b))
                else:
                    e["result"] = one_line(tool_result_text(b), 160) if e["error"] else None
    return {
        "agentId": agent_id,
        "size": size,
        "truncated": size > SHELL_TAIL,
        "cwd": cwd,
        "entries": entries[-600:],
    }


# ---- resume: a stopped run, restarted by its own session ---------------------
#
# Resume is a Workflow tool call inside the session that owns the run, so the mod types a
# request into that session's terminal: sessionId → ~/.claude/sessions/<pid>.json → the
# Herdr terminal whose foreground process is that pid. With the session gone, it opens
# `claude --resume <sessionId>` in a new terminal first (labelled with the run id).

RESUMABLE = ("stalled", "killed", "failed")
RESUME_LABEL = "herdr.workflows.resume"


def hc_json(*args):
    import subprocess
    try:
        r = subprocess.run(["hc", args[0], "--json", *args[1:]], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout).strip()[-400:] or f"hc {args[0]} exited {r.returncode}"
    try:
        return json.loads(r.stdout or "null"), None
    except ValueError:
        return {"text": r.stdout.strip()}, None


def terminals():
    listed, _ = hc_json("ls")
    out = []
    for t in (listed or {}).get("terminals") or []:
        got, _ = hc_json("get", t["address"])
        if isinstance(got, dict):
            out.append(got)
    return out


def terminal_brief(t):
    st = t.get("status") if isinstance(t.get("status"), dict) else {}
    fg = t.get("foreground") or {}
    return {"address": t.get("address"), "where": (t.get("labels") or {}).get("where"),
            "app": st.get("app"), "state": st.get("state"), "foreground": fg.get("argv"), "pid": fg.get("pid")}


def resume_text(run_id, script):
    return (f'Resume workflow run {run_id} with Workflow({{scriptPath: "{script}", resumeFromRunId: "{run_id}"}}). '
            "Check the run record first; if it is still running, do not resume.")


def cmd_resume_plan(run_id):
    run_dir = run_dirs().get(run_id)
    if not run_dir:
        return {"error": "no such run: " + run_id}
    s = summarize(run_id, run_dir)
    proc = session_procs().get(s["sessionId"])
    alive = bool(proc and proc["alive"])
    terminal, opened = None, None
    for t in terminals():
        if alive and proc["pid"] in ((t.get("foreground") or {}).get("pid"), t.get("pid")):
            terminal = terminal_brief(t)
        if (t.get("labels") or {}).get(RESUME_LABEL) == run_id and t.get("state") == "live":
            opened = terminal_brief(t)
    return {
        "runId": run_id, "status": s["status"], "resumable": s["status"] in RESUMABLE and bool(s["scriptPath"]),
        "sessionId": s["sessionId"], "scriptPath": s["scriptPath"],
        "cwd": (proc or {}).get("cwd") or session_cwd(run_dir) or s.get("cwd"),
        "session": {"pid": (proc or {}).get("pid"), "name": (proc or {}).get("name"), "alive": alive},
        "terminal": terminal, "opened": opened, "text": resume_text(run_id, s["scriptPath"]),
        "openCommand": f"{CLAUDE} --resume {s['sessionId']}",
    }


def cmd_resume(run_id, into=None):
    """Types the resume request into the owning session's terminal, or into `into`, a
    terminal resume-open started for this run. Re-checks the run first."""
    import subprocess
    plan = cmd_resume_plan(run_id)
    if plan.get("error"):
        return plan
    if not plan["resumable"]:
        return {"error": f"run {run_id} is {plan['status']}; only stalled, killed or failed runs are resumed"}
    target = plan["terminal"]
    if into:
        if not plan["opened"] or plan["opened"]["address"] != into:
            return {"error": f"{into} is not a terminal opened to resume {run_id}"}
        target = plan["opened"]
    if not target:
        return {"error": "no live terminal holds session " + plan["sessionId"][:8], "plan": plan}
    try:
        r = subprocess.run(["hc", "send", target["address"], plan["text"]], capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": f"hc send failed: {e}"}
    if r.returncode != 0:
        return {"error": f"hc send {target['address']}: " + ((r.stderr or r.stdout).strip()[-300:] or str(r.returncode))}
    return {"ok": True, "terminal": target, "text": plan["text"]}


def cmd_resume_open(run_id, space=""):
    """Starts a shell in the run's folder, labelled for this run (and shown in `space` as a
    new tab), and types `claude --resume <sessionId>` into it. Only when the session is gone."""
    import subprocess
    import uuid
    plan = cmd_resume_plan(run_id)
    if plan.get("error"):
        return plan
    if not plan["resumable"]:
        return {"error": f"run {run_id} is {plan['status']}; nothing to resume"}
    if plan["session"]["alive"]:
        return {"error": "its session is still alive; resume there instead"}
    if plan["opened"]:
        return {"ok": True, "terminal": plan["opened"], "reused": True}
    cwd = plan["cwd"] if plan["cwd"] and os.path.isdir(plan["cwd"]) else os.path.expanduser("~")
    argv = ["run", "--bg", "--keep", "--no-parent", "--cwd", cwd, "--label", f"{RESUME_LABEL}={run_id}"]
    if space:
        argv += ["--label", f"herdr.space={space}", "--label", "herdr.tab=tb" + uuid.uuid4().hex]
    started, err = hc_json(*argv, "--", login_shell(), "-l")
    if err or not isinstance(started, dict) or not started.get("address"):
        return {"error": "couldn't start a terminal: " + (err or json.dumps(started))}
    addr = started["address"]
    r = subprocess.run(["hc", "send", addr, plan["openCommand"]], capture_output=True, text=True, timeout=25)
    if r.returncode != 0:
        return {"error": f"started {addr}, but couldn't type into it: " + (r.stderr or r.stdout).strip()[-300:]}
    return {"ok": True, "terminal": {"address": addr}, "command": plan["openCommand"], "cwd": cwd}


# ---- saved workflows -------------------------------------------------------

MODEL_MARK = "// @herdr-workflow "


def git_root(path):
    import subprocess
    try:
        out = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def describe(path, scope, root):
    try:
        with open(path) as f:
            text = f.read()
        st = os.stat(path)
    except OSError:
        return None
    meta = meta_from_script(text)
    return {
        "path": path,
        "scope": scope,
        "root": root,
        "name": meta.get("name") or os.path.splitext(os.path.basename(path))[0],
        "description": meta.get("description") or "",
        "phases": meta.get("phases") or [],
        "editable": MODEL_MARK in text,
        "mtime": int(st.st_mtime * 1000),
        "size": st.st_size,
    }


def cmd_library(folders):
    out, seen = [], set()
    user_dir = os.path.expanduser("~/.claude/workflows")
    roots = []
    for f in folders:
        r = git_root(f) or f
        if r and r not in roots and os.path.isdir(r) and os.path.expanduser("~") != r:
            roots.append(r)
    for scope, root, d in [("user", None, user_dir)] + [("project", r, os.path.join(r, ".claude", "workflows")) for r in roots]:
        for p in sorted(glob.glob(os.path.join(d, "*.js"))):
            real = os.path.realpath(p)
            if real in seen:
                continue
            seen.add(real)
            w = describe(p, scope, root)
            if w:
                out.append(w)
    out.sort(key=lambda w: w["mtime"], reverse=True)
    repos = {r: repo_of(r) for r in roots}
    for w in out:
        w["repo"] = repos.get(w["root"]) if w["root"] else None
    return {"workflows": out, "roots": roots, "rootRepos": repos, "userDir": user_dir}


def cmd_save(src, dest, replace):
    """Moves a draft the mod wrote into place; refuses to overwrite unless asked."""
    if os.path.exists(dest) and replace != "replace":
        return {"error": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    import shutil
    shutil.move(src, dest)
    return {"ok": True, "path": dest}


def cmd_delete(path):
    if not path.endswith(".js") or "/.claude/workflows/" not in path:
        return {"error": "refusing to delete outside .claude/workflows: " + path}
    os.remove(path)
    return {"ok": True}


# ---- AI generation jobs ----------------------------------------------------
#
# One adapter per agent CLI: how to start it headless and read-only, and how to read
# its event stream. Claude and Codex enforce the model's JSON schema; the others get the
# schema in the prompt and the JSON is taken from their final message, then validated
# by the editor like any other model.

AGENTS = [
    {"id": "claude", "label": "Claude Code", "bin": "claude", "icon": "icons/claude.svg", "schema": True,
     "models": ["opus", "sonnet", "haiku"]},
    {"id": "codex", "label": "Codex", "bin": "codex", "icon": "icons/codex.svg", "schema": True, "models": []},
    {"id": "omp", "label": "omp", "bin": "omp", "icon": "icons/pi.svg", "tint": True, "schema": False, "models": []},
    {"id": "opencode", "label": "OpenCode", "bin": "opencode", "icon": "icons/opencode.svg", "schema": False, "models": []},
    {"id": "cursor", "label": "Cursor Agent", "bin": "cursor-agent", "icon": "icons/cursor.svg", "schema": False, "models": []},
]


def cmd_agents():
    import shutil
    return {"agents": [dict(a, installed=bool(shutil.which(a["bin"]))) for a in AGENTS]}


# Provider credentials an agent CLI reads from its environment. Herdr's processes don't
# run the person's shell setup, so a key exported there (a fish universal variable, a
# line in .zshrc) is missing from what this helper inherits, and `claude` then silently
# falls back to the claude.ai login and its limits. Ask the login shell for what's missing.
CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
               "CURSOR_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]


def login_shell():
    import pwd
    try:
        return pwd.getpwuid(os.getuid()).pw_shell or os.environ.get("SHELL") or "/bin/zsh"
    except KeyError:
        return os.environ.get("SHELL") or "/bin/zsh"


def agent_env():
    import subprocess
    env = dict(os.environ)
    missing = [n for n in CREDENTIALS if not env.get(n)]
    if not missing:
        return env
    shell = login_shell()
    # One line per variable; empty when unset. The same printf works in fish, zsh and bash.
    script = "printf '%s\\n' " + " ".join(f'"${n}"' for n in missing)
    flags = ["-c"] if os.path.basename(shell) == "fish" else ["-ilc"]
    try:
        out = subprocess.run([shell, *flags, script], capture_output=True, text=True, timeout=10,
                             stdin=subprocess.DEVNULL).stdout.split("\n")
    except (OSError, subprocess.SubprocessError):
        out = []
    for name, value in zip(missing, out):
        if value.strip():
            env[name] = value.strip()
    return env


def strict(schema):
    """OpenAI structured outputs: every property required, no extra keys, no numeric bounds."""
    if isinstance(schema, dict):
        out = {k: strict(v) for k, v in schema.items() if k not in ("minimum", "maximum")}
        if out.get("type") == "object" and isinstance(out.get("properties"), dict):
            out["required"] = list(out["properties"].keys())
            out["additionalProperties"] = False
        return out
    if isinstance(schema, list):
        return [strict(x) for x in schema]
    return schema


def read(path):
    with open(path) as f:
        return f.read()


def cmd_gen_start(job, cwd, agent, model=""):
    """Starts the agent detached; the mod polls `gen-poll`. Inputs are files in the job folder."""
    import shutil
    import subprocess
    jobs = os.path.dirname(job)
    for old in glob.glob(os.path.join(jobs, "*")):  # finished jobs older than a day
        if old != job and time.time() - os.path.getmtime(old) > 86400:
            shutil.rmtree(old, ignore_errors=True)
    if agent not in [a["id"] for a in AGENTS]:  # older mod builds passed the model here
        agent, model = "claude", agent if agent != "inherit" else model
    model = "" if model in ("", "inherit") else model
    prompt, schema, system = read(os.path.join(job, "prompt.txt")), read(os.path.join(job, "schema.json")), os.path.join(job, "system.md")
    inline = (read(system) + "\n\n---\n\n" + prompt + "\n\nReturn ONLY the workflow model as one JSON object matching this JSON Schema, "
              "with no prose and no code fence. Do not modify any file.\n\n" + schema)
    if agent == "claude":
        argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                "--json-schema", schema, "--append-system-prompt-file", system, "--tools", "Read", "Grep", "Glob"]
        if model:
            argv += ["--model", model]
    elif agent == "codex":
        with open(os.path.join(job, "schema-strict.json"), "w") as f:
            json.dump(strict(json.loads(schema)), f)
        argv = ["codex", "exec", "--json", "--output-schema", os.path.join(job, "schema-strict.json"),
                "-o", os.path.join(job, "last.txt"), "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                read(system) + "\n\n---\n\n" + prompt]
        if model:
            argv[2:2] = ["-m", model]
    elif agent == "omp":
        argv = ["omp", "-p", "--mode", "json", "--tools=read,grep,find,ls", inline]
        if model:
            argv[1:1] = ["--model", model]
    elif agent == "opencode":
        argv = ["opencode", "run", "--format", "json", "--agent", "plan", inline]
        if model:
            argv[2:2] = ["-m", model]
    else:
        argv = ["cursor-agent", "-p", "--output-format", "stream-json", "--trust", inline]
        if model:
            argv[1:1] = ["--model", model]
    with open(os.path.join(job, "agent"), "w") as f:
        f.write(agent)
    out = open(os.path.join(job, "stream.jsonl"), "w")
    err = open(os.path.join(job, "stderr.txt"), "w")
    env = agent_env()
    p = subprocess.Popen(argv, cwd=cwd if os.path.isdir(cwd) else os.path.expanduser("~"), stdout=out, stderr=err,
                         stdin=subprocess.DEVNULL, start_new_session=True, env=env)
    with open(os.path.join(job, "pid"), "w") as f:
        f.write(str(p.pid))
    return {"ok": True, "pid": p.pid, "agent": agent,
            "auth": "api key" if env.get("ANTHROPIC_API_KEY") and agent == "claude" else None}


def alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # a finished child we never reaped is a zombie: treat it as gone
        import subprocess
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(st) and not st.startswith("Z")
    except OSError:
        return True


def json_in(text):
    """The JSON object a free-text answer carries: whole, fenced, or the outermost braces."""
    text = (text or "").strip()
    candidates = [text]
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fence:
        candidates.append(fence.group(1))
    if "{" in text and "}" in text:
        candidates.append(text[text.index("{"): text.rindex("}") + 1])
    for c in candidates:
        try:
            v = json.loads(c)
            if isinstance(v, dict):
                return v
        except ValueError:
            pass
    return None


def ev_tool(name, inp):
    return {"kind": "tool", "name": name or "tool", "text": tool_summary(name, inp) if isinstance(inp, dict) else one_line(str(inp or ""), 140)}


def parse_stream(agent, lines, job):
    """(events, finished, final model or None, error or None, cost)."""
    events, final_text, model, error, done, cost = [], None, None, None, False, None
    for d in lines:
        if not isinstance(d, dict):
            continue
        t = d.get("type")
        if agent in ("claude", "cursor"):
            if t == "assistant":
                for b in (d.get("message") or {}).get("content") or []:
                    if b.get("type") == "text" and b.get("text", "").strip():
                        events.append({"kind": "text", "text": one_line(b["text"], 240)})
                        final_text = b["text"]
                    elif b.get("type") == "thinking" and (b.get("thinking") or "").strip():
                        events.append({"kind": "thinking", "text": one_line(b["thinking"], 240)})
                    elif b.get("type") == "tool_use":
                        events.append({"kind": "tool", "name": "Drafting", "text": "writing the workflow"} if b.get("name") == "StructuredOutput"
                                      else ev_tool(b.get("name"), b.get("input")))
            elif t == "tool_call" and agent == "cursor":
                call = d.get("tool_call") or {}
                name = next(iter(call), "tool")
                events.append(ev_tool(name.replace("ToolCall", ""), (call.get(name) or {}).get("args")))
            elif t == "result":
                done, cost = True, d.get("total_cost_usd")
                if d.get("is_error"):
                    error = str(d.get("result"))[:600]
                else:
                    model = d.get("structured_output") or json_in(d.get("result") or final_text)
        elif agent == "codex":
            item = d.get("item") or {}
            if t in ("item.started", "item.completed"):
                it = item.get("type")
                if it == "agent_message" and t == "item.completed":
                    final_text = item.get("text")
                    events.append({"kind": "text", "text": one_line(final_text, 240)})
                elif it == "reasoning" and t == "item.completed" and item.get("text"):
                    events.append({"kind": "thinking", "text": one_line(item["text"], 240)})
                elif it == "command_execution" and t == "item.started":
                    events.append({"kind": "tool", "name": "Shell", "text": one_line(item.get("command", ""), 140)})
                elif it in ("mcp_tool_call", "web_search") and t == "item.started":
                    events.append({"kind": "tool", "name": item.get("tool") or "Search", "text": one_line(item.get("query") or json.dumps(item.get("arguments") or {}), 140)})
            elif t == "turn.completed":
                done = True
                try:
                    model = json_in(read(os.path.join(job, "last.txt"))) or json_in(final_text)
                except OSError:
                    model = json_in(final_text)
            elif t in ("turn.failed", "error"):
                done = True
                error = str((d.get("error") or {}).get("message") or d.get("message") or "Codex failed")[:600]
        elif agent == "omp":
            if t == "message_end":
                m = d.get("message") or {}
                if m.get("role") == "assistant":
                    for b in m.get("content") or []:
                        if b.get("type") == "text" and b.get("text", "").strip():
                            final_text = b["text"]
                            events.append({"kind": "text", "text": one_line(b["text"], 240)})
                        elif b.get("type") == "thinking" and (b.get("thinking") or "").strip():
                            events.append({"kind": "thinking", "text": one_line(b["thinking"], 240)})
                    if m.get("stopReason") == "error" or m.get("errorMessage"):
                        error = str(m.get("errorMessage") or "omp failed")[:600]
            elif t == "tool_execution_start":
                events.append(ev_tool(d.get("toolName"), d.get("args")))
            elif t == "agent_end":
                done = True
                model = json_in(final_text)
        elif agent == "opencode":
            part = d.get("part") or {}
            if t == "text" and part.get("text", "").strip():
                final_text = part["text"]
                events.append({"kind": "text", "text": one_line(part["text"], 240)})
            elif t == "tool_use":
                events.append(ev_tool(part.get("tool"), (part.get("state") or {}).get("input")))
            elif t == "error":
                done = True
                err = d.get("error") or {}
                error = str(err.get("message") or (err.get("data") or {}).get("message") or "OpenCode failed")[:600]
            elif t == "step_finish" and (part.get("reason") == "stop"):
                done = True
                model = json_in(final_text)
    if done and not error and model is None:
        error = "The agent answered, but not with a workflow model: " + one_line(final_text or "(no answer)", 300)
    return events, done, model, error, cost


def cmd_gen_poll(job):
    try:
        agent = read(os.path.join(job, "agent")).strip()
    except OSError:
        agent = "claude"
    try:
        with open(os.path.join(job, "stream.jsonl")) as f:
            lines = [parse_line(l.encode()) for l in f]
    except OSError:
        lines = []
    events, done, model, error, cost = parse_stream(agent, lines, job)
    try:
        pid = int(read(os.path.join(job, "pid")).strip())
    except (OSError, ValueError):
        pid = None
    running = not done and pid is not None and alive(pid)
    result = None
    if done:
        result = {"ok": model is not None and not error, "model": model, "error": error, "cost": cost}
    elif not running:
        if agent == "codex":  # codex can exit without turn.completed when it fails early
            try:
                model = json_in(read(os.path.join(job, "last.txt")))
            except OSError:
                model = None
        try:
            err = read(os.path.join(job, "stderr.txt")).strip().splitlines()
        except OSError:
            err = []
        err = [l for l in err if l.strip() and "connectors are disabled" not in l and "Reading additional input" not in l]
        result = {"ok": model is not None, "model": model,
                  "error": None if model is not None else (err[-1] if err else f"{agent} exited without a result")[:600]}
    return {"running": running, "events": events[-40:], "result": result, "agent": agent}


# ---- files for prompts -----------------------------------------------------

def _word(q, p, name_at):
    """Best score of word `q` in path `p` where every character either continues the previous
    match or starts a word (after / - _ . or at 0): "engv3state" finds engine-v3/…/v3-state.
    None when no such alignment exists."""
    from functools import lru_cache
    n = len(p)
    starts = [k == 0 or p[k - 1] in "/-_. " for k in range(n)]

    @lru_cache(maxsize=None)
    def best(qi, prev):
        if qi == len(q):
            return 0.0
        ch, top = q[qi], None
        k = p.find(ch, prev + 1)
        while k >= 0:
            run = k == prev + 1 and qi > 0
            if run or starts[k]:
                rest = best(qi + 1, k)
                if rest is not None:
                    sc = rest + (5 if run else 3) + (2 if k >= name_at else 0)
                    top = sc if top is None or sc > top else top
            k = p.find(ch, k + 1)
        return top

    return best(0, -1)


def _subsequence(q, p):
    i = 0
    for ch in q:
        i = p.find(ch, i) + 1
        if not i:
            return False
    return True


def fuzzy(query, path):
    """Every space-separated word must align (see _word); shorter paths win ties."""
    p = path.lower()
    name_at = p.rfind("/") + 1
    total = 0.0
    for word in query.lower().split():
        if not _subsequence(word, p):
            return None
        sc = _word(word, p, name_at)
        if sc is None:
            return None
        total += sc
    return total - len(p) * 0.02


def cmd_files(root, query):
    """Repo files matching `query`, best first: tracked and untracked-but-not-ignored."""
    import subprocess
    r = subprocess.run(["git", "-C", root, "ls-files", "-co", "--exclude-standard"], capture_output=True, text=True, timeout=10)
    files = r.stdout.splitlines() if r.returncode == 0 else []
    if not files:  # not a repo: a shallow walk
        for base, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
            files += [os.path.relpath(os.path.join(base, n), root) for n in names]
            if len(files) > 20000:
                break
    query = query.strip()
    if not query:
        return {"root": root, "files": files[:0], "total": len(files)}
    scored = sorted(((fuzzy(query, f), f) for f in files), key=lambda x: -(x[0] or -1e9))
    return {"root": root, "files": [f for sc, f in scored if sc is not None][:40], "total": len(files)}


def cmd_exists(root, paths):
    out = {}
    for p in paths:
        full = os.path.expanduser(p) if os.path.isabs(os.path.expanduser(p)) else os.path.join(root, p)
        out[p] = os.path.isfile(full)
    return {"exists": out}


def cmd_pick_start(out_file, directory):
    """The macOS file picker, detached: the mod's exec gives up after 30 s and people browse longer."""
    import subprocess
    script = ('set picked to choose file with prompt "Add files to the workflow" '
              f'default location (POSIX file "{directory}") with multiple selections allowed\n'
              'set out to ""\nrepeat with f in picked\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out')
    with open(out_file + ".tmp", "w") as f:
        pass
    p = subprocess.Popen(["sh", "-c", f'osascript -e \'{script}\' > "{out_file}.tmp" 2>/dev/null; mv "{out_file}.tmp" "{out_file}"'],
                         stdin=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True, "pid": p.pid}


def cmd_pick_poll(out_file):
    if not os.path.exists(out_file):
        return {"done": False}
    paths = [l for l in read(out_file).splitlines() if l.strip()]
    os.remove(out_file)
    return {"done": True, "paths": paths}


def cmd_gen_cancel(job):
    import signal
    try:
        with open(os.path.join(job, "pid")) as f:
            os.killpg(int(f.read().strip()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    return {"ok": True}


def main(argv):
    global ROOT, SESSIONS, CLAUDE
    for flag in ("--root", "--sessions", "--claude"):  # other folders and binaries, for tests
        if flag in argv:
            i = argv.index(flag)
            value = os.path.expanduser(argv[i + 1])
            if flag == "--root":
                ROOT = value
            elif flag == "--sessions":
                SESSIONS = value
            else:
                CLAUDE = value
            argv = argv[:i] + argv[i + 2:]
    cmd = argv[1] if len(argv) > 1 else "list"
    a = argv[2:]
    if cmd == "list":
        out = cmd_list(a[0] if a else None)
    elif cmd == "run" and a:
        out = cmd_run(a[0])
    elif cmd == "agent" and len(a) > 1:
        out = cmd_agent(a[0], a[1])
    elif cmd == "shell" and len(a) > 1:
        out = cmd_shell(a[0], a[1])
    elif cmd == "script" and a:
        d = run_dirs().get(a[0])
        doc = read_json(os.path.join(session_of(d), "workflows", a[0] + ".json")) if d else None
        out = {"script": (doc or {}).get("script") or script_for(session_of(d), a[0]) if d else None}
    elif cmd == "library":
        out = cmd_library(a)
    elif cmd == "save" and len(a) > 1:
        out = cmd_save(a[0], a[1], a[2] if len(a) > 2 else "")
    elif cmd == "delete" and a:
        out = cmd_delete(a[0])
    elif cmd == "files" and a:
        out = cmd_files(a[0], a[1] if len(a) > 1 else "")
    elif cmd == "exists" and a:
        out = cmd_exists(a[0], a[1:])
    elif cmd == "pick-start" and len(a) > 1:
        out = cmd_pick_start(a[0], a[1])
    elif cmd == "pick-poll" and a:
        out = cmd_pick_poll(a[0])
    elif cmd == "resume-plan" and a:
        out = cmd_resume_plan(a[0])
    elif cmd == "resume" and a:
        out = cmd_resume(a[0], a[1] if len(a) > 1 else None)
    elif cmd == "resume-open" and a:
        out = cmd_resume_open(a[0], a[1] if len(a) > 1 else "")
    elif cmd == "agents":
        out = cmd_agents()
    elif cmd == "gen-start" and len(a) > 2:
        out = cmd_gen_start(a[0], a[1], a[2], a[3] if len(a) > 3 else "")
    elif cmd == "gen-poll" and a:
        out = cmd_gen_poll(a[0])
    elif cmd == "gen-cancel" and a:
        out = cmd_gen_cancel(a[0])
    else:
        out = {"error": "usage: collect.py list | run | agent | script | library | save | delete | gen-start | gen-poll | gen-cancel"}
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv)
