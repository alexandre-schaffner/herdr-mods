"""File search and the folder picker for the editor."""

import os

from gen import read



def _word(q, p, name_at):
    """Best score of word `q` in path `p` where every character either continues the previous
    match or starts a word (after / - _ . or at 0): "engv3state" finds engine-v3/…/v3-state.
    None when no such alignment exists."""
    from functools import lru_cache
    n = len(p)
    starts = [k == 0 or p[k - 1] in "/-_. " for k in range(n)]

    @lru_cache(maxsize=None)
    def best(qi, prev):
        if qi == len(q):
            return 0.0
        ch, top = q[qi], None
        k = p.find(ch, prev + 1)
        while k >= 0:
            run = k == prev + 1 and qi > 0
            if run or starts[k]:
                rest = best(qi + 1, k)
                if rest is not None:
                    sc = rest + (5 if run else 3) + (2 if k >= name_at else 0)
                    top = sc if top is None or sc > top else top
            k = p.find(ch, k + 1)
        return top

    return best(0, -1)


def _subsequence(q, p):
    i = 0
    for ch in q:
        i = p.find(ch, i) + 1
        if not i:
            return False
    return True


def fuzzy(query, path):
    """Every space-separated word must align (see _word); shorter paths win ties."""
    p = path.lower()
    name_at = p.rfind("/") + 1
    total = 0.0
    for word in query.lower().split():
        if not _subsequence(word, p):
            return None
        sc = _word(word, p, name_at)
        if sc is None:
            return None
        total += sc
    return total - len(p) * 0.02


def cmd_files(root, query=""):
    """Repo files matching `query`, best first: tracked and untracked-but-not-ignored."""
    import subprocess
    r = subprocess.run(["git", "-C", root, "ls-files", "-co", "--exclude-standard"], capture_output=True, text=True, timeout=10)
    files = r.stdout.splitlines() if r.returncode == 0 else []
    if not files:  # not a repo: a shallow walk
        for base, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
            files += [os.path.relpath(os.path.join(base, n), root) for n in names]
            if len(files) > 20000:
                break
    query = query.strip()
    if not query:
        return {"root": root, "files": files[:0], "total": len(files)}
    scored = sorted(((fuzzy(query, f), f) for f in files), key=lambda x: -(x[0] or -1e9))
    return {"root": root, "files": [f for sc, f in scored if sc is not None][:40], "total": len(files)}


def cmd_exists(root, paths):
    out = {}
    for p in paths:
        full = os.path.expanduser(p) if os.path.isabs(os.path.expanduser(p)) else os.path.join(root, p)
        out[p] = os.path.isfile(full)
    return {"exists": out}


def cmd_pick_start(out_file, directory):
    """The macOS file picker, detached: the mod's exec gives up after 30 s and people browse longer."""
    import subprocess
    script = ('set picked to choose file with prompt "Add files to the workflow" '
              f'default location (POSIX file "{directory}") with multiple selections allowed\n'
              'set out to ""\nrepeat with f in picked\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out')
    with open(out_file + ".tmp", "w") as f:
        pass
    p = subprocess.Popen(["sh", "-c", f'osascript -e \'{script}\' > "{out_file}.tmp" 2>/dev/null; mv "{out_file}.tmp" "{out_file}"'],
                         stdin=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True, "pid": p.pid}


def cmd_pick_poll(out_file):
    if not os.path.exists(out_file):
        return {"done": False}
    paths = [l for l in read(out_file).splitlines() if l.strip()]
    os.remove(out_file)
    return {"done": True, "paths": paths}
