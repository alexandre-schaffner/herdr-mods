"""PostToolUse hook (Bash|Monitor) for masters and managers: a background command or a Monitor the
agent starts on its own is filed in HQ's watch registry, so HQ > Loops sees what it waits on
without reading its transcript.

It only records, never rewrites: the command runs exactly as the agent wrote it and as auto mode
reviewed it. A record holds the task id, the command, and where Claude Code writes its output;
watches.py decides from that whether it still runs (a process holds the output open; a monitor
until it times out). Wired through answer_guard.settings() with the Stop hook. Never fails the
tool call: any error is swallowed.
"""

import glob
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REG = os.path.join(os.path.dirname(os.path.dirname(HERE)), "data", "hq", "_watches")
TASK_ID = re.compile(r"(?:background with ID|task) ?:? (\w+)")


def output_file(hook, tid):
    """Where Claude Code writes the task's output: <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output."""
    sid, project = hook.get("session_id"), os.path.basename(os.path.dirname(hook.get("transcript_path") or ""))
    if not sid or not project:
        return None
    hits = glob.glob(os.path.join("/private/tmp", f"claude-{os.getuid()}", project, sid, "tasks", f"{tid}.output")) or \
        glob.glob(os.path.join("/tmp", f"claude-{os.getuid()}", project, sid, "tasks", f"{tid}.output"))
    return hits[0] if hits else None


def main():
    hook = json.load(sys.stdin)
    name, inp = hook.get("tool_name"), hook.get("tool_input") or {}
    if not (name == "Monitor" or (name == "Bash" and inp.get("run_in_background"))):
        return
    res = hook.get("tool_response")
    res = res if isinstance(res, dict) else {"text": str(res or "")}
    tid = res.get("backgroundTaskId") or res.get("taskId")
    if not tid:
        m = TASK_ID.search(json.dumps(res))
        tid = m and m.group(1)
    if not tid:
        return
    now = int(time.time() * 1000)
    timeout = res.get("timeoutMs") or inp.get("timeout_ms")
    rec = {"id": f"own-{tid}", "kind": "own", "tool": "monitor" if name == "Monitor" else "bash", "taskId": tid,
           "label": (inp.get("description") or inp.get("command") or "")[:200], "command": (inp.get("command") or "")[:2000],
           "createdAt": now, "state": "watching", "sessionId": hook.get("session_id"),
           "terminal": os.environ.get("HC_TERMINAL_ID") or os.environ.get("HC_TERMINAL") or os.environ.get("HERDR_TERMINAL"),
           "org": os.environ.get("HQ_ORG"), "cwd": hook.get("cwd"), "output": output_file(hook, tid),
           "persistent": bool(res.get("persistent")),
           "expiresAt": now + int(timeout) if name == "Monitor" and timeout and not res.get("persistent") else None}
    os.makedirs(REG, exist_ok=True)
    tmp = os.path.join(REG, f".{rec['id']}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f)
    os.replace(tmp, os.path.join(REG, f"{rec['id']}.json"))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001: a bookkeeping hook must never get in the agent's way
        pass
