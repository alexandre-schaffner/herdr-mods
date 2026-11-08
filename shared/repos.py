"""Which repository a folder belongs to, the same for every worktree of it (workflows, master)."""

import os
import re
import subprocess

_REPOS = {}


def repo_of(path):
    """The repository a folder belongs to, the same for every worktree of it:
    {key: git common dir, name, path: main checkout}. A deleted folder is
    judged by its nearest existing parent; a folder outside git is its own repo."""
    if not path:
        return None
    probe = path
    while probe and not os.path.isdir(probe):
        parent = os.path.dirname(probe)
        probe = parent if parent != probe else ""
    if probe in _REPOS:
        return _REPOS[probe]
    def git(*args):
        try:
            r = subprocess.run(["git", "-C", probe, *args], capture_output=True, text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""

    common = git("rev-parse", "--path-format=absolute", "--git-common-dir") if probe else ""
    if common:
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        url = git("config", "--get", "remote.origin.url")
        name = re.sub(r"\.git$", "", re.split(r"[:/]", url)[-2] + "/" + re.split(r"[:/]", url)[-1]) if url.count("/") or ":" in url else ""
        repo = {"key": os.path.realpath(common), "name": name or os.path.basename(main), "path": main}
    else:
        ws = re.search(r"/conductor/workspaces/([^/]+)/", path + "/")
        if ws:  # a removed Conductor workspace still belongs to its repository
            repo = {"key": "conductor:" + ws.group(1), "name": ws.group(1), "path": path[: ws.end(1)]}
        else:
            repo = {"key": path, "name": os.path.basename(path.rstrip("/")) or path, "path": path}
    _REPOS[probe] = repo
    return repo
