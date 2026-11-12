// Generated from shared/js/claude-chat.js by shared/sync.sh: edit it there.

// A Claude Code session as a chat you can drive, for any mod: the whole conversation read
// from its JSONL transcript (claude-reader/read.py), and everything you'd do in its TUI —
// messages (queued while it works), slash commands with a palette, Stop, the permission
// mode, model and effort, its dialogs (permission prompts, questions, plan approval)
// answered with buttons, prompt history, dropped files, its todo list and background work.
//
//   this.chat = new ClaudeChat(cx, { terminal, compact, picker, actions, onGoToTerminal })
//   cx.timer.every(1000, cx => this.chat.poll(cx))         the host owns the clock
//   render: this.chat.render(t, cx)                         fills its parent
//   keys:   this.chat.onKey(e, cx) → handled?; this.chat.typing()
//   this.chat.setTarget(address, cx)                        another terminal
//   this.chat.dispose()                                     when dropping it (ends its watch)
//
// Text reaches Claude through `hc send` with the sender's hc variables cleared, so it
// arrives as typed input (slash commands run) rather than as a message from a terminal.

import { h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { div, image, svg } from "gpui-kit";
import { agents, appHome, exec, hc, notify, setShared, shared, terminals, watchFolder } from "herdr";
import {
  absorb,
  backgroundOf,
  buildRows,
  emptyState,
  family,
  fmtDuration,
  fmtTime,
  fmtTokens,
  foldOrg,
  relayed,
  rowText,
  shortModel,
  shortPath,
  todosOf,
  toMarkdown,
} from "./claude-model.js";
import { alpha, COLUMN, claudeColor, ICON, icon, mix, mono, renderRow, SPIN } from "./claude-rows.js";
import { dark } from "./look.js";
import { kindOf } from "./media-kinds.js";
import { cacheImage, openRich, pumpRich, richImage } from "./rich.js";
import { openLink } from "./viewer-link.js";

const PREFS = "claude-reader";
export const MODES = [
  { id: "clean", label: "Chat", hint: "Only the conversation" },
  { id: "normal", label: "Steps", hint: "Tool calls folded per burst" },
  { id: "verbose", label: "Everything", hint: "Every tool call and thought" },
];
const PERMISSION = {
  default: { label: "Manual", glyph: "⏸", hint: "Asks before edits and commands" },
  acceptEdits: { label: "Accept edits", glyph: "⏵⏵", hint: "Edits without asking" },
  plan: { label: "Plan", glyph: "⏸", hint: "Plans only, no changes" },
  auto: { label: "Auto", glyph: "⏵⏵", hint: "The classifier decides" },
  bypassPermissions: { label: "Bypass", glyph: "⏵⏵", hint: "Never asks" },
};
/** The rows of Claude Code's model picker (`/model` with no argument), the only way to pick a
 *  model for one session (its `s` key; a typed `/model X` saves X as every session's default).
 *  `model`: what the row stands for, as the picker last showed it (see pickInPicker). */
const PICKER_ROWS = ["opus", "fable", "sonnet", "haiku", "default"];
const familyOf = id => /claude-([a-z]+)/.exec(id ?? "")?.[1] ?? null;
const wait = (cx, ms) => new Promise(done => cx.timer.after(ms, () => done()));
/** A message as the transcript and HQ both say it: without Claude Code's "[Image #N]" markers and
 *  the picture paths a message carries (Claude Code turns those into images), spaces collapsed. */
const IMG_EXT = "png|jpe?g|gif|webp|heic|heif|tiff?|bmp";
const plainText = s =>
  String(s ?? "")
    .replace(/\[Image #\d+\]/g, " ")
    .replace(new RegExp(`"[^"]*\\.(?:${IMG_EXT})"|'[^']*\\.(?:${IMG_EXT})'|\\S+\\.(?:${IMG_EXT})\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
const sameMessage = (a, b) => {
  const x = plainText(a);
  const y = plainText(b);
  if (!x || !y) return false;
  return x === y || x.includes(y.slice(0, 60)) || y.includes(x.slice(0, 60));
};
const MODELS_PY = () => `${appHome()}/mods/claude-reader/models.py`;
/** Whether a menu choice is what the session runs: the same model id or effort, or an alias
 *  ("opus", "sonnet[1m]") that names the session's model. */
function isCurrent(choice, current) {
  if (!choice || !current) return false;
  const x = String(choice).toLowerCase();
  const c = String(current).toLowerCase();
  if (x === c) return true;
  return /^[a-z]+$/.test(x) && familyOf(c) === x;
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SEND_ENV = ["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "-u", "HC_TERMINAL_SOCKET"];
const READ = () => `${appHome()}/mods/claude-reader/read.py`;
const COMMANDS = () => `${appHome()}/mods/claude-reader/commands.py`;
/** Rows that unroll in when they arrive (see arrive). More at once than ARRIVE_MAX just show. */
const ARRIVES = new Set(["prompt", "text", "group", "note", "dur", "cmd", "bash", "fold", "foldend", "working"]);
const ARRIVE_MAX = 8;
/** How long a first Esc waits for the second that confirms it (see escape). */
const ESC_MS = 2000;
/** How long a sent message takes to glide from the composer into the conversation. */
const FLIGHT_MS = 420;
/** The system's Reduce Motion, read once for every chat: rows then appear without unrolling. */
let stillMotion = null;
function readStillMotion() {
  if (stillMotion !== null) return;
  stillMotion = false;
  exec("defaults", ["read", "com.apple.universalaccess", "reduceMotion"])
    .then(r => (stillMotion = r.stdout.trim() === "1"))
    .catch(() => {});
}
/** The installed Claude Code's version, read once: the picker's rows are only known for the
 *  version that showed them (see modelChoices). "" until read, or when it can't be. */
let claudeVersion = null;
function readClaudeVersion() {
  if (claudeVersion !== null) return;
  claudeVersion = "";
  exec("claude", ["--version"])
    .then(r => (claudeVersion = /\d[\w.-]*/.exec(r.stdout)?.[0] ?? ""))
    .catch(() => {});
}
/** From this width the chat shows its session panel beside the conversation. */
const ASIDE_FROM = 1180;
const ASIDE_W = 300;
/** A session's context window, from its model (the transcript's id, e.g. claude-fable-5-1): every
 *  current model has 1M; Claude 3 and Haiku 4.5 have 200k. Unknown: 1M. */
const windowFor = model => (/claude-(?:3|haiku-4-5)/.test(model ?? "") ? 200_000 : 1_000_000);
const HISTORY = "claude-chat.history";
const isClaude = a => a && (a.app === "claude-code" || a.program?.key === "claude");
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

export class ClaudeChat {
  /**
   * `o.terminal`: the address to show (else `o.pick()`, else none). `o.compact`: a narrow
   * side-panel look. `o.picker`: the header's session picker (default true). `o.actions(t)`:
   * extra header buttons. `o.onGoToTerminal(addr)`: what "Go to terminal" does.
   * `o.foldOrg`: fold the turns the person didn't start (ticks, other agents' messages, lines
   * HQ typed) into one row per run. `o.replace(t, chat)`: a host's own pane in place of the
   * conversation when it returns one (the composer stays). `o.onSent(text, cx)`: after a
   * message leaves the composer.
   */
  constructor(cx, o = {}) {
    this.o = o;
    this.handle = cx.focus_handle();
    bindSuggestKeys(cx);
    this.search = InputState.new({ placeholder: "Search this conversation" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      this.bump();
      cx.notify();
    });
    this.search.on("focus", (_e, cx) => {
      this.searchFocus = true;
      cx.notify();
    });
    this.search.on("blur", (_e, cx) => {
      this.searchFocus = false;
      cx.notify();
    });
    this.composer = TextareaState.new({ placeholder: "Message Claude…  / for commands", rows: 1 });
    this.composer.set_auto_grow(1, 10);
    this.composer.on("submit", (e, cx) => {
      // ↵ sends (or queues, while Claude works); ⌘↵ / Ctrl+↵ sends now, into the running turn.
      if (!e?.shift) this.send(cx, undefined, { now: !!e?.secondary });
    });
    this.composer.on("change", (_e, cx) => {
      this.palSel = 0;
      // An "@" asks for files and agents: read them now (once per folder), redraw when in.
      if (/(^|\s)@[^\s]*$/.test(this.composer.value()) && !this.mentions) this.loadMentions(cx);
      cx.notify();
    });
    // A paste that found no text: a picture on the clipboard. Saved to a file and attached.
    this.composer.on("paste_other", (_e, cx) => this.pastePicture(cx));
    this.composer.on("focus", (_e, cx) => {
      this.composing = true;
      cx.notify();
    });
    this.composer.on("blur", (_e, cx) => {
      this.composing = false;
      cx.notify();
    });

    this.query = "";
    this.searching = false;
    this.toggled = new Set();
    this.follow = true;
    this.heights = new Map();
    this.anchorKey = null;
    this.off = 0;
    this.viewH = 600;
    this.version = 0;
    this.picking = false;
    this.menu = null; // "model" | "effort" | "todos" | "bg"
    this.palSel = 0;
    this.commands = null;
    this.queued = [];
    this.attached = []; // pictures for the next message: { path, rel } (rel: an image() path)
    this.history = loadHistory();
    this.histAt = -1;
    this.tick = 0;
    this.footer = {};
    this.gen = 0; // bumped on another target: a read still in flight for the old one is dropped
    this.addr = o.terminal ?? o.pick?.() ?? null;
    this.arriving = new Map(); // row key → { h, ms, delay, hold, at }: rows unrolling in
    this.sentN = 0;
    readStillMotion();
    readClaudeVersion();
    this.reset();
  }

  reset() {
    this.state = emptyState();
    this.meta = {};
    this.path = "";
    this.offset = 0;
    this.pid = null;
    this.cwd = null;
    this.pidAt = 0;
    this.loaded = false;
    this.readAt = 0;
    this.dirty = true;
    this.error = null;
    this.dropped = 0;
    this.truncated = false;
    this.screen = null;
    this.footer = {};
    this.queued = [];
    this.seen = null; // the row keys already shown: the next rows() takes them in without motion
    this.arriving?.clear();
    this.sent = []; // { id, text, at }: messages sent and shown before the transcript has them
    if (this.addr) this.loadQueue();
    this.handoff = new Map(); // a transcript prompt's row key → the sent row it replaces
    this.flight = null; // { id, key, at, h }: a sent message gliding from the composer
    this.bump();
  }

  bump() {
    this.version += 1;
  }

  typing() {
    return !!(this.composing || this.searchFocus);
  }

  focus() {
    this.handle.focus();
  }

  // ─── which terminal ────────────────────────────────────────────────────

  agent() {
    return agents().find(a => a.address === this.addr) ?? null;
  }

  status() {
    return this.agent()?.status ?? null;
  }

  /** Claude's own turn runs, so a message waits in the queue. Not while the turn has ended and
   *  only background agents run: Herdr still says "working", but the TUI takes messages then.
   *  The footer must be read since the status last changed, else a new turn could look ended. */
  turnRunning() {
    if (this.status() !== "working") return false;
    return !(this.footer.backgroundOnly && (this.footer.at ?? 0) > (this.stAt ?? 0));
  }

  term() {
    return terminals().find(t => t.address === this.addr) ?? null;
  }

  setTarget(addr, cx) {
    if (!addr || addr === this.addr) return;
    this.addr = addr;
    this.picking = false;
    this.menu = null;
    this.mentions = null; // another agent may work in another folder
    this.mentionsFor = null;
    this.toggled.clear();
    this.follow = true;
    this.gen += 1;
    this.busy = false;
    this.watch_ = null;
    this.reset();
    this.refresh(cx);
    cx.notify();
  }

  /** The host drops this chat: its folder watch ends on the next change. */
  dispose() {
    this.gen += 1;
    this.disposed = true;
    this.watch_ = null;
  }

  // ─── reading ───────────────────────────────────────────────────────────

  /**
   * Call about once a second. The transcript is read when its folder changed (a watch marks
   * it), and every few seconds anyway, to notice a new session; without a watch, every second
   * while it works or waits on you, else every 3 s. The TUI's footer is read every 3 s, and a
   * dialog on screen every second.
   */
  poll(cx) {
    this.tick += 1;
    pumpRich(cx);
    // Motions end natively; their state is dropped here (a size callback may not see the end).
    const now = Date.now();
    if (this.flight && now - this.flight.at > FLIGHT_MS + 300) {
      this.flight = null;
      cx.notify();
    }
    for (const [k, a] of this.arriving) if (now - a.at > 2500) this.arriving.delete(k);
    this.flushQueue(cx);
    const st = this.status();
    const live = st === "working" || st === "blocked";
    const since = Date.now() - this.readAt;
    const read = this.watch_ ? this.dirty || since >= (live ? 5000 : 15000) : live || since >= 3000;
    const footer = Date.now() - (this.footer.at ?? 0) >= (live ? 3000 : 10000);
    if (read || footer || st === "blocked") this.refresh(cx, { read, footer });
  }

  refresh(cx, { read = true, footer = true } = {}) {
    if (!this.addr) {
      this.addr = this.o.pick?.() ?? null;
      if (!this.addr) return;
    }
    if (this.busy) return;
    this.busy = true;
    const gen = this.gen;
    const st = this.status();
    cx.spawn(async cx => {
      try {
        if (read) await this.read(gen);
        if (gen !== this.gen) return;
        if (st === "blocked") await this.readScreen();
        else {
          this.screen = null;
          if (footer || !this.footer.at) await this.readFooter();
        }
        if (!this.commands) this.loadCommands();
        this.watch(cx);
      } catch (err) {
        if (gen === this.gen) this.error = String(err?.message ?? err);
      } finally {
        if (gen === this.gen) this.busy = false;
        cx.notify();
      }
    });
  }

  /** Marks the chat dirty when its transcript's folder changes, so polls skip reading an
   *  unchanged file. Without a watch (it failed, or no transcript yet), polls read on a clock. */
  watch(cx) {
    const path = this.path;
    const dir = path ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dir || this.watch_ || this.watchFailed || this.disposed) return;
    // Identity, not the folder: another session in the same folder gets a watch of its own.
    const token = { dir };
    this.watch_ = token;
    const base = path.slice(dir.length);
    cx.spawn(async () => {
      try {
        while (this.watch_ === token) {
          const paths = await watchFolder(dir);
          // The root in a batch means "refresh everything".
          if (paths.some(p => p === dir || p.endsWith(base))) this.dirty = true;
        }
      } catch {
        this.watchFailed = true;
      }
      if (this.watch_ === token) this.watch_ = null;
    });
  }

  async read(gen) {
    const now = Date.now();
    // Finding the session reads the process table: only with the terminal's facts, every 8 s.
    let resolve = !this.path;
    if (!this.pid || now - this.pidAt > 8000) {
      const r = await hc(["get", this.addr, "--json"]);
      if (gen !== this.gen) return;
      if (r.code === 0) {
        const info = JSON.parse(r.stdout);
        this.pid = info.foreground?.pid ?? info.pid ?? null;
        this.cwd = info.foreground?.cwd ?? info.cwd ?? null;
        this.pidAt = now;
      }
      resolve = true;
    }
    this.dirty = false; // before reading: a change while it reads marks it again
    const args = [
      "-I",
      READ(),
      "--pid",
      String(this.pid ?? ""),
      "--cwd",
      this.cwd ?? "",
      "--path",
      this.path,
      "--offset",
      String(this.offset),
    ];
    const r = await exec("python3", resolve ? [...args, "--resolve"] : args);
    if (gen !== this.gen) return;
    this.readAt = Date.now();
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "read.py failed");
    const out = JSON.parse(r.stdout);
    if (out.error) {
      this.error = out.error;
      this.loaded = true;
      return;
    }
    this.error = null;
    if (out.reset && this.loaded) {
      this.state = emptyState();
      this.meta = {};
    }
    if (out.reset) {
      this.dropped = out.dropped ?? 0;
      this.truncated = !!out.truncated;
    }
    if (out.path !== this.path) this.watch_ = null; // another session: watch its folder
    this.path = out.path;
    this.offset = out.offset;
    if (out.config) this.configDir = out.config;
    this.loadModels();
    this.meta = { ...this.meta, ...out.meta, name: out.name ?? this.meta.name };
    if (out.events.length || !this.loaded) {
      absorb(this.state, out.events);
      this.settleQueued(out.events);
      this.bump();
    }
    this.loaded = true;
  }

  /** Queued messages leave the queue once the transcript shows them as prompts. */
  settleQueued(events) {
    this.settleSent(events);
  }

  /** A sent message the transcript now has: its prompt row takes the sent row's place, unmoved. */
  settleSent(events) {
    if (!this.sent.length) return;
    const old = Date.now() - 2 * 60_000;
    for (const e of events) {
      if (e.k !== "user") continue;
      const i = this.sent.findIndex(
        x => sameMessage(e.text, x.text) || (!plainText(x.text) && x.files?.length && e.images),
      );
      if (i < 0) continue;
      this.handoff.set(`u:${e.id}`, `sent:${this.sent[i].id}`);
      this.sent.splice(i, 1);
    }
    this.sent = this.sent.filter(x => x.at > old);
  }

  async screenLines(n) {
    const r = await hc(["read", this.addr, "--lines", String(n)]);
    if (r.code !== 0) return null;
    const rows = strip(r.stdout)
      .split("\n")
      .map(l => l.replace(/\s+$/, ""))
      .filter(l => !l.startsWith("[hc] "));
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    return rows;
  }

  /** The TUI's footer: the permission mode line, the effort marker, and whether the turn has ended
   *  with only background work left ("✻ Waiting for 1 background agent to finish", above the
   *  prompt and the list of running agents, hence the extra lines). */
  async readFooter() {
    const rows = await this.screenLines(30);
    if (!rows) return;
    const f = { at: Date.now() };
    // The live status line sits right above the input box (a rule, then "❯"); older turns'
    // lines in the scrollback don't count.
    const box = rows.findLastIndex((l, i) => /^\s*─{8,}/.test(l) && /^\s*❯/.test(rows[i + 1] ?? ""));
    const above = rows.slice(0, Math.max(box, 0)).findLast(l => l.trim());
    f.backgroundOnly = box > 0 && /^\s*\S\s+Waiting for (?:\d+ |background )/.test(above ?? "");
    for (const l of rows) {
      const m = l.match(/(⏵⏵|⏸)\s+(auto mode|accept edits|plan mode|manual mode|bypass permissions)\s+on/i);
      if (m)
        f.mode = {
          "auto mode": "auto",
          "accept edits": "acceptEdits",
          "plan mode": "plan",
          "manual mode": "default",
          "bypass permissions": "bypassPermissions",
        }[m[2].toLowerCase()];
      if (m || /shift\+tab to cycle/.test(l)) {
        f.shells = Number(l.match(/(\d+)\s+shells?\b/)?.[1] ?? 0);
        f.agents = Number(l.match(/(\d+)\s+(?:background\s+)?agents?\b/)?.[1] ?? 0);
      }
      const e = l.match(/[◐◑◒◓○●◔◕]\s*(low|medium|high|xhigh|max)\s*·\s*\/effort/i);
      if (e) f.effort = e[1].toLowerCase();
    }
    this.footer = f;
  }

  /** A dialog on screen: its text, its options and the keys that pick each one. */
  async readScreen() {
    const rows = await this.screenLines(60);
    if (rows) this.screen = parseDialog(rows);
  }

  loadCommands() {
    this.commands = [];
    exec("python3", ["-I", COMMANDS(), "--cwd", this.meta.cwd ?? this.cwd ?? ""])
      .then(r => {
        this.commands = JSON.parse(r.stdout || "{}").commands ?? [];
      })
      .catch(() => {});
  }

  // ─── acting ────────────────────────────────────────────────────────────

  /** Types `text` into the session as if at its prompt; `force` answers a dialog. */
  async deliver(text, force) {
    const args = [...SEND_ENV, "hc", "send", ...(force ? ["--force"] : []), this.addr, text];
    const r = await exec("env", args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 240) || "hc send failed");
  }

  /**
   * Sends the composer's text (or `given`). While Claude works, a message waits in this chat's
   * own queue (see the queue below) instead of Claude Code's: there it can be edited, sent now or
   * removed, and it goes out when the turn ends. `o.now` (⌘↵) sends at once, into the running
   * turn; slash commands and dialog answers always go at once.
   */
  send(cx, given, o = {}) {
    let text = (given ?? this.composer.value()).trim();
    if (!given) {
      const sug = this.suggest();
      if (sug && sug.items.length && sug.mode !== "command") {
        this.complete(sug.items[Math.min(this.palSel, sug.items.length - 1)], cx);
        return;
      }
      if (sug?.mode === "command" && sug.items.length)
        text = sug.items[Math.min(this.palSel, sug.items.length - 1)].insert;
    }
    const files = given ? [] : this.attached.map(a => a.path);
    if ((!text && !files.length) || !this.addr) return;
    if (files.length) {
      // Paths at the end, quoted: Claude Code turns each into an attached image ("[Image #N]").
      text = [text, ...files.map(p => `"${p}"`)].filter(Boolean).join(" ");
      this.attached = [];
    }
    // The @-mention list (every tracked file of the folder) is big; free it once a message goes.
    this.mentions = null;
    this.mentionsFor = null;
    // Claude Code exited there: what's left is a shell, which would run the message as a command.
    if (!this.agent()) {
      notify({
        title: "Not sent",
        body: `${this.addr} no longer runs an agent, so your message stayed in the box.`,
        level: "warning",
      });
      return;
    }
    const st = this.status();
    if (!given) this.composer.set_value("");
    this.follow = true;
    this.o.onSent?.(text, cx);
    this.histAt = -1;
    this.history = [text, ...this.history.filter(h => h !== text)].slice(0, 100);
    saveHistory(this.history);
    if (this.turnRunning() && !o.now && !given && !text.startsWith("/")) {
      const q = { id: ++this.sentN, text, files, at: Date.now() };
      this.queued.push(q);
      this.saveQueue();
      if (!stillMotion && this.loaded && !this.query)
        this.flight = { id: q.id, key: `queued:${q.id}`, at: Date.now(), h: null };
      this.bump();
      cx.notify();
      return;
    }
    this.dispatch(text, cx, { animate: !given, blocked: st === "blocked", restore: given ? null : text, files });
  }

  /** Delivers `text` to Claude Code now, shown at once as sent (a bubble until the transcript has it). */
  dispatch(text, cx, { animate = false, blocked = false, restore = null, back = null, files = [] } = {}) {
    let sent = null;
    if (!blocked && !text.startsWith("/") && !this.query) {
      sent = { id: ++this.sentN, text, files, at: Date.now() };
      this.sent.push(sent);
      if (animate && !stillMotion && this.loaded)
        this.flight = { id: sent.id, key: `sent:${sent.id}`, at: Date.now(), h: null };
      this.bump();
    }
    cx.spawn(async cx => {
      try {
        await this.deliver(text, blocked);
      } catch (e) {
        if (restore != null) this.composer.set_value(restore);
        if (back) {
          this.queued = [...back, ...this.queued];
          this.saveQueue();
        }
        if (sent) {
          this.sent = this.sent.filter(x => x !== sent);
          this.flight = null;
        }
        this.bump();
        notify({ title: "Couldn't send", body: String(e?.message ?? e), level: "error" });
      }
      this.refresh(cx);
      cx.notify();
    });
    cx.notify();
  }

  // ─── the queue: messages held while Claude works ───────────────────────

  /** When the turn has ended (idle a moment, not waiting on a dialog), what's queued goes as one
   *  message, as Claude Code merges its own queue. */
  flushQueue(cx) {
    const st = this.status();
    if (st !== this.stNow) {
      this.stNow = st;
      this.stAt = Date.now();
    }
    if (
      !this.queued.length ||
      !this.loaded ||
      this.turnRunning() ||
      st === "blocked" ||
      Date.now() - this.stAt < 1200 ||
      !this.agent()
    )
      return;
    const items = this.queued;
    this.queued = [];
    this.saveQueue();
    this.dispatch(items.map(q => q.text).join("\n\n"), cx, { back: items, files: items.flatMap(q => q.files ?? []) });
  }

  queueEdit(id, cx) {
    const q = this.queued.find(x => x.id === id);
    if (!q) return;
    this.queued = this.queued.filter(x => x !== q);
    this.saveQueue();
    const cur = this.composer.value().trim();
    const words = plainText(q.text) ? q.text.replace(/\s*"[^"]*"\s*$/g, "").trim() : "";
    for (const p of q.files ?? [])
      if (!this.attached.some(a => a.path === p)) this.attached.push({ local: p, path: p, rel: null });
    this.composer.set_value(cur ? `${cur}\n\n${words}` : words);
    this.composer.focus();
    this.bump();
    cx.notify();
  }

  queueSendNow(id, cx) {
    const q = this.queued.find(x => x.id === id);
    if (!q) return;
    this.queued = this.queued.filter(x => x !== q);
    this.saveQueue();
    this.dispatch(q.text, cx, { back: [q], files: q.files ?? [] });
  }

  queueRemove(id, cx) {
    this.queued = this.queued.filter(x => x.id !== id);
    this.saveQueue();
    this.bump();
    cx.notify();
  }

  /** The queue outlives the chat (a reload, HQ dropping a hidden chat): kept per terminal. */
  saveQueue() {
    if (!this.addr) return;
    try {
      if (this.queued.length) localStorage.setItem(`chat.queue.${this.addr}`, JSON.stringify(this.queued));
      else localStorage.removeItem(`chat.queue.${this.addr}`);
    } catch {
      // the queue still holds in memory
    }
  }

  loadQueue() {
    try {
      const got = JSON.parse(localStorage.getItem(`chat.queue.${this.addr}`) ?? "[]");
      this.queued = Array.isArray(got) ? got.filter(q => q?.id && q.text) : [];
      for (const q of this.queued) this.sentN = Math.max(this.sentN, q.id);
    } catch {
      this.queued = [];
    }
  }

  keys(keys, cx) {
    cx.spawn(async cx => {
      await hc(["keys", this.addr, ...keys]);
      this.screen = null;
      this.footer.at = 0;
      this.refresh(cx);
    });
  }

  interrupt(cx) {
    this.keys(["esc"], cx);
  }

  cycleMode(cx) {
    this.keys(["shift+tab"], cx);
  }

  goToTerminal() {
    if (this.o.onGoToTerminal) this.o.onGoToTerminal(this.addr);
  }

  setMode(mode, cx) {
    setShared(PREFS, { ...(shared(PREFS) ?? {}), mode });
    this.toggled.clear();
    this.bump();
    cx.notify();
  }

  mode() {
    return shared(PREFS)?.mode ?? "normal";
  }

  rows() {
    if (this.cache?.version === this.version && this.cache.mode === this.mode() && this.cache.st === this.status())
      return this.cache.rows;
    const fold = this.folding();
    let rows = buildRows(this.state, { mode: this.mode(), query: this.query, foldOrg: fold });
    if (fold && !this.query.trim()) rows = foldOrg(rows, (key, byDefault) => this.isOpen(key, !!byDefault));
    const older = this.dropped + (this.state.trimmed ?? 0);
    if ((older || this.truncated) && !this.query)
      rows.unshift({
        type: "top",
        key: "top",
        text: this.truncated
          ? "Showing the latest part · older messages not loaded"
          : `Showing the latest part · ${older} older events not loaded`,
      });
    if (this.sent.length && !this.query) {
      const turn = Math.max(0, ...rows.map(r => r.turn ?? 0)) + 1;
      for (const x of this.sent)
        rows.push({
          type: "prompt",
          key: `sent:${x.id}`,
          ev: { text: plainText(x.text), files: x.files ?? [], ts: new Date(x.at).toISOString() },
          turn,
        });
    }
    if (this.status() === "working" && !this.query) {
      const last = rows[rows.length - 1];
      const start = [...rows].reverse().find(r => r.type === "prompt" || r.type === "cmd" || r.type === "fold");
      const since = start?.type === "fold" ? start.turns[start.turns.length - 1]?.ts : start?.ev?.ts;
      rows.push({ type: "working", key: "working", turn: last?.turn, since });
    }
    if (this.queued.length && !this.query) {
      const turn = Math.max(0, ...rows.map(r => r.turn ?? 0)) + 1;
      this.queued.forEach((q, i) =>
        rows.push({
          type: "prompt",
          key: `queued:${q.id}`,
          ev: { text: plainText(q.text), files: q.files ?? [], ts: new Date(q.at).toISOString() },
          turn,
          waiting: true,
          qid: q.id,
          qn: i + 1,
          qof: this.queued.length,
        }),
      );
    }
    rows.push({ type: "end", key: "end" });
    this.noteArrivals(rows);
    this.cache = {
      version: this.version,
      mode: this.mode(),
      st: this.status(),
      rows,
      todos: todosOf(this.state),
      bg: backgroundOf(this.state),
    };
    return rows;
  }

  /**
   * Marks rows that weren't there before to unroll in. Not on the first rows of a chat, nor when
   * the view mode or a search changed them all, nor for a burst too big to watch (a chat shown
   * again after a while): those simply show.
   */
  noteArrivals(rows) {
    const look = `${this.mode()}|${this.query}`;
    // A transcript prompt replacing a sent row takes its measured height and shows in place.
    for (const r of rows) {
      const was = this.handoff.get(r.key);
      if (!was) continue;
      if (this.heights.has(was)) this.heights.set(r.key, this.heights.get(was));
      this.seen?.add(r.key);
      this.handoff.delete(r.key);
    }
    const fresh =
      this.seen && this.seenLook === look && this.loaded && !stillMotion
        ? rows.filter(r => ARRIVES.has(r.type) && !this.seen.has(r.key))
        : [];
    if (fresh.length && fresh.length <= ARRIVE_MAX)
      fresh.forEach((r, i) => {
        // The row a message flies into opens at once and shows when the flyer lands (FLIGHT_MS).
        const flying = this.flight?.key === r.key;
        this.arriving.set(r.key, {
          h: null,
          delay: flying ? 0 : i * 70,
          hold: flying ? FLIGHT_MS - 40 : null,
          at: Date.now(),
        });
      });
    this.seen = new Set(rows.map(r => r.key));
    this.seenLook = look;
  }

  /**
   * A row arriving: drawn at no height and clear, measured, then grown to its own height while it
   * fades in (natively: GPUI's transitions), so an answer unrolls and the conversation glides up
   * instead of jumping. Taller rows take a little longer. Once grown it is a plain row again.
   */
  arrive(row, el) {
    const a = this.arriving.get(row.key);
    // The same two wrappers either way, so a row that has grown keeps its elements (no remount).
    if (!a) return div().id(`arrive-${row.key}`).w_full().flex_none().child(div().w_full().flex_none().child(el));
    const inner = div()
      .w_full()
      .flex_none()
      .on_size_change((size, cx) => {
        if (a.h == null && size.height > 0) {
          a.h = size.height;
          a.ms = Math.round(Math.min(900, Math.max(240, 180 + size.height * 0.9)));
          cx.notify();
        }
      })
      .child(el);
    const wrap = div()
      .id(`arrive-${row.key}`)
      .w_full()
      .flex_none()
      .overflow_hidden()
      .transition("height", { duration: a.ms ?? 300, delay: a.delay, easing: "ease-out" })
      .transition(
        "opacity",
        a.hold != null
          ? { duration: 120, delay: a.hold }
          : { duration: Math.min(a.ms ?? 300, 420), delay: a.delay, easing: "ease-out" },
      )
      .on_size_change((size, cx) => {
        // Grown: let go of the fixed height (an opened step can grow it later).
        if (a.h != null && size.height >= a.h - 0.5) {
          this.arriving.delete(row.key);
          cx.notify();
        }
      });
    return a.h == null ? wrap.h(0).opacity(0).child(inner) : wrap.h(a.h).opacity(1).child(inner);
  }

  /** Whether this chat folds org work: `o.foldOrg`, a flag or a function of the chat. */
  folding() {
    const f = this.o.foldOrg;
    return !!(typeof f === "function" ? f(this) : f);
  }

  isOpen(key, byDefault) {
    return byDefault !== this.toggled.has(key);
  }

  toggle(key, cx) {
    if (this.toggled.has(key)) this.toggled.delete(key);
    else this.toggled.add(key);
    if (key.startsWith("o:")) this.bump(); // a fold changes the rows themselves
    cx.notify();
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    notify({ title: "Copied", body: text.slice(0, 80), level: "success", timeout: 1600 });
  }

  copyAll(cx) {
    cx.write_to_clipboard(toMarkdown(this.state, this.title(), this.meta.cwd));
    notify({ title: "Conversation copied as Markdown", level: "success", timeout: 1800 });
  }

  /** Files dropped on the chat: their paths go into the composer (Claude reads image paths);
   * on another machine they're copied there first. */
  /** Files dropped on the chat: pictures attach to the next message (chips in the composer);
   *  other files go into the text as paths. A remote agent gets copies on its machine first. */
  drop(paths, cx) {
    if (!paths?.length) return;
    cx.spawn(async cx => {
      const text = [];
      for (const p of paths) {
        if (kindOf(p) === "image") await this.attach(p);
        else text.push(await this.onAgentMachine(p));
      }
      if (text.length) {
        const cur = this.composer.value();
        this.composer.set_value(
          (cur ? cur.replace(/\s*$/, " ") : "") + text.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ",
        );
      }
      this.composer.focus();
      cx.notify();
    });
  }

  async onAgentMachine(p) {
    if (!this.addr?.includes("/")) return p;
    const r = await hc(["put", this.addr, p]);
    return r.code === 0 ? r.stdout.trim().split("\n").pop() : p;
  }

  /** A picture for the next message: its path (on the agent's machine) and a thumbnail. */
  async attach(file) {
    if (this.attached.some(a => a.local === file)) return;
    const [path, rel] = await Promise.all([this.onAgentMachine(file), cacheImage(file).catch(() => null)]);
    this.attached.push({ local: file, path, rel });
  }

  /** ⌘V with a picture on the clipboard: saved as a PNG (macOS osascript) and attached. */
  pastePicture(cx) {
    cx.spawn(async cx => {
      const dir = `${appHome()}/data/chat-attachments`;
      const file = `${dir}/paste-${Date.now()}.png`;
      await exec("mkdir", ["-p", dir]);
      const script = [
        `set f to POSIX file "${file}"`,
        "set d to the clipboard as «class PNGf»",
        "set h to open for access f with write permission",
        "set eof h to 0",
        "write d to h",
        "close access h",
      ];
      const r = await exec(
        "osascript",
        script.flatMap(l => ["-e", l]),
      ).catch(e => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        notify({ title: "Nothing to paste", body: "The clipboard holds no picture HQ can read.", level: "warning" });
        return;
      }
      await this.attach(file);
      this.composer.focus();
      cx.notify();
    });
  }

  detach(i, cx) {
    this.attached.splice(i, 1);
    cx.notify();
  }

  // ─── the command palette ───────────────────────────────────────────────

  /**
   * What the composer suggests for the word being typed (at the end of the text):
   *   "/x" as the whole message: slash commands and skills (Enter runs the top one);
   *   "/x" later in a message: skills, to mention by name;
   *   "@x": files in the session's folder and subagent types (`@agent-name`).
   * Returns { mode, token, items } or null; each item has `insert` (what replaces the word).
   */
  suggest() {
    if (!this.composing) return null;
    const v = this.composer.value();
    if (v.startsWith("/") && !/\s/.test(v)) {
      const q = v.slice(1).toLowerCase();
      const all = this.commands ?? [];
      const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
      const has = q
        ? all.filter(
            c =>
              !c.name.toLowerCase().startsWith(q) &&
              (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
          )
        : [];
      return {
        mode: "command",
        token: v,
        items: [...starts, ...has].slice(0, 8).map(c => ({ ...c, label: `/${c.name}`, insert: `/${c.name}` })),
      };
    }
    const m = /(^|\s)([@/][^\s]*)$/.exec(v);
    if (!m) return null;
    const token = m[2];
    const q = token.slice(1).toLowerCase();
    if (token[0] === "/") {
      const skills = (this.commands ?? []).filter(c => c.source !== "builtin" && c.source !== "user");
      const hit = skills.filter(
        c => c.name.toLowerCase().includes(q) || (q.length > 2 && c.description.toLowerCase().includes(q)),
      );
      return {
        mode: "skill",
        token,
        items: hit.slice(0, 8).map(c => ({ ...c, label: `/${c.name}`, insert: `/${c.name}` })),
      };
    }
    if (!this.mentions) return { mode: "mention", token, items: [], loading: true };
    const agentsOnly = q.startsWith("agent-");
    const aq = agentsOnly ? q.slice(6) : q;
    const agents = (this.mentions.agents ?? [])
      .filter(
        a =>
          !aq ||
          a.name.toLowerCase().includes(aq) ||
          (aq.length > 2 && (a.description ?? "").toLowerCase().includes(aq)),
      )
      .slice(0, agentsOnly ? 8 : 3)
      .map(a => ({ ...a, label: `@agent-${a.name}`, insert: `@agent-${a.name}`, kind: "agent" }));
    const files = agentsOnly
      ? []
      : rankFiles(this.mentions.files ?? [], q, 8 - agents.length).map(f => ({
          name: f,
          label: `@${f}`,
          insert: `@${f}`,
          description: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
          source: "file",
          kind: "file",
        }));
    return { mode: "mention", token, items: q ? [...files, ...agents] : [...agents, ...files] };
  }

  moveSuggestion(step, cx) {
    const pal = this.paletteItems();
    if (!pal?.length) return;
    this.palSel = (Math.min(this.palSel, pal.length - 1) + step + pal.length) % pal.length;
    cx.notify();
  }

  paletteItems() {
    // Esc hides the list until the text changes.
    if (this.suggestOff != null && this.suggestOff === this.composer.value()) return null;
    this.suggestOff = null;
    const s = this.suggest();
    return s && (s.items.length || s.loading) ? s.items : null;
  }

  /** Files and subagent types for @-mentions, read once per folder. */
  loadMentions(cx) {
    const cwd = this.meta.cwd ?? this.cwd ?? "";
    if (this.mentionsFor === cwd || this.loadingMentions) return;
    this.loadingMentions = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", ["-I", COMMANDS(), "--mentions", "--cwd", cwd]);
        this.mentions = JSON.parse(r.stdout || "{}");
        this.mentionsFor = cwd;
      } catch {
        this.mentions = { files: [], agents: [] };
      }
      this.loadingMentions = false;
      cx.notify();
    });
  }

  complete(item, cx) {
    const s = this.suggest();
    const v = this.composer.value();
    const head = s && v.endsWith(s.token) ? v.slice(0, v.length - s.token.length) : "";
    this.composer.set_value(`${head}${item.insert ?? `/${item.name}`} `);
    this.palSel = 0;
    this.composer.focus();
    cx.notify();
  }

  // ─── scrolling ─────────────────────────────────────────────────────────

  h(row) {
    const known = this.heights.get(row.key);
    if (known != null) return known;
    return (
      { prompt: 96, text: 110, group: 52, note: 40, dur: 26, cmd: 50, bash: 90, working: 40, top: 50 }[row.type] ?? 30
    );
  }

  anchorIndex(rows) {
    const i = rows.findIndex(r => r.key === this.anchorKey);
    return i >= 0 ? i : Math.max(0, rows.length - 1);
  }

  topIndex(rows) {
    if (!this.follow) return this.anchorIndex(rows);
    let acc = 0;
    let i = rows.length - 1;
    while (i > 0 && acc + this.h(rows[i]) < this.viewH) acc += this.h(rows[i--]);
    return i;
  }

  scrollBy(dy, cx) {
    const rows = this.rows();
    const last = rows.length - 1;
    const H = this.viewH;
    if (this.follow) {
      if (dy <= 0) return;
      let acc = 0;
      let i = last;
      while (i > 0 && acc + this.h(rows[i]) < H) acc += this.h(rows[i--]);
      const hidden = acc + this.h(rows[i]) - H;
      if (hidden <= 0 && i === 0) return;
      this.anchorKey = rows[i].key;
      this.off = Math.max(0, hidden);
      this.follow = false;
    }
    let a = this.anchorIndex(rows);
    let off = this.off - dy;
    while (off < 0 && a > 0) off += this.h(rows[--a]);
    if (off < 0) off = 0;
    while (a < last && off >= this.h(rows[a])) off -= this.h(rows[a++]);
    let below = -off;
    for (let i = a; i <= last && below <= H; i++) below += this.h(rows[i]);
    if (below <= H) this.follow = true;
    else {
      this.anchorKey = rows[a].key;
      this.off = off;
    }
    cx.notify();
  }

  scrollToRow(i, cx) {
    const rows = this.rows();
    this.follow = false;
    this.anchorKey = rows[Math.max(0, Math.min(i, rows.length - 1))]?.key ?? null;
    this.off = 0;
    this.scrollBy(0, cx);
  }

  jumpPrompt(dir, cx) {
    const rows = this.rows();
    const top = this.topIndex(rows);
    const prompts = rows.map((r, i) => (r.type === "prompt" || r.type === "cmd" ? i : -1)).filter(i => i >= 0);
    if (!prompts.length) return;
    const atTop = !this.follow && this.off < 4;
    const target =
      dir < 0
        ? ([...prompts].reverse().find(i => (atTop ? i < top : i <= top)) ?? prompts[0])
        : (prompts.find(i => i > top) ?? null);
    if (target == null) return this.toBottom(cx);
    this.scrollToRow(target, cx);
  }

  toBottom(cx) {
    this.follow = true;
    cx.notify();
  }

  toTop(cx) {
    this.scrollToRow(0, cx);
  }

  openSearch(cx) {
    this.searching = true;
    this.search.focus();
    cx.notify();
  }

  closeSearch(cx) {
    this.searching = false;
    this.search.set_value("");
    this.query = "";
    this.bump();
    this.handle.focus();
    cx.notify();
  }

  /**
   * Esc's action, behind a second press with `o.confirmEsc`: the first press says what the next
   * one does (see escHint), and only an Esc within ESC_MS does it. Any other key disarms it.
   */
  escape(what, act, cx) {
    const now = Date.now();
    if (!this.o.confirmEsc || (this.escArmed?.what === what && now - this.escArmed.at < ESC_MS)) {
      this.escArmed = null;
      act(cx);
      cx.notify();
      return;
    }
    this.escArmed = { what, at: now };
    cx.notify();
    cx.timer.after(ESC_MS, cx => {
      if (this.escArmed && Date.now() - this.escArmed.at >= ESC_MS - 20) {
        this.escArmed = null;
        cx.notify();
      }
    });
  }

  /** Returns true when it handled the key. */
  onKey(e, cx) {
    const k = e.key;
    if (k !== "escape" && this.escArmed) this.escArmed = null;
    const mod = e.modifiers ?? {};
    if (this.composing) {
      const pal = this.paletteItems();
      if (pal?.length && (k === "up" || k === "down")) {
        this.palSel = (this.palSel + (k === "down" ? 1 : pal.length - 1)) % pal.length;
        cx.notify();
        return true;
      }
      if (pal?.length && k === "tab") {
        this.complete(pal[Math.min(this.palSel, pal.length - 1)], cx);
        return true;
      }
      const v = this.composer.value();
      if ((k === "up" || k === "down") && (!v || this.histAt >= 0) && !v.includes("\n") && this.history.length) {
        this.histAt = Math.max(-1, Math.min(this.history.length - 1, this.histAt + (k === "up" ? 1 : -1)));
        this.composer.set_value(this.histAt >= 0 ? this.history[this.histAt] : "");
        cx.notify();
        return true;
      }
      if (k === "escape") {
        if (!v && this.status() === "working") this.escape("stop", cx => this.interrupt(cx), cx);
        else this.handle.focus();
        return true;
      }
      return false;
    }
    if (this.searchFocus) {
      if (k === "escape") {
        this.closeSearch(cx);
        return true;
      }
      return false;
    }
    if (mod.control || mod.platform || mod.alt) {
      if (k === "f" && (mod.platform || mod.control)) {
        this.openSearch(cx);
        return true;
      }
      return false;
    }
    if (k === "tab" && mod.shift) this.cycleMode(cx);
    else if (k === "escape" && this.status() === "working") this.escape("stop", cx => this.interrupt(cx), cx);
    else if (k === "escape" && (this.searching || this.menu || this.picking)) {
      if (this.searching) this.closeSearch(cx);
      this.menu = null;
      this.picking = false;
      cx.notify();
    } else if (k === "down") this.scrollBy(-60, cx);
    else if (k === "up") this.scrollBy(60, cx);
    else if (k === "pagedown" || k === "space") this.scrollBy(-(this.viewH * 0.85) * (mod.shift ? -1 : 1), cx);
    else if (k === "pageup") this.scrollBy(this.viewH * 0.85, cx);
    else if (k === "j" || k === "]") this.jumpPrompt(1, cx);
    else if (k === "k" || k === "[") this.jumpPrompt(-1, cx);
    else if (k === "g" && !mod.shift) this.toTop(cx);
    else if (k === "g" || k === "G" || k === "end") this.toBottom(cx);
    else if (k === "home") this.toTop(cx);
    else if (k === "/") this.openSearch(cx);
    else if (k === "1" || k === "2" || k === "3") this.setMode(MODES[Number(k) - 1].id, cx);
    else if (k === "i" || k === "r" || k === "enter") this.composer.focus();
    else return false;
    return true;
  }

  title() {
    return this.meta.title || this.meta.ai_title || this.meta.summary || this.agent()?.title || "Claude Code";
  }

  // ─── drawing ───────────────────────────────────────────────────────────

  render(t, _cx) {
    const st = this.status();
    const rows = this.rows();
    // Wide enough: the session's live state sits beside the conversation (see aside).
    this.wide =
      !this.o.compact &&
      this.o.aside !== false &&
      (this.rootW ?? 0) >= ASIDE_FROM &&
      !!this.addr &&
      this.loaded &&
      !this.error;
    const ctx = {
      results: this.state.results,
      cwd: this.meta.cwd ?? this.cwd,
      running: st === "working",
      lastTool: this.state.lastTool,
      workingMsg: this.term()?.report?.msg ?? this.term()?.status?.msg ?? null,
      mode: this.mode(),
      query: this.query,
      isOpen: (key, byDefault) => this.isOpen(key, byDefault),
      toggle: (key, cx) => this.toggle(key, cx),
      copy: (text, cx) => this.copy(text, cx),
      rowText: row => rowText(row, this.state),
      queue: {
        edit: (id, cx) => this.queueEdit(id, cx),
        now: (id, cx) => this.queueSendNow(id, cx),
        remove: (id, cx) => this.queueRemove(id, cx),
      },
      rich: (kind, code) => richImage(kind, code),
      openRich: (kind, code) => openRich(richImage(kind, code)),
      colW: Math.min(COLUMN, (this.rootW ?? COLUMN) - (this.wide ? ASIDE_W : 0)) - 56,
    };
    return (
      v_flex()
        .id("claude-chat")
        .size_full()
        .min_h(0)
        .bg(t.background)
        .text_color(t.foreground)
        .track_focus(this.handle)
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - (this.rootW ?? 0)) > 0.5) {
            this.rootW = size.width;
            cx.notify();
          }
        })
        .on_key_down((e, cx) => {
          if (this.onKey(e, cx)) cx.stop_propagation();
        })
        // A click on the conversation takes keys back from the composer; the composer and the
        // search box stop the mouse-down so a click in them keeps their focus.
        .on_mouse_down("left", () => {
          if (!this.typing()) this.handle.focus();
        })
        .on_drop((e, cx) => this.drop(e.paths, cx))
        .when(!this.o.slim, el => el.child(this.header(t, st)))
        .when(this.picking, el => el.child(this.picker(t)))
        .child(this.statusBar(t, st))
        .children([this.o.below?.(t, this)].filter(Boolean))
        .when(!this.wide && this.menu === "todos", el => el.child(this.todoPanel(t)))
        .when(!this.wide && this.menu === "bg", el => el.child(this.bgPanel(t)))
        .child(
          h_flex()
            .flex_1()
            .min_h(0)
            .items_stretch()
            .child(
              v_flex()
                .relative()
                .flex_1()
                .min_w(0)
                .min_h(0)
                .when(this.searching, el => el.child(this.searchBar(t, rows)))
                .child(this.o.replace?.(t, this) ?? this.body(t, rows, ctx, st))
                .when(st === "blocked", el => el.child(this.blockedPanel(t)))
                .child(this.composerBar(t, st))
                .children([this.flyer(t, rows, ctx)].filter(Boolean)),
            )
            .when(this.wide, el => el.child(this.aside(t, rows, st, ctx))),
        )
    );
  }

  /**
   * A sent message on its way: its bubble drawn over the composer's text, then gliding up to the
   * end of the conversation (where its row is opening, see noteArrivals) and handing over to it.
   * Both motions run natively; the row shows and the flyer fades together when it lands.
   */
  flyer(t, rows, ctx) {
    const f = this.flight;
    if (!f) return null;
    const i = rows.findIndex(r => r.key === f.key);
    if (i < 0) return null;
    const row = rows[i];
    const c = !!this.o.compact;
    const bodyTop = this.searching ? 40 : 0;
    // The bubble's text over the composer's: the row's top padding, the bubble's, the composer's.
    const rowPt = row.turn === 1 ? 20 : 40;
    const start = bodyTop + this.viewH + (c ? 16 : 15) - 10 - rowPt;
    // Its place: the conversation's end, above the rows after it (followed to the bottom on send).
    let after = 0;
    for (let j = i + 1; j < rows.length; j++) after += this.h(rows[j]);
    const end = bodyTop + this.viewH - after - (f.h ?? 0);
    const landed = f.h != null;
    return div()
      .id(`flyer-${f.id}`)
      .absolute()
      .left(0)
      .right(0)
      .top(landed ? end : start)
      .opacity(landed ? 0 : 1)
      .transition("top", { duration: FLIGHT_MS, easing: "ease-out" })
      .transition("opacity", { duration: 120, delay: FLIGHT_MS - 40 })
      .on_size_change((size, cx) => {
        if (f.h == null && size.height > 0) {
          f.h = size.height;
          cx.notify();
        }
      })
      .child(renderRow(t, row, ctx));
  }

  // ─── the session panel ─────────────────────────────────────────────────

  /** Beside a wide conversation: how the session is doing, what you asked it, what it changed. */
  aside(t, rows, st, ctx) {
    const todos = this.cache?.todos ?? [];
    const bg = (this.cache?.bg ?? []).filter(x => !x.done);
    const files = this.filesChanged();
    return v_flex()
      .id("cc-aside")
      .flex_none()
      .w(ASIDE_W)
      .min_h(0)
      .border_l(1)
      .border_color(alpha(t.border, 0.55))
      .bg(mix(t.background, t.foreground, dark() ? 0.022 : 0.018))
      .overflow_y_scroll()
      .child(
        v_flex()
          .px(18)
          .pt(18)
          .pb(24)
          .gap(26)
          .child(this.sessionCard(t, rows, st, ctx))
          .when(todos.length > 0, el =>
            el.child(
              this.asideSection(
                t,
                "Todo list",
                `${todos.filter(x => x.status === "completed").length}/${todos.length}`,
                this.todoList(t, todos),
              ),
            ),
          )
          .when(bg.length > 0, el =>
            el.child(this.asideSection(t, "In the background", String(bg.length), this.bgList(t, bg))),
          )
          .child(this.asideSection(t, "Your messages", null, this.outline(t, rows)))
          .when(files.length > 0, el =>
            el.child(
              this.asideSection(
                t,
                "Files changed",
                String(files.length),
                this.fileList(t, files.slice(0, 10), ctx.cwd),
              ),
            ),
          ),
      );
  }

  asideSection(t, title, count, body) {
    return v_flex()
      .gap(8)
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(title))
          .when(!!count, el => el.child(div().text_size(11).font_family(mono()).text_color(t.dim).child(count))),
      )
      .child(body);
  }

  /** Status, how long it has been at it, how full its context is, what it runs on. */
  sessionCard(t, rows, st, ctx) {
    const working = st === "working";
    const blocked = st === "blocked";
    const since = rows.find(r => r.type === "working")?.since;
    const lastTs = [...this.state.events].reverse().find(e => e.ts)?.ts;
    const look = working
      ? {
          color: claudeColor(t),
          word: this.turnRunning() ? "Working" : "Background agents running",
          spin: true,
          note: since ? fmtDuration(Math.max(0, Date.now() - Date.parse(since))) : null,
        }
      : blocked
        ? { color: t.blocked, word: "Waiting for you", icon: "alert", note: null }
        : { color: t.dim, word: "Idle", note: lastTs ? `last active ${fmtTime(lastTs)}` : null };
    const used = this.meta.context ?? 0;
    const max = this.contextWindow();
    const f = Math.min(1, used / max);
    const barColor = f >= 0.85 ? t.blocked : f >= 0.6 ? (t.ansi3 ?? t.working) : t.accent;
    const permId = this.footer.mode ?? this.meta.permissionMode ?? null;
    const facts = [
      this.modelLabel(this.meta.model),
      this.current("/effort") && `${this.current("/effort")} effort`,
      PERMISSION[permId]?.label,
    ].filter(Boolean);
    return v_flex()
      .gap(14)
      .child(
        v_flex()
          .gap(6)
          .child(div().text_size(14).font_semibold().line_height(1.35).text_color(t.foreground).child(this.title()))
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(
                look.spin
                  ? div().w(12).text_size(12).text_color(look.color).frames(SPIN, 90)
                  : look.icon
                    ? icon(look.icon, 12, look.color)
                    : div().w(7).h(7).rounded_full().bg(look.color),
              )
              .child(
                div()
                  .text_size(12)
                  .font_medium()
                  .text_color(working || blocked ? look.color : t.muted)
                  .child(look.word),
              )
              .when(!!look.note, el => el.child(div().text_size(11.5).text_color(t.dim).child(`· ${look.note}`))),
          )
          .when(working && !!ctx.workingMsg, el =>
            el.child(div().text_size(11.5).line_height(1.45).text_color(t.muted).child(ctx.workingMsg)),
          ),
      )
      .when(used > 0, el =>
        el.child(
          v_flex()
            .id("cc-aside-ctx")
            .gap(7)
            .tooltip(`${used.toLocaleString()} of ${max.toLocaleString()} tokens in context`)
            .child(
              h_flex()
                .items_end()
                .gap(5)
                .child(
                  div().text_size(22).font_semibold().line_height(1).text_color(t.foreground).child(fmtTokens(used)),
                )
                .child(
                  div()
                    .pb(1)
                    .text_size(12)
                    .text_color(t.dim)
                    .child(`/ ${fmtTokens(max)} context`),
                )
                .child(div().flex_1())
                .child(
                  div()
                    .pb(1)
                    .text_size(11.5)
                    .font_family(mono())
                    .text_color(f >= 0.6 ? barColor : t.dim)
                    .child(`${Math.round(f * 100)}%`),
                ),
            )
            .child(
              div()
                .w_full()
                .h(6)
                .rounded_full()
                .bg(alpha(t.foreground, 0.08))
                .child(
                  div()
                    .h(6)
                    .w(Math.max(4, Math.round((ASIDE_W - 36) * f)))
                    .rounded_full()
                    .bg(barColor),
                ),
            ),
        ),
      )
      .when(facts.length > 0, el =>
        el.child(
          h_flex()
            .flex_wrap()
            .gap(5)
            .children(
              facts.map(x =>
                div().px(7).py(2).rounded(6).bg(alpha(t.foreground, 0.06)).text_size(11.5).text_color(t.muted).child(x),
              ),
            ),
        ),
      );
  }

  /** Every message the person sent, oldest first: a click scrolls to it. Turns that ended with
   *  no reply are marked, and the one in view is lit. */
  outline(t, rows) {
    const top = rows[this.topIndex(rows)]?.turn;
    const replied = new Set(rows.filter(r => r.type === "text" && !r.thought).map(r => r.turn));
    const items = [];
    rows.forEach((r, i) => {
      if (r.type === "prompt" && !relayed(r.ev.text)) items.push({ i, r, text: r.ev.text });
      else if (r.type === "cmd") items.push({ i, r, text: `${r.ev.name} ${r.ev.args ?? ""}`.trim() });
    });
    if (!items.length) return div().text_size(12).text_color(t.dim).child("Nothing yet.");
    const shown = items.slice(-14);
    return v_flex()
      .gap(1)
      .when(items.length > shown.length, el =>
        el.child(
          div()
            .px(8)
            .pb(4)
            .text_size(11)
            .text_color(t.dim)
            .child(`${items.length - shown.length} earlier`),
        ),
      )
      .children(
        shown.map(({ i, r, text }) => {
          const on = r.turn === top && !this.follow;
          const silent = r.type === "prompt" && !replied.has(r.turn);
          return h_flex()
            .id(`cc-ol-${r.key}`)
            .h(30)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(on ? alpha(t.accent, 0.12) : alpha(t.accent, 0))
            .hover(s => s.bg(alpha(t.foreground, 0.06)))
            .tooltip(text)
            .on_click((_e, cx) => this.scrollToRow(i, cx))
            .child(
              div()
                .flex_none()
                .w(36)
                .text_size(10.5)
                .font_family(mono())
                .text_color(t.dim)
                .child(fmtTime(r.ev.ts).slice(-5)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12.5)
                .text_color(on ? t.accent : t.foreground)
                .child(text.split("\n")[0]),
            )
            .when(silent, el =>
              el.child(
                div()
                  .flex_none()
                  .id(`cc-ol-s-${r.key}`)
                  .tooltip("No reply written")
                  .child(icon("alert", 11, t.ansi3 ?? t.working)),
              ),
            );
        }),
      );
  }

  /** Files the session wrote or edited, most recent first. */
  filesChanged() {
    if (this.filesFor === this.version) return this.files;
    const by = new Map();
    for (const e of this.state.tools.values()) {
      if (family(e.name) !== "edit") continue;
      const f = e.input?.file_path ?? e.input?.notebook_path;
      if (!f) continue;
      const cur = by.get(f) ?? { path: f, n: 0, ts: e.ts };
      cur.n += 1;
      cur.ts = e.ts;
      by.set(f, cur);
    }
    this.files = [...by.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    this.filesFor = this.version;
    return this.files;
  }

  fileList(t, files, cwd) {
    return v_flex()
      .gap(1)
      .children(
        files.map((f, k) => {
          const rel = shortPath(f.path, cwd);
          const cut = rel.lastIndexOf("/");
          return h_flex()
            .id(`cc-file-${k}`)
            .h(30)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .hover(s => s.bg(alpha(t.foreground, 0.06)))
            .tooltip(`Open ${rel}`)
            .on_click(() => openLink(f.path, cwd))
            .child(icon("square-pen", 12, t.ansi3 ?? t.accent))
            .child(
              div()
                .flex_none()
                .text_size(12.5)
                .text_color(t.foreground)
                .child(rel.slice(cut + 1)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(cut > 0 ? rel.slice(0, cut) : ""),
            )
            .when(f.n > 1, el =>
              el.child(div().flex_none().text_size(10.5).font_family(mono()).text_color(t.dim).child(`×${f.n}`)),
            );
        }),
      );
  }

  todoList(t, todos) {
    return v_flex()
      .gap(6)
      .children(
        todos.map(x => {
          const done = x.status === "completed";
          const now = x.status === "in_progress";
          return h_flex()
            .gap(9)
            .items_start()
            .child(
              div()
                .flex_none()
                .mt(2)
                .w(14)
                .h(14)
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .when(done, d => d.bg(alpha(t.ansi2 ?? t.accent, 0.2)).child(icon("check", 9, t.ansi2 ?? t.accent)))
                .when(!done, d => d.border(now ? 2 : 1).border_color(now ? claudeColor(t) : t.dim)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(12.5)
                .line_height(1.45)
                .text_color(done ? t.dim : now ? t.foreground : t.muted)
                .when(done, d => d.line_through())
                .child(x.text),
            );
        }),
      );
  }

  bgList(t, items) {
    return v_flex()
      .gap(6)
      .children(
        items.map(x =>
          h_flex()
            .gap(8)
            .items_center()
            .child(svg(ICON("spinner")).flex_none().w(11).h(11).text_color(t.working).spin(900))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(x.label))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(x.kind)),
        ),
      );
  }

  header(t, st) {
    const meta = this.meta;
    const folder = (meta.cwd ?? this.cwd ?? "").split("/").filter(Boolean).pop();
    const facts = [folder, meta.branch && meta.branch !== "HEAD" ? meta.branch : null].filter(Boolean);
    const c = !!this.o.compact;
    const dot =
      st === "working"
        ? div().w(10).text_size(11).text_color(t.working).frames(SPIN, 90)
        : div()
            .flex_none()
            .w(7)
            .h(7)
            .rounded_full()
            .bg(st === "blocked" ? t.blocked : st === "done" ? t.done : alpha(t.dim, 0.9));
    const word =
      { working: "working", blocked: "needs you", done: "finished", idle: "idle" }[st] ??
      (this.addr ? "not running" : "");
    const picker = this.o.picker !== false;
    return h_flex()
      .flex_none()
      .h(c ? 42 : 52)
      .px(c ? 8 : 14)
      .gap(c ? 6 : 10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .bg(mix(t.background, t.foreground, 0.015))
      .child(
        h_flex()
          .id("cc-who")
          .flex_1()
          .min_w(0)
          .gap(c ? 8 : 10)
          .items_center()
          .px(6)
          .py(4)
          .rounded(8)
          .when(picker, el =>
            el
              .cursor_pointer()
              .hover(s => s.bg(alpha(t.foreground, 0.04)))
              .on_click((_e, cx) => {
                this.picking = !this.picking;
                cx.notify();
              }),
          )
          .when(!c, el =>
            el.child(
              div()
                .flex_none()
                .w(28)
                .h(28)
                .rounded(8)
                .bg(alpha(claudeColor(t), 0.14))
                .flex()
                .items_center()
                .justify_center()
                .child(image("icons/claude.svg").w(16).h(16)),
            ),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex()
                  .gap(7)
                  .items_center()
                  .min_w(0)
                  .child(
                    div()
                      .min_w(0)
                      .truncate()
                      .text_size(c ? 12.5 : 13.5)
                      .font_semibold()
                      .child(this.o.title?.() ?? this.title()),
                  )
                  .when(picker, el => el.child(icon(this.picking ? "chevron-down" : "chevron-right", 11, t.dim))),
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .min_w(0)
                  .child(dot)
                  .child(
                    div()
                      .flex_none()
                      .text_size(11)
                      .text_color(st === "blocked" ? t.blocked : t.muted)
                      .child(word),
                  )
                  .when(facts.length > 0 && !c, el =>
                    el.child(
                      div()
                        .min_w(0)
                        .truncate()
                        .text_size(11)
                        .text_color(t.dim)
                        .child("· " + facts.join("  ·  ")),
                    ),
                  ),
              ),
          ),
      )
      .when(!c, el => el.child(this.modeSwitch(t)))
      .child(
        h_flex()
          .gap(2)
          .items_center()
          .child(
            this.iconButton(
              t,
              "cc-search",
              "search",
              "Search  /",
              cx => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)),
              this.searching,
            ),
          )
          .when(!c, el => el.child(this.iconButton(t, "cc-copy", "copy", "Copy as Markdown", cx => this.copyAll(cx))))
          .when(!!this.o.onGoToTerminal, el =>
            el.child(this.iconButton(t, "cc-term", "terminal", "Go to the terminal", () => this.goToTerminal())),
          )
          .children(this.o.actions?.(t, this) ?? []),
      );
  }

  iconButton(t, id, name, tip, onClick, active) {
    return div()
      .id(id)
      .w(28)
      .h(28)
      .rounded(7)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .tooltip(tip)
      .bg(active ? alpha(t.accent, 0.14) : alpha(t.foreground, 0))
      .hover(s => s.bg(alpha(t.foreground, 0.07)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(icon(name, 14, active ? t.accent : t.muted));
  }

  modeSwitch(t) {
    const cur = this.mode();
    return h_flex()
      .flex_none()
      .p(2)
      .gap(2)
      .rounded(8)
      .bg(alpha(t.foreground, 0.05))
      .children(
        MODES.map(m =>
          div()
            .id(`cc-view-${m.id}`)
            .px(this.o.compact ? 7 : 10)
            .h(24)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .tooltip(m.hint)
            .text_size(11.5)
            .bg(cur === m.id ? t.background : alpha(t.background, 0))
            .when(cur === m.id, el => el.shadow_sm())
            .text_color(cur === m.id ? t.foreground : t.muted)
            .hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => this.setMode(m.id, cx))
            .child(m.label),
        ),
      );
  }

  picker(t) {
    const claude = agents().filter(isClaude);
    const word = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };
    return v_flex()
      .flex_none()
      .max_h(260)
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .bg(mix(t.background, t.foreground, 0.025))
      .py(6)
      .child(div().px(20).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child("CLAUDE SESSIONS"))
      .when(!claude.length, el =>
        el.child(div().px(20).py(8).text_size(12).text_color(t.dim).child("No Claude Code agents are running.")),
      )
      .children(
        claude.map(a =>
          h_flex()
            .id(`cc-pick-${a.address}`)
            .mx(8)
            .px(12)
            .h(32)
            .gap(10)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(a.address === this.addr ? alpha(t.accent, 0.12) : alpha(t.foreground, 0))
            .hover(s => s.bg(alpha(t.foreground, 0.06)))
            .on_click((_e, cx) => this.setTarget(a.address, cx))
            .child(
              div()
                .flex_none()
                .w(7)
                .h(7)
                .rounded_full()
                .bg(
                  a.status === "working"
                    ? t.working
                    : a.status === "blocked"
                      ? t.blocked
                      : a.status === "done"
                        ? t.done
                        : t.dim,
                ),
            )
            .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(a.space_name))
            .child(
              div()
                .flex_none()
                .text_size(12)
                .text_color(t.dim)
                .child(a.tab_name && a.tab_name !== String(a.tab_index) ? `· ${a.tab_name}` : `· tab ${a.tab_index}`),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.muted)
                .child(a.title ?? ""),
            )
            .child(
              div()
                .flex_none()
                .text_size(11)
                .text_color(a.status === "blocked" ? t.blocked : t.dim)
                .child(word[a.status] ?? ""),
            ),
        ),
      );
  }

  /** The TUI's status line, as controls: permission mode, model, effort, context, todos,
   * background work; a menu opens below it. */
  /** `o.slim`: no header; the status bar is the one toolbar, led by `o.lead(t, chat)` (a host's
   * own control, e.g. who to talk to) and ending with the view switch and tools. */
  statusBar(t, st) {
    const slim = !!this.o.slim;
    const lead = slim ? (this.o.lead?.(t, this) ?? null) : null;
    const tools = slim
      ? h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .when(!this.o.compact, el => el.child(this.modeSwitch(t)).child(div().w(4)))
          .child(
            this.iconButton(
              t,
              "cc-search",
              "search",
              "Search  /",
              cx => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)),
              this.searching,
            ),
          )
          .when(!this.o.compact, el =>
            el.child(this.iconButton(t, "cc-copy", "copy", "Copy as Markdown", cx => this.copyAll(cx))),
          )
          .when(!!this.o.onGoToTerminal, el =>
            el.child(this.iconButton(t, "cc-term", "terminal", "Go to the terminal", () => this.goToTerminal())),
          )
          .children(this.o.actions?.(t, this) ?? [])
      : null;
    if (!this.addr)
      return slim && lead
        ? h_flex()
            .flex_none()
            .px(10)
            .py(5)
            .gap(5)
            .items_center()
            .border_b(1)
            .border_color(alpha(t.border, 0.6))
            .child(lead)
        : div();
    const permId = this.footer.mode ?? this.meta.permissionMode ?? null;
    const perm = PERMISSION[permId] ?? null;
    const todos = this.cache?.todos ?? [];
    const doneN = todos.filter(x => x.status === "completed").length;
    const bg = this.cache?.bg ?? [];
    // The TUI's footer counts what really runs in the background; the transcript only says what started.
    const live = this.footer.shells != null ? this.footer.shells + this.footer.agents : null;
    const bgLive = live ?? bg.filter(x => !x.done).length;
    const bgWord =
      live != null
        ? [
            this.footer.shells ? `${this.footer.shells} shell${this.footer.shells > 1 ? "s" : ""}` : null,
            this.footer.agents ? `${this.footer.agents} agent${this.footer.agents > 1 ? "s" : ""}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : `${bgLive} running`;
    const chip = (id, content, o) => this.chip(t, id, content, o);
    const menu = id => cx => this.toggleMenu(id, cx);
    const permColor =
      permId === "plan"
        ? (t.ansi6 ?? t.accent)
        : permId === "default"
          ? t.muted
          : permId === "bypassPermissions"
            ? t.blocked
            : (t.ansi5 ?? t.accent);
    if (slim && this.o.compact) {
      // Narrow hosts (a side panel): one row. Mode, model and effort fold into one chip whose
      // menu holds all three; background work and Stop stay visible because they're live state.
      const word =
        [perm ? perm.label : null, this.modelLabel(this.meta.model) || null].filter(Boolean).join(" · ") || "settings";
      return v_flex()
        .flex_none()
        .border_b(1)
        .border_color(alpha(t.border, 0.6))
        .child(
          h_flex()
            .px(8)
            .py(5)
            .gap(4)
            .items_center()
            .when(!!lead, el => el.child(lead))
            .child(div().flex_1().min_w(4))
            .child(
              chip(
                "settings",
                [
                  div()
                    .font_family(mono())
                    .text_color(permColor)
                    .child(perm?.glyph ?? "⏵"),
                  div().child(word),
                  icon("chevron-down", 9, t.dim),
                ],
                {
                  tip: `Mode, model and effort${this.meta.context ? ` · ${fmtTokens(this.meta.context)} of ${fmtTokens(this.contextWindow())} context` : ""}`,
                  on: this.menu === "settings",
                  click: menu("settings"),
                },
              ),
            )
            .when(todos.length > 0, el =>
              el.child(
                chip("todos", [icon("list", 11, t.muted), div().child(`${doneN}/${todos.length}`)], {
                  tip: "Todo list",
                  on: this.menu === "todos",
                  click: menu("todos"),
                }),
              ),
            )
            .when(bgLive > 0, el =>
              el.child(
                chip("bg", [icon("layers", 11, t.working), div().child(String(bgLive))], {
                  tip: bgWord,
                  on: this.menu === "bg",
                  color: t.working,
                  click: menu("bg"),
                }),
              ),
            )
            .when(st === "working", el =>
              el.child(
                chip("stop", [div().w(7).h(7).rounded(2).bg(t.blocked), div().child("Stop")], {
                  tip: "Interrupt (esc)",
                  color: t.blocked,
                  click: cx => this.interrupt(cx),
                }),
              ),
            )
            .when(!!tools, el => el.child(tools)),
        )
        .when(this.menu === "settings", el =>
          el.child(
            v_flex()
              .px(10)
              .pb(8)
              .gap(6)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().w(44).text_size(10.5).text_color(t.dim).child("Mode"))
                  .child(
                    chip(
                      "perm2",
                      [
                        div()
                          .font_family(mono())
                          .child(perm?.glyph ?? "⏵"),
                        div().child(perm ? perm.label : "mode"),
                      ],
                      {
                        tip: `${perm?.hint ?? "Permission mode"} · click (or ⇧Tab) to cycle`,
                        color: permColor,
                        click: cx => this.cycleMode(cx),
                      },
                    ),
                  )
                  .child(div().flex_1())
                  .children([this.contextMeter(t)].filter(Boolean)),
              )
              .child(
                this.pickList(
                  t,
                  "Model",
                  "/model",
                  this.modelChoices().map(r => r.id),
                  this.current("/model"),
                  id => this.rowLabel(id),
                ),
              )
              .child(this.pickList(t, "Effort", "/effort", EFFORTS, this.current("/effort"))),
          ),
        );
    }
    // Mode, model, effort and context live in the composer (see composerControls); Stop is its button.
    const hasTodos = todos.length > 0 && !this.wide;
    const hasBg = (bg.length > 0 || bgLive > 0) && !this.wide;
    if (!lead && !tools && !hasTodos && !hasBg) return div();
    return h_flex()
      .flex_none()
      .h(44)
      .px(slim ? 12 : 16)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.55))
      .when(!!lead, el => el.child(lead))
      .child(div().flex_1())
      .when(hasTodos, el =>
        el.child(
          chip("todos", [icon("list", 11, t.muted), div().child(`${doneN}/${todos.length} todos`)], {
            tip: "Todo list",
            on: this.menu === "todos",
            click: menu("todos"),
          }),
        ),
      )
      .when(hasBg, el =>
        el.child(
          chip("bg", [icon("layers", 11, bgLive ? t.working : t.muted), div().child(bgLive ? bgWord : "background")], {
            tip: "Background shells and agents",
            on: this.menu === "bg",
            color: bgLive ? t.working : null,
            click: menu("bg"),
          }),
        ),
      )
      .when(!!tools, el => el.child(div().flex_none().w(1).h(18).mx(4).bg(alpha(t.border, 0.9))).child(tools));
  }

  /** A small control: a tinted pill that opens a menu or runs `o.click`. */
  chip(t, id, content, o = {}) {
    return h_flex()
      .id(`cc-sb-${id}`)
      .flex_none()
      .h(o.h ?? 24)
      .px(8)
      .gap(5)
      .items_center()
      .rounded(7)
      .text_size(11.5)
      .cursor_pointer()
      .tooltip(o.tip ?? "")
      .bg(o.on ? alpha(o.color ?? t.accent, 0.16) : alpha(t.foreground, o.quiet ? 0 : 0.05))
      .text_color(o.on ? (o.color ?? t.accent) : (o.color ?? t.muted))
      .hover(s => s.bg(alpha(o.color ?? t.foreground, 0.1)).text_color(o.color ?? t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        o.click(cx);
      })
      .children(content);
  }

  toggleMenu(id, cx) {
    this.menu = this.menu === id ? null : id;
    cx.notify();
  }

  /**
   * Sets this session's model (a picker row: "opus", "fable", …) or effort, for this session
   * only: through Claude Code's own picker and its `s` key, so the account's default (and every
   * session that follows it) stays as it was. Only while the agent waits for a message: the
   * picker takes the keyboard. The pick shows at once, until the session reports it.
   */
  pickSetting(cmd, value, cx) {
    this.menu = null;
    const st = this.status();
    if (st === "working" || st === "blocked") {
      notify({
        title: "Not now",
        body: "The model and effort change when the agent is idle: Claude Code's picker would take its keyboard mid-turn.",
        level: "warning",
      });
      cx.notify();
      return;
    }
    const was = this.reported(cmd);
    this.picked = { ...(this.picked ?? {}), [cmd]: { value, was, at: Date.now() } };
    cx.notify();
    cx.spawn(async cx => {
      try {
        await this.pickInPicker(cmd === "/model" ? { row: value } : { effort: value }, cx);
      } catch (e) {
        delete this.picked[cmd];
        notify({ title: "Couldn't change it", body: String(e?.message ?? e), level: "error" });
      }
      this.footer.at = 0;
      this.refresh(cx);
      cx.notify();
    });
  }

  /**
   * Drives Claude Code's model picker: opens it (`/model`), moves to `row` and/or steps the
   * effort to `effort` (← →), then presses `s`, "use this session only". The picker's rows and
   * what they stand for are kept for the menu's labels.
   */
  async pickInPicker({ row, effort }, cx) {
    await this.deliver("/model");
    let lines = null;
    for (let i = 0; i < 30 && !lines; i++) {
      await wait(cx, 150);
      const l = await this.screenLines(40);
      if (l?.some(x => /s to use this session only/.test(x))) lines = l;
    }
    if (!lines) throw new Error("Claude Code's model picker didn't open.");
    const rows = [];
    let at = -1;
    let level = null;
    for (const l of lines) {
      const m = /^\s*(❯)?\s*(\d+)\.\s+(.+?)(?:\s+✔)?\s{2,}(.+)$/.exec(l);
      if (m) {
        if (m[1]) at = rows.length;
        // "Opus 5.5 · Best for…", or the default row's "Use the default model (currently Opus 5.5) · …"
        const said = m[4].split("·")[0].trim();
        // A pinned model (ANTHROPIC_DEFAULT_FABLE_MODEL) gets its own row, "Fable 5.2  Custom Fable
        // model (claude-fable-5-2)", beside the family's "Fable": its label is its id and its name.
        const pinned = /^\S+ \d/.test(m[3]);
        const model = /currently ([^)]+)\)/.exec(said)?.[1] ?? (pinned ? m[3] : said);
        rows.push({ id: (pinned ? m[3] : m[3].split(/\s/)[0]).toLowerCase(), model, current: /✔/.test(l) });
      }
      const e = /(low|medium|high|xhigh|max) effort/i.exec(l);
      if (e) level = e[1].toLowerCase();
    }
    if (rows.length) {
      this.pickerRows = rows;
      setShared(PREFS, {
        ...(shared(PREFS) ?? {}),
        pickerRows: rows.map(({ id, model }) => ({ id, model })),
        pickerVersion: claudeVersion || undefined,
      });
    }
    const keys = [];
    if (row) {
      const want = rows.findIndex(r => r.id === row);
      if (want < 0 || at < 0) {
        await hc(["keys", this.addr, "esc"]);
        throw new Error(`Claude Code's picker has no ${row} row.`);
      }
      const n = want - at;
      for (let i = 0; i < Math.abs(n); i++) keys.push(n > 0 ? "down" : "up");
    }
    if (effort && level) {
      const n = EFFORTS.indexOf(effort) - EFFORTS.indexOf(level);
      if (EFFORTS.indexOf(effort) >= 0 && EFFORTS.indexOf(level) >= 0)
        for (let i = 0; i < Math.abs(n); i++) keys.push(n > 0 ? "right" : "left");
    }
    keys.push("s");
    const r = await hc(["keys", this.addr, ...keys]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || "hc keys failed");
  }

  /** What the session says it runs: the transcript's model, the TUI footer's effort. The model
   *  is the picker row naming it exactly ("fable 5.2" over "fable", which may stand for 5.1). */
  reported(cmd) {
    if (cmd !== "/model") return this.footer.effort;
    const name = this.meta.model ? this.modelLabel(this.meta.model) : null;
    const row = name && this.modelChoices().find(r => r.id !== "default" && r.model === name);
    return row?.id ?? familyOf(this.meta.model);
  }

  /** The session's model or effort: a fresh pick until the session reports something new. */
  current(cmd) {
    const p = this.picked?.[cmd];
    const now = this.reported(cmd);
    if (p && now === p.was && Date.now() - p.at < 10 * 60_000) return p.value;
    return now;
  }

  /** The session's context window: the account's model list says (models.py), else its family. */
  contextWindow() {
    return this.models?.find(m => m.id === this.meta.model)?.window ?? windowFor(this.meta.model);
  }

  /** A model's name for people: "Fable 5.2", from the account's list or the id. */
  modelLabel(id) {
    if (!id) return "";
    const m = this.models?.find(x => x.id === id);
    return m ? m.name.replace(/^Claude /, "") : shortModel(id) || id;
  }

  /** The model menu's choices: the picker's rows as it last showed them (each Claude Code
   *  version has its own), else the usual ones; each with the model it stands for. Rows kept
   *  from another Claude Code version keep their order, but what they stand for has moved on
   *  (an update turns "Fable 5.1" into "Fable 5.2"): until the picker shows again, each stands
   *  for the account's newest model of its family. */
  modelChoices() {
    const saved = shared(PREFS);
    if (this.pickerRows) return this.pickerRows.map(({ id, model }) => ({ id, model }));
    const seen = saved?.pickerRows ?? [];
    if (seen.length && !(claudeVersion && saved.pickerVersion !== claudeVersion))
      return seen.map(({ id, model }) => ({ id, model }));
    return (seen.length ? seen.map(r => r.id) : PICKER_ROWS).map(id => ({ id, model: this.newestOf(id) }));
  }

  /** The account's newest model of a family ("fable" -> "Fable 5.2"), null when unknown. */
  newestOf(family) {
    const m = this.models?.find(x => familyOf(x.id) === family);
    return m ? m.name.replace(/^Claude /, "") : null;
  }

  /** A picker row's name: "Fable 5.1" once the picker has shown what it stands for, else "Fable". */
  rowLabel(id) {
    const m = this.modelChoices().find(r => r.id === id)?.model;
    const name = id.charAt(0).toUpperCase() + id.slice(1);
    return id === "default" ? `Default${m ? ` · ${m}` : ""}` : m && /\d/.test(m) ? m : name;
  }

  /** The account's models, once per account (the session's config dir, see read.py). */
  loadModels() {
    const key = this.configDir ?? "";
    if (this.modelsFor === key) return;
    this.modelsFor = key;
    const args = ["-I", MODELS_PY(), ...(this.configDir ? ["--config", this.configDir] : [])];
    exec("python3", args)
      .then(r => {
        if (this.modelsFor !== key) return;
        const list = JSON.parse(r.stdout || "{}").models ?? [];
        this.models = list.length ? list : null;
        this.bump();
      })
      .catch(() => {});
  }

  /** How full the context is, against its window: a bar and "207k / 1M". */
  contextMeter(t) {
    const used = this.meta.context;
    if (!used) return null;
    const max = this.contextWindow();
    const f = Math.min(1, used / max);
    const color = f >= 0.85 ? t.blocked : f >= 0.6 ? (t.ansi3 ?? t.working) : alpha(t.foreground, 0.42);
    return h_flex()
      .id("cc-ctx")
      .flex_none()
      .gap(7)
      .items_center()
      .tooltip(
        `${used.toLocaleString()} of ${max.toLocaleString()} tokens in context${f >= 0.85 ? " · compact soon" : ""}`,
      )
      .child(
        div()
          .w(40)
          .h(4)
          .rounded_full()
          .bg(alpha(t.foreground, 0.1))
          .child(
            div()
              .h(4)
              .w(Math.max(3, Math.round(40 * f)))
              .rounded_full()
              .bg(color),
          ),
      )
      .child(
        div()
          .text_size(11)
          .font_family(mono())
          .text_color(f >= 0.6 ? color : t.dim)
          .child(`${fmtTokens(used)} / ${fmtTokens(max)}`),
      );
  }

  /** The composer's footer: permission mode, model, effort and context. */
  composerControls(t) {
    const permId = this.footer.mode ?? this.meta.permissionMode ?? null;
    const perm = PERMISSION[permId] ?? null;
    const permColor =
      permId === "plan"
        ? (t.ansi6 ?? t.accent)
        : permId === "default"
          ? t.muted
          : permId === "bypassPermissions"
            ? t.blocked
            : (t.ansi5 ?? t.accent);
    const model =
      this.picked?.["/model"] && this.current("/model") === this.picked["/model"].value
        ? this.rowLabel(this.current("/model"))
        : this.modelLabel(this.meta.model);
    const effort = this.current("/effort");
    return (
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .items_center()
        .child(
          this.chip(
            t,
            "perm",
            [
              div()
                .font_family(mono())
                .text_size(10.5)
                .child(perm?.glyph ?? "⏵"),
              div().child(perm ? perm.label : "Mode"),
            ],
            {
              tip: `${perm?.hint ?? "Permission mode"} · click (or ⇧Tab) to cycle`,
              color: permColor,
              quiet: true,
              click: cx => this.cycleMode(cx),
            },
          ),
        )
        .child(
          this.chip(t, "model", [div().child(model || "Model"), icon("chevron-down", 9, t.dim)], {
            tip: "Model for this session",
            on: this.menu === "model",
            quiet: true,
            click: cx => this.toggleMenu("model", cx),
          }),
        )
        .child(
          this.chip(
            t,
            "effort",
            [icon("brain", 11, t.dim), div().child(effort || "Effort"), icon("chevron-down", 9, t.dim)],
            {
              tip: "Reasoning effort for this session",
              on: this.menu === "effort",
              quiet: true,
              click: cx => this.toggleMenu("effort", cx),
            },
          ),
        )
        .child(div().flex_1().min_w(8))
        // With the session panel showing, its gauge says this already.
        .children([this.wide ? null : this.contextMeter(t)].filter(Boolean))
    );
  }

  /** The model or effort menu, above the composer: one line per choice, the current one checked. */
  pickMenu(t) {
    const cmd = this.menu === "model" ? "/model" : "/effort";
    const list = this.menu === "model" ? this.modelChoices().map(r => r.id) : EFFORTS;
    const cur = this.current(cmd);

    return v_flex()
      .w(260)
      .p(4)
      .gap(1)
      .rounded(10)
      .bg(t.popover ?? mix(t.background, t.foreground, 0.06))
      .border(1)
      .border_color(alpha(t.border, 1))
      .shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        div()
          .px(8)
          .pt(4)
          .pb(5)
          .text_size(11)
          .text_color(t.dim)
          .child(cmd === "/model" ? "Model for this session" : "Reasoning effort for this session"),
      )
      .children(
        list.map(x => {
          const on = isCurrent(x, cur);
          return h_flex()
            .id(`cc-pick-${cmd}-${x}`)
            .h(28)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(on ? alpha(t.accent, 0.12) : alpha(t.accent, 0))
            .hover(s => s.bg(alpha(t.foreground, 0.07)))
            .on_click((_e, cx) => this.pickSetting(cmd, x, cx))
            .child(
              div()
                .flex_1()
                .text_size(12.5)
                .text_color(on ? t.accent : t.foreground)
                .child(cmd === "/model" ? this.rowLabel(x) : x),
            )
            .when(on, el => el.child(icon("check", 12, t.accent)));
        }),
      )
      .when(cmd === "/model", el =>
        el.child(
          div()
            .px(8)
            .pt(5)
            .pb(3)
            .text_size(10.5)
            .line_height(1.45)
            .text_color(t.dim)
            .child("Claude Code's own models, for this session only. Others need a session started with --model."),
        ),
      );
  }

  /** A labelled row of choices that each run `cmd <choice>` (the current one marked). */
  pickList(t, label, cmd, list, current, name = x => x) {
    return h_flex()
      .gap(4)
      .items_center()
      .flex_wrap()
      .child(div().w(44).flex_none().text_size(10.5).text_color(t.dim).child(label))
      .children(
        list.map(x => {
          const on = isCurrent(x, current);
          return div()
            .id(`cc-pl-${cmd}-${x}`)
            .h(22)
            .px(8)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .text_size(11.5)
            .bg(on ? alpha(t.accent, 0.16) : alpha(t.foreground, 0.06))
            .text_color(on ? t.accent : t.foreground)
            .hover(s => s.bg(alpha(t.accent, 0.16)).text_color(t.accent))
            .on_click((_e, cx) => this.pickSetting(cmd, x, cx))
            .child(name(x));
        }),
      );
  }

  todoPanel(t) {
    const todos = this.cache?.todos ?? [];
    const look = {
      completed: ["circle-check", t.ansi2 ?? t.done],
      in_progress: ["play", t.working],
      pending: ["square", t.dim],
    };
    return v_flex()
      .flex_none()
      .max_h(220)
      .overflow_y_scroll()
      .id("cc-todos")
      .px(this.o.compact ? 12 : 22)
      .py(8)
      .gap(3)
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .bg(mix(t.background, t.foreground, 0.02))
      .children(
        todos.map((x, i) => {
          const [ic, color] = look[x.status] ?? look.pending;
          return h_flex()
            .id(`cc-todo-${i}`)
            .gap(8)
            .items_start()
            .child(
              div()
                .pt(2)
                .child(icon(ic, 12, color)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(12)
                .text_color(x.status === "completed" ? t.dim : t.foreground)
                .when(x.status === "completed", el => el.line_through())
                .when(x.status === "in_progress", el => el.font_medium())
                .child(x.text),
            );
        }),
      );
  }

  bgPanel(t) {
    const bg = this.cache?.bg ?? [];
    const head = div().text_size(10.5).text_color(t.dim).pb(2).child("Started in the background (from the transcript)");
    return v_flex()
      .flex_none()
      .px(this.o.compact ? 12 : 22)
      .py(8)
      .gap(3)
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .bg(mix(t.background, t.foreground, 0.02))
      .child(head)
      .children(
        bg.map((x, i) =>
          h_flex()
            .id(`cc-bg-${i}`)
            .gap(8)
            .items_center()
            .child(
              x.done
                ? icon("circle-check", 12, t.dim)
                : div().w(12).text_size(11).text_color(t.working).frames(SPIN, 90),
            )
            .child(icon(x.kind === "shell" ? "terminal" : "sparkles", 11, t.dim))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(x.done ? t.dim : t.foreground)
                .child(x.label),
            ),
        ),
      );
  }

  searchBar(t, rows) {
    const hits = this.query
      ? rows.filter(r => r.type !== "end" && r.type !== "top" && r.type !== "working").length
      : null;
    return h_flex()
      .flex_none()
      .h(40)
      .px(16)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .child(icon("search", 13, t.dim))
      .child(
        div()
          .flex_1()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.search).w_full().h(30).text_size(13).text_color(t.foreground)),
      )
      .when(hits != null, el =>
        el.child(
          div()
            .text_size(11.5)
            .text_color(hits ? t.muted : t.blocked)
            .child(hits ? `${hits} match${hits === 1 ? "" : "es"}` : "No matches"),
        ),
      )
      .child(this.iconButton(t, "cc-search-x", "x", "Clear", cx => this.closeSearch(cx)));
  }

  body(t, rows, ctx, st) {
    if (!this.addr)
      return this.empty(t, "No Claude Code chat to show", "Focus a terminal running Claude Code, then press ⌘⇧M.");
    if (this.error === "no-transcript")
      return this.empty(
        t,
        "No transcript yet",
        "This terminal isn't running Claude Code, or it hasn't written a session yet.",
      );
    if (!this.loaded) return this.empty(t, "Reading the conversation…", null, true);
    const onlyEnd = rows.length <= 1;
    return div()
      .id("cc-view")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs(size.height - this.viewH) > 0.5) {
          this.viewH = size.height;
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => this.scrollBy(e.delta?.y ?? 0, cx))
      .child(this.viewport(t, rows, ctx))
      .when(!onlyEnd && !this.wide, el => el.child(this.rail(t, rows)))
      .when(onlyEnd, el =>
        el.child(
          div()
            .absolute()
            .inset_0()
            .child(
              this.empty(
                t,
                this.query ? "Nothing matches" : "Nothing said yet",
                this.query ? "Try another word." : "Send Claude a message below.",
              ),
            ),
        ),
      )
      .when(!this.follow && !onlyEnd, el =>
        el.child(
          div()
            .absolute()
            .bottom(14)
            .left(0)
            .right(0)
            .flex()
            .justify_center()
            .child(
              h_flex()
                .id("cc-latest")
                .px(12)
                .h(28)
                .gap(6)
                .items_center()
                .rounded_full()
                .bg(t.popover ?? t.surface)
                .border(1)
                .border_color(alpha(t.border, 1))
                .shadow_md()
                .cursor_pointer()
                .hover(s => s.bg(t.hover ?? t.raised))
                .on_click((_e, cx) => this.toBottom(cx))
                .child(icon("arrow-down", 12, t.foreground))
                .child(
                  div()
                    .text_size(11.5)
                    .text_color(t.foreground)
                    .child(st === "working" ? "Latest · working" : "Latest"),
                ),
            ),
        ),
      );
  }

  viewport(t, rows, ctx) {
    const H = this.viewH;
    const last = rows.length - 1;
    let start;
    let end;
    let top = null;
    if (this.follow) {
      end = last;
      start = last;
      let acc = this.h(rows[last]);
      while (start > 0 && acc < H + 200) acc += this.h(rows[--start]);
      if (start === 0 && acc <= H) top = 0;
    } else {
      const a = this.anchorIndex(rows);
      start = Math.max(0, a - 1);
      end = a;
      let acc = this.h(rows[a]) - this.off;
      while (end < last && acc < H + 200) acc += this.h(rows[++end]);
      let above = 0;
      for (let i = start; i < a; i++) above += this.h(rows[i]);
      top = -(this.off + above);
    }
    const items = [];
    for (let i = start; i <= end; i++) {
      const row = rows[i];
      items.push(
        div()
          .id(`row-${row.key}`)
          .w_full()
          .flex_none()
          .on_size_change((size, cx) => {
            if (this.heights.get(row.key) !== size.height) {
              this.heights.set(row.key, size.height);
              cx.notify();
            }
          })
          .child(this.arrive(row, renderRow(t, row, ctx))),
      );
    }
    const content = v_flex().absolute().left(0).right(0).children(items);
    return top == null ? content.bottom(0) : content.top(top);
  }

  rail(t, rows) {
    const H = Math.max(40, this.viewH - 24);
    const n = Math.max(1, rows.length - 1);
    const at = this.follow ? 1 : this.anchorIndex(rows) / n;
    const ticks = [];
    rows.forEach((r, i) => {
      if (r.type !== "prompt" && r.type !== "cmd") return;
      ticks.push(
        div()
          .id(`tick-${r.key}`)
          .absolute()
          .top(Math.round((i / n) * (H - 6)))
          .right(0)
          .w(14)
          .h(6)
          .flex()
          .items_center()
          .justify_end()
          .cursor_pointer()
          .on_click((_e, cx) => this.scrollToRow(i, cx))
          .child(
            div()
              .w(8)
              .h(2)
              .rounded_full()
              .bg(alpha(t.accent, 0.55))
              .hover(s => s.w(12).bg(t.accent)),
          ),
      );
    });
    return div()
      .absolute()
      .top(12)
      .right(6)
      .w(14)
      .h(H)
      .child(div().absolute().top(0).bottom(0).right(3).w(2).rounded_full().bg(alpha(t.foreground, 0.05)))
      .child(
        div()
          .absolute()
          .top(Math.round(at * (H - 28)))
          .right(2)
          .w(4)
          .h(28)
          .rounded_full()
          .bg(alpha(t.foreground, 0.22)),
      )
      .children(ticks);
  }

  empty(t, title, body, spin) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .size_full()
      .items_center()
      .justify_center()
      .gap(8)
      .child(
        spin
          ? svg(ICON("spinner")).w(18).h(18).text_color(t.dim).spin(900)
          : div()
              .w(40)
              .h(40)
              .rounded(12)
              .bg(alpha(claudeColor(t), 0.12))
              .flex()
              .items_center()
              .justify_center()
              .child(image("icons/claude.svg").w(20).h(20)),
      )
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(title))
      .when(!!body, el => el.child(div().max_w(380).text_center().text_size(12).text_color(t.muted).child(body)));
  }

  /** Claude waits on a dialog: its text, an answer button per option, and raw keys. */
  blockedPanel(t) {
    const s = this.screen;
    const numbered = (s?.options ?? []).some(o => o.key);
    const raw = [
      ["↑", "up"],
      ["↓", "down"],
      ["⏎", "enter"],
      ["esc", "esc"],
      ["tab", "tab"],
    ];
    const keyBtn = (id, label, keys, o = {}) =>
      h_flex()
        .id(id)
        .h(o.big ? 30 : 24)
        .px(o.big ? 10 : 8)
        .gap(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .bg(o.selected ? alpha(t.blocked, 0.16) : alpha(t.foreground, 0.06))
        .border(1)
        .border_color(o.selected ? alpha(t.blocked, 0.5) : alpha(t.border, 1))
        .hover(h => h.bg(alpha(t.foreground, 0.11)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.keys(keys, cx))
        .when(!!o.hint, el => el.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(o.hint)))
        .child(
          div()
            .max_w(o.big ? 420 : 80)
            .truncate()
            .text_size(o.big ? 12.5 : 11.5)
            .text_color(t.foreground)
            .child(label),
        );
    return div()
      .flex_none()
      .w_full()
      .flex()
      .justify_center()
      .px(this.o.compact ? 8 : 16)
      .pt(10)
      .child(
        v_flex()
          .w_full()
          .max_w(COLUMN - 24)
          .gap(10)
          .p(14)
          .rounded(12)
          .bg(alpha(t.blocked, 0.07))
          .border(1)
          .border_color(alpha(t.blocked, 0.4))
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(icon("alert", 14, t.blocked))
              .child(
                div().flex_1().text_size(12.5).font_semibold().text_color(t.blocked).child("Claude is waiting for you"),
              )
              .when(!!this.o.onGoToTerminal, el =>
                el.child(this.textButton(t, "cc-goterm", "Answer in terminal", () => this.goToTerminal())),
              ),
          )
          .when(!s, el => el.child(div().text_size(12).text_color(t.dim).child("Reading the dialog…")))
          .when(!!s?.text, el =>
            el.child(
              div()
                .id("cc-dialog")
                .max_h(220)
                .overflow_y_scroll()
                .font_family(mono())
                .text_size(11.5)
                .line_height(1.5)
                .text_color(t.foreground)
                .child(s.text),
            ),
          )
          .when(!!s?.options?.length, el =>
            el.child(
              v_flex()
                .gap(5)
                .children(
                  s.options.map((o, i) =>
                    keyBtn(`cc-opt-${i}`, o.label, o.keys, {
                      big: true,
                      selected: o.selected,
                      hint: o.key ?? (o.selected ? "❯" : " "),
                    }),
                  ),
                ),
            ),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .flex_wrap()
              .child(div().text_size(10.5).text_color(t.dim).pr(4).child("Keys"))
              .children(raw.map(([label, k]) => keyBtn(`cc-raw-${k}`, label, [k])))
              .when(numbered, el => el.children(["1", "2", "3", "4", "5"].map(d => keyBtn(`cc-raw-${d}`, d, [d]))))
              .child(div().flex_1())
              .child(div().text_size(10.5).text_color(t.dim).child("Typing below answers the dialog")),
          ),
      );
  }

  textButton(t, id, label, onClick, primary) {
    return div()
      .id(id)
      .h(26)
      .px(10)
      .flex()
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .text_size(11.5)
      .bg(primary ? t.solid : alpha(t.foreground, 0.07))
      .text_color(primary ? t.solid_foreground : t.foreground)
      .hover(s => s.bg(primary ? alpha(t.solid, 0.85) : alpha(t.foreground, 0.12)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  palette(t, items) {
    const sug = this.suggest();
    if (sug?.loading)
      return div()
        .w_full()
        .mb(6)
        .px(12)
        .py(8)
        .rounded(10)
        .bg(t.popover ?? t.surface)
        .border(1)
        .border_color(alpha(t.border, 1))
        .text_size(11.5)
        .text_color(t.dim)
        .child("Reading the folder's files and agents…");
    const hint =
      {
        command: "↑↓ choose · tab complete · ⏎ run",
        skill: "↑↓ choose · tab or ⏎ insert the skill",
        mention: "↑↓ choose · tab or ⏎ insert · @agent- for agents only",
      }[sug?.mode] ?? "";
    return v_flex()
      .w_full()
      .mb(6)
      .py(4)
      .rounded(10)
      .bg(t.popover ?? t.surface)
      .border(1)
      .border_color(alpha(t.border, 1))
      .shadow_md()
      .children(
        items.map((c, i) =>
          h_flex()
            .id(`cc-pal-${c.kind ?? "c"}-${c.name}`)
            .mx(4)
            .px(8)
            .h(28)
            .gap(10)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(i === this.palSel ? alpha(t.accent, 0.14) : alpha(t.foreground, 0))
            .hover(s => s.bg(alpha(t.foreground, 0.06)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.complete(c, cx))
            .when(!!c.kind, el =>
              el.child(icon(c.kind === "agent" ? "user" : "file-text", 12, i === this.palSel ? t.accent : t.dim)),
            )
            .child(
              div()
                .flex_none()
                .max_w(c.kind === "file" ? 420 : 300)
                .truncate()
                .font_family(mono())
                .text_size(12)
                .text_color(i === this.palSel ? t.accent : t.foreground)
                .child(c.kind === "file" ? `@${c.name.split("/").pop()}` : (c.label ?? `/${c.name}`)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.dim)
                .child(c.description ?? ""),
            )
            .child(
              div()
                .flex_none()
                .text_size(10)
                .text_color(t.dim)
                .child(c.source ?? ""),
            ),
        ),
      )
      .child(div().px(12).pt(4).text_size(10).text_color(t.dim).child(hint));
  }

  /** The pictures going with the next message: thumbnails, each with a way to take it off. */
  attachments(t) {
    return h_flex()
      .flex_wrap()
      .gap(8)
      .pb(2)
      .children(
        this.attached.map((a, i) =>
          h_flex()
            .id(`cc-att-${i}`)
            .h(52)
            .pl(4)
            .pr(6)
            .gap(8)
            .items_center()
            .rounded(10)
            .bg(alpha(t.foreground, 0.05))
            .border(1)
            .border_color(alpha(t.border, 0.8))
            .tooltip(a.local)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(
              div()
                .w(44)
                .h(44)
                .rounded(7)
                .overflow_hidden()
                .bg(alpha(t.foreground, 0.06))
                .flex()
                .items_center()
                .justify_center()
                .child(a.rel ? image(a.rel).w(44).h(44) : icon("image", 16, t.dim)),
            )
            .child(div().max_w(160).truncate().text_size(11.5).text_color(t.muted).child(a.local.split("/").pop()))
            .child(
              div()
                .id(`cc-att-x-${i}`)
                .w(20)
                .h(20)
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .cursor_pointer()
                .hover(s => s.bg(alpha(t.foreground, 0.1)))
                .on_click((_e, cx) => this.detach(i, cx))
                .child(icon("x", 10, t.muted)),
            ),
        ),
      );
  }

  composerBar(t, st) {
    const live = !!this.term() && this.term()?.state !== "finished";
    const pal = this.paletteItems();
    const blocked = st === "blocked";
    const working = st === "working";
    const c = !!this.o.compact;
    const empty = !this.composer.value().trim() && !this.attached.length;
    // While it works and the box is empty, the button stops it; with text, it queues the text.
    const stop = working && empty;
    const ring = blocked ? alpha(t.blocked, 0.6) : this.composing ? alpha(t.accent, 0.65) : alpha(t.border, 0.95);
    const button = div()
      .id("cc-send")
      .flex_none()
      .w(30)
      .h(30)
      .flex()
      .items_center()
      .justify_center()
      .rounded(9)
      .cursor_pointer()
      .tooltip(stop ? "Stop (esc)" : working ? "Queue (↵) · ⌘↵ sends now" : "Send (↵)")
      .bg(stop ? alpha(t.blocked, 0.16) : live && !empty ? claudeColor(t) : alpha(t.foreground, 0.08))
      .hover(s =>
        s.bg(stop ? alpha(t.blocked, 0.26) : live && !empty ? alpha(claudeColor(t), 0.85) : alpha(t.foreground, 0.12)),
      )
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (stop) this.interrupt(cx);
        else this.send(cx);
      })
      .child(
        stop
          ? div().w(9).h(9).rounded(2).bg(t.blocked)
          : icon(working ? "clock" : "arrow-up", 14, live && !empty ? "#ffffff" : t.dim),
      );
    const field = div()
      .flex_1()
      .min_w(0)
      // While a suggestion list shows, ↑ ↓ Tab Esc drive it (see bindSuggestKeys): the
      // text box binds those keys itself, and a binding wins over any key handler.
      .when(!!pal?.length, el => el.key_context("ChatSuggest"))
      .on_action("chat::SuggestUp", (_e, cx) => this.moveSuggestion(-1, cx))
      .on_action("chat::SuggestDown", (_e, cx) => this.moveSuggestion(1, cx))
      .on_action("chat::SuggestPick", (_e, cx) => {
        if (pal?.length) this.complete(pal[Math.min(this.palSel, pal.length - 1)], cx);
      })
      .on_action("chat::SuggestClose", (_e, cx) => {
        this.suggestOff = this.composer.value();
        cx.notify();
      })
      .child(Textarea.new(this.composer).w_full().text_size(13.5).line_height(1.5).text_color(t.foreground));
    const box = v_flex()
      .id("cc-composer")
      .w_full()
      .px(c ? 10 : 14)
      .pt(c ? 8 : 11)
      .pb(c ? 8 : 9)
      .gap(c ? 0 : 8)
      .rounded(c ? 12 : 18)
      .bg(mix(t.background, t.foreground, dark() ? 0.06 : 0.0))
      .border(1)
      .border_color(ring)
      // A card that floats over the conversation's end.
      .when(!c, el => el.shadow_lg())
      .cursor_text()
      // Its own clicks: the conversation's mouse-down would take the focus back (see render).
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (!this.composing) this.composer.focus();
        cx.notify();
      })
      .when(this.attached.length > 0, el => el.child(this.attachments(t)))
      .when(c, el => el.child(h_flex().w_full().gap(8).items_end().child(field).child(button)))
      .when(!c, el =>
        el
          .child(field)
          .child(
            h_flex()
              .w_full()
              .h(30)
              .gap(6)
              .items_center()
              .child(this.composerControls(t))
              .child(div().w(4))
              .child(button),
          ),
      );
    const menuOpen = !c && (this.menu === "model" || this.menu === "effort");
    return div()
      .flex_none()
      .w_full()
      .flex()
      .justify_center()
      .px(c ? 8 : 16)
      .pt(c ? 8 : 4)
      .pb(c ? 10 : 18)
      .child(
        v_flex()
          .w_full()
          .max_w(COLUMN - 24)
          .gap(6)
          .when(!!pal?.length, el => el.child(this.palette(t, pal)))
          .when(menuOpen, el => el.child(this.pickMenu(t)))
          .when(this.escArmed?.what === "stop", el =>
            el.child(
              h_flex()
                .self_center()
                .h(28)
                .px(12)
                .gap(8)
                .items_center()
                .rounded_full()
                .bg(alpha(t.blocked, 0.14))
                .border(1)
                .border_color(alpha(t.blocked, 0.4))
                .child(
                  div()
                    .px(5)
                    .rounded(4)
                    .bg(alpha(t.blocked, 0.2))
                    .text_size(10.5)
                    .font_family(mono())
                    .text_color(t.blocked)
                    .child("esc"),
                )
                .child(div().text_size(12).text_color(t.foreground).child("again to stop Claude")),
            ),
          )
          .child(box)
          // Slim hosts keep only the hint that changes what Enter does (a dialog, a busy agent).
          .when(!this.o.slim || blocked || working, el =>
            el.child(
              h_flex()
                .px(6)
                .gap(14)
                .text_size(10.5)
                .text_color(t.dim)
                .child(
                  div().child(
                    blocked
                      ? "↵ types into the dialog"
                      : working
                        ? "↵ queue · ⌘↵ send now · esc stop · ⇧↵ newline"
                        : "↵ send · / commands · ↑ history · ⇧↵ newline",
                  ),
                )
                .child(div().flex_1())
                .when(!c && !this.o.slim, el =>
                  el.child(div().child("j / k prompts · ⇧tab mode · drop files to attach")),
                ),
            ),
          ),
      );
  }
}

/** A Claude Code dialog in screen lines: { text, options: [{ label, selected, keys, key }] }.
 * Numbered options are picked by their digit; arrow-only lists by moving there and Enter. */
/** The best `n` paths for query `q`, in tiers: the file name starts with it, the name contains
 *  it, the path contains it, every word of it is in the path ("live apr" finds live_apr/...),
 *  then the name has its letters in order. Shorter paths first within a tier. */
function rankFiles(files, q, n) {
  if (n <= 0) return [];
  if (!q) return files.slice(0, n);
  const lower = (files._lower ??= files.map(f => f.toLowerCase()));
  const words = q.split(/[-_/.\s]+/).filter(Boolean);
  const tiers = [[], [], [], [], []];
  for (let k = 0; k < files.length; k++) {
    const lf = lower[k];
    const base = lf.slice(lf.lastIndexOf("/") + 1);
    if (base.startsWith(q)) tiers[0].push(files[k]);
    else if (base.includes(q)) tiers[1].push(files[k]);
    else if (lf.includes(q)) tiers[2].push(files[k]);
    else if (words.length > 1 && words.every(w => lf.includes(w))) tiers[3].push(files[k]);
    else if (tiers[4].length < 100 && q.length > 2 && base.length <= q.length * 3 + 6) {
      let i = 0;
      for (let c = 0; c < base.length && i < q.length; c++) if (base[c] === q[i]) i++;
      if (i === q.length) tiers[4].push(files[k]);
    }
    if (tiers[0].length >= n * 4) break;
  }
  const out = [];
  for (const tier of tiers) {
    tier.sort((a, b) => a.length - b.length);
    for (const f of tier) {
      if (out.length >= n) return out;
      out.push(f);
    }
  }
  return out;
}

/** ↑ ↓ Tab Esc for the suggestion list. Bound under "ChatSuggest > Input": the text box inside a
 *  composer whose list is open. That matches as deep as the text box's own bindings and is
 *  installed after them, so it wins; elsewhere the keys keep their usual meaning. Installed once
 *  per load (bindings are app-wide). */
let suggestKeysBound = false;
function bindSuggestKeys(cx) {
  if (suggestKeysBound) return;
  suggestKeysBound = true;
  const keys = [
    ["up", "chat::SuggestUp"],
    ["down", "chat::SuggestDown"],
    ["tab", "chat::SuggestPick"],
    ["escape", "chat::SuggestClose"],
  ];
  try {
    cx.bind_keys(keys.map(([keystroke, action]) => ({ keystroke, action, context: "ChatSuggest > Input" })));
  } catch {
    // A runtime without the descendant operator: bind on the composer's own context instead.
    try {
      cx.bind_keys(keys.map(([keystroke, action]) => ({ keystroke, action, context: "ChatSuggest" })));
    } catch {
      suggestKeysBound = false;
    }
  }
}

export function parseDialog(rows) {
  let start = Math.max(0, rows.length - 24);
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) {
    if (/^\s*[╭┌]/.test(rows[i]) || /^[▔─]{20,}/.test(rows[i].trim())) {
      start = i + (/^[▔─]/.test(rows[i].trim()) ? 1 : 0);
      break;
    }
  }
  const region = rows.slice(start).map(l => l.replace(/^\s*[│|]\s?/, "").replace(/\s*[│|]\s*$/, ""));
  const options = [];
  const optionLines = new Set();
  // Numbered: "❯ 1. Yes" — the digit picks it.
  region.forEach((l, i) => {
    const m = l.match(/^\s*(❯|›|>)?\s*(\d)\.\s+(.+?)\s*$/);
    if (m) {
      options.push({ label: m[3], selected: !!m[1], keys: [m[2]], key: m[2] });
      optionLines.add(i);
    }
  });
  // Arrows only: the block of lines around "❯ …" — moving there and Enter picks it.
  if (!options.length) {
    const sel = region.findIndex(l => /^\s*❯\s+\S/.test(l));
    if (sel >= 0) {
      const indent = l => l.match(/^\s*/)[0].length;
      let a = sel;
      let b = sel;
      const isOpt = l =>
        l.trim() &&
        !/to (confirm|cancel|select|navigate)|·\s*esc/i.test(l) &&
        Math.abs(indent(l.replace("❯", " ")) - indent(region[sel].replace("❯", " "))) <= 2;
      while (a > 0 && isOpt(region[a - 1])) a--;
      while (b < region.length - 1 && isOpt(region[b + 1])) b++;
      for (let i = a; i <= b; i++) {
        const d = i - sel;
        const label = region[i].replace(/^\s*❯?\s*/, "").trim();
        options.push({
          label,
          selected: i === sel,
          keys: [...Array(Math.abs(d)).fill(d < 0 ? "up" : "down"), "enter"],
          key: null,
        });
        optionLines.add(i);
      }
    }
  }
  const text = region
    .filter((_l, i) => !optionLines.has(i))
    .map(l =>
      l
        .replace(/^[\s]*[│╭╰╮╯─┌└┐┘▔]+/, "")
        .replace(/[│╮╯─┐┘]+\s*$/, "")
        .trimEnd(),
    )
    .filter(l => l.trim() && !/^[╌─▔┄┈\s]+$/.test(l))
    .join("\n");
  return { text, options: options.slice(0, 9) };
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(h) {
  try {
    localStorage.setItem(HISTORY, JSON.stringify(h));
  } catch {
    // history is a nicety
  }
}
