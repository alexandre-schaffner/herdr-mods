"""Image and video staging for mods that show thumbnails (Workflows): files are staged here first.

  python3 -I media.py <command> <file> [args]   → one JSON object on stdout

  image <file>            the image, copied (or converted / scaled down) into the cache
  video <file>            facts from ffprobe, a poster frame and a storyboard sheet
  pdf <file>              page count and first-page size
  page <file> <n>         page n rendered into the cache
  play <file> <seconds>   starts ffplay in its own window; prints its pid
  prune                   drops cache entries nobody opened for a while

Herdr only draws images that live under its home, and it keeps every image it has
drawn in memory until it quits. So staged files have stable names (the source's path,
size and mtime), are scaled to a sane size, and a video becomes one poster and one
storyboard sheet: never a stream of frames.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_HOME = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")  # hidden: writing here doesn't reload the mod

MAX_IMAGE = 3200  # px, longest edge of a staged image
PAGE_WIDTH = 1600  # px, a rendered PDF page
POSTER_WIDTH = 1600
BOARD_COLS, BOARD_ROWS, TILE_WIDTH = 6, 2, 320
KEEP_DAYS = 14

AS_IS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


class Fail(Exception):
    pass


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")))


def tool(name):
    found = shutil.which(name)
    if found:
        return found
    for d in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        p = os.path.join(d, name)
        if os.access(p, os.X_OK):
            return p
    return None


# Herdr's exec stops a command after 30 s: every step shares this budget, and anything that
# doesn't fit is left for the next call (staged files only appear once complete).
DEADLINE = time.time() + 25


def left():
    return DEADLINE - time.time()


def run(argv, timeout=60):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=max(1, min(timeout, left())))
    except subprocess.TimeoutExpired:
        raise Fail("%s took too long" % os.path.basename(argv[0]))
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip().splitlines()
        raise Fail(msg[-1] if msg else "%s failed" % os.path.basename(argv[0]))
    return r.stdout


def source(path):
    if not os.path.isfile(path):
        raise Fail("File not found")
    return os.stat(path)


def entry(path, st, suffix):
    """A stable cache path for (this file as it is now, this variant)."""
    key = hashlib.sha1(("%s|%d|%d" % (path, st.st_size, int(st.st_mtime))).encode()).hexdigest()[:20]
    os.makedirs(CACHE, exist_ok=True)
    return os.path.join(CACHE, key + suffix)


def rel(p):
    """What `image()` takes: the path from Herdr's home."""
    return os.path.relpath(p, APP_HOME)


def fresh(p):
    if os.path.exists(p):
        os.utime(p)  # prune goes by last use
        return True
    return False


# ─── images ──────────────────────────────────────────────────────────────


def svg_size(path):
    with open(path, "rb") as f:
        head = f.read(4096).decode("utf-8", "replace")
    tag = re.search(r"<svg\b[^>]*>", head, re.S)
    if not tag:
        return 0, 0
    attr = lambda n: re.search(r'\b%s\s*=\s*"([\d.]+)(?:px)?"' % n, tag.group(0))
    w, h = attr("width"), attr("height")
    if w and h:
        return round(float(w.group(1))), round(float(h.group(1)))
    vb = re.search(r'viewBox\s*=\s*"[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', tag.group(0))
    return (round(float(vb.group(1))), round(float(vb.group(2)))) if vb else (0, 0)


def pixel_size(path):
    sips = tool("sips")
    if sips:
        try:
            o = run([sips, "-g", "pixelWidth", "-g", "pixelHeight", path])
            w, h = re.search(r"pixelWidth: (\d+)", o), re.search(r"pixelHeight: (\d+)", o)
            if w and h:
                return int(w.group(1)), int(h.group(1))
        except Fail:
            pass
    ffprobe = tool("ffprobe")
    if ffprobe:
        o = run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path])
        s = (json.loads(o).get("streams") or [{}])[0]
        return s.get("width") or 0, s.get("height") or 0
    return 0, 0


def cmd_image(path):
    st = source(path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".svg":
        dest = entry(path, st, ".svg")
        if not fresh(dest):
            shutil.copyfile(path, dest)
        w, h = svg_size(path)
        return {"src": rel(dest), "width": w, "height": h, "natural": [w, h], "bytes": st.st_size}

    w, h = pixel_size(path)
    big = max(w, h) > MAX_IMAGE
    # GIFs are copied whole, even big ones: scaling them would stop the animation.
    if ext in AS_IS and (ext == ".gif" or not big):
        dest = entry(path, st, ext)
        if not fresh(dest):
            shutil.copyfile(path, dest)
        return {"src": rel(dest), "width": w, "height": h, "natural": [w, h], "bytes": st.st_size}

    keep = ext in (".jpg", ".jpeg")
    dest = entry(path, st, ".jpg" if keep else ".png")
    if not fresh(dest):
        sips, ffmpeg = tool("sips"), tool("ffmpeg")
        tmp = dest + ".part" + os.path.splitext(dest)[1]
        if sips:
            argv = [sips, "-s", "format", "jpeg" if keep else "png"]
            if big:
                argv += ["-Z", str(MAX_IMAGE)]
            run(argv + [path, "--out", tmp])
        elif ffmpeg:
            scale = ["-vf", "scale='min(%d,iw)':-2" % MAX_IMAGE] if big else []
            run([ffmpeg, "-v", "error", "-y", "-i", path, *scale, "-frames:v", "1", tmp])
        else:
            raise Fail("Can't convert %s images here" % ext.lstrip(".").upper())
        os.replace(tmp, dest)
    sw, sh = pixel_size(dest)
    return {"src": rel(dest), "width": sw, "height": sh, "natural": [w or sw, h or sh], "bytes": st.st_size}


# ─── video ───────────────────────────────────────────────────────────────


def ratio(s):
    try:
        a, b = str(s).split("/")
        return float(a) / float(b) if float(b) else 0.0
    except ValueError:
        return 0.0


def grab(ffmpeg, path, t, width, dest):
    run([ffmpeg, "-v", "error", "-y", "-ss", "%.3f" % t, "-i", path, "-frames:v", "1",
         "-vf", "scale='min(%d,iw)':-2" % width, "-q:v", "3", dest], timeout=30)


def cmd_video(path):
    st = source(path)
    ffprobe, ffmpeg = tool("ffprobe"), tool("ffmpeg")
    if not (ffprobe and ffmpeg):
        raise Fail("Install ffmpeg to preview videos (brew install ffmpeg)")
    o = json.loads(run([ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path]))
    streams = o.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = o.get("format") or {}
    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0)
    info = {
        "duration": duration,
        "bytes": st.st_size,
        "bitrate": int(fmt.get("bit_rate") or 0),
        "audio": a and {"codec": a.get("codec_name"), "channels": a.get("channels"), "rate": int(a.get("sample_rate") or 0)},
        "video": None,
        "poster": None,
        "board": None,
        "player": bool(tool("ffplay")),
    }
    if not v:
        return info
    w, h = v.get("width") or 0, v.get("height") or 0
    rot = abs(int((v.get("tags") or {}).get("rotate") or 0))
    for sd in v.get("side_data_list") or []:
        rot = abs(int(sd.get("rotation") or rot))
    if rot % 180 == 90:
        w, h = h, w
    info["video"] = {"codec": v.get("codec_name"), "width": w, "height": h, "fps": round(ratio(v.get("avg_frame_rate") or v.get("r_frame_rate")), 2)}

    poster = entry(path, st, ".poster.jpg")
    if not fresh(poster):
        grab(ffmpeg, path, min(duration * 0.1, 3.0) if duration > 1 else 0, POSTER_WIDTH, poster + ".part.jpg")
        os.replace(poster + ".part.jpg", poster)
    info["poster"] = rel(poster)

    if duration > 2:
        tiles = BOARD_COLS * BOARD_ROWS
        times = [duration * (i + 0.5) / tiles for i in range(tiles)]
        board = entry(path, st, ".board.jpg")
        if not fresh(board):
            work = board + ".parts"
            os.makedirs(work, exist_ok=True)
            try:
                for i, t in enumerate(times):
                    if left() < 4:  # no time for the sheet now: the next open makes it
                        return info
                    grab(ffmpeg, path, t, TILE_WIDTH, os.path.join(work, "%02d.jpg" % i))
                run([ffmpeg, "-v", "error", "-y", "-i", os.path.join(work, "%02d.jpg"),
                     "-vf", "tile=%dx%d" % (BOARD_COLS, BOARD_ROWS), "-frames:v", "1", "-q:v", "3", board + ".part.jpg"])
                os.replace(board + ".part.jpg", board)
            finally:
                shutil.rmtree(work, ignore_errors=True)
        tw = min(TILE_WIDTH, w) if w else TILE_WIDTH
        info["board"] = {"src": rel(board), "cols": BOARD_COLS, "rows": BOARD_ROWS, "times": times,
                         "tile": [tw, round(tw * h / w) if w else round(tw * 9 / 16)]}
    return info


def cmd_play(path, start):
    source(path)
    ffplay = tool("ffplay")
    if not ffplay:
        raise Fail("ffplay isn't installed")
    argv = [ffplay, "-hide_banner", "-loglevel", "quiet", "-autoexit", "-window_title", os.path.basename(path)]
    if float(start) > 0.05:
        argv += ["-ss", "%.2f" % float(start)]
    p = subprocess.Popen(argv + [path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    return {"pid": p.pid}


# ─── pdf ─────────────────────────────────────────────────────────────────


def pdf_helper():
    """The PDFKit renderer, compiled once per version of pdf.swift. The compile runs on its
    own (it can outlast this call) and the binary only appears, renamed, once it is whole."""
    src = os.path.join(HERE, "pdf.swift")
    with open(src, "rb") as f:
        ver = hashlib.sha1(f.read()).hexdigest()[:12]
    exe = os.path.join(CACHE, "bin", "pdf-" + ver)
    if os.access(exe, os.X_OK):
        return exe
    swiftc = tool("swiftc")
    if not swiftc:
        return None
    bindir = os.path.dirname(exe)
    os.makedirs(bindir, exist_ok=True)
    lock = exe + ".building"
    if not os.path.exists(lock) or time.time() - os.path.getmtime(lock) > 300:
        for old in os.listdir(bindir):
            if not old.startswith("pdf-" + ver):
                os.remove(os.path.join(bindir, old))
        open(lock, "w").close()
        subprocess.Popen(["sh", "-c", '"$1" -O "$2" -o "$3.part" && mv "$3.part" "$3"; rm -f "$3.part" "$3.building"',
                          "sh", swiftc, src, exe], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    while left() > 6 and os.path.exists(lock) and not os.access(exe, os.X_OK):
        time.sleep(0.5)
    if os.access(exe, os.X_OK):
        return exe
    if tool("pdfinfo"):
        return None  # poppler meanwhile
    raise Fail("Preparing the PDF renderer (first use); open it again in a moment")


def cmd_pdf(path):
    st = source(path)
    exe = pdf_helper()
    if exe:
        info = json.loads(run([exe, "info", path]))
    elif tool("pdfinfo"):
        o = run([tool("pdfinfo"), path])
        n = re.search(r"Pages:\s+(\d+)", o)
        size = re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", o)
        info = {"pages": int(n.group(1)) if n else 0,
                "width": round(float(size.group(1))) if size else 612, "height": round(float(size.group(2))) if size else 792}
    else:
        raise Fail("Rendering PDFs needs Xcode's command line tools (xcode-select --install) or poppler")
    return dict(info, bytes=st.st_size)


def cmd_page(path, n):
    st = source(path)
    n = int(n)
    dest = entry(path, st, ".p%d.png" % n)
    if not fresh(dest):
        tmp = dest + ".part.png"
        exe = pdf_helper()
        if exe:
            run([exe, "render", path, str(n), str(PAGE_WIDTH), tmp])
        elif tool("pdftoppm"):
            run([tool("pdftoppm"), "-png", "-singlefile", "-f", str(n), "-l", str(n),
                 "-scale-to-x", str(PAGE_WIDTH), "-scale-to-y", "-1", path, tmp[:-4]])
        else:
            raise Fail("No PDF renderer available")
        os.replace(tmp, dest)
    return {"src": rel(dest)}


# ─── housekeeping ────────────────────────────────────────────────────────


def cmd_prune():
    if not os.path.isdir(CACHE):
        return {"removed": 0}
    cutoff = time.time() - KEEP_DAYS * 86400
    removed = 0
    for name in os.listdir(CACHE):
        p = os.path.join(CACHE, name)
        if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
            os.remove(p)
            removed += 1
        elif name.endswith(".parts"):
            shutil.rmtree(p, ignore_errors=True)
    return {"removed": removed}


COMMANDS = {"image": cmd_image, "video": cmd_video, "pdf": cmd_pdf, "page": cmd_page, "play": cmd_play, "prune": cmd_prune}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        out({"error": "usage: media.py %s <file> [args]" % "|".join(COMMANDS)})
        return
    try:
        out(COMMANDS[argv[0]](*argv[1:]))
    except Fail as e:
        out({"error": str(e)})
    except Exception as e:  # anything else still reaches the viewer as a message
        out({"error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    main(sys.argv[1:])
