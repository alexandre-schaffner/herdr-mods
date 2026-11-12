"""The Claude models a Claude Code account can use, for the chat's model menu and context gauge.

  python3 -I models.py [--config <claude config dir>]

Asks the account's API (its settings.json env: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or
ANTHROPIC_API_KEY; a proxy serves the same Models API) and prints
{"models": [{"id", "name", "window"}]}: Claude models only, newest first, `window` the context
window in tokens. Cached an hour per account. Empty when the account can't be asked (an
OAuth-only login, no network): the chat then falls back to its own short list.
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".config", "herdr-app", "data", "claude-models")
TTL = 3600


def args(argv):
    a = {"config": os.path.join(HOME, ".claude")}
    it = iter(argv)
    for k in it:
        if k[2:] in a:
            a[k[2:]] = next(it, "") or a[k[2:]]
    return a


def account(config):
    try:
        with open(os.path.join(config, "settings.json"), encoding="utf-8") as f:
            env = (json.load(f) or {}).get("env") or {}
    except (OSError, ValueError):
        env = {}
    pick = lambda k: env.get(k) or os.environ.get(k) or ""  # noqa: E731
    return pick("ANTHROPIC_BASE_URL").rstrip("/") or "https://api.anthropic.com", pick("ANTHROPIC_AUTH_TOKEN") or pick("ANTHROPIC_API_KEY")


def version(model_id):
    """Sort key: newer first by the numbers in the id (fable-5-2 > fable-5-1 > opus-5-5 …)."""
    return [int(n) for n in re.findall(r"\d+", model_id.split("-20")[0])]


def fetch(base, token):
    req = urllib.request.Request(f"{base}/v1/models?limit=1000", headers={
        "x-api-key": token, "Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.load(r).get("data") or []
    out = []
    for m in data:
        mid, name = m.get("id") or "", m.get("display_name") or ""
        # Claude's own models: a proxy may route other vendors' models under claude-* ids.
        if not mid.startswith("claude-") or not name.startswith("Claude"):
            continue
        out.append({"id": mid, "name": name, "window": m.get("max_input_tokens"), "created": m.get("created_at") or ""})
    out.sort(key=lambda m: (m["created"], version(m["id"])), reverse=True)
    return [{k: m[k] for k in ("id", "name", "window")} for m in out]


def main():
    a = args(sys.argv[1:])
    base, token = account(a["config"])
    path = os.path.join(CACHE, hashlib.sha1(f"{a['config']}|{base}".encode()).hexdigest()[:16] + ".json")
    try:
        if time.time() - os.path.getmtime(path) < TTL:
            with open(path, encoding="utf-8") as f:
                sys.stdout.write(f.read())
            return
    except OSError:
        pass
    models = []
    if token:
        try:
            models = fetch(base, token)
        except Exception:  # noqa: BLE001 - no network, a proxy down, an OAuth-only account
            models = []
    text = json.dumps({"models": models})
    if models:
        os.makedirs(CACHE, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
