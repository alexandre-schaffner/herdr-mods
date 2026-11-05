"""Claude Code transcript → compact events, read incrementally.

  python3 -I read.py --pid <pid> --cwd <dir> [--path <jsonl>] [--offset <bytes>]

Finds the session a Claude Code process is writing (~/.claude/sessions/<pid>.json →
~/.claude/projects/<slug>/<sessionId>.jsonl, else the newest transcript for the folder),
parses the lines after `offset` and prints one JSON object: the events, the new offset
and session facts. Only complete lines are consumed, so a line being written is read
on the next call. Big tool outputs are clipped; on a huge first read the oldest events
are dropped to keep the output small.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
IMAGES = os.path.join(HOME, ".cache", "claude-reader", "images")
IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
OUT_BUDGET = 5_500_000
RESULT_HEAD, RESULT_TAIL = 2600, 900

REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
TAG = lambda name: re.compile(r"<%s>(.*?)</%s>" % (name, name), re.S)
CMD_NAME, CMD_ARGS = TAG("command-name"), TAG("command-args")
LOCAL_OUT = TAG("local-command-stdout")
BASH_IN, BASH_OUT, BASH_ERR = TAG("bash-input"), TAG("bash-stdout"), TAG("bash-stderr")
SUMMARY, STATUS = TAG("summary"), TAG("status")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def slug(path):
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def newest(folder):
    try:
        files = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".jsonl")]
    except OSError:
        return None
    return max(files, key=os.path.getmtime) if files else None


def resolve(pid, cwd, given):
    if pid:
        s = read_json(os.path.join(CLAUDE, "sessions", "%s.json" % pid))
        if s and s.get("sessionId"):
            p = os.path.join(CLAUDE, "projects", slug(s.get("cwd") or cwd), s["sessionId"] + ".jsonl")
            if os.path.exists(p):
                return p, s
            # The session moved folders (worktree, cd): find it by id.
            folder = os.path.join(CLAUDE, "projects")
            for d in os.listdir(folder):
                q = os.path.join(folder, d, s["sessionId"] + ".jsonl")
                if os.path.exists(q):
                    return q, s
    if given and os.path.exists(given):
        return given, None
    if cwd:
        return newest(os.path.join(CLAUDE, "projects", slug(cwd))), None
    return None, None


def clip(text, head=RESULT_HEAD, tail=RESULT_TAIL):
    text = ANSI.sub("", text or "")
    if len(text) <= head + tail + 40:
        return text
    cut = len(text) - head - tail
    return "%s\n… %d more characters …\n%s" % (text[:head], cut, text[-tail:])


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


def block_text(content):
    """Text of a tool result's content (a string or a list of blocks), and its images' files."""
    if isinstance(content, str):
        return content, []
    parts, images = [], []
    for b in content or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "image":
            images.append(save_image(b))
        elif b.get("type") == "tool_reference":
            parts.append(b.get("tool_name", ""))
    return "\n".join(parts), images


def slim_input(name, inp):
    if not isinstance(inp, dict):
        return {"value": clip(str(inp), 1500, 300)}
    out = {}
    for k, v in inp.items():
        if k in ("content", "old_string", "new_string"):
            out[k] = clip(v if isinstance(v, str) else json.dumps(v), 6000, 1200)
        elif k == "edits" and isinstance(v, list):
            out[k] = [
                {"old_string": clip(e.get("old_string", ""), 3000, 600), "new_string": clip(e.get("new_string", ""), 3000, 600)}
                for e in v[:20]
                if isinstance(e, dict)
            ]
        elif isinstance(v, str):
            out[k] = clip(v, 3000, 600)
        else:
            s = json.dumps(v)
            out[k] = v if len(s) < 2000 else clip(s, 1500, 300)
    return out


def user_events(o, ev):
    msg = o.get("message") or {}
    content = msg.get("content")
    uid, ts = o.get("uuid"), o.get("timestamp")
    if o.get("isCompactSummary"):
        text = content if isinstance(content, str) else block_text(content)[0]
        ev.append({"k": "note", "id": uid, "ts": ts, "kind": "compact", "text": text})
        return
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
    texts, images = [], []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "tool_result":
            text, imgs = block_text(b.get("content"))
            ev.append({"k": "res", "id": b.get("tool_use_id"), "ts": ts, "text": clip(text), "err": bool(b.get("is_error")),
                       "images": len(imgs), "files": [f for f in imgs if f]})
        elif t == "text":
            texts.append(b.get("text", ""))
        elif t == "image":
            images.append(save_image(b))
    if o.get("isMeta"):
        return
    raw = "\n".join(texts)
    if not raw.strip() and not images:
        return
    text = REMINDER.sub("", raw).strip()
    if "<local-command-caveat>" in raw:
        return
    m = CMD_NAME.search(raw)
    if m:
        a = CMD_ARGS.search(raw)
        ev.append({"k": "cmd", "id": uid, "ts": ts, "name": m.group(1).strip(), "args": (a.group(1).strip() if a else "")})
        return
    m = LOCAL_OUT.search(raw)
    if m:
        out = ANSI.sub("", m.group(1)).strip()
        if out:
            ev.append({"k": "note", "id": uid, "ts": ts, "kind": "info", "text": out})
        return
    m = BASH_IN.search(raw)
    if m:
        ev.append({"k": "bash", "id": uid, "ts": ts, "cmd": m.group(1)})
        return
    if BASH_OUT.search(raw) or BASH_ERR.search(raw):
        out, err = BASH_OUT.search(raw), BASH_ERR.search(raw)
        ev.append({"k": "bashout", "id": uid, "ts": ts, "out": clip(out.group(1) if out else ""), "err": clip(err.group(1) if err else "")})
        return
    if raw.lstrip().startswith("<task-notification>"):
        s, st = SUMMARY.search(raw), STATUS.search(raw)
        label = (s.group(1) if s else "Background task update").strip()
        ev.append({"k": "note", "id": uid, "ts": ts, "kind": "task", "text": label, "status": (st.group(1).strip() if st else "")})
        return
    if text.startswith("[Request interrupted by user"):
        ev.append({"k": "note", "id": uid, "ts": ts, "kind": "interrupt", "text": "Interrupted"})
        return
    if not text and not images:
        return
    ev.append({"k": "user", "id": uid, "ts": ts, "text": text, "images": len(images), "files": [f for f in images if f]})


def assistant_events(o, ev, meta):
    msg = o.get("message") or {}
    uid, ts = o.get("uuid"), o.get("timestamp")
    model = msg.get("model")
    if model and model != "<synthetic>":
        meta["model"] = model
    u = msg.get("usage") or {}
    if u and model != "<synthetic>":
        ctx = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
        if ctx:
            meta["context"] = ctx
    if o.get("isApiErrorMessage"):
        text = block_text(msg.get("content"))[0]
        ev.append({"k": "note", "id": uid, "ts": ts, "kind": "error", "text": text or "API error"})
        return
    for i, b in enumerate(msg.get("content") or []):
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        bid = "%s:%d" % (uid, i)
        if t == "text":
            text = (b.get("text") or "").strip()
            if text and not (model == "<synthetic>" and text == "No response requested."):
                ev.append({"k": "text", "id": bid, "ts": ts, "text": text})
        elif t == "thinking":
            text = (b.get("thinking") or "").strip()
            if text:
                ev.append({"k": "think", "id": bid, "ts": ts, "text": clip(text, 8000, 1000)})
        elif t == "tool_use" or t == "server_tool_use":
            ev.append({"k": "tool", "id": b.get("id") or bid, "ts": ts, "name": b.get("name") or "tool", "input": slim_input(b.get("name"), b.get("input"))})


def parse(line, ev, meta):
    # The biggest lines are request records nobody reads; skip them before parsing.
    head = line[:48]
    if head.startswith('{"type":"api-request') or head.startswith('{"type":"prompt'):
        return
    try:
        o = json.loads(line)
    except ValueError:
        return
    t = o.get("type")
    if o.get("isSidechain"):
        return
    if o.get("gitBranch"):
        meta["branch"] = o["gitBranch"]
    if o.get("cwd"):
        meta["cwd"] = o["cwd"]
    if t == "user":
        user_events(o, ev)
    elif t == "assistant":
        assistant_events(o, ev, meta)
    elif t == "ai-title":
        meta["ai_title"] = o.get("aiTitle")
    elif t == "custom-title":
        meta["title"] = o.get("customTitle")
    elif t == "summary" and o.get("summary"):
        meta.setdefault("summary", o.get("summary"))
    elif t == "attachment":
        a = o.get("attachment") or {}
        if a.get("type") == "queued_command" and (a.get("origin") or {}).get("kind", "human") == "human":
            text = a.get("prompt")
            if isinstance(text, list):
                text = block_text(text)[0]
            if text:
                ev.append({"k": "user", "id": o.get("uuid"), "ts": o.get("timestamp") or a.get("timestamp"), "text": REMINDER.sub("", text).strip(), "queued": True})
    elif t == "system":
        st = o.get("subtype")
        uid, ts = o.get("uuid"), o.get("timestamp")
        if st == "turn_duration" and o.get("durationMs"):
            ev.append({"k": "dur", "id": uid, "ts": ts, "ms": o["durationMs"]})
        elif st == "compact_boundary":
            ev.append({"k": "note", "id": uid, "ts": ts, "kind": "compact", "text": ""})
        elif st == "away_summary" and o.get("content"):
            ev.append({"k": "note", "id": uid, "ts": ts, "kind": "recap", "text": re.sub(r"\s*\(disable recaps in /config\)\s*$", "", o["content"])})
        elif st == "scheduled_task_fire" and o.get("content"):
            ev.append({"k": "note", "id": uid, "ts": ts, "kind": "info", "text": o["content"]})
        elif st == "api_error" or o.get("level") == "error":
            text = o.get("content") or ((o.get("error") or {}).get("message") if isinstance(o.get("error"), dict) else None)
            if text:
                ev.append({"k": "note", "id": uid, "ts": ts, "kind": "error", "text": str(text)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", default="")
    ap.add_argument("--cwd", default="")
    ap.add_argument("--path", default="")
    ap.add_argument("--offset", type=int, default=0)
    a = ap.parse_args()

    path, session = resolve(a.pid, a.cwd, a.path)
    out = {"path": path, "session": (session or {}).get("sessionId"), "name": (session or {}).get("name"), "events": [], "meta": {}}
    if not path:
        out["error"] = "no-transcript"
        print(json.dumps(out))
        return
    size = os.path.getsize(path)
    offset = a.offset if (path == a.path and 0 <= a.offset <= size) else 0
    out["reset"] = offset == 0
    ev, meta = [], {}
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1
    for raw in data[:end].split(b"\n"):
        if raw:
            parse(raw.decode("utf-8", "replace"), ev, meta)
    out["offset"] = offset + end
    out["size"] = size
    out["meta"] = meta

    text = json.dumps(out | {"events": ev}, separators=(",", ":"))
    dropped = 0
    while len(text) > OUT_BUDGET and len(ev) > 50:
        n = len(ev) // 4
        ev = ev[n:]
        dropped += n
        text = json.dumps(out | {"events": ev, "dropped": dropped}, separators=(",", ":"))
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
