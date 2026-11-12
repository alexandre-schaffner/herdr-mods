"""The master's mailbox: managers and workflow owners write to the master here instead of typing
into its session, so their reports don't crowd the person's conversation with it or queue ahead
of what the person says.

- `hq tell "<text>" [--urgent]` files one message (data/hq/<org>/mail/<id>.json). Its urgency is
  the sender's flag, else a rule (READY and merge-queue lines), else
  Jev's judgement (TypeSafe; TYPESAFE_API_KEY), else normal.
- bin/hc turns a manager's `hc send <its master> ...` into `hq tell` (hcguard.mailbox_target), so
  sessions briefed before the mailbox existed use it too.
- The master reads unread mail in `hq tick`, which marks it read. `hq mail` lists it.
- HQ's autopilot runs `gate` each minute: it wakes an idle master with one line only when
  something can't wait for its heartbeat (urgent mail, the person's steering, a manager gone, a
  manager stopped and waiting). Otherwise the master sleeps a whole heartbeat, so a quiet org
  costs no turns.
"""

import hashlib
import json
import os
import re
import urllib.error
import urllib.request

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
WAKE_GAP_MS = 3 * 60_000     # at most one wake this often: bursts land in one tick
SETTLE_MS = 2 * 60_000       # a manager idle this long has finished its turn: judge what it said
KEEP_MS = 14 * 86400_000     # read mail older than this is dropped

URGENT_RULES = [
    (re.compile(r"^\s*(QUEUED-GREEN|QUEUE-REJECTED|QUEUE-REVOKED)", re.M), "a merge-queue line"),
]
# Without Jev, words stand in for its judgement (they over-match: "no longer blocked").
FALLBACK_RULES = [
    (re.compile(r"\bblocked\b|\bstuck\b|\bwaiting (on|for) (you|the master|a decision|an answer|approval)\b", re.I), "blocked or waiting"),
]
ROUTINE_RULES = [(re.compile(r"^\s*LESSON:", re.I), "a lesson")]


def mail_dir(H, repo):
    return os.path.join(H.data_dir(repo), "mail")


def gate_path(H, repo):
    return os.path.join(H.data_dir(repo), "gate.json")


def items(H, repo, unread=False):
    d = mail_dir(H, repo)
    got = []
    for name in os.listdir(d) if os.path.isdir(d) else []:
        if name.endswith(".json"):
            it = H.claude.read_json(os.path.join(d, name))
            if isinstance(it, dict) and not (unread and it.get("readAt")):
                got.append(it)
    got.sort(key=lambda i: i.get("at") or 0, reverse=True)
    return got


def save(H, repo, it):
    H.write_json(os.path.join(mail_dir(H, repo), it["id"] + ".json"), it)


# ---- Jev: small typed judgements, never a blocker (no key, an outage: the rules decide alone)

def jev(state, questions, timeout=8):
    """Answers for `questions` about `state`, or None when Jev can't be reached."""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return None
    body = json.dumps({"model": JEV_MODEL, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(JEV_URL, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return (json.loads(r.read() or b"{}") or {}).get("answers")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def noul(answers, qid):
    a = (answers or {}).get(qid) or {}
    p = a.get("noul")
    return p if isinstance(p, (int, float)) else None


def sender_state(H, repo, frm):
    m = next((x for x in H.org(repo)["managers"] if x["id"] == (frm or {}).get("role")), None)
    return {"id": (frm or {}).get("role") or (frm or {}).get("terminal") or "unknown",
            "kind": (m or {}).get("kind") or ("workflow owner" if (frm or {}).get("role") else "agent"),
            "area": (m or {}).get("area")}


def judge(H, repo, text, frm, flagged):
    """(urgent, why) for a message to the master."""
    if flagged:
        return True, "flagged by sender"
    for rx, why in URGENT_RULES:
        if rx.search(text):
            return True, f"rule: {why}"
    for rx, why in ROUTINE_RULES:
        if rx.search(text) and len(text) < 600:
            return False, f"rule: {why}"
    s = H.settings(repo)
    p = s["jev"] and noul(jev({"message": text[:4000], "sender": sender_state(H, repo, frm)}, {"wake": {
        "type": "noul",
        "instructions": "A manager in an engineering org sent this `message` to the master chat that coordinates "
                        "it. Should the master be woken now to handle it, rather than reading it at its next "
                        "routine check-in, which can be up to an hour away?",
        "criteria": {
            "true": "The sender is stopped or about to stop until the master answers, decides, approves, unblocks "
                    "or coordinates something; work is ready to merge or land; something broke, regressed or is "
                    "at risk; or waiting an hour wastes the sender's or the person's time.",
            "false": "A progress update, plan note, lesson, FYI or finished phase that needs no prompt reply; the "
                     "sender keeps working either way and nothing stalls if it waits an hour.",
        },
    }}), "wake")
    if isinstance(p, (int, float)):
        return p >= s["jevThreshold"], f"jev {p:.2f}"
    for rx, why in FALLBACK_RULES:
        if rx.search(text):
            return True, f"rule: {why}"
    return False, "normal"


# ---- filing and reading

def tell(H, repo, text, frm=None, urgent=False):
    """Files a message for the master; returns the item."""
    frm = frm or H.who_am_i(repo)
    text = (text or "").strip()
    flagged = bool(urgent)
    hot, why = judge(H, repo, text, frm, flagged)
    it = {"id": H.new_id(), "at": H.NOW(), "from": frm, "text": text, "urgent": hot, "why": why,
          "readAt": None, "wokeAt": None}
    save(H, repo, it)
    return it


def mark_read(H, repo, its):
    now = H.NOW()
    for it in its:
        it["readAt"] = now
        save(H, repo, it)


def who(it):
    f = it.get("from") or {}
    return f.get("role") or f.get("terminal") or "?"


def tick_lines(H, repo, unread):
    """The digest's mail section: every unread message in full, oldest first."""
    if not unread:
        return []
    lines = [f"- Mail ({len(unread)} unread; reply to a sender with `hc send <terminal> \"...\"` only when it needs an answer):"]
    for it in sorted(unread, key=lambda i: i.get("at") or 0):
        f = it.get("from") or {}
        stamp = H.time.strftime("%H:%M", H.time.localtime((it.get("at") or 0) / 1000))
        head = f"  - {who(it)}{' ' + f['terminal'] if f.get('terminal') and f.get('role') else ''} {stamp}{' URGENT' if it.get('urgent') else ''}: "
        body = (it.get("text") or "").strip()
        if len(body) > 2000:
            body = body[:1999] + "…"
        lines.append(head + body.replace("\n", "\n    "))
    return lines


def snapshot(H, repo):
    its = items(H, repo)
    return {"unread": sum(1 for i in its if not i.get("readAt")), "items": its[:100]}


# ---- the gate: wake the master only when something can't wait for its heartbeat

def last_said(H, path):
    """The full text of a transcript's last assistant message (facts['said'] is clipped)."""
    for e in reversed(H.tail_lines(path, 400_000) if path else []):
        if e.get("type") == "assistant" and not e.get("isSidechain"):
            text = "\n".join(b.get("text", "") for b in (e.get("message") or {}).get("content") or []
                             if isinstance(b, dict) and b.get("type") == "text").strip()
            if text:
                return text
    return None


def waiting(H, m, text, cache, s):
    """Jev: has this idle manager stopped to wait on the master or the person? Cached per text."""
    h = hashlib.sha1(text.encode()).hexdigest()[:16]
    if h not in cache:
        p = noul(jev({"manager": {"id": m["id"], "kind": m.get("kind"), "area": m.get("area")},
                      "last_message": text[-3000:]}, {"waiting": {
            "type": "noul",
            "instructions": "This `manager` (an agent running one area of an engineering org) has gone idle, and "
                            "`last_message` is the last thing it wrote. Has it stopped because it is waiting for "
                            "direction, an answer, a decision or an approval from the master or the person?",
            "criteria": {
                "true": "It ends on a question, asks what to do next, says it is blocked or waiting on someone, or "
                        "has finished everything it was given and needs new work.",
                "false": "It is waiting on something that resolves by itself (CI, a timer, a background job, a "
                         "subagent), or it reported progress and will carry on unprompted.",
            },
        }}), "waiting")
        if p is None:
            return None  # no verdict: ask again next minute
        cache[h] = round(p, 3)
    return h if cache[h] >= s["waitThreshold"] else None


def reasons(H, repo, master, managers, s, g):
    """[(key, line)] for everything new that can't wait for the heartbeat. `g` is the gate's
    state (first-seen times, Jev's verdicts), updated in place."""
    tick = H.claude.read_json(H.paths(repo)["tick"]) or {}
    first = g.setdefault("first", {})
    found = []

    def add(key, line):
        first.setdefault(key, H.NOW())
        found.append((key, line))

    for it in items(H, repo, unread=True):
        if it.get("urgent"):
            add(f"mail:{it['id']}", f"urgent mail from {who(it)}")
    for key in ("orders", "policy"):
        if tick.get(key) and tick[key] != H.file_hash(H.paths(repo)[key]):
            add(f"{key}:{H.file_hash(H.paths(repo)[key])}", f"the person edited the {'standing orders' if key == 'orders' else 'approval policy'}")
    for it in H.todo_load(repo)["items"]:
        for n in it.get("notes", []):
            if not n.get("seen") and (n.get("at") or 0) > (tick.get("at") or 0):
                add(f"note:{it['id']}:{n.get('at')}", f"the person noted on to-do '{H.clip(it['title'], 40)}'")
    cache = g.setdefault("jev", {})
    for m in managers:
        if m.get("status") == "retired":
            continue
        if not m["live"]:
            add(f"gone:{m['id']}:{m.get('terminal')}", f"{m['id']}'s session is gone")
            continue
        f = m.get("facts") or {}
        if m["status"] in ("idle", "done") and s["jev"] and H.NOW() - (f.get("lastAt") or H.NOW()) > SETTLE_MS:
            text = last_said(H, f.get("transcript"))
            h = text and waiting(H, m, text, cache, s)
            if h:
                add(f"wait:{m['id']}:{h}", f"{m['id']} stopped and is waiting")
    return found


def gate(H, repo, master, s):
    """One autopilot pass: wakes the master with one line when there's something new it
    hasn't seen in a tick and that can't wait. Returns what it did."""
    if not s["wakeGate"] or not master.get("terminal") or (master.get("runner") or master).get("status") not in ("idle", "done"):
        return []
    path = gate_path(H, repo)
    g = H.claude.read_json(path) or {}
    managers = [H.manager_view(repo, m, s) for m in H.org(repo)["managers"]]
    flags = H.loops.wake_flags(H, repo)
    kind = {"mail": "mail", "orders": "steering", "policy": "steering", "note": "steering", "gone": "gone", "wait": "waiting"}
    found = [(k, line) for k, line in reasons(H, repo, master, managers, s, g) if flags.get(kind.get(k.split(":")[0], ""), True)]
    tick_at = (H.claude.read_json(H.paths(repo)["tick"]) or {}).get("at") or 0
    woke = set(g.get("woke") or [])
    new = [(k, line) for k, line in found if k not in woke and g["first"].get(k, 0) > tick_at]
    live = {k for k, _ in found}
    g["first"] = {k: v for k, v in g["first"].items() if k in live}
    g["woke"] = [k for k in woke if k in live]
    g["jev"] = dict(list(g.get("jev", {}).items())[-200:])
    did = []
    loop = master.get("loop") or {}
    soon = loop.get("state") == "waiting" and (loop.get("wakeAt") or 0) - H.NOW() < 2 * 60_000
    # Just finished a turn: maybe a conversation with the person. Let it breathe a minute first.
    talking = H.NOW() - ((master.get("loopFacts") or master.get("facts") or {}).get("lastAt") or 0) < 60_000
    if new and not soon and not talking and H.NOW() - (g.get("wokeAt") or 0) > WAKE_GAP_MS:
        lines = [line for _, line in new]
        text = "HQ TICK: " + "; ".join(lines[:4]) + (f"; and {len(lines) - 4} more" if len(lines) > 4 else "") + ". Run `hq tick`."
        code, _, _ = H.hc(["send", master.get("loopTerminal") or master["terminal"], text], repo, timeout=25)  # status checked above; `--if idle` refuses `done`
        if code == 0:
            g["wokeAt"] = H.NOW()
            g["woke"] = sorted(set(g["woke"]) | {k for k, _ in new})
            for it in items(H, repo, unread=True):
                if f"mail:{it['id']}" in g["woke"] and not it.get("wokeAt"):
                    it["wokeAt"] = H.NOW()
                    save(H, repo, it)
            H.log_activity(repo, "wake", text[len("HQ TICK: "):], by="hq")
            did.append(("woke the loop runner (" if master.get("runner") else "woke the master (") + "; ".join(lines[:2]) + ")")
    for it in items(H, repo):
        if it.get("readAt") and H.NOW() - it["readAt"] > KEEP_MS:
            try:
                os.remove(os.path.join(mail_dir(H, repo), it["id"] + ".json"))
            except OSError:
                pass
    H.write_json(path, g)
    return did


# ---- commands

def cmd_tell(H, repo, args):
    urgent = "--urgent" in args
    via_hc = "--via-hc" in args
    text = " ".join(a for a in args if a not in ("--urgent", "--via-hc"))
    if text.startswith("@") and os.path.isfile(text[1:]):
        text = H.read(text[1:], "")
    if not text.strip():
        H.fail('hq tell "<message for the master>" [--urgent]')
    it = tell(H, repo, text, urgent=urgent)
    lead = "hc: your message to the master went to its mailbox instead (hq tell). " if via_hc else ""
    when = "HQ wakes it for this" if it["urgent"] else "it reads it on its next tick"
    print(f"{lead}{it['id']} filed for the master ({'urgent' if it['urgent'] else 'normal'}: {it['why']}); {when}."
          + ("" if it["urgent"] else " Add --urgent if it can't wait an hour."))


def cmd_mail(H, repo, args):
    its = items(H, repo, unread="--all" not in args)
    if "--json" in args:
        return H.out({"items": its})
    if not its:
        return print("No unread mail." if "--all" not in args else "No mail.")
    for it in its:
        print(f"[{it['id']}] {who(it)}{' URGENT' if it.get('urgent') else ''} ({it.get('why')}){'' if it.get('readAt') else ' unread'}")
        print("  " + (it.get("text") or "").replace("\n", "\n  "))


COMMANDS = {"tell": cmd_tell, "mail": cmd_mail}
