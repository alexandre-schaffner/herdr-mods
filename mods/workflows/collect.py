"""Reads Claude Code workflow runs for the herdr `workflows` mod. One JSON object on stdout.

  collect.py list [here]           every run, newest activity first
  collect.py run <runId>           one run: phases and agents
  collect.py agent <runId> <id>    one agent session: prompt, transcript tail, result
  collect.py shell <runId> <id>    one agent session as a terminal: its commands and their output
  collect.py script <runId>        the script a run executed
  collect.py resume-plan <runId>   who owns a stopped run, which terminal holds that session, and
                                   the argv that reopens it (the mod starts it with tab.new + task)
  collect.py resume <runId>        type the resume request into that session's terminal
  collect.py library <folder>...   saved workflows: ~/.claude/workflows and each folder's repo
  collect.py save <src> <dest> [replace] | delete <path>
  collect.py files <root> [query] | exists <root> <path>... | pick-start <out> <dir> | pick-poll <out>
  collect.py agents | gen-start <job> <cwd> <agent> [model] | gen-poll <job> | gen-cancel <job>
  --root <dir>                     read another projects folder (tests)
  --sessions <dir>                 read another sessions folder instead of every account's (tests)

A finished run has `<session>/workflows/<runId>.json` (a resumed run keeps the
earlier attempt's record until it ends; see runs.current_record). A live run has no JSON
yet, so it is rebuilt from its script (`workflows/scripts/*-<runId>.js`), each
agent's `.meta.json` and the head/tail of each transcript. Transcripts can
reach hundreds of MB, so they are never read whole.

The work is in the modules beside this file; Claude-wide helpers (sessions, terminals,
repos) are in ~/.config/herdr-app/shared, also used by the master and claude-reader mods.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(os.path.dirname(os.path.dirname(HERE)), "shared")]

import files  # noqa: E402
import gen  # noqa: E402
import library  # noqa: E402
import resume  # noqa: E402
import runs  # noqa: E402
import transcript  # noqa: E402


def cmd_script(run_id):
    d = runs.run_dirs().get(run_id)
    if not d:
        return {"script": None}
    doc = runs.read_json(os.path.join(runs.session_of(d), "workflows", run_id + ".json"))
    return {"script": (doc or {}).get("script") or runs.script_for(runs.session_of(d), run_id)}


# name → (handler, required argument count); the rest of the arguments are optional.
COMMANDS = {
    "list": (runs.cmd_list, 0),
    "run": (runs.cmd_run, 1),
    "agent": (transcript.cmd_agent, 2),
    "shell": (transcript.cmd_shell, 2),
    "script": (cmd_script, 1),
    "resume-plan": (resume.cmd_resume_plan, 1),
    "resume": (resume.cmd_resume, 1),
    "library": (lambda *folders: library.cmd_library(list(folders)), 0),
    "save": (library.cmd_save, 2),
    "delete": (library.cmd_delete, 1),
    "files": (files.cmd_files, 1),
    "exists": (lambda root, *paths: files.cmd_exists(root, list(paths)), 1),
    "pick-start": (files.cmd_pick_start, 2),
    "pick-poll": (files.cmd_pick_poll, 1),
    "agents": (gen.cmd_agents, 0),
    "gen-start": (gen.cmd_gen_start, 3),
    "gen-poll": (gen.cmd_gen_poll, 1),
    "gen-cancel": (gen.cmd_gen_cancel, 1),
}


def arity(handler):
    """How many arguments a handler takes (extras are ignored, as they always were)."""
    import inspect
    params = inspect.signature(handler).parameters.values()
    return None if any(p.kind == p.VAR_POSITIONAL for p in params) else len(params)


def main(argv):
    for flag in ("--root", "--sessions"):  # other folders, for tests
        if flag in argv:
            i = argv.index(flag)
            value = os.path.expanduser(argv[i + 1])
            if flag == "--root":
                runs.ROOT = value
            else:
                runs.SESSION_DIRS = [value]
            argv = argv[:i] + argv[i + 2:]
    cmd, args = (argv[1] if len(argv) > 1 else "list"), argv[2:]
    handler, need = COMMANDS.get(cmd, (None, 0))
    if not handler or len(args) < need:
        out = {"error": "usage: collect.py " + " | ".join(COMMANDS)}
    else:
        out = handler(*args[:arity(handler)])
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv)
