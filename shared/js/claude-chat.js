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
//
// Text reaches Claude through `hc send` with the sender's hc variables cleared, so it
// arrives as typed input (slash commands run) rather than as a message from a terminal.

import { div, image, svg } from "gpui-kit";
import { h_flex, Input, InputState, Textarea, TextareaState, v_flex } from "gpui-base";
import { agents, appHome, exec, hc, notify, setShared, shared, terminals } from "herdr";

import { absorb, backgroundOf, buildRows, emptyState, fmtTokens, rowText, shortModel, todosOf, toMarkdown } from "./claude-model.js";
import { alpha, claudeColor, COLUMN, icon, ICON, mix, mono, renderRow, SPIN } from "./claude-rows.js";

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
const MODELS = ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SEND_ENV = ["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "-u", "HC_TERMINAL_SOCKET"];
const READ = () => `${appHome()}/mods/claude-reader/read.py`;
const COMMANDS = () => `${appHome()}/mods/claude-reader/commands.py`;
const HISTORY = "claude-chat.history";
const isClaude = (a) => a && (a.app === "claude-code" || a.program?.key === "claude");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

export class ClaudeChat {
  /**
   * `o.terminal`: the address to show (else `o.pick()`, else none). `o.compact`: a narrow
   * side-panel look. `o.picker`: the header's session picker (default true). `o.actions(t)`:
   * extra header buttons. `o.onGoToTerminal(addr)`: what "Go to terminal" does.
   */
  constructor(cx, o = {}) {
    this.o = o;
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search this conversation" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      this.bump();
      cx.notify();
    });
    this.search.on("focus", (_e, cx) => { this.searchFocus = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searchFocus = false; cx.notify(); });
    this.composer = TextareaState.new({ placeholder: "Message Claude…  / for commands", rows: 1 });
    this.composer.set_auto_grow(1, 10);
    this.composer.on("submit", (e, cx) => {
      if (!e?.shift) this.send(cx);
    });
    this.composer.on("change", (_e, cx) => {
      this.palSel = 0;
      cx.notify();
    });
    this.composer.on("focus", (_e, cx) => { this.composing = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.composing = false; cx.notify(); });

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
    this.history = loadHistory();
    this.histAt = -1;
    this.tick = 0;
    this.footer = {};
    this.addr = o.terminal ?? o.pick?.() ?? null;
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
    this.error = null;
    this.dropped = 0;
    this.screen = null;
    this.footer = {};
    this.queued = [];
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
    return agents().find((a) => a.address === this.addr) ?? null;
  }

  status() {
    return this.agent()?.status ?? null;
  }

  term() {
    return terminals().find((t) => t.address === this.addr) ?? null;
  }

  setTarget(addr, cx) {
    if (!addr || addr === this.addr) return;
    this.addr = addr;
    this.picking = false;
    this.menu = null;
    this.toggled.clear();
    this.follow = true;
    this.reset();
    this.refresh(cx);
    cx.notify();
  }

  // ─── reading ───────────────────────────────────────────────────────────

  /** Call about once a second: reads fast while it works or waits on you, else every 3 s. */
  poll(cx) {
    this.tick += 1;
    const st = this.status();
    if (st === "working" || st === "blocked" || this.tick % 3 === 0) this.refresh(cx);
  }

  refresh(cx) {
    if (!this.addr) {
      this.addr = this.o.pick?.() ?? null;
      if (!this.addr) return;
    }
    if (this.busy) return;
    this.busy = true;
    const st = this.status();
    const wantFooter = st === "blocked" || this.tick % 3 === 0 || !this.footer.at;
    cx.spawn(async (cx) => {
      try {
        await this.read();
        if (st === "blocked") await this.readScreen();
        else {
          this.screen = null;
          if (wantFooter) await this.readFooter();
        }
        if (!this.commands) this.loadCommands();
      } catch (err) {
        this.error = String(err?.message ?? err);
      }
      this.busy = false;
      cx.notify();
    });
  }

  async read() {
    const now = Date.now();
    if (!this.pid || now - this.pidAt > 8000) {
      const r = await hc(["get", this.addr, "--json"]);
      if (r.code === 0) {
        const info = JSON.parse(r.stdout);
        this.pid = info.foreground?.pid ?? info.pid ?? null;
        this.cwd = info.foreground?.cwd ?? info.cwd ?? null;
        this.pidAt = now;
      }
    }
    const r = await exec("python3", ["-I", READ(), "--pid", String(this.pid ?? ""), "--cwd", this.cwd ?? "", "--path", this.path, "--offset", String(this.offset)]);
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
    if (out.reset) this.dropped = out.dropped ?? 0;
    this.path = out.path;
    this.offset = out.offset;
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
    if (!this.queued.length) return;
    const said = events.filter((e) => e.k === "user" || e.k === "cmd").map((e) => (e.k === "cmd" ? `${e.name} ${e.args ?? ""}` : e.text).trim());
    const old = Date.now() - 15 * 60_000;
    this.queued = this.queued.filter((q) => q.at > old && !said.some((s) => s === q.text || s.startsWith(q.text.slice(0, 60))));
  }

  async screenLines(n) {
    const r = await hc(["read", this.addr, "--lines", String(n)]);
    if (r.code !== 0) return null;
    const rows = strip(r.stdout).split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => !l.startsWith("[hc] "));
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    return rows;
  }

  /** The TUI's footer: the permission mode line and the effort marker. */
  async readFooter() {
    const rows = await this.screenLines(10);
    if (!rows) return;
    const f = { at: Date.now() };
    for (const l of rows) {
      const m = l.match(/(⏵⏵|⏸)\s+(auto mode|accept edits|plan mode|manual mode|bypass permissions)\s+on/i);
      if (m) f.mode = { "auto mode": "auto", "accept edits": "acceptEdits", "plan mode": "plan", "manual mode": "default", "bypass permissions": "bypassPermissions" }[m[2].toLowerCase()];
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
      .then((r) => {
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

  send(cx, given) {
    let text = (given ?? this.composer.value()).trim();
    if (!given) {
      const pal = this.paletteItems();
      if (pal && pal.length && !/\s/.test(text)) text = `/${pal[Math.min(this.palSel, pal.length - 1)].name}`;
    }
    if (!text || !this.addr) return;
    const st = this.status();
    if (!given) this.composer.set_value("");
    this.follow = true;
    this.histAt = -1;
    this.history = [text, ...this.history.filter((h) => h !== text)].slice(0, 100);
    saveHistory(this.history);
    if (st === "working" && !text.startsWith("/")) this.queued.push({ text, at: Date.now() });
    cx.spawn(async (cx) => {
      try {
        await this.deliver(text, st === "blocked");
      } catch (e) {
        if (!given) this.composer.set_value(text);
        this.queued = this.queued.filter((q) => q.text !== text);
        notify({ title: "Couldn't send", body: String(e?.message ?? e), level: "error" });
      }
      this.refresh(cx);
      cx.notify();
    });
    cx.notify();
  }

  keys(keys, cx) {
    cx.spawn(async (cx) => {
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
    if (this.cache?.version === this.version && this.cache.mode === this.mode() && this.cache.st === this.status()) return this.cache.rows;
    const rows = buildRows(this.state, { mode: this.mode(), query: this.query });
    if (this.dropped && !this.query) rows.unshift({ type: "top", key: "top", text: `Showing the latest part · ${this.dropped} older events not loaded` });
    if (this.status() === "working" && !this.query) rows.push({ type: "working", key: "working" });
    rows.push({ type: "end", key: "end" });
    this.cache = { version: this.version, mode: this.mode(), st: this.status(), rows, todos: todosOf(this.state), bg: backgroundOf(this.state) };
    return rows;
  }

  isOpen(key, byDefault) {
    return byDefault !== this.toggled.has(key);
  }

  toggle(key, cx) {
    if (this.toggled.has(key)) this.toggled.delete(key);
    else this.toggled.add(key);
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
  drop(paths, cx) {
    if (!paths?.length) return;
    cx.spawn(async (cx) => {
      const out = [];
      for (const p of paths) {
        if (this.addr?.includes("/")) {
          const r = await hc(["put", this.addr, p]);
          out.push(r.code === 0 ? r.stdout.trim().split("\n").pop() : p);
        } else out.push(p);
      }
      const cur = this.composer.value();
      this.composer.set_value((cur ? cur.replace(/\s*$/, " ") : "") + out.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ");
      this.composer.focus();
      cx.notify();
    });
  }

  // ─── the command palette ───────────────────────────────────────────────

  paletteItems() {
    const v = this.composer.value();
    if (!v.startsWith("/") || /\s/.test(v) || !this.composing) return null;
    const q = v.slice(1).toLowerCase();
    const all = this.commands ?? [];
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const has = q ? all.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))) : [];
    return [...starts, ...has].slice(0, 8);
  }

  complete(item, cx) {
    this.composer.set_value(`/${item.name} `);
    this.composer.focus();
    cx.notify();
  }

  // ─── scrolling ─────────────────────────────────────────────────────────

  h(row) {
    const known = this.heights.get(row.key);
    if (known != null) return known;
    return { prompt: 96, text: 110, group: 52, note: 40, dur: 26, cmd: 50, bash: 90, working: 40, top: 50 }[row.type] ?? 30;
  }

  anchorIndex(rows) {
    const i = rows.findIndex((r) => r.key === this.anchorKey);
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
    const prompts = rows.map((r, i) => (r.type === "prompt" || r.type === "cmd" ? i : -1)).filter((i) => i >= 0);
    if (!prompts.length) return;
    const atTop = !this.follow && this.off < 4;
    const target = dir < 0 ? [...prompts].reverse().find((i) => (atTop ? i < top : i <= top)) ?? prompts[0] : prompts.find((i) => i > top) ?? null;
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

  /** Returns true when it handled the key. */
  onKey(e, cx) {
    const k = e.key;
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
        if (!v && this.status() === "working") this.interrupt(cx);
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
    else if (k === "escape" && this.status() === "working") this.interrupt(cx);
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
    const ctx = {
      results: this.state.results,
      cwd: this.meta.cwd ?? this.cwd,
      running: st === "working",
      lastTool: [...this.state.tools.keys()].pop(),
      workingMsg: this.term()?.report?.msg ?? this.term()?.status?.msg ?? null,
      mode: this.mode(),
      query: this.query,
      isOpen: (key, byDefault) => this.isOpen(key, byDefault),
      toggle: (key, cx) => this.toggle(key, cx),
      copy: (text, cx) => this.copy(text, cx),
      rowText: (row) => rowText(row, this.state),
    };
    return v_flex()
      .id("claude-chat")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.onKey(e, cx)) cx.stop_propagation();
      })
      .on_mouse_down("left", () => {
        if (!this.typing()) this.handle.focus();
      })
      .on_drop((e, cx) => this.drop(e.paths, cx))
      .when(!this.o.slim, (el) => el.child(this.header(t, st)))
      .when(this.picking, (el) => el.child(this.picker(t)))
      .child(this.statusBar(t, st))
      .children([this.o.below?.(t, this)].filter(Boolean))
      .when(this.menu === "todos", (el) => el.child(this.todoPanel(t)))
      .when(this.menu === "bg", (el) => el.child(this.bgPanel(t)))
      .when(this.searching, (el) => el.child(this.searchBar(t, rows)))
      .child(this.body(t, rows, ctx, st))
      .when(st === "blocked", (el) => el.child(this.blockedPanel(t)))
      .child(this.composerBar(t, st));
  }

  header(t, st) {
    const meta = this.meta;
    const folder = (meta.cwd ?? this.cwd ?? "").split("/").filter(Boolean).pop();
    const facts = [folder, meta.branch && meta.branch !== "HEAD" ? meta.branch : null].filter(Boolean);
    const c = !!this.o.compact;
    const dot =
      st === "working"
        ? div().w(10).text_size(11).text_color(t.working).frames(SPIN, 90)
        : div().flex_none().w(7).h(7).rounded_full().bg(st === "blocked" ? t.blocked : st === "done" ? t.done : alpha(t.dim, 0.9));
    const word = { working: "working", blocked: "needs you", done: "finished", idle: "idle" }[st] ?? (this.addr ? "not running" : "");
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
          .when(picker, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.bg(alpha(t.foreground, 0.04)))
              .on_click((_e, cx) => {
                this.picking = !this.picking;
                cx.notify();
              }),
          )
          .when(!c, (el) =>
            el.child(div().flex_none().w(28).h(28).rounded(8).bg(alpha(claudeColor(t), 0.14)).flex().items_center().justify_center().child(image("icons/claude.svg").w(16).h(16))),
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
                  .child(div().min_w(0).truncate().text_size(c ? 12.5 : 13.5).font_semibold().child(this.o.title?.() ?? this.title()))
                  .when(picker, (el) => el.child(icon(this.picking ? "chevron-down" : "chevron-right", 11, t.dim))),
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .min_w(0)
                  .child(dot)
                  .child(div().flex_none().text_size(11).text_color(st === "blocked" ? t.blocked : t.muted).child(word))
                  .when(facts.length > 0 && !c, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child("· " + facts.join("  ·  ")))),
              ),
          ),
      )
      .when(!c, (el) => el.child(this.modeSwitch(t)))
      .child(
        h_flex()
          .gap(2)
          .items_center()
          .child(this.iconButton(t, "cc-search", "search", "Search  /", (cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)), this.searching))
          .when(!c, (el) => el.child(this.iconButton(t, "cc-copy", "copy", "Copy as Markdown", (cx) => this.copyAll(cx))))
          .when(!!this.o.onGoToTerminal, (el) => el.child(this.iconButton(t, "cc-term", "terminal", "Go to the terminal", () => this.goToTerminal())))
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
      .hover((s) => s.bg(alpha(t.foreground, 0.07)))
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
        MODES.map((m) =>
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
            .when(cur === m.id, (el) => el.shadow_sm())
            .text_color(cur === m.id ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground))
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
      .when(!claude.length, (el) => el.child(div().px(20).py(8).text_size(12).text_color(t.dim).child("No Claude Code agents are running.")))
      .children(
        claude.map((a) =>
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
            .hover((s) => s.bg(alpha(t.foreground, 0.06)))
            .on_click((_e, cx) => this.setTarget(a.address, cx))
            .child(div().flex_none().w(7).h(7).rounded_full().bg(a.status === "working" ? t.working : a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : t.dim))
            .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(a.space_name))
            .child(div().flex_none().text_size(12).text_color(t.dim).child(a.tab_name && a.tab_name !== String(a.tab_index) ? `· ${a.tab_name}` : `· tab ${a.tab_index}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(a.title ?? ""))
            .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(word[a.status] ?? "")),
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
          .when(!this.o.compact, (el) => el.child(this.modeSwitch(t)).child(div().w(4)))
          .child(this.iconButton(t, "cc-search", "search", "Search  /", (cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)), this.searching))
          .when(!this.o.compact, (el) => el.child(this.iconButton(t, "cc-copy", "copy", "Copy as Markdown", (cx) => this.copyAll(cx))))
          .when(!!this.o.onGoToTerminal, (el) => el.child(this.iconButton(t, "cc-term", "terminal", "Go to the terminal", () => this.goToTerminal())))
          .children(this.o.actions?.(t, this) ?? [])
      : null;
    if (!this.addr)
      return slim && lead
        ? h_flex().flex_none().px(10).py(5).gap(5).items_center().border_b(1).border_color(alpha(t.border, 0.6)).child(lead)
        : div();
    const permId = this.footer.mode ?? this.meta.permissionMode ?? null;
    const perm = PERMISSION[permId] ?? null;
    const todos = this.cache?.todos ?? [];
    const doneN = todos.filter((x) => x.status === "completed").length;
    const bg = this.cache?.bg ?? [];
    // The TUI's footer counts what really runs in the background; the transcript only says what started.
    const live = this.footer.shells != null ? this.footer.shells + this.footer.agents : null;
    const bgLive = live ?? bg.filter((x) => !x.done).length;
    const bgWord = live != null ? [this.footer.shells ? `${this.footer.shells} shell${this.footer.shells > 1 ? "s" : ""}` : null, this.footer.agents ? `${this.footer.agents} agent${this.footer.agents > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ") : `${bgLive} running`;
    const chip = (id, content, o = {}) =>
      h_flex()
        .id(`cc-sb-${id}`)
        .flex_none()
        .h(22)
        .px(7)
        .gap(5)
        .items_center()
        .rounded(6)
        .text_size(11)
        .cursor_pointer()
        .tooltip(o.tip ?? "")
        .bg(o.on ? alpha(o.color ?? t.accent, 0.16) : alpha(t.foreground, 0.05))
        .text_color(o.color ?? t.muted)
        .hover((s) => s.bg(alpha(o.color ?? t.foreground, 0.12)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => o.click(cx))
        .children(content);
    const menu = (id) => (cx) => {
      this.menu = this.menu === id ? null : id;
      cx.notify();
    };
    const permColor = permId === "plan" ? t.ansi6 ?? t.accent : permId === "default" ? t.muted : permId === "bypassPermissions" ? t.blocked : t.ansi5 ?? t.accent;
    if (slim && this.o.compact) {
      // Narrow hosts (a side panel): one row. Mode, model and effort fold into one chip whose
      // menu holds all three; background work and Stop stay visible because they're live state.
      const word = [perm ? perm.label : null, shortModel(this.meta.model) || null].filter(Boolean).join(" · ") || "settings";
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
            .when(!!lead, (el) => el.child(lead))
            .child(div().flex_1().min_w(4))
            .child(
              chip("settings", [div().font_family(mono()).text_color(permColor).child(perm?.glyph ?? "⏵"), div().child(word), icon("chevron-down", 9, t.dim)], {
                tip: `Mode, model and effort${this.meta.context ? ` · ${fmtTokens(this.meta.context)} context` : ""}`,
                on: this.menu === "settings",
                click: menu("settings"),
              }),
            )
            .when(todos.length > 0, (el) => el.child(chip("todos", [icon("list", 11, t.muted), div().child(`${doneN}/${todos.length}`)], { tip: "Todo list", on: this.menu === "todos", click: menu("todos") })))
            .when(bgLive > 0, (el) => el.child(chip("bg", [icon("layers", 11, t.working), div().child(String(bgLive))], { tip: bgWord, on: this.menu === "bg", color: t.working, click: menu("bg") })))
            .when(st === "working", (el) => el.child(chip("stop", [div().w(7).h(7).rounded(2).bg(t.blocked), div().child("Stop")], { tip: "Interrupt (esc)", color: t.blocked, click: (cx) => this.interrupt(cx) })))
            .when(!!tools, (el) => el.child(tools)),
        )
        .when(this.menu === "settings", (el) =>
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
                  .child(chip("perm2", [div().font_family(mono()).child(perm?.glyph ?? "⏵"), div().child(perm ? perm.label : "mode")], { tip: `${perm?.hint ?? "Permission mode"} · click (or ⇧Tab) to cycle`, color: permColor, click: (cx) => this.cycleMode(cx) }))
                  .when(!!this.meta.context, (el) => el.child(div().flex_1()).child(div().text_size(10.5).text_color(t.dim).font_family(mono()).child(`${fmtTokens(this.meta.context)} ctx`))),
              )
              .child(this.pickList(t, "Model", "/model", MODELS, shortModel(this.meta.model)))
              .child(this.pickList(t, "Effort", "/effort", EFFORTS, this.footer.effort)),
          ),
        );
    }
    return v_flex()
      .flex_none()
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .child(
        h_flex()
          .px(this.o.compact ? 8 : slim ? 10 : 14)
          .py(5)
          .gap(5)
          .items_center()
          .flex_wrap()
          .when(!!lead, (el) => el.child(lead).child(div().flex_none().w(1).h(18).mx(4).bg(alpha(t.border, 0.9))))
          .child(
            chip("perm", [div().font_family(mono()).child(perm?.glyph ?? "⏵"), div().child(perm ? perm.label : "mode")], {
              tip: `${perm?.hint ?? "Permission mode"} · click (or ⇧Tab) to cycle`,
              color: permColor,
              click: (cx) => this.cycleMode(cx),
            }),
          )
          .child(chip("model", [div().child(shortModel(this.meta.model) || "model"), icon("chevron-down", 9, t.dim)], { tip: "Model: /model", on: this.menu === "model", click: menu("model") }))
          .child(chip("effort", [div().child(this.footer.effort ?? "effort"), icon("chevron-down", 9, t.dim)], { tip: "Reasoning effort: /effort", on: this.menu === "effort", click: menu("effort") }))
          .when(!!this.meta.context, (el) => el.child(div().px(4).text_size(11).text_color(t.dim).font_family(mono()).child(`${fmtTokens(this.meta.context)} ctx`)))
          .child(div().flex_1())
          .when(todos.length > 0, (el) =>
            el.child(chip("todos", [icon("list", 11, t.muted), div().child(`${doneN}/${todos.length}`)], { tip: "Todo list", on: this.menu === "todos", click: menu("todos") })),
          )
          .when(bg.length > 0 || bgLive > 0, (el) =>
            el.child(
              chip("bg", [icon("layers", 11, bgLive ? t.working : t.muted), div().child(bgLive ? bgWord : "background")], {
                tip: "Background shells and agents",
                on: this.menu === "bg",
                color: bgLive ? t.working : null,
                click: menu("bg"),
              }),
            ),
          )
          .when(st === "working", (el) => el.child(chip("stop", [div().w(7).h(7).rounded(2).bg(t.blocked), div().child("Stop")], { tip: "Interrupt (esc)", color: t.blocked, click: (cx) => this.interrupt(cx) })))
          .when(!!tools, (el) => el.child(tools)),
      )
      .when(this.menu === "model" || this.menu === "effort", (el) => {
        const list = this.menu === "model" ? MODELS : EFFORTS;
        const cmd = this.menu === "model" ? "/model" : "/effort";
        return el.child(
          h_flex()
            .px(this.o.compact ? 8 : 14)
            .pb(6)
            .gap(4)
            .flex_wrap()
            .child(div().text_size(10.5).text_color(t.dim).pr(4).child(cmd))
            .children(
              list.map((x) =>
                div()
                  .id(`cc-pick-${this.menu}-${x}`)
                  .h(22)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .text_size(11.5)
                  .bg(alpha(t.foreground, 0.06))
                  .hover((s) => s.bg(alpha(t.accent, 0.16)).text_color(t.accent))
                  .on_click((_e, cx) => {
                    this.menu = null;
                    this.send(cx, `${cmd} ${x}`);
                  })
                  .child(x),
              ),
            ),
        );
      });
  }

  /** A labelled row of choices that each run `cmd <choice>` (the current one marked). */
  pickList(t, label, cmd, list, current) {
    return h_flex()
      .gap(4)
      .items_center()
      .flex_wrap()
      .child(div().w(44).flex_none().text_size(10.5).text_color(t.dim).child(label))
      .children(
        list.map((x) => {
          const on = current && String(current).toLowerCase().startsWith(x.replace(/\[1m\]/, "").toLowerCase()) && (x.includes("[1m]") === /1m/i.test(String(current)));
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
            .hover((s) => s.bg(alpha(t.accent, 0.16)).text_color(t.accent))
            .on_click((_e, cx) => {
              this.menu = null;
              this.send(cx, `${cmd} ${x}`);
            })
            .child(x);
        }),
      );
  }

  todoPanel(t) {
    const todos = this.cache?.todos ?? [];
    const look = { completed: ["circle-check", t.ansi2 ?? t.done], in_progress: ["play", t.working], pending: ["square", t.dim] };
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
            .child(div().pt(2).child(icon(ic, 12, color)))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(12)
                .text_color(x.status === "completed" ? t.dim : t.foreground)
                .when(x.status === "completed", (el) => el.line_through())
                .when(x.status === "in_progress", (el) => el.font_medium())
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
            .child(x.done ? icon("circle-check", 12, t.dim) : div().w(12).text_size(11).text_color(t.working).frames(SPIN, 90))
            .child(icon(x.kind === "shell" ? "terminal" : "sparkles", 11, t.dim))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(x.done ? t.dim : t.foreground).child(x.label)),
        ),
      );
  }

  searchBar(t, rows) {
    const hits = this.query ? rows.filter((r) => r.type !== "end" && r.type !== "top" && r.type !== "working").length : null;
    return h_flex()
      .flex_none()
      .h(40)
      .px(16)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .child(icon("search", 13, t.dim))
      .child(Input.new(this.search).flex_1().h(30).text_size(13).text_color(t.foreground))
      .when(hits != null, (el) => el.child(div().text_size(11.5).text_color(hits ? t.muted : t.blocked).child(hits ? `${hits} match${hits === 1 ? "" : "es"}` : "No matches")))
      .child(this.iconButton(t, "cc-search-x", "x", "Clear", (cx) => this.closeSearch(cx)));
  }

  body(t, rows, ctx, st) {
    if (!this.addr) return this.empty(t, "No Claude Code chat to show", "Focus a terminal running Claude Code, then press ⌘⇧M.");
    if (this.error === "no-transcript") return this.empty(t, "No transcript yet", "This terminal isn't running Claude Code, or it hasn't written a session yet.");
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
      .when(!onlyEnd, (el) => el.child(this.rail(t, rows)))
      .when(onlyEnd, (el) =>
        el.child(div().absolute().inset_0().child(this.empty(t, this.query ? "Nothing matches" : "Nothing said yet", this.query ? "Try another word." : "Send Claude a message below."))),
      )
      .when(!this.follow && !onlyEnd, (el) =>
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
                .hover((s) => s.bg(t.hover ?? t.raised))
                .on_click((_e, cx) => this.toBottom(cx))
                .child(icon("arrow-down", 12, t.foreground))
                .child(div().text_size(11.5).text_color(t.foreground).child(st === "working" ? "Latest · working" : "Latest")),
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
          .child(renderRow(t, row, ctx)),
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
          .child(div().w(8).h(2).rounded_full().bg(alpha(t.accent, 0.55)).hover((s) => s.w(12).bg(t.accent))),
      );
    });
    return div()
      .absolute()
      .top(12)
      .right(6)
      .w(14)
      .h(H)
      .child(div().absolute().top(0).bottom(0).right(3).w(2).rounded_full().bg(alpha(t.foreground, 0.05)))
      .child(div().absolute().top(Math.round(at * (H - 28))).right(2).w(4).h(28).rounded_full().bg(alpha(t.foreground, 0.22)))
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
          : div().w(40).h(40).rounded(12).bg(alpha(claudeColor(t), 0.12)).flex().items_center().justify_center().child(image("icons/claude.svg").w(20).h(20)),
      )
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(title))
      .when(!!body, (el) => el.child(div().max_w(380).text_center().text_size(12).text_color(t.muted).child(body)));
  }

  /** Claude waits on a dialog: its text, an answer button per option, and raw keys. */
  blockedPanel(t) {
    const s = this.screen;
    const numbered = (s?.options ?? []).some((o) => o.key);
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
        .hover((h) => h.bg(alpha(t.foreground, 0.11)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.keys(keys, cx))
        .when(!!o.hint, (el) => el.child(div().font_family(mono()).text_size(11).text_color(t.dim).child(o.hint)))
        .child(div().max_w(o.big ? 420 : 80).truncate().text_size(o.big ? 12.5 : 11.5).text_color(t.foreground).child(label));
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
              .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.blocked).child("Claude is waiting for you"))
              .when(!!this.o.onGoToTerminal, (el) => el.child(this.textButton(t, "cc-goterm", "Answer in terminal", () => this.goToTerminal()))),
          )
          .when(!s, (el) => el.child(div().text_size(12).text_color(t.dim).child("Reading the dialog…")))
          .when(!!s?.text, (el) =>
            el.child(div().id("cc-dialog").max_h(220).overflow_y_scroll().font_family(mono()).text_size(11.5).line_height(1.5).text_color(t.foreground).child(s.text)),
          )
          .when(!!s?.options?.length, (el) =>
            el.child(
              v_flex()
                .gap(5)
                .children(s.options.map((o, i) => keyBtn(`cc-opt-${i}`, o.label, o.keys, { big: true, selected: o.selected, hint: o.key ?? (o.selected ? "❯" : " ") }))),
            ),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .flex_wrap()
              .child(div().text_size(10.5).text_color(t.dim).pr(4).child("Keys"))
              .children(raw.map(([label, k]) => keyBtn(`cc-raw-${k}`, label, [k])))
              .when(numbered, (el) => el.children(["1", "2", "3", "4", "5"].map((d) => keyBtn(`cc-raw-${d}`, d, [d]))))
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
      .hover((s) => s.bg(primary ? alpha(t.solid, 0.85) : alpha(t.foreground, 0.12)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  palette(t, items) {
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
            .id(`cc-pal-${c.name}`)
            .mx(4)
            .px(8)
            .h(28)
            .gap(10)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(i === this.palSel ? alpha(t.accent, 0.14) : alpha(t.foreground, 0))
            .hover((s) => s.bg(alpha(t.foreground, 0.06)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.complete(c, cx))
            .child(div().flex_none().font_family(mono()).text_size(12).text_color(i === this.palSel ? t.accent : t.foreground).child(`/${c.name}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c.description))
            .child(div().flex_none().text_size(10).text_color(t.dim).child(c.source)),
        ),
      )
      .child(div().px(12).pt(4).text_size(10).text_color(t.dim).child("↑↓ choose · tab complete · ⏎ run"));
  }

  composerBar(t, st) {
    const live = !!this.term() && this.term()?.state !== "finished";
    const pal = this.paletteItems();
    const blocked = st === "blocked";
    const c = !!this.o.compact;
    return div()
      .flex_none()
      .w_full()
      .flex()
      .justify_center()
      .px(c ? 8 : 16)
      .pt(10)
      .pb(c ? 10 : 14)
      .child(
        v_flex()
          .w_full()
          .max_w(COLUMN - 24)
          .gap(6)
          .when(!!pal?.length, (el) => el.child(this.palette(t, pal)))
          .when(this.queued.length > 0, (el) =>
            el.child(
              v_flex()
                .gap(3)
                .children(
                  this.queued.map((q, i) =>
                    h_flex()
                      .id(`cc-q-${i}`)
                      .px(10)
                      .py(4)
                      .gap(8)
                      .items_center()
                      .rounded(7)
                      .bg(alpha(t.foreground, 0.05))
                      .child(icon("clock", 11, t.dim))
                      .child(div().text_size(10.5).text_color(t.dim).child("Queued"))
                      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(q.text)),
                  ),
                ),
            ),
          )
          .child(
            h_flex()
              .w_full()
              .gap(8)
              .items_end()
              .px(12)
              .py(8)
              .rounded(12)
              .bg(mix(t.background, t.foreground, 0.03))
              .border(1)
              .border_color(blocked ? alpha(t.blocked, 0.6) : this.composing ? alpha(t.accent, 0.7) : alpha(t.border, 1))
              .child(div().flex_1().min_w(0).child(Textarea.new(this.composer).w_full().text_size(13).line_height(1.5).text_color(t.foreground)))
              .child(
                div()
                  .id("cc-send")
                  .w(28)
                  .h(28)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(8)
                  .cursor_pointer()
                  .bg(live ? claudeColor(t) : alpha(t.foreground, 0.1))
                  .hover((s) => s.bg(live ? alpha(claudeColor(t), 0.85) : alpha(t.foreground, 0.1)))
                  .on_click((_e, cx) => this.send(cx))
                  .child(icon("arrow-up", 14, live ? "#ffffff" : t.dim)),
              ),
          )
          // Slim hosts keep only the hint that changes what Enter does (a dialog, a busy agent).
          .when(!this.o.slim || blocked || st === "working", (el) => el.child(
            h_flex()
              .px(4)
              .gap(14)
              .text_size(10.5)
              .text_color(t.dim)
              .child(div().child(blocked ? "↵ types into the dialog" : st === "working" ? "↵ queue · esc stop · ⇧↵ newline" : "↵ send · / commands · ↑ history · ⇧↵ newline"))
              .child(div().flex_1())
              .when(!c && !this.o.slim, (el) => el.child(div().child("j / k prompts · ⇧tab mode · drop files to attach"))),
          )),
      );
  }
}

/** A Claude Code dialog in screen lines: { text, options: [{ label, selected, keys, key }] }.
 * Numbered options are picked by their digit; arrow-only lists by moving there and Enter. */
export function parseDialog(rows) {
  let start = Math.max(0, rows.length - 24);
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) {
    if (/^\s*[╭┌]/.test(rows[i]) || /^[▔─]{20,}/.test(rows[i].trim())) { start = i + (/^[▔─]/.test(rows[i].trim()) ? 1 : 0); break; }
  }
  const region = rows.slice(start).map((l) => l.replace(/^\s*[│|]\s?/, "").replace(/\s*[│|]\s*$/, ""));
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
    const sel = region.findIndex((l) => /^\s*❯\s+\S/.test(l));
    if (sel >= 0) {
      const indent = (l) => l.match(/^\s*/)[0].length;
      let a = sel;
      let b = sel;
      const isOpt = (l) => l.trim() && !/to (confirm|cancel|select|navigate)|·\s*esc/i.test(l) && Math.abs(indent(l.replace("❯", " ")) - indent(region[sel].replace("❯", " "))) <= 2;
      while (a > 0 && isOpt(region[a - 1])) a--;
      while (b < region.length - 1 && isOpt(region[b + 1])) b++;
      for (let i = a; i <= b; i++) {
        const d = i - sel;
        const label = region[i].replace(/^\s*❯?\s*/, "").trim();
        options.push({ label, selected: i === sel, keys: [...Array(Math.abs(d)).fill(d < 0 ? "up" : "down"), "enter"], key: null });
        optionLines.add(i);
      }
    }
  }
  const text = region
    .filter((_l, i) => !optionLines.has(i))
    .map((l) => l.replace(/^[\s]*[│╭╰╮╯─┌└┐┘▔]+/, "").replace(/[│╮╯─┐┘]+\s*$/, "").trimEnd())
    .filter((l) => l.trim() && !/^[╌─▔┄┈\s]+$/.test(l))
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
