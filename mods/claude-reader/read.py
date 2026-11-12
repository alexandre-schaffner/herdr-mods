"""Claude Code transcript → compact events, read incrementally.

  python3 -I read.py --pid <pid> --cwd <dir> [--path <jsonl>] [--offset <bytes>] [--resolve]

With --resolve (or without a --path that exists), finds the session a terminal runs (`pid`: its shell or claude itself; the claude under it,
named by any account's sessions/<pid>.json or else its `--session-id`/`--resume` argument →
projects/<slug>/<sessionId>.jsonl, else the folder's newest transcript no running claude owns),
parses the lines after `offset` and prints one JSON object: the events, the new offset
and session facts. Finding the session reads the whole process table, so a caller that
already knows the path resolves it only now and then (a /clear starts a new transcript).
Only complete lines are consumed, so a line being written is read on the next call. Big
tool outputs are clipped. A first read takes the transcript from its end, backward, until
its events fill the budget: a long session's transcript runs to hundreds of MB, and is
never parsed or held whole (`truncated`: older lines weren't read).
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "shared"))
from claude import ANSI, PROJECTS, claimed_sessions, find_transcript, keep_image, save_image, session_of, slug  # noqa: E402

OUT_BUDGET = 1_200_000  # what a chat loads at once; the mods' script memory is small and shared
RESULT_HEAD, RESULT_TAIL = 2600, 900
TAIL_STEP = 2 << 20  # a first read's first chunk from the end; each next one doubles

REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
PASTED = re.compile(r"</?pasted_content[^>]*>")
# Claude Code's stand-ins for an attached picture: "[Image #N]" where it sat, "[Image: source: <path>]" after it
IMAGE_MARK = re.compile(r"\[Image #\d+\]\s*|\[Image: source: [^\]\n]*\]\s*")
# A picture named by its absolute path (a message HQ sent, a file dropped on a terminal): quoted,
# or bare with its spaces escaped. Claude Code doesn't always turn these into images.
_EXT = r"\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp)"
IMAGE_PATH = re.compile(r'"((?:/|~/)[^"\n]*?%s)"|\'((?:/|~/)[^\'\n]*?%s)\'|(?<!\S)((?:/|~/)(?:\\ |[^\s"\'])+?%s)(?!\S)' % (_EXT, _EXT, _EXT), re.I)


def said(raw):
    """A user message's words, and the pictures it names by path (kept, or None once gone)."""
    named = []

    def take(m):
        p = m.group(1) or m.group(2) or m.group(3).replace("\\ ", " ")
        named.append(keep_image(p))
        return "\0"

    text = IMAGE_PATH.sub(take, IMAGE_MARK.sub("", PASTED.sub("", REMINDER.sub("", raw))))
    return re.sub(r"[ \t]*\0[ \t]*", " ", text).strip(), named
TAG = lambda name: re.compile(r"<%s>(.*?)</%s>" % (name, name), re.S)
CMD_NAME, CMD_ARGS = TAG("command-name"), TAG("command-args")
LOCAL_OUT = TAG("local-command-stdout")
BASH_IN, BASH_OUT, BASH_ERR = TAG("bash-input"), TAG("bash-stdout"), TAG("bash-stderr")
SUMMARY, STATUS = TAG("summary"), TAG("status")
TOOL_ID = TAG("tool-use-id")
HANDBACK = re.compile(r'<agent-message from="([^"]+)">\s*\[Subagent hand-back\][^\n]*\n(?:.*?The report follows:\n)?(.*?)(?:</agent-message>|$)', re.S)
def newest(folder):
    """The folder's newest transcript that no running claude owns: a terminal whose session
    can't be named (claude exited) may show its last one, never another live session's."""
    taken = claimed_sessions()
    try:
        files = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".jsonl") and n[:-6] not in taken]
    except OSError:
        return None
    return max(files, key=os.path.getmtime) if files else None


def resolve(pid, cwd, given, again):
    if given and not again and os.path.exists(given):
        return given, None
    s = session_of([int(pid)]) if str(pid).isdigit() else None
    if s:
        # A known session with no transcript yet shows nothing rather than a neighbour's.
        return find_transcript(s["sessionId"], s.get("cwd") or cwd), s
    if given and os.path.exists(given):
        return given, None
    if cwd:
        return newest(os.path.join(PROJECTS, slug(cwd))), None
    return None, None


def clip(text, head=RESULT_HEAD, tail=RESULT_TAIL):
    text = ANSI.sub("", text or "")
    if len(text) <= head + tail + 40:
        return text
    cut = len(text) - head - tail
    return "%s\n… %d more characters …\n%s" % (text[:head], cut, text[-tail:])


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
        elif k == "todos" and isinstance(v, list):
            out[k] = [{"content": clip(str(x.get("content", "")), 300, 0), "activeForm": clip(str(x.get("activeForm", "")), 300, 0),
                       "status": x.get("status")} for x in v[:60] if isinstance(x, dict)]
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
    raw = "\n".join(texts)
    if o.get("isMeta"):
        # A background agent's final report, handed back as a hidden message: it starts the turn
        # that answers it (see task_note).
        m = HANDBACK.search(raw)
        if m:
            report = "\n".join(l[2:] if l.startswith("  ") else l for l in m.group(2).strip().split("\n"))
            ev.append({"k": "note", "id": uid, "ts": ts, "kind": "task", "text": "A background agent reported back", "agent": m.group(1),
                       "report": clip(report, 6000, 1500)})
        return
    if not raw.strip() and not images:
        return
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
        ev.append(task_note(raw, uid, ts))
        return
    # A long paste arrives wrapped in <pasted_content>: the words are what was said.
    text, named = said(raw)
    images += named
    if text.startswith("[Request interrupted by user"):
        ev.append({"k": "note", "id": uid, "ts": ts, "kind": "interrupt", "text": "Interrupted"})
        return
    if not text and not images:
        return
    ev.append({"k": "user", "id": uid, "ts": ts, "text": text, "images": len(images), "files": [f for f in images if f]})


def task_note(raw, uid, ts):
    """Background work reporting back: what finished, and the tool call that started it."""
    s, st, tid = SUMMARY.search(raw), STATUS.search(raw), TOOL_ID.search(raw)
    return {"k": "note", "id": uid, "ts": ts, "kind": "task", "text": (s.group(1) if s else "Background task update").strip(),
            "status": (st.group(1).strip() if st else ""), "tool": (tid.group(1).strip() if tid else None)}


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
    elif t == "permission-mode" and o.get("permissionMode"):
        meta["permissionMode"] = o["permissionMode"]
    elif t == "ai-title":
        meta["ai_title"] = o.get("aiTitle")
    elif t == "custom-title":
        meta["title"] = o.get("customTitle")
    elif t == "summary" and o.get("summary"):
        meta.setdefault("summary", o.get("summary"))
    elif t == "attachment":
        a = o.get("attachment") or {}
        kind = (a.get("origin") or {}).get("kind", "human")
        if a.get("type") == "queued_command" and kind == "task-notification" and isinstance(a.get("prompt"), str):
            ev.append(task_note(a["prompt"], o.get("uuid"), o.get("timestamp") or a.get("timestamp")))
        elif a.get("type") == "queued_command" and kind == "human":
            text = a.get("prompt")
            if isinstance(text, list):
                text = block_text(text)[0]
            if text:
                words, named = said(text)
                ev.append({"k": "user", "id": o.get("uuid"), "ts": o.get("timestamp") or a.get("timestamp"), "text": words, "queued": True,
                           "images": len(named), "files": [f for f in named if f]})
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


def parse_lines(data, meta):
    ev = []
    for raw in data.split(b"\n"):
        if raw:
            parse(raw.decode("utf-8", "replace"), ev, meta)
    return ev


def read_tail(f, size):
    """A first read: the newest complete lines whose events fill the budget, read backward in
    chunks that double. → (events, meta, end offset, whether it reached the start)."""
    hi = lo = size
    step, end, carry = TAIL_STEP, None, b""
    parts, meta, est = [], {}, 0
    while lo > 0 and est < OUT_BUDGET:
        lo = max(0, lo - step)
        step *= 2
        f.seek(lo)
        data = f.read(hi - lo) + carry
        hi, carry = lo, b""
        if end is None:
            cut = data.rfind(b"\n") + 1
            if not cut:
                continue  # all of it is a last line still being written
            end, data = lo + cut, data[:cut]
        if lo > 0:
            # The chunk starts inside a line: that part goes with the chunk before it.
            nl = data.find(b"\n") + 1
            carry, data = data[:nl], data[nl:]
        older = {}
        ev = parse_lines(data, older)
        parts.append(ev)
        est += sum(len(json.dumps(e)) for e in ev)
        for k, v in older.items():
            if k == "summary" or k not in meta:  # the newest wins, but the summary is the first one
                meta[k] = v
    return [e for ev in reversed(parts) for e in ev], meta, end or 0, lo == 0


def args(argv):
    """The flags (see the top). Not argparse: this runs every second or so while a chat shows,
    and argparse is a third of its start-up."""
    a = {"pid": "", "cwd": "", "path": "", "offset": 0, "resolve": False}
    it = iter(argv)
    for k in it:
        name = k[2:]
        if name == "resolve":
            a["resolve"] = True
        elif name in a:
            v = next(it, "")
            a[name] = int(v or 0) if name == "offset" else v
    return a


def main():
    a = args(sys.argv[1:])
    path, session = resolve(a["pid"], a["cwd"], a["path"], a["resolve"])
    s = session or {}
    # config: the account the session runs under (its models, see models.py).
    out = {"path": path, "session": s.get("sessionId"), "name": s.get("name"), "config": s.get("configDir"), "events": [], "meta": {}}
    if not path:
        out["error"] = "no-transcript"
        print(json.dumps(out))
        return
    size = os.path.getsize(path)
    offset = a["offset"] if (path == a["path"] and 0 <= a["offset"] <= size) else 0
    out["reset"] = offset == 0
    with open(path, "rb") as f:
        if offset == 0:
            ev, meta, end, whole = read_tail(f, size)
            out["truncated"] = not whole
        else:
            f.seek(offset)
            data = f.read()
            cut = data.rfind(b"\n") + 1
            meta = {}
            ev = parse_lines(data[:cut], meta)
            end = offset + cut
    out["offset"] = end
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
