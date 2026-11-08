"""Reading big JSONL transcripts without loading them whole, and small text helpers."""

import calendar
import json
import time


HEAD = 256 * 1024


TAIL = 1024 * 1024


def head_lines(path, size=HEAD):
    try:
        with open(path, "rb") as f:
            data = f.read(size)
    except OSError:
        return []
    lines = data.split(b"\n")
    if len(data) == size:
        lines = lines[:-1]
    return [x for x in (parse_line(l) for l in lines) if x]


def tail_lines(path, size=TAIL):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            end = f.tell()
            f.seek(max(0, end - size))
            data = f.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if end > size:
        lines = lines[1:]
    return [x for x in (parse_line(l) for l in lines) if x]


def parse_line(raw):
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def ts_ms(value):
    if not value:
        return None
    try:
        return calendar.timegm(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
    except ValueError:
        return None


def one_line(text, n):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def clip_text(v, n):
    v = "" if v is None else str(v)
    return v if len(v) <= n else v[:n] + "…"
