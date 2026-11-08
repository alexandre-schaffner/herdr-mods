"""Resume: a stopped run, restarted by its own session.

Resume is a Workflow tool call inside the session that owns the run, so the mod types a
request into that session's terminal (the Herdr terminal whose shell runs that claude).
With the session gone, the mod reopens it itself: tab.new with openArgv and the request as task."""

from claude import resume_argv, shows_session, terminal_brief, terminals
from repos import repo_of
from runs import RESUMABLE, run_dirs, session_cwd, session_procs, summarize


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
    terminal = next((terminal_brief(t) for t in terminals() if shows_session(t, proc)), None) if alive else None
    return {
        "runId": run_id, "status": s["status"], "resumable": s["status"] in RESUMABLE and bool(s["scriptPath"]),
        "sessionId": s["sessionId"], "scriptPath": s["scriptPath"],
        "cwd": (proc or {}).get("cwd") or session_cwd(run_dir) or s.get("cwd"),
        "session": {"pid": (proc or {}).get("pid"), "name": (proc or {}).get("name"), "alive": alive},
        "master": s["owner"]["master"], "repoPath": (repo_of(session_cwd(run_dir) or s.get("cwd")) or {}).get("path"),
        "terminal": terminal, "text": resume_text(run_id, s["scriptPath"]),
        "openArgv": resume_argv(s["sessionId"], (proc or {}).get("configDir")),
        "openCommand": f"claude --resume {s['sessionId']}",
    }


def cmd_resume(run_id):
    """Types the resume request into the owning session's terminal. Re-checks the run first.
    A session that is gone is reopened by the mod itself (tab.new with openArgv and the text as task)."""
    import subprocess
    plan = cmd_resume_plan(run_id)
    if plan.get("error"):
        return plan
    if not plan["resumable"]:
        return {"error": f"run {run_id} is {plan['status']}; only stalled, killed or failed runs are resumed"}
    target = plan["terminal"]
    if not target:
        return {"error": "no live terminal holds session " + plan["sessionId"][:8], "plan": plan}
    try:
        r = subprocess.run(["hc", "send", target["address"], plan["text"]], capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": f"hc send failed: {e}"}
    if r.returncode != 0:
        return {"error": f"hc send {target['address']}: " + ((r.stderr or r.stdout).strip()[-300:] or str(r.returncode))}
    return {"ok": True, "terminal": target, "text": plan["text"]}
