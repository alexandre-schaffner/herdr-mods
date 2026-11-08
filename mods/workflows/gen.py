"""Generating a workflow with a coding agent CLI in the background: start, poll, cancel."""

import glob
import json
import os
import re
import time

from jsonl import one_line, parse_line
from runs import tool_summary


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


def cmd_gen_cancel(job):
    import signal
    try:
        with open(os.path.join(job, "pid")) as f:
            os.killpg(int(f.read().strip()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    return {"ok": True}
