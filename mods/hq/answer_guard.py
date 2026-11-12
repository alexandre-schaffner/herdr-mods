"""Stop hook for masters and managers: a turn the person started ends with an answer they can see.

A heartbeat turn ends when ScheduleWakeup returns, so a model that thinks its answer and then
arms the heartbeat leaves the person with nothing (thinking isn't shown). At Stop, when the
person wrote in this turn and no text has been written since, this blocks the stop once and
asks for the answer as plain text. `stop_hook_active` (the model already continued for this
hook) always lets it stop, so it can't loop.

Wired by master.py and hq.py through `--settings` (SETTINGS below), so it runs only in HQ's
sessions. Reads the hook's JSON on stdin; prints a block decision or nothing.
"""

import json
import os
import re
import sys

TAIL = 4 << 20  # a turn's records are near the end; a long one still fits
# Lines HQ, its autopilot and master.py type in on their own: not the person (see claude-model.js).
ORG = re.compile(r"^(?:HQ TICK\b|HQ MAIL\b|HQ WATCH\b|HQ LOOP\b|HQ ESCALATION\b|/loop master tick\b|(?:FYI )?HQ DECISION\b|HQ WORKFLOW REQUEST\b|WORKFLOW REPORT\b|Resume workflow run\b|HQ:|/compact\s*$|"
                 r"You are this repository's master chat\b|You were restarted\. Read your handoff\b)")


def settings():
    """The `--settings` file that wires this hook into a session (written beside this script,
    since its path is the app's home): a path, so the launch argv carries no JSON to quote."""
    cmd = f"python3 -I {json.dumps(os.path.abspath(__file__))}"
    # And watch_hook.py: files the background commands and Monitors the agent starts (HQ > Loops).
    watch = f"python3 -I {json.dumps(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'watch_hook.py'))}"
    text = json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd, "timeout": 10}]}],
                                 "PostToolUse": [{"matcher": "Bash|Monitor", "hooks": [{"type": "command", "command": watch, "timeout": 5}]}]}},
                      indent=2) + "\n"
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "answer-guard.settings.json")
    try:
        with open(path, encoding="utf-8") as f:
            same = f.read() == text
    except OSError:
        same = False
    if not same:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return path


def records(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL))
        data = f.read()
    if size > TAIL:
        data = data[data.find(b"\n") + 1:]
    for raw in data.split(b"\n"):
        if raw.strip():
            try:
                yield json.loads(raw)
            except ValueError:
                continue


def person_text(o):
    """What the person typed in this record, or None (tool results, other agents, HQ's lines)."""
    if o.get("isSidechain") or o.get("isMeta"):
        return None
    if o.get("type") == "attachment":
        a = o.get("attachment") or {}
        if a.get("type") != "queued_command" or (a.get("origin") or {}).get("kind", "human") != "human":
            return None
        text = a.get("prompt")
    elif o.get("type") == "user":
        c = (o.get("message") or {}).get("content")
        if isinstance(c, list):
            if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                return None
            c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
        text = c
    else:
        return None
    if not isinstance(text, str):
        return None
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S).strip()
    # Tags are Claude Code's own (commands, task notifications) or another terminal's <hc> message.
    if not text or text.startswith("<") or ORG.match(text):
        return None
    return text


def unanswered(path):
    """The person's last message in the current turn when nothing was written after it."""
    asked, said = None, False
    for o in records(path):
        if o.get("type") == "system" and o.get("subtype") == "turn_duration":
            asked, said = None, False  # a turn ended: what follows is this one
            continue
        text = person_text(o)
        if text:
            asked, said = text, False
        elif asked and o.get("type") == "assistant" and not o.get("isSidechain"):
            for b in (o.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "text" and (b.get("text") or "").strip():
                    said = True
    return asked if asked and not said else None


def main():
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        return
    path = hook.get("transcript_path")
    if hook.get("stop_hook_active") or not path or not os.path.exists(path):
        return
    # Claude Code may not have flushed the final reply to the transcript yet: trust the hook input.
    if (hook.get("last_assistant_message") or "").strip():
        return
    asked = unanswered(path)
    if not asked:
        return
    quote = asked if len(asked) <= 200 else asked[:199] + "…"
    print(json.dumps({
        "decision": "block",
        "reason": f"The person asked: \"{quote}\" and this turn wrote no answer: they never see your thinking or tool calls. "
                  "Answer them now in plain text. Don't call ScheduleWakeup again; your heartbeat is already set.",
    }))


if __name__ == "__main__":
    main()
