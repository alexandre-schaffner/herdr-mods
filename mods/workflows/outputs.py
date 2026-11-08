"""What a run produced: file paths named in its results, with their kind."""

import json
import os
import re



KIND_EXT = {
    "video": "mp4 m4v mov webm mkv avi",
    "image": "png jpg jpeg gif webp bmp svg heic heif tif tiff avif ico",
    "audio": "mp3 wav m4a aac flac ogg opus aiff",
    "pdf": "pdf",
    "markdown": "md markdown mdx",
    "subtitles": "srt vtt ass",
    "web": "html htm",
    "data": "json jsonl csv tsv yaml yml xml parquet sqlite db",
    "doc": "txt log docx pptx xlsx key pages rtf",
    "archive": "zip tar gz tgz 7z dmg",
    "code": "ts tsx js jsx mjs py rs go rb java kt swift c cc cpp h hpp cs sh sql css scss toml lua",
}


KIND_OF = {e: k for k, exts in KIND_EXT.items() for e in exts.split()}


KIND_RANK = ["video", "image", "audio", "pdf", "web", "markdown", "subtitles", "doc", "data", "archive", "folder", "code", "other"]


PATH_IN_TEXT = re.compile(r"(?<![\w/.~-])((?:~/|/)[^\s`'\"<>|*?()\[\]{},;]+)")


PATHISH = re.compile(r"^(?:~/|/|\./|\.\./)?[^\s`'\"<>|*?]+\.[A-Za-z0-9]{1,8}/?$")


def humanize(key):
    k = re.sub(r"(Path|File|Dir|Url|_path|_file|_dir)$", "", str(key))
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", k).replace("_", " ").replace("-", " ").strip()
    return (words[:1].upper() + words[1:].lower()) if words else ""


def kind_of(path, is_dir):
    if is_dir:
        return "folder"
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    return KIND_OF.get(ext, "other")


def resolve_path(raw, cwd):
    p = raw.strip().rstrip(".,:;)")
    if p.startswith("~/"):
        p = os.path.expanduser(p)
    elif not p.startswith("/"):
        if not cwd:
            return None
        p = os.path.normpath(os.path.join(cwd, p))
    return p.rstrip("/") or "/"


def outputs(result, cwd):
    """Files a run's result names: whole-string fields (`videoPath`) and absolute paths
    inside text. Each with whether it exists now; plus the rest of the result as facts
    (short scalars), notes (lists of text, long text) and data (anything else)."""
    files, seen, used = [], set(), set()

    def add(raw, label, source):
        p = resolve_path(raw, cwd)
        if not p or p in seen or len(files) >= 80:
            return False
        try:
            st = os.stat(p)
        except OSError:
            st = None
        if st is None and source == "text":
            return False  # a path mentioned in prose that isn't there is noise
        seen.add(p)
        is_dir = bool(st) and os.path.isdir(p)
        files.append({
            "path": p, "name": os.path.basename(p) or p, "label": label, "source": source,
            "kind": kind_of(p, is_dir), "exists": st is not None,
            "size": (st.st_size if st and not is_dir else None),
            "mtime": int(st.st_mtime * 1000) if st else None,
        })
        return True

    def walk(v, key, ctx):
        if isinstance(v, str):
            s = v.strip()
            if "\n" not in s and len(s) < 600 and PATHISH.match(s) and (s.startswith(("/", "~/", "./", "../")) or "/" in s):
                if add(s, humanize(key) or ctx, "field"):
                    used.add(id(v))
                return
            for m in PATH_IN_TEXT.finditer(v):
                add(m.group(1), ctx or ("Mentioned in " + humanize(key).lower() if humanize(key) else "Mentioned"), "text")
        elif isinstance(v, dict):
            name = next((v[k] for k in ("id", "name", "title", "label") if isinstance(v.get(k), str)), None)
            for k, x in v.items():
                walk(x, k, name or ctx)
        elif isinstance(v, list):
            for x in v:
                walk(x, key, ctx)

    walk(result, "", "")
    files.sort(key=lambda f: (not f["exists"], KIND_RANK.index(f["kind"]), f["source"] != "field"))

    facts, notes, data = [], [], []

    def clip(text, n):
        return text if len(text) <= n else text[: n - 1] + "…"

    def note_of(title, v):
        if isinstance(v, str):
            if v.strip():
                notes.append({"title": title, "text": clip(v.strip(), 12000)})
        elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            notes.append({"title": title, "items": [clip(x, 3000) for x in v[:60]]})
        elif isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            for x in v[:30]:
                name = next((x[k] for k in ("id", "name", "title", "label", "lane") if isinstance(x.get(k), str)), title)
                body = next((x[k] for k in ("result", "summary", "text", "verdict") if isinstance(x.get(k), str)), None)
                if body:
                    notes.append({"title": name, "text": clip(body, 6000)})
                else:
                    data.append({"title": name, "json": clip(json.dumps(x, indent=2), 6000)})
        elif v is not None:
            data.append({"title": title, "json": clip(json.dumps(v, indent=2), 6000)})

    if isinstance(result, dict):
        for k, v in result.items():
            if id(v) in used or v is None:
                continue
            if isinstance(v, bool) or isinstance(v, (int, float)) or (isinstance(v, str) and len(v) <= 80 and "\n" not in v):
                facts.append({"key": k, "label": humanize(k), "value": v})
            else:
                note_of(humanize(k), v)
    elif result is not None:
        note_of("Result", result)
    return {"files": files, "facts": facts, "notes": notes, "data": data}
