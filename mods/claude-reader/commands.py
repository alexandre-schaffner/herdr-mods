"""The slash commands a Claude Code session offers, for the chat's command palette.

  python3 -I commands.py [--cwd <dir>]

  python3 -I commands.py --mentions [--cwd <dir>]   files and subagent types for @-mentions

Prints {"commands": [{name, description, source}]}: Claude Code's built-in commands, the
person's own (~/.claude/commands/**/*.md, and the project's .claude/commands under cwd),
skills (~/.claude/skills/*/SKILL.md, the project's .claude/skills) and installed plugins'
commands and skills (namespaced `plugin:name`). Names and descriptions come from each
file's frontmatter, else its path and first line.
"""

import argparse
import glob
import json
import os
import re

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")

BUILTINS = [
    ("add-dir", "Add a working directory"), ("agents", "Manage agent configurations"),
    ("clear", "Clear the conversation and free up context"), ("compact", "Clear history but keep a summary in context"),
    ("config", "Open settings"), ("context", "Show what fills the context window"), ("cost", "Show the session's cost and duration"),
    ("doctor", "Check the installation"), ("effort", "Set the reasoning effort"), ("exit", "Exit Claude Code"),
    ("export", "Export the conversation"), ("help", "Show help"), ("hooks", "Manage hooks"), ("init", "Write a CLAUDE.md for this codebase"),
    ("login", "Sign in"), ("logout", "Sign out"), ("loop", "Run a prompt on a loop, or let Claude pace itself"),
    ("mcp", "Manage MCP servers"), ("memory", "Edit memory files"), ("model", "Set the model"), ("permissions", "Manage tool permissions"),
    ("plugin", "Manage plugins"), ("rename", "Rename this session"), ("resume", "Resume a conversation"), ("review", "Review a pull request"),
    ("rewind", "Rewind the conversation or code"), ("status", "Show version, model, account and connectivity"),
    ("statusline", "Set up the status line"), ("todos", "Show the todo list"), ("usage", "Show plan usage limits"),
]


def frontmatter(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(4000)
    except OSError:
        return {}, ""
    fm = {}
    body = text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            k, sep, v = line.partition(":")
            if sep and not line.startswith((" ", "\t")):
                fm[k.strip()] = v.strip().strip("'\"")
    first = next((l.strip("# ").strip() for l in body.splitlines() if l.strip()), "")
    return fm, first


def clip(s, n=140):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def add(out, seen, name, desc, source):
    if name and name not in seen:
        seen.add(name)
        out.append({"name": name, "description": clip(desc), "source": source})


def commands_in(root, prefix, source, out, seen):
    for p in sorted(glob.glob(os.path.join(root, "**", "*.md"), recursive=True)):
        fm, first = frontmatter(p)
        rel = os.path.relpath(p, root)[:-3].replace(os.sep, ":")
        add(out, seen, prefix + (fm.get("name") or rel), fm.get("description") or first, source)


def skills_in(root, prefix, source, out, seen):
    for p in sorted(glob.glob(os.path.join(root, "*", "SKILL.md"))):
        fm, first = frontmatter(p)
        add(out, seen, prefix + (fm.get("name") or os.path.basename(os.path.dirname(p))), fm.get("description") or first, source)


def plugins(out, seen):
    roots = set()
    for manifest in glob.glob(os.path.join(CLAUDE, "plugins", "**", ".claude-plugin", "plugin.json"), recursive=True):
        roots.add(os.path.dirname(os.path.dirname(manifest)))
    for root in sorted(roots):
        try:
            with open(os.path.join(root, ".claude-plugin", "plugin.json")) as f:
                name = json.load(f).get("name") or os.path.basename(root)
        except (OSError, ValueError):
            name = os.path.basename(root)
        commands_in(os.path.join(root, "commands"), f"{name}:", "plugin", out, seen)
        skills_in(os.path.join(root, "skills"), f"{name}:", "plugin", out, seen)


BUILTIN_AGENTS = [
    ("general-purpose", "Research, search and multi-step tasks"),
    ("Explore", "Read-only search across many files"),
    ("Plan", "Design an implementation plan"),
]
MAX_FILES = 40000


def agents_in(root, prefix, source, out, seen):
    for p in sorted(glob.glob(os.path.join(root, "*.md"))):
        fm, first = frontmatter(p)
        add(out, seen, prefix + (fm.get("name") or os.path.basename(p)[:-3]), fm.get("description") or first, source)


def agents(cwd):
    out, seen = [], set()
    for name, desc in BUILTIN_AGENTS:
        add(out, seen, name, desc, "builtin")
    if cwd:
        agents_in(os.path.join(cwd, ".claude", "agents"), "", "project", out, seen)
    agents_in(os.path.join(CLAUDE, "agents"), "", "user", out, seen)
    # Installed plugins live under plugins/cache/<marketplace>/<plugin>/<version>/ (newest wins).
    for root in sorted(glob.glob(os.path.join(CLAUDE, "plugins", "cache", "*", "*", "*")), reverse=True):
        try:
            with open(os.path.join(root, ".claude-plugin", "plugin.json")) as f:
                name = json.load(f).get("name") or os.path.basename(os.path.dirname(root))
        except (OSError, ValueError):
            name = os.path.basename(os.path.dirname(root))
        agents_in(os.path.join(root, "agents"), f"{name}:", "plugin", out, seen)
    return out


def files(cwd):
    """The folder's files, relative: git's tracked files (untracked ones make big trees slow), else a
    shallow walk that skips hidden and dependency folders."""
    if not cwd or not os.path.isdir(cwd):
        return []
    try:
        import subprocess
        r = subprocess.run(["git", "-C", cwd, "ls-files"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.splitlines()[:MAX_FILES]
    except (OSError, ValueError):
        pass
    found = []
    skip = {"node_modules", "target", "dist", "build", "__pycache__", ".git"}
    for dirpath, dirnames, filenames in os.walk(cwd):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in skip]
        if dirpath[len(cwd):].count(os.sep) >= 5:
            dirnames[:] = []
        for fn in filenames:
            found.append(os.path.relpath(os.path.join(dirpath, fn), cwd))
            if len(found) >= MAX_FILES:
                return found
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default="")
    ap.add_argument("--mentions", action="store_true", help="files and agents for @-mentions")
    a = ap.parse_args()
    if a.mentions:
        print(json.dumps({"files": files(a.cwd), "agents": agents(a.cwd)}, separators=(",", ":")))
        return
    out, seen = [], set()
    for name, desc in BUILTINS:
        add(out, seen, name, desc, "builtin")
    if a.cwd:
        commands_in(os.path.join(a.cwd, ".claude", "commands"), "", "project", out, seen)
        skills_in(os.path.join(a.cwd, ".claude", "skills"), "", "project", out, seen)
    commands_in(os.path.join(CLAUDE, "commands"), "", "user", out, seen)
    skills_in(os.path.join(CLAUDE, "skills"), "", "skill", out, seen)
    plugins(out, seen)
    print(json.dumps({"commands": out}, separators=(",", ":")))


if __name__ == "__main__":
    main()
