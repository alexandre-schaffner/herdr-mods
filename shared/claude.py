"""Claude Code on this machine, for the mods' Python helpers (workflows, master, claude-reader).

    sys.path.insert(0, os.path.join(<app home>, "shared")); import claude

Accounts: ~/.claude, plus each claude-picker account's own CLAUDE_CONFIG_DIR (~/.claude-<name>),
whose projects/ is a symlink to ~/.claude/projects but whose sessions/ is its own.
"""

import base64
import glob
import hashlib
import json
import os
import re
import subprocess

HOME = os.path.expanduser("~")
DEFAULT_CONFIG = os.path.join(HOME, ".claude")
PROJECTS = os.path.join(DEFAULT_CONFIG, "projects")
APP_HOME = os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config", "herdr-app")
IMAGES = os.path.join(HOME, ".cache", "herdr", "images")
IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
# CSI and OSC sequences, charset switches and bare carriage returns.
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r(?!\n)")


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def slug(path):
    """A folder's name under projects/."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def config_dirs():
    return [DEFAULT_CONFIG, *sorted(d for d in glob.glob(os.path.join(HOME, ".claude-*")) if os.path.isdir(d))]


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False
    return True


# ---- sessions: <config>/sessions/<pid>.json, one per running (or crashed) claude

_SESSIONS = {}


def sessions(dirs=None):
    """sessionId → its session file, with `alive` and `configDir`; a live one wins.
    `dirs`: sessions folders to read instead of every account's (tests)."""
    key = tuple(dirs or ())
    if key not in _SESSIONS:
        found = {}
        for folder in dirs or [os.path.join(c, "sessions") for c in config_dirs()]:
            for p in glob.glob(os.path.join(folder, "*.json")):
                d = read_json(p)
                if not isinstance(d, dict) or not d.get("sessionId") or not isinstance(d.get("pid"), int):
                    continue
                d["alive"] = pid_alive(d["pid"])
                d["configDir"] = os.path.dirname(os.path.dirname(p))
                prev = found.get(d["sessionId"])
                if not prev or (d["alive"] and not prev["alive"]):
                    found[d["sessionId"]] = d
        _SESSIONS[key] = found
    return _SESSIONS[key]


_PARENTS = None


def _parents():
    global _PARENTS
    if _PARENTS is None:
        _PARENTS = {}
        try:
            out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                _PARENTS[int(parts[0])] = int(parts[1])
    return _PARENTS


def lineage(pid):
    """pid and its ancestors. Herdr starts an agent under its terminal's shell
    (`fish -lic 'command …; exec fish -li'`), so a terminal's pid is claude's parent, not
    claude itself: match sessions and terminals through this chain."""
    chain, parents = [], _parents()
    while isinstance(pid, int) and pid > 1 and pid not in chain:
        chain.append(pid)
        pid = parents.get(pid)
    return chain


def has_children(pid):
    return any(pp == pid for pp in _parents().values())


def session_in(pids, dirs=None):
    """The live session a terminal runs: the one whose process is closest under any of
    `pids` (a claude it started, e.g. `claude -p` in a Bash call, sits deeper), or None."""
    pids = {p for p in pids if isinstance(p, int)}
    best, depth = None, None
    for s in sessions(dirs).values():
        if not s["alive"]:
            continue
        chain = lineage(s["pid"])
        d = next((i for i, p in enumerate(chain) if p in pids), None)
        if d is not None and (depth is None or d < depth):
            best, depth = s, d
    return best


def find_transcript(session_id, cwd=None):
    """A session's transcript: projects/<slug(cwd)>/<id>.jsonl, else wherever it moved
    (worktree, cd)."""
    if cwd:
        p = os.path.join(PROJECTS, slug(cwd), session_id + ".jsonl")
        if os.path.exists(p):
            return p
    found = glob.glob(os.path.join(PROJECTS, "*", session_id + ".jsonl"))
    return found[0] if found else None


def resume_argv(session_id, config_dir=None):
    """argv that reopens a session, in the account (config folder) it ran in."""
    if not config_dir or os.path.realpath(config_dir) == os.path.realpath(DEFAULT_CONFIG):
        return ["claude", "--resume", session_id]
    return ["env", "-u", "ANTHROPIC_API_KEY", f"CLAUDE_CONFIG_DIR={config_dir}", "claude", "--resume", session_id]


# ---- Herdr terminals (herdr-core's `hc`)

def hc_json(*args, timeout=15):
    """`hc <cmd> --json …` → (parsed output, None) or (None, error text)."""
    try:
        r = subprocess.run(["hc", args[0], "--json", *args[1:]], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout).strip()[-400:] or f"hc {args[0]} exited {r.returncode}"
    try:
        return json.loads(r.stdout or "null"), None
    except ValueError:
        return {"text": r.stdout.strip()}, None


def terminals():
    """Every live core terminal, as `hc get` describes it."""
    listed, _ = hc_json("ls")
    out = []
    for t in (listed or {}).get("terminals") or []:
        got, _ = hc_json("get", t["address"])
        if isinstance(got, dict):
            out.append(got)
    return out


def terminal_pids(t):
    return {(t.get("foreground") or {}).get("pid"), t.get("pid")} - {None}


def shows_session(t, proc):
    """The live terminal `t` runs the session process `proc`."""
    if not proc or not proc.get("alive") or t.get("state") != "live":
        return False
    return bool(terminal_pids(t).intersection(lineage(proc["pid"])))


def runs_claude(t):
    """The terminal runs Claude Code now, not the shell left behind when it exited."""
    st = t.get("status") if isinstance(t.get("status"), dict) else {}
    return t.get("state") == "live" and st.get("app") == "claude-code"


def terminal_brief(t):
    st = t.get("status") if isinstance(t.get("status"), dict) else {}
    fg = t.get("foreground") or {}
    return {"address": t.get("address"), "where": (t.get("labels") or {}).get("where"),
            "app": st.get("app"), "state": st.get("state"), "foreground": fg.get("argv"), "pid": fg.get("pid")}


# ---- transcripts

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


# ---- master chats (the master mod writes them; workflows marks the runs they own)

# repo key → {sessionId, path, name, startedAt}
MASTERS = os.path.join(APP_HOME, "data", "master", "masters.json")


def masters():
    m = read_json(MASTERS)
    return m if isinstance(m, dict) else {}
