"""Workflow owners: every workflow the person runs gets its own Claude session, the owner.
The master spawns it, the owner starts the run, watches it, resumes it when it stalls, and
reports to the master when it ends. The master's context stays on coordination, and the run
has a session that lives exactly as long as it does (only the session that started a run can
resume it). hq.py calls in here; `H` is the hq module (its helpers: paths, herdr, hc_ls, ...).

  requested   the person asked (Workflows editor > Run, or `hq workflow-request`); the master
              hasn't spawned the owner yet
  starting    the owner runs but hasn't started the Workflow yet
  running | stalled | completed | failed | killed   the run's own state (the Workflows mod's runs.py)
  closed      the master (or the person) closed the owner after the result was relayed

State: data/hq/<repo>/workflows.json, and per owner data/hq/<repo>/workflows/<id>/{brief.md,report.md}.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
import time
import uuid

LABEL = "herdr.hq.workflow"
SPACE = "workflows"
MODEL = "sonnet"  # an owner mostly starts, resumes and reports on a run
RECENT_MS = 3 * 24 * 3600_000  # other org runs older than this aren't shown
ENDED = ("completed", "failed", "killed")

DEFAULT_BRIEF = """# Workflow owner: {name}

You own one workflow run in {repo}'s org. The person asked for it from Herdr, the master chat
({master}) handed it to you, and you report back to the master when it ends. This session
exists for this run only: take on no other work.

## The run
- Start it now: {call}
- Working folder: {folder}
- From the master: {note}

The person asked for this run themselves, so you have their opt-in to the Workflow tool for it.

## While it runs
- The Workflow tool runs in the background and wakes you when the run ends. Don't poll it and
  don't start a second run.
- If the run stalls, is killed without anyone asking, or fails on something transient (a crash,
  a timeout, a rate limit, a lost session), resume it: `Workflow({{scriptPath, resumeFromRunId}})`
  with the run's script path and id. Resume at most twice; after that, report instead.
- Outward-facing actions need the person's approval. Read {policy}. File
  `hq ask approval ...` or `hq ask question ...` for those, then tell the master in one line:
  `hq tell "WORKFLOW {id}: waiting on the person for <what>"` (its mailbox: never type into the
  master's terminal, the person talks to it there).
- If the master or the person messages you, answer briefly and keep going.

## When it ends
1. Read the run's result. Check its main claims against the files or PRs it names when that
   takes only a few tool calls. Don't redo the work.
2. Write a Markdown report to a file. The first line is the outcome in one sentence. After it:
   what the run produced (files, PRs, links), what failed or is left and why, and any
   `LESSON: ...` lines the master should keep in memory.
3. File it with `hq workflow-report {id} --status completed|partial|failed --body-file <file>`.
   HQ stores it, shows it to the person in HQ > Workflows, and sends the master a one-line summary.
4. Then wait. The master closes this session once it has relayed the result. If it asks a
   follow-up, answer it.

## Your headquarters (HQ)
The person follows this run in Herdr's HQ (Workflows): your status, the run's graph and your
report. HQ also acts on its own:
- Decisions come back typed into your terminal as `HQ DECISION <id> ...`: do exactly what was
  approved. `HQ: ...` lines are HQ telling you something: act on them.
- An `hc send` from you to the master is rerouted to its mailbox, like `hq tell`; `hc` into
  another org's terminals is refused.
- No loop and no heartbeat for you: the Workflow tool wakes you. Don't arm `/loop`.
- When the person writes to you directly, answer in text: a Stop hook sends a turn the person
  started back to you once if it ends without an answer.
- The person's own words (their messages, the standing orders, the policy) win over this brief.
"""


# ---- state

def state_path(H, repo):
    return os.path.join(H.paths(repo)["dir"], "workflows.json")


def owner_dir(H, repo, wid):
    return os.path.join(H.paths(repo)["dir"], "workflows", wid)


def brief_template(H, repo):
    """The owner brief template (HQ > Prompts), written with the default the first time."""
    p = os.path.join(H.paths(repo)["dir"], "workflow-owner.md")
    if not os.path.exists(p):
        H.write(p, DEFAULT_BRIEF)
    return p


def load(H, repo):
    d = H.claude.read_json(state_path(H, repo))
    d = d if isinstance(d, dict) else {}
    d.setdefault("owners", [])
    return d


def save(H, repo, d):
    H.write_json(state_path(H, repo), d)


def find(H, repo, wid):
    d = load(H, repo)
    for w in d["owners"]:
        if w["id"] == wid:
            return d, w
    H.fail(f"no workflow owner {wid}; `hq workflows` lists them")


def new_id(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "run").lower()).strip("-")[:28] or "run"
    return f"{slug}-{uuid.uuid4().hex[:4]}"


def flags(H, args, names, bools=()):
    o, i = {}, 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and a[2:] in bools:
            o[a[2:]] = True
            i += 1
        elif a.startswith("--") and a[2:] in names and i + 1 < len(args):
            o[a[2:]] = args[i + 1]
            i += 2
        else:
            o.setdefault("_", []).append(a)
            i += 1
    return o


def parse_args_json(H, text):
    if not text:
        return {}
    try:
        v = json.loads(text)
    except ValueError as e:
        H.fail(f"--args-json isn't JSON: {e}")
    if not isinstance(v, dict):
        H.fail("--args-json must be a JSON object")
    return v


# ---- the runs an owner (or the master, or a manager) started

def _runs_module(H):
    """The Workflows mod's run reader (mods/workflows/runs.py); None when it can't load."""
    wf = os.path.join(H.APP, "mods", "workflows")
    if wf not in sys.path:
        sys.path.append(wf)
    try:
        import runs  # noqa: PLC0415
        return runs
    except Exception:
        return None


def runs_of(H, sid, cache):
    """The workflow runs a session started, newest first, each as runs.summarize gives it."""
    if not sid:
        return []
    if sid in cache:
        return cache[sid]
    rm = _runs_module(H)
    out = []
    for d in glob.glob(os.path.join(H.claude.PROJECTS, "*", sid, "subagents", "workflows", "wf_*")):
        rid = os.path.basename(d)
        try:
            s = rm.summarize(rid, d) if rm else None
        except Exception as e:  # one unreadable run must not hide the rest
            s = {"id": rid, "status": "unreadable", "error": str(e)}
        if s is None:
            s = {"id": rid, "status": "unknown"}
        keep = ("id", "name", "status", "startedAt", "endedAt", "agents", "done", "failed", "phases", "error", "scriptPath")
        r = {k: s.get(k) for k in keep}
        r["live"] = (s.get("liveness") or {}).get("text")
        out.append(r)
    out.sort(key=lambda r: r.get("startedAt") or 0, reverse=True)
    cache[sid] = out
    return out


# ---- the picture

def terminal_of(H, addr):
    for t in H.hc_ls():
        if t["address"] == addr:
            return t
    return None


def view(H, repo, w, cache, now):
    t = terminal_of(H, w.get("terminal")) if w.get("terminal") else None
    runs = runs_of(H, w.get("sessionId"), cache) if w.get("terminal") else []
    run = runs[0] if runs else None
    status = w.get("status") or "requested"
    if status not in ("requested", "closed"):
        status = (run or {}).get("status") or ("starting" if t else "gone")
    report = H.read(os.path.join(owner_dir(H, repo, w["id"]), "report.md"), "") if w.get("reportedAt") else ""
    return {**w, "status": status, "run": run, "runs": runs, "owner": {
        "live": bool(t), "state": H.status_of(t) if t else None, "where": (t or {}).get("where"), "turn": (t or {}).get("turn")},
        "report": report[:20000], "headline": headline(report), "ageMs": now - (w.get("createdAt") or now)}


def headline(report):
    for line in (report or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return H_clip(line, 200)
    return None


def H_clip(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def org_sessions(H, repo):
    """Session ids in the org that start runs themselves: the master and each manager."""
    out = {}
    m = H.claude.masters().get(repo["key"]) or {}
    if m.get("sessionId"):
        out[m["sessionId"]] = "master"
    for mg in H.org(repo)["managers"]:
        if mg.get("sessionId") and mg.get("status") != "retired":
            out[mg["sessionId"]] = mg["id"]
    return out


def signals(views, now):
    sig = []

    def add(level, w, text, terminal=None, action=None):
        sig.append({"level": level, "who": f"workflow {w['name']}", "text": text, "terminal": terminal,
                    "action": action or f"workflow:{w['id']}"})

    for w in views:
        st, o, addr = w["status"], w["owner"], w.get("terminal")
        if st in ("requested", "closed"):
            if st == "requested" and w["ageMs"] > 10 * 60_000:
                add("warn", w, f"Asked for {w['ageMs'] // 60000} min ago; the master hasn't spawned its owner yet.")
            continue
        elif not o["live"] and st not in ENDED:
            add("alert", w, "Its owner session is gone while the run isn't finished. Resume it from the Workflows panel, or ask the master.")
        elif o["state"] == "blocked":
            add("alert", w, "Its owner waits on a question in its terminal.", addr, "focus")
        elif st == "stalled":
            add("warn", w, f"The run stalled: {(w.get('run') or {}).get('live') or 'no progress'}.", addr, "peek")
        elif st in ENDED and not w.get("reportedAt") and now - ((w.get("run") or {}).get("endedAt") or now) > 10 * 60_000:
            add("warn", w, "The run ended but its owner hasn't reported yet.", addr, "peek")
    return sig


def snapshot(H, repo, now=None):
    """HQ's Workflows section: the owners, the other runs the org started, counts, signals."""
    now = now or H.NOW()
    brief_template(H, repo)
    d = load(H, repo)
    cache = {}
    views = [view(H, repo, w, cache, now) for w in d["owners"]]
    views.sort(key=lambda w: (w["status"] == "closed", -(w.get("createdAt") or 0)))
    owned = {w.get("sessionId") for w in views}
    others = []
    for sid, who in org_sessions(H, repo).items():
        if sid in owned:
            continue
        for r in runs_of(H, sid, cache):
            if r["status"] == "running" or now - (r.get("endedAt") or r.get("startedAt") or 0) < RECENT_MS:
                others.append({**r, "by": who, "sessionId": sid})
    others.sort(key=lambda r: (r["status"] != "running", -(r.get("endedAt") or r.get("startedAt") or 0)))
    sig = signals(views, now)
    live = [w for w in views if w["status"] != "closed"]
    counts = {
        "requested": sum(1 for w in live if w["status"] == "requested"),
        "running": sum(1 for w in live if w["status"] in ("starting", "running")) + sum(1 for r in others if r["status"] == "running"),
        "attention": sum(1 for s in sig if s["level"] != "info"),
        "unrelayed": sum(1 for w in live if w.get("reportedAt")),
    }
    return {"owners": views[:60], "others": others[:30], "counts": counts, "signals": sig,
            "briefPath": brief_template(H, repo), "space": d.get("space")}


def terminals(H, repo):
    """Owner terminals, so `hq discover` doesn't offer them as managers."""
    return {w.get("terminal") for w in load(H, repo)["owners"] if w.get("terminal")}


def role_of(H, repo, addr):
    for w in load(H, repo)["owners"]:
        if addr and w.get("terminal") == addr and w.get("status") != "closed":
            return f"workflow:{w['id']}"
    return None


def tick_lines(H, repo, since):
    """The master's digest: requests to spawn, results to relay, runs in trouble, runs in flight."""
    snap = snapshot(H, repo)
    lines = []
    for w in snap["owners"]:
        st, name, wid = w["status"], w["name"], w["id"]
        if st == "requested":
            lines.append(f"- Workflow request [{wid}] '{name}' from {w.get('requestedBy') or 'the person'} waits for you: "
                         f"`hq workflow-launch {wid}` (add --note \"<context>\" if you have some).")
        elif st == "closed":
            continue
        elif w.get("reportedAt"):
            fresh = " (new)" if w["reportedAt"] > since else ""
            lines.append(f"- Workflow [{wid}] '{name}' reported{fresh} {w.get('reportStatus') or st}: {w.get('headline') or '(no headline)'}. "
                         f"Relay it to the person (Home, or `hq done` if it's worth a look), save its LESSON lines, "
                         f"then `hq workflow-close {wid}`. Report: `hq workflow-show {wid}`.")
        else:
            r = w.get("run") or {}
            prog = f"{r.get('done') or 0}/{r.get('agents') or 0} agents" if r else "not started yet"
            lines.append(f"- Workflow [{wid}] '{name}' {st} ({prog}), owner {w.get('terminal')} {w['owner']['state'] or 'gone'}.")
    for s in snap["signals"]:
        lines.append(f"- {s['level'].upper()} {s['who']}{' (' + s['terminal'] + ')' if s.get('terminal') else ''}: {s['text']}")
    return lines


# ---- commands

def who(H, repo, by):
    if by:
        return by
    me = H.who_am_i(repo)
    return me.get("role") or me.get("terminal") or "person"


def tell_master(H, repo, text, start=False, space=""):
    """Sends the master a message: `hc send` while it runs, master.py open (starts it, and
    shows it) only when `start`. Returns where it went, or why it didn't."""
    mt, _ = H.master_terminal(repo)
    if mt:
        if H.status_of(mt) == "blocked":
            return {"sent": False, "why": f"the master ({mt['address']}) is waiting on you in its terminal; it picks this up on its next tick"}
        code, so, se = H.run(["hc", "send", mt["address"], text], timeout=25)
        if code != 0:
            return {"sent": False, "why": (se or so).strip()[-300:] or "hc send failed"}
        return {"sent": True, "address": mt["address"]}
    if not start:
        return {"sent": False, "why": "the master isn't running; it picks this up from `hq tick` when it starts"}
    code, so, se = H.run(["python3", "-I", os.path.join(H.APP, "mods", "master", "master.py"), "open", repo["path"], space or "", text], timeout=60)
    try:
        o = json.loads(so or "{}")
    except ValueError:
        o = {"error": (se or so).strip()[-300:]}
    if o.get("error"):
        return {"sent": False, "why": o["error"]}
    return {"sent": True, "address": o.get("address"), "started": o.get("started")}


def describe(w):
    what = f"the saved workflow \"{w['name']}\"" if w.get("source") == "name" else f"the workflow script {w.get('script')}"
    args = f" with args {json.dumps(w['args'])}" if w.get("args") else ""
    return f"{what}{args} in {w['folder']}"


def make(H, repo, o, by):
    name, script = o.get("name"), o.get("script")
    if not name and not script:
        H.fail("give --name <saved workflow> or --script <file>")
    if script:
        script = os.path.realpath(os.path.expanduser(script))
        if not os.path.isfile(script):
            H.fail(f"no script at {script}")
    folder = os.path.realpath(os.path.expanduser(o.get("folder") or repo["path"]))
    if not os.path.isdir(folder):
        H.fail(f"no folder {folder}")
    w = {"id": new_id(name or os.path.basename(script).rsplit(".", 1)[0]), "name": name or os.path.basename(script).rsplit(".", 1)[0],
         "source": "name" if name else "script", "script": script, "args": parse_args_json(H, o.get("args-json")),
         "folder": folder, "note": o.get("note") or "", "requestedBy": who(H, repo, o.get("by")), "createdAt": H.NOW(),
         "status": "requested"}
    return w


REQUEST_FLAGS = ("name", "script", "args-json", "folder", "note", "by", "space")


def cmd_request(H, repo, args):
    """The person's run, handed to the master: recorded as requested, then the master is told
    to spawn its owner (HQ > Workflows shows it waiting meanwhile)."""
    o = flags(H, args, REQUEST_FLAGS, ("json",))
    w = make(H, repo, o, o.get("by"))
    d = load(H, repo)
    d["owners"].append(w)
    save(H, repo, d)
    H.log_activity(repo, "workflow", f"Asked to run {w['name']}", id=w["id"], by=w["requestedBy"])
    msg = (f"HQ WORKFLOW REQUEST [{w['id']}]: {w['requestedBy'] if w['requestedBy'] != 'person' else 'the person'} wants to run "
           f"{describe(w)}. Spawn its owner with `hq workflow-launch {w['id']}` (add --note \"<what the owner should know>\" "
           f"when your memory or the org has context for it), note it in your handoff, and carry on. The owner reports back "
           f"to you when the run ends.")
    told = tell_master(H, repo, msg, start=True, space=o.get("space") or "")
    if o.get("json"):
        return H.out({"ok": True, "id": w["id"], "master": told})
    print(f"{w['id']}  requested; " + (f"sent to the master ({told.get('address')})" if told["sent"] else f"not sent: {told['why']}"))


def compose_brief(H, repo, w):
    mt, _ = H.master_terminal(repo)
    master = (mt or {}).get("address") or "the master"
    if w["source"] == "name":
        args = f", args: {json.dumps(w['args'])}" if w.get("args") else ""
        call = f"`Workflow({{name: {json.dumps(w['name'])}{args}}})`."
        if w.get("script"):
            call += f" Its script is {w['script']}; if the name doesn't resolve, read that file and pass its contents as `script`."
    else:
        inside = w["script"].startswith(w["folder"].rstrip("/") + "/")
        args = f", args: {json.dumps(w['args'])}" if w.get("args") else ""
        call = (f"`Workflow({{scriptPath: {json.dumps(w['script'])}{args}}})`." if inside else
                f"read {w['script']} and pass its contents as `script` (`Workflow({{script, name: {json.dumps(w['name'])}{args}}})`); "
                f"the Workflow tool refuses a scriptPath outside your folder.")
    text = H.read(brief_template(H, repo), DEFAULT_BRIEF)
    fields = {"name": w["name"], "repo": repo["name"], "id": w["id"], "master": master, "policy": H.paths(repo)["policy"],
              "folder": w["folder"], "call": call, "note": w.get("note") or "(nothing more)"}
    try:
        body = text.format(**fields)
    except (KeyError, IndexError, ValueError):
        body = DEFAULT_BRIEF.format(**fields)
    return body.rstrip() + "\n\n" + H.style_section()


def space_id(H, d):
    """The owners' space: the one made for them while it exists, else none (a new one)."""
    sp = d.get("space")
    if sp and any(s.get("id") == sp for s in (H.herdr("ls").get("spaces") or [])):
        return sp
    return None


LAUNCH_FLAGS = ("note", "model", *REQUEST_FLAGS)


def cmd_launch(H, repo, args):
    """Spawns a run's owner: `hq workflow-launch <id>` for a request, or straight from
    --name/--script for a run of the master's own."""
    o = flags(H, args, LAUNCH_FLAGS)
    pos = o.get("_") or []
    d = load(H, repo)
    if pos:
        w = next((x for x in d["owners"] if x["id"] == pos[0]), None)
        if not w:
            H.fail(f"no workflow request {pos[0]}; `hq workflows` lists them")
        if w.get("status") != "requested":
            H.fail(f"{w['id']} already has its owner ({w.get('terminal')}); talk to it with `hc send {w.get('terminal')} ...`")
        if o.get("note"):
            w["note"] = o["note"]
    else:
        w = make(H, repo, o, o.get("by"))
        d["owners"].append(w)
    sid = str(uuid.uuid4())
    folder = w["folder"]
    od = owner_dir(H, repo, w["id"])
    brief = os.path.join(od, "brief.md")
    H.write(brief, compose_brief(H, repo, w))
    model = o.get("model") or H.settings(repo).get("workflowOwnerModel") or MODEL
    # In the org like a manager: its hc goes through the wall, and its `hc send` to the master to the mailbox.
    argv = ["env", *H.guard.env(repo), "claude", "--model", model, "--permission-mode", "auto", "--session-id", sid, "--name", f"{w['name']} · workflow"]
    first = f"Run the workflow \"{w['name']}\" for the person: read {brief} in full and follow it."
    tab_name = w["name"][:24]
    herdr_args = ["--folder", folder, "--argv", json.dumps(argv), "--task", first]
    sp = space_id(H, d)
    try:
        made = (H.herdr("do", "tab.new", "--space", sp, "--name", tab_name, *herdr_args) if sp
                else H.herdr("do", "space.new", "--name", SPACE, "--tab", tab_name, *herdr_args))
    except RuntimeError as e:
        H.fail(str(e))
    addr = made.get("terminal")
    if not addr:
        H.fail("herdr made no terminal: " + json.dumps(made))
    if not sp:
        d["space"] = made.get("space") or next((s["id"] for s in H.herdr("ls").get("spaces") or []
                                                if any(t.get("id") == made.get("tab") for t in s.get("tabs") or [])), None)
    H.run(["hc", "label", addr, f"{LABEL}={w['id']}"])
    w.update({"status": "launched", "terminal": addr, "tab": made.get("tab"), "sessionId": sid, "model": model,
              "brief": brief, "launchedAt": H.NOW(), "launchedBy": who(H, repo, None)})
    save(H, repo, d)
    H.log_activity(repo, "workflow", f"Spawned the owner of {w['name']} in {addr}", id=w["id"], by=w["launchedBy"])
    print(f"{w['id']}  owner {addr} started in {folder}. It reports back with `hq workflow-report`; "
          f"close it with `hq workflow-close {w['id']}` once you've relayed the result.")


def cmd_report(H, repo, args):
    """The owner's report: stored, shown in HQ, and summed up to the master in one line."""
    o = flags(H, args, ("status", "body", "body-file"))
    pos = o.get("_") or []
    if not pos:
        H.fail("hq workflow-report <id> --status completed|partial|failed --body-file <file>")
    d, w = find(H, repo, pos[0])
    body = H.read(o["body-file"], "") if o.get("body-file") else (o.get("body") or "")
    if not body.strip():
        H.fail("the report is empty: pass --body-file <file> (Markdown; first line = the outcome)")
    st = o.get("status") or "completed"
    if st not in ("completed", "partial", "failed"):
        H.fail("--status is completed, partial or failed")
    H.write(os.path.join(owner_dir(H, repo, w["id"]), "report.md"), body)
    w.update({"reportedAt": H.NOW(), "reportStatus": st})
    save(H, repo, d)
    head = headline(body)
    H.log_activity(repo, "workflow", f"{w['name']} {st}: {head}", id=w["id"], by=f"workflow:{w['id']}")
    it = H.mbox.tell(H, repo, f"WORKFLOW REPORT [{w['id']}] '{w['name']}' {st}: {head} "
                              f"Full report: `hq workflow-show {w['id']}`. Close the owner with `hq workflow-close {w['id']}` once relayed.",
                     frm={"role": f"workflow:{w['id']}", "terminal": w.get("terminal")})
    print("Filed in the master's mailbox: " + ("HQ wakes it for this." if it["urgent"] else "it reads it on its next tick."))


def cmd_close(H, repo, args):
    """Closes an owner whose run is over: its tab goes, its record and report stay."""
    o = flags(H, args, (), ("force", "json"))
    pos = o.get("_") or []
    if not pos:
        H.fail("hq workflow-close <id> [--force]")
    d, w = find(H, repo, pos[0])
    v = view(H, repo, w, {}, H.NOW())
    if not o.get("force"):
        if v["status"] in ("starting", "running"):
            H.fail(f"its run is {v['status']}; let it end (or stop it in the Workflows panel), or pass --force")
        if v["owner"]["state"] in ("working", "blocked"):
            H.fail(f"its owner {w.get('terminal')} is {v['owner']['state']}; close it once it's idle, or pass --force")
    if v["owner"]["live"] and w.get("tab"):
        try:
            H.herdr("do", "tab.close", "--id", w["tab"], "--confirmed", "true")
        except RuntimeError:
            try:
                H.herdr("do", "terminal.kill", "--terminal", w["terminal"])
            except RuntimeError:
                pass
    w.update({"status": "closed", "closedAt": H.NOW(), "closedBy": who(H, repo, None), "finalStatus": v["status"]})
    save(H, repo, d)
    H.log_activity(repo, "workflow", f"Closed the owner of {w['name']}", id=w["id"], by=w["closedBy"])
    if o.get("json"):
        return H.out({"ok": True})
    print(f"Closed {w['id']}. Its report stays in HQ > Workflows.")


def cmd_drop(H, repo, args):
    """Drops a request that was never launched (the person changed their mind)."""
    pos = flags(H, args, (), ("json",)).get("_") or []
    if not pos:
        H.fail("hq workflow-drop <id>")
    d, w = find(H, repo, pos[0])
    if w.get("status") != "requested":
        H.fail(f"{w['id']} already has an owner; close it with `hq workflow-close {w['id']}`")
    d["owners"] = [x for x in d["owners"] if x["id"] != w["id"]]
    save(H, repo, d)
    H.log_activity(repo, "workflow", f"Dropped the request to run {w['name']}", id=w["id"], by=who(H, repo, None))
    H.out({"ok": True})


def cmd_list(H, repo, args):
    snap = snapshot(H, repo)
    rows = [w for w in snap["owners"] if "--all" in args or w["status"] != "closed"]
    if not rows:
        print("No workflow owners. The person's runs arrive as HQ WORKFLOW REQUEST messages; "
              "spawn one for a run of your own with `hq workflow-launch --name <workflow> [--args-json '{...}']`.")
    for w in rows:
        r = w.get("run") or {}
        prog = f"{r.get('done') or 0}/{r.get('agents') or 0}" if r else "-"
        print(f"{w['id']:28} {w['status']:10} {prog:6} {w.get('terminal') or '-':6} {w['name']}"
              + (f"  reported {w.get('reportStatus')}: {H_clip(w.get('headline') or '', 70)}" if w.get("reportedAt") else ""))
    for r in snap["others"]:
        print(f"{r['id']:28} {r['status']:10} {str(r.get('done') or 0) + '/' + str(r.get('agents') or 0):6} {'-':6} {r.get('name')}  (started by {r['by']})")


def cmd_show(H, repo, args):
    pos = flags(H, args, (), ("json",)).get("_") or []
    if not pos:
        H.fail("hq workflow-show <id>")
    _, w = find(H, repo, pos[0])
    v = view(H, repo, w, {}, H.NOW())
    if "--json" in args:
        return H.out(v)
    r = v.get("run") or {}
    print(f"{v['id']}: {describe(v)}\nStatus: {v['status']}" + (f" (run {r.get('id')}, {r.get('done') or 0}/{r.get('agents') or 0} agents)" if r else "")
          + f"\nOwner: {v.get('terminal') or '-'} {v['owner']['state'] or ('gone' if v.get('terminal') else '')}\n")
    print(v["report"] or "(no report yet)")


COMMANDS = {
    "workflow-request": cmd_request,
    "workflow-launch": cmd_launch,
    "workflow-report": cmd_report,
    "workflow-close": cmd_close,
    "workflow-drop": cmd_drop,
    "workflow-show": cmd_show,
    "workflows": cmd_list,
}

HELP = """Workflow owners (HQ > Workflows; each of the person's runs gets its own owner session):
  hq workflows [--all]             owners and their runs, plus runs the master and managers started
  hq workflow-launch <id> [--note "<context for the owner>"]   spawn the owner of a request
  hq workflow-launch --name W | --script F [--args-json '{...}'] [--folder F] [--note N]
                                   spawn an owner for a run of your own
  hq workflow-show <id>            its status and the owner's report
  hq workflow-close <id> [--force] close the owner once its result is relayed (the report stays)
  hq workflow-drop <id>            drop a request that was never launched
  hq workflow-request --name W | --script F [--args-json J] [--folder F]   ask the master for a run
  hq workflow-report <id> --status completed|partial|failed --body-file F   (the owner) file the result
"""
