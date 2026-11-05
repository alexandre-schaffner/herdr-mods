// Claude Reader: a Claude Code chat as a clean, live document.
//
// Opens as a dialog over the focused Claude terminal (`mod.open:claude-reader`, ⌘⇧M), or
// docked beside it as a pane (props: { terminal }). It reads the session's JSONL
// transcript (read.py), not the screen, so it shows the whole conversation: prompts,
// replies as Markdown, tool calls folded into one line per burst, and lets you answer
// from a composer at the bottom. Pasted images, images tools returned, and the images,
// videos, Markdown and PDFs steps touched open in the `viewer` mod (viewer.js).

import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, appHome, closeOverlay, exec, focused, hc, nextCommand, notify, panes, props, run, setShared, shared, terminals, theme } from "herdr";
import { absorb, buildRows, emptyState, fmtTokens, rowText, shortModel, toMarkdown } from "./model.js";
import { alpha, claudeColor, COLUMN, icon, ICON, mix, mono, renderRow, SPIN } from "./ui.js";

const PREFS = "claude-reader";
const MODES = [
  { id: "clean", label: "Chat", hint: "Only the conversation" },
  { id: "normal", label: "Steps", hint: "Tool calls folded per burst" },
  { id: "verbose", label: "Everything", hint: "Every tool call and thought" },
];
const isClaude = (a) => a && (a.app === "claude-code" || a.program?.key === "claude");
const SCRIPT = () => `${appHome()}/mods/claude-reader/read.py`;

export default class ClaudeReader extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search this conversation" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      this.bump();
      cx.notify();
    });
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.composer = TextareaState.new({ placeholder: "Message Claude…", rows: 1 });
    this.composer.set_auto_grow(1, 8);
    this.composer.on("submit", (e, cx) => {
      if (!e?.shift) this.send(cx);
    });
    this.composer.on("focus", (_e, cx) => { this.typing = true; this.composing = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.typing = false; this.composing = false; cx.notify(); });

    this.query = "";
    this.searching = false;
    this.toggled = new Set();
    this.follow = true;
    // The viewport: following the bottom, or browsing with `anchorKey`'s row at the top,
    // `off` px of it scrolled out of view. Row heights are measured as they're drawn.
    this.heights = new Map();
    this.anchorKey = null;
    this.off = 0;
    this.viewH = 600;
    this.version = 0;
    this.picking = false;
    this.addr = this.pickTarget();
    this.reset();

    this.tick = 0;
    cx.timer.every(1000, (cx) => {
      this.tick += 1;
      const st = this.status();
      if (st === "working" || st === "blocked" || this.tick % 3 === 0) this.refresh(cx);
    });
    this.refresh(cx);
    if (props()?.overlay) this.handle.focus();

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
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
    this.bump();
  }

  bump() {
    this.version += 1;
  }

  // ─── which terminal ────────────────────────────────────────────────────

  pickTarget() {
    const p = props() ?? {};
    if (p.terminal) return p.terminal;
    const all = agents();
    const f = focused();
    const byAddr = (a) => all.find((x) => x.address === a);
    if (f?.terminal && isClaude(byAddr(f.terminal))) return f.terminal;
    if (f?.agent && isClaude(byAddr(f.agent))) return f.agent;
    const claude = all.filter(isClaude);
    const here = claude.find((a) => a.tab === f?.tab);
    if (here) return here.address;
    return claude.sort((a, b) => b.seq - a.seq)[0]?.address ?? null;
  }

  agent() {
    return agents().find((a) => a.address === this.addr) ?? null;
  }

  status() {
    return this.agent()?.status ?? null;
  }

  term() {
    return terminals().find((t) => t.address === this.addr) ?? null;
  }

  switchTo(addr, cx) {
    if (addr === this.addr) return;
    this.addr = addr;
    this.picking = false;
    this.toggled.clear();
    this.follow = true;
    this.reset();
    this.refresh(cx);
    cx.notify();
  }

  // ─── reading ───────────────────────────────────────────────────────────

  refresh(cx) {
    if (this.busy || !this.addr) {
      if (!this.addr) {
        this.addr = this.pickTarget();
        if (this.addr) this.refresh(cx);
      }
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.read();
        if (this.status() === "blocked") await this.readScreen();
        else this.screen = null;
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
    const r = await exec("python3", [
      "-I", SCRIPT(),
      "--pid", String(this.pid ?? ""),
      "--cwd", this.cwd ?? "",
      "--path", this.path,
      "--offset", String(this.offset),
    ]);
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
      this.bump();
    }
    this.loaded = true;
  }

  async readScreen() {
    const r = await hc(["read", this.addr]);
    if (r.code !== 0) return;
    const rows = r.stdout.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    const options = [];
    for (const l of rows) {
      const m = l.match(/^[\s│|]*(❯|›|>)?\s*(\d)\.\s+(.+?)\s*[│|]?\s*$/);
      if (m) options.push({ key: m[2], label: m[3], selected: !!m[1] });
    }
    // The dialog: from the last box top or question to the end, trimmed of frame lines.
    let start = Math.max(0, rows.length - 18);
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 30); i--) {
      if (/^\s*╭/.test(rows[i])) { start = i; break; }
    }
    const text = rows
      .slice(start)
      .map((l) => l.replace(/^[\s]*[│╭╰╮╯─]+/, "").replace(/[│╮╯─]+\s*$/, "").trimEnd())
      .filter((l) => l.trim())
      .join("\n");
    this.screen = { text, options: options.slice(-6) };
  }

  // ─── acting ────────────────────────────────────────────────────────────

  send(cx) {
    const text = this.composer.value().trim();
    if (!text || !this.addr) return;
    this.composer.set_value("");
    this.follow = true;
    cx.spawn(async (cx) => {
      const r = await hc(["send", this.addr, text]);
      if (r.code !== 0) {
        this.composer.set_value(text);
        notify({ title: "Couldn't send", body: (r.stderr || r.stdout).trim().slice(0, 200), level: "error" });
      }
      this.refresh(cx);
      cx.notify();
    });
  }

  keys(keys, cx) {
    cx.spawn(async (cx) => {
      await hc(["keys", this.addr, ...keys]);
      this.screen = null;
      this.refresh(cx);
    });
  }

  goToTerminal() {
    const p = props() ?? {};
    if (p.overlay) closeOverlay(p.overlay);
    run("pane.focus", { terminal: this.addr });
  }

  dock() {
    const p = props() ?? {};
    const pane = panes().find((x) => x.terminal === this.addr);
    if (p.overlay) closeOverlay(p.overlay);
    run("pane.split", { direction: "right", ...(pane ? { pane: pane.pane } : {}), mod: "claude-reader", props: { terminal: this.addr } });
  }

  close() {
    const p = props() ?? {};
    if (p.overlay) closeOverlay(p.overlay);
    else run("pane.close", {});
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
    this.cache = { version: this.version, mode: this.mode(), st: this.status(), rows };
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

  // ─── scrolling ─────────────────────────────────────────────────────────
  // Our own viewport: rows are laid out from an anchor and clipped, so following the
  // bottom needs no scroll call and only what's on screen is built.

  h(row) {
    const known = this.heights.get(row.key);
    if (known != null) return known;
    return { prompt: 96, text: 110, group: 52, note: 40, dur: 26, cmd: 50, bash: 90, working: 40, top: 50 }[row.type] ?? 30;
  }

  anchorIndex(rows) {
    const i = rows.findIndex((r) => r.key === this.anchorKey);
    return i >= 0 ? i : Math.max(0, rows.length - 1);
  }

  /** Index of the row at the top edge of the view. */
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
      const hidden = acc + this.h(rows[i]) - H; // how much of row i sits above the top edge
      if (hidden <= 0 && i === 0) return; // everything fits
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
    if (below <= H) {
      this.follow = true;
    } else {
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
    this.scrollBy(0, cx); // settles at the bottom if the rest fits
  }

  jumpPrompt(dir, cx) {
    const rows = this.rows();
    const top = this.topIndex(rows);
    const prompts = rows.map((r, i) => (r.type === "prompt" || r.type === "cmd" ? i : -1)).filter((i) => i >= 0);
    if (!prompts.length) return;
    const atTop = !this.follow && this.off < 4;
    const target = dir < 0
      ? [...prompts].reverse().find((i) => (atTop ? i < top : i <= top)) ?? prompts[0]
      : prompts.find((i) => i > top) ?? null;
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

  onKey(e, cx) {
    const k = e.key;
    if (this.typing) {
      if (k === "escape") {
        if (this.searching && !this.composing) this.closeSearch(cx);
        else this.handle.focus();
        cx.stop_propagation();
      }
      return;
    }
    const mod = e.modifiers ?? {};
    if (mod.control || mod.platform || mod.alt) {
      if (k === "f" && (mod.platform || mod.control)) this.openSearch(cx);
      return;
    }
    if (k === "down") this.scrollBy(-60, cx);
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
    else if (k === "i" || k === "r") this.composer.focus();
    else if (k === "escape" && this.searching) this.closeSearch(cx);
    else return;
    cx.stop_propagation();
  }

  title() {
    return this.meta.title || this.meta.ai_title || this.meta.summary || this.agent()?.title || "Claude Code";
  }

  // ─── drawing ───────────────────────────────────────────────────────────

  render(cx) {
    const t = theme();
    const p = props() ?? {};
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
      .id("claude-reader")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => {
        if (!this.typing) this.handle.focus();
      })
      .child(this.header(t, st))
      .when(this.picking, (el) => el.child(this.picker(t)))
      .when(this.searching, (el) => el.child(this.searchBar(t, rows)))
      .child(this.body(t, rows, ctx, st))
      .when(st === "blocked", (el) => el.child(this.blockedPanel(t)))
      .child(this.composerBar(t, st));
  }

  header(t, st) {
    const p = props() ?? {};
    const a = this.agent();
    const meta = this.meta;
    const folder = (meta.cwd ?? this.cwd ?? "").split("/").filter(Boolean).pop();
    const facts = [
      folder,
      meta.branch && meta.branch !== "HEAD" ? meta.branch : null,
      shortModel(meta.model),
      meta.context ? `${fmtTokens(meta.context)} context` : null,
    ].filter(Boolean);
    const dot = st === "working"
      ? div().w(10).text_size(11).text_color(t.working).frames(SPIN, 90)
      : div().flex_none().w(7).h(7).rounded_full().bg(st === "blocked" ? t.blocked : st === "done" ? t.done : alpha(t.dim, 0.9));
    const word = { working: "working", blocked: "needs you", done: "finished", idle: "idle" }[st] ?? (this.addr ? "not running" : "");
    return h_flex()
      .flex_none()
      .h(52)
      .px(14)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .bg(mix(t.background, t.foreground, 0.015))
      .child(
        h_flex()
          .id("cr-who")
          .flex_1()
          .min_w(0)
          .gap(10)
          .items_center()
          .px(6)
          .py(4)
          .rounded(8)
          .cursor_pointer()
          .hover((s) => s.bg(alpha(t.foreground, 0.04)))
          .on_click((_e, cx) => { this.picking = !this.picking; cx.notify(); })
          .child(
            div().flex_none().w(28).h(28).rounded(8).bg(alpha(claudeColor(t), 0.14)).flex().items_center().justify_center()
              .child(image("icons/claude.svg").w(16).h(16)),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex().gap(7).items_center().min_w(0)
                  .child(div().min_w(0).truncate().text_size(13.5).font_semibold().child(this.title()))
                  .child(icon(this.picking ? "chevron-down" : "chevron-right", 11, t.dim)),
              )
              .child(
                h_flex().gap(6).items_center().min_w(0)
                  .child(dot)
                  .child(div().flex_none().text_size(11).text_color(st === "blocked" ? t.blocked : t.muted).child(word))
                  .when(facts.length > 0, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child("· " + facts.join("  ·  ")))),
              ),
          ),
      )
      .child(this.modeSwitch(t))
      .child(
        h_flex().gap(2).items_center()
          .child(this.iconButton(t, "cr-search", "search", "Search  /", (cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)), this.searching))
          .child(this.iconButton(t, "cr-copy", "copy", "Copy as Markdown", (cx) => this.copyAll(cx)))
          .child(this.iconButton(t, "cr-term", "terminal", "Go to the terminal", () => this.goToTerminal()))
          .child(p.overlay
            ? this.iconButton(t, "cr-dock", "layers", "Dock beside the terminal", () => this.dock())
            : this.iconButton(t, "cr-zoom", panes().find((x) => x.mod === "claude-reader" && x.zoomed) ? "shrink" : "expand", "Focus", () => run("pane.zoom", {})))
          .child(this.iconButton(t, "cr-close", "x", p.overlay ? "Close  esc" : "Close", () => this.close())),
      );
  }

  iconButton(t, id, name, _tip, onClick, active) {
    return div()
      .id(id)
      .w(30)
      .h(30)
      .rounded(7)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
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
            .id(`cr-mode-${m.id}`)
            .px(10)
            .h(24)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
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
            .id(`cr-pick-${a.address}`)
            .mx(8)
            .px(12)
            .h(32)
            .gap(10)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(a.address === this.addr ? alpha(t.accent, 0.12) : alpha(t.foreground, 0))
            .hover((s) => s.bg(alpha(t.foreground, 0.06)))
            .on_click((_e, cx) => this.switchTo(a.address, cx))
            .child(div().flex_none().w(7).h(7).rounded_full().bg(a.status === "working" ? t.working : a.status === "blocked" ? t.blocked : a.status === "done" ? t.done : t.dim))
            .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(a.space_name))
            .child(div().flex_none().text_size(12).text_color(t.dim).child(a.tab_name && a.tab_name !== String(a.tab_index) ? `· ${a.tab_name}` : `· tab ${a.tab_index}`))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(a.title ?? ""))
            .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(word[a.status] ?? "")),
        ),
      );
  }

  searchBar(t, rows) {
    const hits = this.query ? rows.filter((r) => r.type !== "end" && r.type !== "top" && r.type !== "working").length : null;
    return h_flex()
      .flex_none()
      .h(42)
      .px(20)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.9))
      .child(icon("search", 13, t.dim))
      .child(Input.new(this.search).flex_1().h(30).text_size(13).text_color(t.foreground))
      .when(hits != null, (el) => el.child(div().text_size(11.5).text_color(hits ? t.muted : t.blocked).child(hits ? `${hits} match${hits === 1 ? "" : "es"}` : "No matches")))
      .child(this.iconButton(t, "cr-search-x", "x", "Clear", (cx) => this.closeSearch(cx)));
  }

  body(t, rows, ctx, st) {
    if (!this.addr)
      return this.empty(t, "No Claude Code chat to show", "Focus a terminal running Claude Code, then press ⌘⇧M.");
    if (this.error === "no-transcript")
      return this.empty(t, "No transcript yet", "This terminal isn't running Claude Code, or it hasn't written a session yet.");
    if (!this.loaded) return this.empty(t, "Reading the conversation…", null, true);
    const onlyEnd = rows.length <= 1;
    return div()
      .id("cr-view")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs(size.height - this.viewH) > 0.5) { this.viewH = size.height; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => this.scrollBy(e.delta?.y ?? 0, cx))
      .child(this.viewport(t, rows, ctx))
      .when(!onlyEnd, (el) => el.child(this.rail(t, rows)))
      .when(onlyEnd, (el) => el.child(div().absolute().inset_0().child(this.empty(t, this.query ? "Nothing matches" : "Nothing said yet", this.query ? "Try another word." : "Send Claude a message below."))))
      .when(!this.follow && !onlyEnd, (el) =>
        el.child(
          div().absolute().bottom(14).left(0).right(0).flex().justify_center().child(
            h_flex()
              .id("cr-latest")
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

  /** The rows on screen (plus one above for measuring), clipped by the view. */
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
      if (start === 0 && acc <= H) top = 0; // short chat: start at the top
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

  /** A slim rail: where you are, and a tick per prompt to jump to. */
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

  blockedPanel(t) {
    const s = this.screen;
    return div().flex_none().w_full().flex().justify_center().px(16).pt(10).child(
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
          h_flex().gap(8).items_center()
            .child(icon("alert", 14, t.blocked))
            .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.blocked).child("Claude is waiting for you"))
            .child(this.textButton(t, "cr-goterm", "Answer in terminal", () => this.goToTerminal())),
        )
        .when(!!s?.text, (el) => el.child(div().max_h(180).overflow_hidden().font_family(mono()).text_size(11.5).line_height(1.5).text_color(t.foreground).child(s.text)))
        .when(!!s?.options?.length, (el) =>
          el.child(
            h_flex().gap(6).flex_wrap().children(
              s.options.map((o) =>
                h_flex()
                  .id(`cr-opt-${o.key}`)
                  .h(28)
                  .px(10)
                  .gap(7)
                  .items_center()
                  .rounded(7)
                  .cursor_pointer()
                  .bg(o.selected ? alpha(t.blocked, 0.16) : alpha(t.foreground, 0.06))
                  .border(1)
                  .border_color(o.selected ? alpha(t.blocked, 0.5) : alpha(t.border, 1))
                  .hover((h) => h.bg(alpha(t.foreground, 0.1)))
                  .on_click((_e, cx) => this.keys([o.key], cx))
                  .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(o.key))
                  .child(div().max_w(320).truncate().text_size(12).text_color(t.foreground).child(o.label)),
              ),
            ),
          ),
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

  composerBar(t, st) {
    const live = !!this.term() && this.term()?.state !== "finished";
    return div().flex_none().w_full().flex().justify_center().px(16).pt(10).pb(14).child(
      v_flex()
        .w_full()
        .max_w(COLUMN - 24)
        .gap(6)
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
            .border_color(this.composing ? alpha(t.accent, 0.7) : alpha(t.border, 1))
            .child(div().flex_1().min_w(0).child(Textarea.new(this.composer).w_full().text_size(13).line_height(1.5).text_color(t.foreground)))
            .when(st === "working", (el) =>
              el.child(
                div().id("cr-stop").h(28).px(10).flex().items_center().gap(6).rounded(8).cursor_pointer()
                  .bg(alpha(t.foreground, 0.07)).hover((s) => s.bg(alpha(t.foreground, 0.12)))
                  .on_click((_e, cx) => this.keys(["esc"], cx))
                  .child(div().w(8).h(8).rounded(2).bg(t.foreground))
                  .child(div().text_size(11.5).text_color(t.foreground).child("Stop")),
              ),
            )
            .child(
              div().id("cr-send").w(28).h(28).flex().items_center().justify_center().rounded(8).cursor_pointer()
                .bg(live ? claudeColor(t) : alpha(t.foreground, 0.1))
                .hover((s) => s.bg(live ? alpha(claudeColor(t), 0.85) : alpha(t.foreground, 0.1)))
                .on_click((_e, cx) => this.send(cx))
                .child(icon("arrow-up", 14, live ? "#ffffff" : t.dim)),
            ),
        )
        .child(
          h_flex().px(4).gap(14).text_size(10.5).text_color(t.dim)
            .child(div().child(st === "working" ? "↵ queue for Claude · ⇧↵ newline" : "↵ send · ⇧↵ newline"))
            .child(div().flex_1())
            .child(div().child("j / k prompts · / search · 1 2 3 views · right-click copies")),
        ),
    );
  }
}
