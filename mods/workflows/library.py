"""Saved workflows: ~/.claude/workflows and each repo's .claude/workflows."""

import glob
import os

from repos import repo_of
from runs import meta_from_script



MODEL_MARK = "// @herdr-workflow "


BODY_MARK = "// @herdr-body "


def fingerprint(text):
    """FNV-1a over code points, as model.js's fingerprint() computes it."""
    h = 0x811C9DC5
    for c in text:
        h = ((h ^ ord(c)) * 0x01000193) & 0xFFFFFFFF
    return "%08x" % h


def hand_edited(text):
    """Whether a designed script changed since it was compiled. Scripts saved before the
    fingerprint can't tell here; the editor checks those when it opens them."""
    lines = text.split("\n")
    mark = next((l for l in lines if l.startswith(BODY_MARK)), None)
    if mark is None:
        return False
    body = "\n".join(l for l in lines if not (l.startswith(BODY_MARK) or l.startswith(MODEL_MARK)))
    return mark[len(BODY_MARK):].strip() != fingerprint(body)


def git_root(path):
    import subprocess
    try:
        out = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def describe(path, scope, root):
    try:
        with open(path) as f:
            text = f.read()
        st = os.stat(path)
    except OSError:
        return None
    meta = meta_from_script(text)
    return {
        "path": path,
        "scope": scope,
        "root": root,
        "name": meta.get("name") or os.path.splitext(os.path.basename(path))[0],
        "description": meta.get("description") or "",
        "phases": meta.get("phases") or [],
        "editable": MODEL_MARK in text and not hand_edited(text),
        "edited": MODEL_MARK in text and hand_edited(text),
        "mtime": int(st.st_mtime * 1000),
        "size": st.st_size,
    }


def cmd_library(folders):
    out, seen = [], set()
    user_dir = os.path.expanduser("~/.claude/workflows")
    roots = []
    for f in folders:
        r = git_root(f) or f
        if r and r not in roots and os.path.isdir(r) and os.path.expanduser("~") != r:
            roots.append(r)
    for scope, root, d in [("user", None, user_dir)] + [("project", r, os.path.join(r, ".claude", "workflows")) for r in roots]:
        for p in sorted(glob.glob(os.path.join(d, "*.js"))):
            real = os.path.realpath(p)
            if real in seen:
                continue
            seen.add(real)
            w = describe(p, scope, root)
            if w:
                out.append(w)
    out.sort(key=lambda w: w["mtime"], reverse=True)
    repos = {r: repo_of(r) for r in roots}
    for w in out:
        w["repo"] = repos.get(w["root"]) if w["root"] else None
    return {"workflows": out, "roots": roots, "rootRepos": repos, "userDir": user_dir}


def cmd_save(src, dest, replace=""):
    """Moves a draft the mod wrote into place; refuses to overwrite unless asked."""
    if os.path.exists(dest) and replace != "replace":
        return {"error": "exists", "path": dest}
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    import shutil
    shutil.move(src, dest)
    return {"ok": True, "path": dest}


def cmd_delete(path):
    if not path.endswith(".js") or "/.claude/workflows/" not in path:
        return {"error": "refusing to delete outside .claude/workflows: " + path}
    os.remove(path)
    return {"ok": True}
