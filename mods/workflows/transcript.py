"""One agent's session: its transcript as items, and its shell commands as a terminal."""

import json
import os
import re

from claude import ANSI, save_image
from jsonl import TAIL, clip_text, head_lines, one_line, tail_lines, ts_ms
from runs import run_dirs, tool_summary



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


def tool_result_images(block):
    """Files for the images a tool returned (screenshots, an image it read)."""
    c = block.get("content")
    if not isinstance(c, list):
        return []
    files = (save_image(x) for x in c if isinstance(x, dict) and x.get("type") == "image")
    return [f for f in files if f]


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
