#!/usr/bin/env python3
"""CLIProxyAPI usage: collected into SQLite, reported as JSON for the `proxy` mod.

  proxy.py collect            drain the proxy's usage queue into the database (launchd, every minute)
  proxy.py report [range]     collect, then everything the mod shows; range: 1h 24h 7d 30d all
  proxy.py install            install the launchd collector (sh.herdr.proxy-stats)

The proxy keeps per-request records in memory for an hour and hands each out once
(GET /observability/usage/queue), so the collector is what makes history survive.
Plan usage (Claude 5h/7d windows, extra usage; Codex windows) comes from the providers'
usage endpoints through the proxy's /requests/api-call, which substitutes each
credential's token itself: no token ever reaches this script. Cached a few minutes.
"""

import json
import re
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
BASE = os.environ.get("CLIPROXY_URL", "http://127.0.0.1:8317")
MGMT = BASE + "/v8/management"
KEY_FILE = os.path.join(HOME, ".config/cliproxyapi/management-key")
DATA = os.path.join(HOME, ".config/herdr-app/data/proxy")
DB = os.path.join(DATA, "usage.db")
NAMES = os.path.join(DATA, "names.json")  # optional {"<credential name or auth_index>": "Label"}
PLAN_TTL = 180
RANGES = {"1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "all": None}
# Chart buckets per range: (bucket seconds, count).
BUCKETS = {"1h": (300, 12), "24h": (3600, 24), "7d": (6 * 3600, 28), "30d": (86400, 30), "all": (86400, 90)}

SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, ts REAL NOT NULL, provider TEXT, model TEXT, alias TEXT,
  auth_index TEXT, account TEXT, auth_type TEXT, endpoint TEXT, client TEXT, user_agent TEXT,
  session_id TEXT, failed INTEGER, status INTEGER, latency_ms INTEGER, ttft_ms INTEGER,
  in_uncached INTEGER, cache_read INTEGER, cache_write INTEGER, out_tokens INTEGER,
  reasoning INTEGER, total INTEGER, stream INTEGER, effort TEXT, speed TEXT, error TEXT, cache_write_1h INTEGER);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE TABLE IF NOT EXISTS limits (auth_index TEXT PRIMARY KEY, ts REAL, json TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, ts REAL, json TEXT);
"""


# ---- proxy access

def mgmt_key():
    with open(KEY_FILE) as f:
        return f.read().strip()


MGMT0 = BASE + "/v0/management"  # the routing and credential-editing endpoints live under v0
STRATEGIES = ("fill-first", "round-robin", "weighted-round-robin")


def call0(path, method="GET", body=None, timeout=15):
    req = urllib.request.Request(MGMT0 + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + mgmt_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def routing():
    """How the pool picks an account: the strategy, and each credential's priority and state."""
    try:
        strategy = (call0("/routing/strategy") or {}).get("strategy")
    except (OSError, ValueError, urllib.error.URLError):
        strategy = None
    return {"strategy": strategy, "strategies": list(STRATEGIES)}


CONFIG_PREFIX = "config:claude:"  # API-key accounts live in the proxy's config, not in credential files
COMPAT_PREFIX = "config:compat:"  # so do the OpenAI-compatible upstreams (OpenCode Go...)


COMPAT_NAMES = {"opencode-go": "OpenCode Go", "opencode": "OpenCode Zen"}


def compat_providers():
    """The OpenAI-compatible upstreams in the proxy's config (OpenCode Go...), without their keys."""
    d = call0("/openai-compatibility") or {}
    rows = d.get("openai-compatibility", d) if isinstance(d, dict) else d
    return [{k: v for k, v in o.items() if k in ("name", "prefix", "base-url", "disabled", "priority")} for o in rows or []]


def config_keys():
    """The Claude API-key groups in the proxy's config (api-keys.claude), as the API returns them."""
    return ((call("/config") or {}).get("api-keys") or {}).get("claude") or []


def set_config_key(name, **fields):
    groups = config_keys()
    g = next((g for g in groups if g.get("name") == name), None)
    if g is None:
        raise ValueError(f"no API key named {name} in the proxy config")
    g.update(fields)
    req = urllib.request.Request(MGMT + "/config", method="PATCH", data=json.dumps({"api-keys": {"claude": groups}}).encode(),
                                 headers={"Authorization": "Bearer " + mgmt_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def set_routing(argv):
    """set-priority <file> <n> | set-enabled <file> on|off | set-strategy <name>: through the
    proxy's management API, which saves the credential (or config) and applies it at once."""
    what = argv[0]
    if what == "set-strategy":
        if argv[1] not in STRATEGIES:
            raise ValueError(f"strategy must be one of {', '.join(STRATEGIES)}")
        call0("/routing/strategy", "PUT", {"value": argv[1]})
    elif argv[1].startswith(COMPAT_PREFIX) and what in ("set-priority", "set-enabled"):
        field = {"priority": int(argv[2])} if what == "set-priority" else {"disabled": argv[2] not in ("on", "true", "1")}
        call0("/openai-compatibility", "PATCH", {"name": argv[1][len(COMPAT_PREFIX):], "value": field})
    elif argv[1].startswith(CONFIG_PREFIX) and what == "set-priority":
        set_config_key(argv[1][len(CONFIG_PREFIX):], priority=int(argv[2]))
    elif argv[1].startswith(CONFIG_PREFIX) and what == "set-enabled":
        set_config_key(argv[1][len(CONFIG_PREFIX):], disabled=argv[2] not in ("on", "true", "1"))
    elif what == "set-priority":
        call0("/auth-files/fields", "PATCH", {"name": argv[1], "priority": int(argv[2])})
    elif what == "set-enabled":
        call0("/auth-files/status", "PATCH", {"name": argv[1], "disabled": argv[2] not in ("on", "true", "1")})
    return {"ok": True, **routing()}


def call(path, body=None, timeout=15):
    req = urllib.request.Request(MGMT + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + mgmt_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def db():
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    con = sqlite3.connect(DB, timeout=10)
    con.executescript(SCHEMA)
    if "cache_write_1h" not in {r[1] for r in con.execute("PRAGMA table_info(requests)")}:
        con.execute("ALTER TABLE requests ADD COLUMN cache_write_1h INTEGER")
    return con


# ---- collect

def client_of(ua):
    u = (ua or "").lower()
    for needle, name in (("claude-cli", "Claude Code"), ("claude-code", "Claude Code"), ("codex", "Codex"),
                         ("opencode", "OpenCode"), ("curl/", "curl"), ("python", "Python"), ("node", "Node")):
        if needle in u:
            return name
    return (ua or "unknown").split("/")[0][:24] or "unknown"


def ts_of(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return time.time()


def row_of(r):
    t = r.get("tokens") or {}
    tb = r.get("token_breakdown") or {}
    tin, tout = tb.get("input") or {}, tb.get("output") or {}
    cache_read = tin.get("cache_read_tokens", t.get("cache_read_tokens", t.get("cached_tokens", 0))) or 0
    cache_write = tin.get("cache_write_tokens", t.get("cache_creation_tokens", 0)) or 0
    uncached = tin.get("uncached_tokens")
    if uncached is None:
        uncached = max((t.get("input_tokens") or 0) - cache_read - cache_write, 0)
    fail = r.get("fail") or {}
    err = (fail.get("body") or "")[:400] if r.get("failed") else ""
    return (
        r.get("request_id") or r.get("execution_id") or f"{r.get('timestamp')}-{r.get('auth_index')}",
        ts_of(r.get("timestamp")), r.get("provider"), r.get("model"), r.get("alias"),
        # For an API key the proxy's "source" is the key itself: never stored.
        r.get("auth_index"), None if "key" in (r.get("auth_type") or "") else r.get("source"), r.get("auth_type"), r.get("endpoint"),
        client_of(r.get("user_agent")), (r.get("user_agent") or "")[:120], r.get("session_id"),
        1 if r.get("failed") else 0, fail.get("status_code"), r.get("latency_ms"), r.get("ttft_ms"),
        uncached, cache_read, cache_write, tout.get("total_tokens", t.get("output_tokens", 0)) or 0,
        tout.get("reasoning_tokens", t.get("reasoning_tokens", 0)) or 0,
        tb.get("total_tokens", t.get("total_tokens", 0)) or 0, 1 if r.get("stream") else 0,
        r.get("reasoning_effort") or "", r.get("speed") or "", err,
        t.get("cache_creation_1h_tokens", ((r.get("cache_details") or {}).get("by_ttl") or {}).get("1h", 0)) or 0)


def limits_of(r):
    """The rate-limit headers a response carried (Claude's unified windows), flattened."""
    h = {k.lower(): (v[0] if isinstance(v, list) and v else v) for k, v in (r.get("response_headers") or {}).items()}
    out = {k.replace("anthropic-ratelimit-unified-", ""): v for k, v in h.items() if k.startswith("anthropic-ratelimit-unified-")}
    for k, v in h.items():
        if k.startswith("x-codex-") or k.startswith("x-ratelimit-"):
            out[k] = v
    if h.get("anthropic-organization-id"):
        out["org"] = h["anthropic-organization-id"]
    return out


def collect(con):
    n = 0
    while True:
        batch = call("/observability/usage/queue?count=500") or []
        if not isinstance(batch, list) or not batch:
            break
        con.executemany(f"INSERT OR IGNORE INTO requests VALUES ({','.join('?' * 27)})", [row_of(r) for r in batch])
        for r in batch:
            lim = limits_of(r)
            if lim and r.get("auth_index"):
                con.execute("INSERT INTO limits VALUES (?,?,?) ON CONFLICT(auth_index) DO UPDATE SET ts=excluded.ts, json=excluded.json "
                            "WHERE excluded.ts >= limits.ts", (r["auth_index"], ts_of(r.get("timestamp")), json.dumps(lim)))
        con.commit()
        n += len(batch)
        if len(batch) < 500:
            break
    return n


# ---- plan usage (cached)

def cached(con, key, ttl, fetch):
    row = con.execute("SELECT ts, json FROM kv WHERE key=?", (key,)).fetchone()
    if row and time.time() - row[0] < ttl:
        return json.loads(row[1])
    try:
        val = fetch()
    except Exception as e:  # keep the last good value, say why it is stale
        return {**(json.loads(row[1]) if row else {}), "stale": str(e)[:160]}
    con.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?)", (key, time.time(), json.dumps(val)))
    con.commit()
    return val


def upstream(auth_index, url, headers):
    r = call("/requests/api-call", {"auth_index": auth_index, "method": "GET", "url": url, "header": headers}, timeout=20)
    if r.get("status_code") != 200:
        raise RuntimeError(f"HTTP {r.get('status_code')}: {(r.get('body') or '')[:120]}")
    return json.loads(r.get("body") or "{}")


def window(label, pct, resets):
    return {"label": label, "pct": None if pct is None else float(pct), "resets": resets}


def claude_plan(auth_index):
    b = upstream(auth_index, "https://api.anthropic.com/api/oauth/usage",
                 {"Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20"})
    wins = []
    for key, label in (("five_hour", "5-hour"), ("seven_day", "Weekly"), ("seven_day_opus", "Weekly · Opus"),
                       ("seven_day_sonnet", "Weekly · Sonnet")):
        w = b.get(key)
        if isinstance(w, dict) and w.get("utilization") is not None:
            wins.append(window(label, w["utilization"], ts_of(w["resets_at"]) if w.get("resets_at") else None))
    extra = None
    x = b.get("extra_usage") or {}
    if x.get("is_enabled"):
        scale = 10 ** (x.get("decimal_places") or 0)
        extra = {"used": (x.get("used_credits") or 0) / scale, "limit": (x.get("monthly_limit") or 0) / scale,
                 "pct": x.get("utilization"), "currency": x.get("currency") or ""}
    return {"windows": wins, "extra": extra}


def codex_plan(auth_index, account_id):
    h = {"Authorization": "Bearer $TOKEN$"}
    if account_id:
        h["chatgpt-account-id"] = account_id
    b = upstream(auth_index, "https://chatgpt.com/backend-api/wham/usage", h)
    rl = b.get("rate_limit") or b
    wins = []
    for key, label in (("primary_window", "5-hour"), ("secondary_window", "Weekly")):
        w = rl.get(key) or {}
        if w.get("used_percent") is not None:
            secs = w.get("limit_window_seconds")
            if secs:
                label = f"{round(secs / 3600)}-hour" if secs < 86400 else ("Weekly" if secs >= 6 * 86400 else f"{round(secs / 86400)}-day")
            resets = w.get("reset_at") or (time.time() + w["reset_after_seconds"] if w.get("reset_after_seconds") else None)
            wins.append(window(label, w["used_percent"], resets))
    return {"windows": wins, "extra": None, "plan": b.get("plan_type")}


def header_plan(lim):
    """Fallback from the last response's headers (fractions → percent)."""
    wins = []
    for key, label in (("5h", "5-hour"), ("7d", "Weekly")):
        if lim.get(f"{key}-utilization") is not None:
            r = lim.get(f"{key}-reset")
            wins.append(window(label, float(lim[f"{key}-utilization"]) * 100, float(r) if r else None))
    return {"windows": wins, "extra": None, "from": "headers"} if wins else None


# ---- report

def names():
    try:
        with open(NAMES) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def label_of(c, alias):
    for k in (c.get("name"), c.get("auth_index"), c.get("id")):
        if k and k in alias:
            return alias[k]
    org = c.get("organization_name") or ""
    if org.endswith("'s Organization"):
        org = "Personal"
    who = c.get("email") or c.get("label") or c.get("name") or "?"
    return f"{org} · {who}" if org else who


def credential_extra(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return {"organization_name": d.get("organization_name"), "account_id": d.get("account_id") or (d.get("tokens") or {}).get("account_id")}
    except (OSError, ValueError, TypeError):
        return {}


def pct(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(round(p * (len(vals) - 1))))]


def agg(rows):
    """rows: (failed, latency, ttft, in_uncached, cache_read, cache_write, out, reasoning, ts, session)."""
    n = len(rows)
    ok = [r for r in rows if not r[0]]
    inp = sum(r[3] + r[4] + r[5] for r in rows)
    lat = [r[1] for r in ok if r[1]]
    ttft = [r[2] for r in ok if r[2]]
    speeds = [r[6] / ((r[1] - r[2]) / 1000) for r in ok if r[1] and r[2] and r[1] - r[2] > 200 and r[6] > 20]
    return {
        "requests": n, "failed": n - len(ok),
        "in_uncached": sum(r[3] for r in rows), "cache_read": sum(r[4] for r in rows),
        "cache_write": sum(r[5] for r in rows), "output": sum(r[6] for r in rows), "reasoning": sum(r[7] for r in rows),
        "input": inp, "tokens": inp + sum(r[6] for r in rows),
        "cache_hit": (sum(r[4] for r in rows) / inp) if inp else None,
        "latency_p50": pct(lat, 0.5), "latency_p95": pct(lat, 0.95),
        "ttft_p50": pct(ttft, 0.5), "tok_s": (sum(speeds) / len(speeds)) if speeds else None,
        "last": max((r[8] for r in rows), default=None),
        "sessions": len({r[9] for r in rows if r[9]}),
    }


COLS = "failed, latency_ms, ttft_ms, in_uncached, cache_read, cache_write, out_tokens, reasoning, ts, session_id"


def grouped(con, key, since):
    out = {}
    for row in con.execute(f"SELECT {key}, {COLS} FROM requests WHERE ts >= ?", (since,)):
        out.setdefault(row[0] or "unknown", []).append(tuple(v or 0 if i < 8 else v for i, v in enumerate(row[1:])))
    return sorted(({"key": k, **agg(v)} for k, v in out.items()), key=lambda x: -x["tokens"])


# USD per million tokens: input, output, cache read (Anthropic list prices, 2026-10). Cache writes
# bill 1.25x input (5-minute) or 2x input (1-hour). Unknown models price as Opus 5.5.
PRICES = {
    "claude-fable-5-1": (10, 50, 0.25), "claude-fable-5": (10, 50, 1.0),
    "claude-opus-5-5": (4, 20, 0.20), "claude-opus-5": (5, 25, 0.5),
    "claude-opus-4-8": (5, 25, 0.5), "claude-opus-4-7": (5, 25, 0.5), "claude-opus-4-6": (5, 25, 0.5),
    "claude-sonnet-5-5": (2, 10, 0.20), "claude-sonnet-5": (2, 10, 0.2), "claude-sonnet-4-6": (3, 15, 0.3),
    "claude-haiku-5-5": (0.10, 0.50, 0.01), "claude-haiku-4-5": (1, 5, 0.1),
}
BALANCE = os.path.join(DATA, "api-balance.json")  # {"usd": <balance as the Console showed it>, "as_of": <epoch>}


def price_of(model):
    m = re.sub(r"-\d{8}$", "", (model or "").replace("[1m]", ""))
    return PRICES.get(m) or next((v for k, v in PRICES.items() if m.startswith(k)), PRICES["claude-opus-5-5"])


def spend(con, idx, since):
    """Estimated USD for the API key's requests since `since` (failed requests bill nothing)."""
    if not idx:
        return 0.0
    usd = 0.0
    for model, inp, cr, cw, cw1h, out in con.execute(
            f"SELECT model, SUM(in_uncached), SUM(cache_read), SUM(cache_write), SUM(COALESCE(cache_write_1h,0)), SUM(out_tokens) "
            f"FROM requests WHERE failed=0 AND ts >= ? AND auth_index IN ({','.join('?' * len(idx))}) GROUP BY model", (since, *idx)):
        pi, po, pc = price_of(model)
        cw1h = min(cw1h or 0, cw or 0)
        usd += ((inp or 0) * pi + (out or 0) * po + (cr or 0) * pc + ((cw or 0) - cw1h) * pi * 1.25 + cw1h * pi * 2) / 1e6
    return usd


def balance_of(con, idx):
    try:
        with open(BALANCE) as f:
            b = json.load(f)
        used = spend(con, idx, b["as_of"])
        return {"set": b["usd"], "as_of": b["as_of"], "used": used, "left": b["usd"] - used}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def set_balance(usd):
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    with open(BALANCE, "w") as f:
        json.dump({"usd": float(usd), "as_of": time.time()}, f)
    return {"ok": True, "usd": float(usd)}


def report(rng):
    rng = rng if rng in RANGES else "24h"
    con = db()
    proxy = {"up": True, "collected": 0}
    try:
        proxy["collected"] = collect(con)
        creds = call("/credentials").get("files") or []
        keyed = config_keys()
        compat = compat_providers()
    except (urllib.error.URLError, OSError, ValueError) as e:
        proxy, creds, keyed, compat = {"up": False, "error": str(e)[:200]}, [], [], []
    now = time.time()
    span = RANGES[rng]
    first = con.execute("SELECT MIN(ts), COUNT(*) FROM requests").fetchone()
    since = now - span if span else (first[0] or now)

    allrows = [tuple(v or 0 if i < 8 else v for i, v in enumerate(r)) for r in con.execute(f"SELECT {COLS} FROM requests WHERE ts >= ?", (since,))]
    totals = agg(allrows)
    prev = None
    if span:
        prev = agg([tuple(v or 0 if i < 8 else v for i, v in enumerate(r))
                    for r in con.execute(f"SELECT {COLS} FROM requests WHERE ts >= ? AND ts < ?", (since - span, since))])

    size, count = BUCKETS[rng]
    start = (int(now) // size - count + 1) * size
    pts = {start + i * size: {"t": start + i * size, "req": 0, "fail": 0, "input": 0, "output": 0, "cache": 0, "by": {}} for i in range(count)}
    for ts, failed, provider, inp, cr, cw, out in con.execute(
            "SELECT ts, failed, provider, in_uncached, cache_read, cache_write, out_tokens FROM requests WHERE ts >= ?", (start,)):
        b = pts.get(start + (int(ts) - start) // size * size)
        if not b:
            continue
        b["req"] += 1
        b["fail"] += failed or 0
        b["input"] += (inp or 0) + (cw or 0)
        b["cache"] += cr or 0
        b["output"] += out or 0
        b["by"][provider or "?"] = b["by"].get(provider or "?", 0) + (inp or 0) + (cr or 0) + (cw or 0) + (out or 0)

    alias = names()
    accounts = {a["key"]: a for a in grouped(con, "auth_index", since)}
    labels = dict(con.execute("SELECT auth_index, account FROM requests GROUP BY auth_index"))
    limits = {k: json.loads(v) for k, v in con.execute("SELECT auth_index, json FROM limits")}
    acc_out = []
    for c in creds:
        idx = c.get("auth_index")
        c = {**c, **credential_extra(c.get("path") or "")}
        usage = accounts.pop(idx, None) or {"key": idx, **agg([])}
        plan = None
        if not c.get("disabled"):
            if c.get("provider") == "claude":
                plan = cached(con, f"plan:{idx}", PLAN_TTL, lambda: claude_plan(idx))
            elif c.get("provider") == "codex":
                plan = cached(con, f"plan:{idx}", PLAN_TTL, lambda: codex_plan(idx, c.get("account_id")))
            if not (plan and plan.get("windows")) and idx in limits:
                plan = header_plan(limits[idx]) or plan
        acc_out.append({
            **usage, "auth_index": idx, "name": c.get("name"), "label": label_of(c, alias), "provider": c.get("provider"),
            "email": c.get("email"), "priority": c.get("priority", 0), "status": c.get("status"),
            "status_message": c.get("status_message"), "disabled": bool(c.get("disabled")),
            "unavailable": bool(c.get("unavailable")), "quota_blocked": bool(c.get("quota_blocked")),
            "cooldowns": c.get("cooldowns") or [], "requires_sign_in": bool(c.get("requires_sign_in")),
            "renewal_state": c.get("renewal_state"), "plan": plan, "live": True,
        })
    # Claude API keys from the config. Their requests carry an auth_index of their own; with one key
    # configured (the usual case) every Claude API-key request belongs to it.
    key_idx = [r[0] for r in con.execute(
        "SELECT auth_index FROM requests WHERE provider='claude' AND auth_type IN ('api_key', 'apikey') GROUP BY auth_index ORDER BY COUNT(*) DESC")]
    for i, g in enumerate(keyed):
        mine = key_idx if len(keyed) == 1 else []
        rows = [tuple(v or 0 if j < 8 else v for j, v in enumerate(r)) for r in con.execute(
            f"SELECT {COLS} FROM requests WHERE ts >= ? AND auth_index IN ({','.join('?' * len(mine))})", (since, *mine))] if mine else []
        for idx in mine:
            accounts.pop(idx, None)
        name = CONFIG_PREFIX + (g.get("name") or f"key-{i}")
        acc_out.append({
            **{"key": name, **agg(rows)}, "auth_index": mine[0] if mine else name, "name": name,
            "label": alias.get(name) or alias.get(g.get("name")) or "Anthropic API key", "provider": "claude", "kind": "api-key",
            "priority": g.get("priority", 0), "disabled": bool(g.get("disabled")), "status": "active", "status_message": "",
            "unavailable": False, "quota_blocked": False, "cooldowns": [], "requires_sign_in": False,
            "renewal_state": None, "plan": None, "live": True,
            "spend": {"today": spend(con, mine, time.mktime(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timetuple())),
                      "month": spend(con, mine, time.mktime(datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timetuple())),
                      "range": spend(con, mine, since), "balance": balance_of(con, mine)},
        })
    # OpenAI-compatible upstreams (OpenCode Go...): one account each, their requests by provider name.
    for g in compat:
        prov = f"openai-compatible-{g['name']}"
        mine = [r[0] for r in con.execute("SELECT auth_index FROM requests WHERE provider=? GROUP BY auth_index ORDER BY COUNT(*) DESC", (prov,))]
        rows = [tuple(v or 0 if j < 8 else v for j, v in enumerate(r)) for r in con.execute(
            f"SELECT {COLS} FROM requests WHERE ts >= ? AND auth_index IN ({','.join('?' * len(mine))})", (since, *mine))] if mine else []
        for idx in mine:
            accounts.pop(idx, None)
        key = COMPAT_PREFIX + g["name"]
        acc_out.append({
            **{"key": key, **agg(rows)}, "auth_index": mine[0] if mine else key, "name": key,
            "label": alias.get(key) or COMPAT_NAMES.get(g["name"]) or g["name"], "provider": prov, "kind": "upstream",
            "upstream": g.get("base-url"), "prefix": g.get("prefix"),
            "priority": g.get("priority", 0), "disabled": bool(g.get("disabled")), "status": "active", "status_message": "",
            "unavailable": False, "quota_blocked": False, "cooldowns": [], "requires_sign_in": False,
            "renewal_state": None, "plan": None, "live": True,
        })
    for idx, usage in accounts.items():  # removed credentials
        acc_out.append({**usage, "auth_index": idx, "label": alias.get(idx) or labels.get(idx) or "Removed account", "provider": None,
                        "live": False, "plan": None})
    acc_out.sort(key=lambda a: (not a.get("live"), -(a.get("priority") or 0), -a["tokens"]))
    provider_of = dict(con.execute("SELECT auth_index, provider FROM requests GROUP BY auth_index"))
    # Per account: requests (and failures) per bucket on the range's time axis, and its model mix.
    per_series, per_models = {}, {}
    for idx, ts, failed in con.execute("SELECT auth_index, ts, failed FROM requests WHERE ts >= ?", (start,)):
        k = (int(ts) - start) // size
        if 0 <= k < count:
            s_ = per_series.setdefault(idx, [[0, 0] for _ in range(count)])
            s_[k][0] += 1
            s_[k][1] += failed or 0
    for idx, model, n, tok in con.execute(
            "SELECT auth_index, model, COUNT(*), SUM(COALESCE(in_uncached,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0)+COALESCE(out_tokens,0)) "
            "FROM requests WHERE ts >= ? GROUP BY auth_index, model ORDER BY 4 DESC", (since,)):
        per_models.setdefault(idx, []).append({"model": model or "unknown", "requests": n, "tokens": tok or 0})
    for a in acc_out:
        a["provider"] = a.get("provider") or provider_of.get(a["auth_index"])
        a["series"] = per_series.get(a["auth_index"], [])
        a["models"] = per_models.get(a["auth_index"], [])[:5]

    models = grouped(con, "model", since)
    prov_of_model = dict(con.execute("SELECT model, provider FROM requests WHERE ts >= ? GROUP BY model", (since,)))
    for m in models:
        m["provider"] = prov_of_model.get(m["key"])

    recent = [dict(zip(("ts", "model", "provider", "account", "client", "failed", "status", "latency", "ttft", "input", "cache_read",
                        "output", "stream", "effort", "error"), r)) for r in con.execute(
        "SELECT ts, model, provider, auth_index, client, failed, status, latency_ms, ttft_ms, in_uncached + cache_write, cache_read, "
        "out_tokens, stream, effort, error FROM requests WHERE ts >= ? ORDER BY ts DESC LIMIT 60", (since,))]
    errors = [dict(zip(("ts", "model", "account", "status", "error"), r)) for r in con.execute(
        "SELECT ts, model, auth_index, status, error FROM requests WHERE failed=1 AND ts >= ? ORDER BY ts DESC LIMIT 20", (since,))]
    names_by_idx = {a["auth_index"]: a["label"] for a in acc_out}
    for r in recent + errors:
        r["account"] = names_by_idx.get(r["account"], r["account"])

    return {
        "ok": True, "range": rng, "now": now, "since": since, "proxy": proxy, "routing": routing(),
        "totals": totals, "previous": prev,
        "series": {"size": size, "points": list(pts.values())},
        "accounts": acc_out, "models": models,
        "providers": grouped(con, "provider", since), "clients": grouped(con, "client", since),
        "recent": recent, "errors": errors,
        "db": {"path": DB, "rows": first[1], "first": first[0]},
    }


# ---- launchd

LABEL = "sh.herdr.proxy-stats"


def install():
    plist = os.path.join(HOME, "Library/LaunchAgents", LABEL + ".plist")
    log = os.path.join(DATA, "collector.log")
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    with open(plist, "w") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{sys.executable}</string><string>{os.path.abspath(__file__)}</string><string>collect</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
""")
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", plist], capture_output=True, text=True)
    return {"ok": r.returncode == 0, "plist": plist, "error": r.stderr.strip()}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "report"
    try:
        if cmd == "collect":
            out = {"ok": True, "collected": collect(db())}
        elif cmd == "report":
            out = report(argv[2] if len(argv) > 2 else "24h")
        elif cmd == "install":
            out = install()
        elif cmd == "set-balance" and len(argv) > 2:
            out = set_balance(argv[2])
        elif cmd in ("set-priority", "set-enabled", "set-strategy"):
            out = set_routing(argv[1:])
        else:
            out = {"ok": False, "error": "usage: proxy.py collect | report [1h|24h|7d|30d|all] | install"}
    except (urllib.error.URLError, OSError, ValueError, sqlite3.Error) as e:
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    json.dump(out, sys.stdout, separators=(",", ":"))
    if cmd == "collect" and not out.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv)
