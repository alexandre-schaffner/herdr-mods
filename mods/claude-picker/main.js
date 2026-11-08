// Claude: pick the account, model and effort.
//   Launch: props { space, name, base } (from the + menu): starts a Claude tab with them.
//   Live:   props { terminal } (from a Claude pane's header): switches model and effort in the
//           running session with /model and /effort. Another account restarts Claude in the
//           tab's shell with --resume: same conversation, new account.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, run, hc, exec, terminals, panes, closeOverlay, shared, setShared, notify } from "herdr";
import { loadConfig, account, launchArgv, labelArgs, resumeLine, sessionAt, stateOf, modelLabel, effortLabel } from "./claude.js";

const LAST = "claude-picker.last";

async function foregroundArgv(addr) {
  try {
    return JSON.parse((await hc(["get", addr, "--json"])).stdout).foreground?.argv;
  } catch {
    return undefined;
  }
}

const count = (text, re) => (text.match(re) ?? []).length;
const SHELLS = new Set(["fish", "zsh", "bash", "sh", "dash", "ksh"]);
const sleep = (s) => exec("sleep", [String(s)]);
async function terminal(addr) { return JSON.parse((await hc(["get", addr, "--json"])).stdout); }
// The shell at the prompt, not a `fish -lic '...'` wrapper still running a command.
const atPrompt = (fg) => SHELLS.has((fg?.argv?.[0] ?? "").split("/").pop()) && !fg.argv.slice(1).some((a) => /^-\w*c/.test(a));

export default class ClaudePicker extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.cfg = null;
    cx.spawn(async (cx) => {
      try { this.cfg = await loadConfig(); }
      catch (e) { this.error = `${e}`; return cx.notify(); }
      const addr = props()?.terminal;
      if (addr) {
        const labels = terminals().find((t) => t.address === addr)?.labels;
        // Without labels, read the flags it started with (the foreground program's argv).
        const argv = labels?.["claude.account"] ? undefined : await foregroundArgv(addr);
        Object.assign(this, stateOf(this.cfg, labels, argv));
        this.applied = { model: this.model, effort: this.effort };
        this.started = account(this.cfg, this.account)?.id;
        this.account = this.started;
      } else {
        const last = shared(LAST) ?? {};
        this.account = account(this.cfg, last.account)?.id;
        this.model = last.model ?? "";
        this.effort = last.effort ?? "";
      }
      cx.notify();
    });
  }

  live() { return Boolean(props()?.terminal); }

  status() { return panes().find((p) => p.terminal === props()?.terminal)?.status ?? null; }

  // Live: the account can change only while Claude waits for a prompt (/exit is typed into it).
  canPickAccount() { return !this.live() || (!this.switching && !["working", "blocked"].includes(this.status())); }

  switchPending() { return this.live() && this.account !== this.started; }

  pickAccount(id, cx) {
    if (!this.canPickAccount()) return;
    this.account = id;
    cx.notify();
  }

  confirm(cx) {
    if (!this.live()) return this.start();
    if (!this.switchPending()) return this.dismiss();
    if (this.switching) return;
    this.switching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.queue;
        await this.switchAccount();
        this.dismiss();
      } catch (e) {
        this.switching = false;
        notify({ title: "Couldn't switch account", body: String(e?.message ?? e), level: "error" });
        cx.notify();
      }
    });
  }

  // /exit the running Claude, wait for the tab's shell, then reopen the session in the new account.
  async switchAccount() {
    const addr = props()?.terminal;
    const t0 = await terminal(addr);
    const session = t0.foreground?.pid && (await sessionAt(this.cfg, t0.foreground.pid));
    if (!session) throw new Error("Couldn't find the Claude session running in this tab.");
    const alive = async () => (await exec("kill", ["-0", String(session.pid)])).code === 0;
    const r = await hc(["send", addr, "/exit"]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    for (let i = 0; ; i++) {
      if (i === 60) throw new Error("Claude didn't exit within 15s.");
      await sleep(0.25);
      const t = await terminal(addr);
      if (t.state !== "live") throw new Error("The tab closed when Claude exited.");
      if (!(await alive()) && atPrompt(t.foreground)) break;
    }
    await sleep(0.3); // let the shell draw its prompt
    const choice = { account: this.account, model: this.model, effort: this.effort };
    await hc(["label", addr, ...labelArgs(this.cfg, choice)]);
    const s = await hc(["send", addr, resumeLine(this.cfg, choice, session.sessionId)]);
    if (s.code !== 0) throw new Error((s.stderr || s.stdout).trim());
  }

  // Not `close`: Herdr calls a View's close(cx) itself when the overlay goes.
  dismiss() { closeOverlay(props()?.overlay); }

  start() {
    const p = props() ?? {};
    const choice = { account: this.account, model: this.model, effort: this.effort };
    setShared(LAST, choice);
    this.dismiss();
    run("tab.new", { name: p.name ?? "Claude Code", space: p.space, argv: launchArgv(this.cfg, p.base ?? ["claude"], choice) });
  }

  pick(kind, v, cx) {
    if (this[kind] === v) return;
    this[kind] = v;
    cx.notify();
    if (!this.live()) return;
    // One switch at a time (a second /model or /effort can't be typed while Claude waits on
    // the "Switch model?" dialog); quick repeats collapse into the latest choice.
    this.queue = (this.queue ?? Promise.resolve()).then(() => this.apply(kind)).catch(e =>
      notify({ title: `Couldn't switch ${kind}`, body: String(e?.message ?? e), level: "error" }));
  }

  async apply(kind) {
    const v = this[kind];
    if (this.applied?.[kind] === v) return;
    const addr = props()?.terminal;
    const label = kind === "model" ? modelLabel(v) : effortLabel(v);
    const read = async () => (await hc(["read", addr, "--lines", "40"])).stdout;
    const before = kind === "model" ? count(await read(), /Set model to/g) : 0;
    const r = await hc(["send", addr, `/${kind} ${label}`]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    await hc(["label", addr, `claude.${kind}=${label}`]);
    this.applied = { ...this.applied, [kind]: v };
    // With history, /model asks "Switch model?" (the cache is re-read): the pick already said yes.
    // Only a confirmation newer than this send counts as done.
    if (kind === "model") for (let i = 0; i < 10; i++) {
      await exec("sleep", ["0.4"]);
      const screen = await read();
      if (/Switch model\?/.test(screen)) { await hc(["keys", addr, "1"]); return; }
      if (count(screen, /Set model to/g) > before) return;
    }
  }

  step(kind, list, by, cx) {
    if (!list.length) return;
    const i = list.findIndex((x) => x.value === this[kind]);
    this.pick(kind, list[(Math.max(i, 0) + by + list.length) % list.length].value, cx);
  }

  heading(t, text, note) {
    return h_flex().gap(6).items_baseline().pt(4)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(text))
      .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.dim).child(note)));
  }

  chip(t, id, label, on, click) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().cursor_pointer()
      .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => click(cx))
      .child(label);
  }

  accountRow(t, a, i) {
    const on = a.id === this.account;
    const fixed = !this.canPickAccount();
    return h_flex().id(`acct-${a.id}`).h(40).px(10).gap(10).items_center().rounded(7).border_1()
      .border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected))
      .when(!fixed && !on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pickAccount(a.id, cx))
      .child(div().size(10).flex_none().rounded(5).border_1().border_color(on ? t.accent : t.dim).when(on, (el) => el.bg(t.accent)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_color(t.foreground).font_medium().child(a.name))
        .child(div().text_size(11).text_color(t.dim).truncate().child(a.detail ?? "")))
      .when(this.live() && a.id === this.started, (el) => el.child(div().text_size(11).text_color(t.dim).child("running")))
      .when(!fixed && i < 9, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(i + 1))));
  }

  render() {
    const t = theme();
    if (!this.cfg) return div().id("claude-picker").track_focus(this.handle).w_full().p(16).bg(t.popover).text_size(12.5).text_color(this.error ? t.blocked : t.dim)
      .child(this.error ? `Couldn't read accounts.json: ${this.error}` : "Loading…");
    const { accounts: ACCOUNTS, models: MODELS, efforts: EFFORTS } = this.cfg;
    const live = this.live();
    const status = live ? this.status() : null;
    const pending = this.switchPending();
    const accountNote = !live ? "" : this.switching ? "restarting Claude…" : !this.canPickAccount() ? "switch when this turn ends"
      : pending ? "restarts Claude here, same conversation" : "switching restarts Claude";
    return v_flex().id("claude-picker").track_focus(this.handle).w_full().p(16).gap(8).bg(t.popover).text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const k = e.key;
        if (k === "enter") return this.confirm(cx);
        if (k === "escape") return this.dismiss();
        if (/^[1-9]$/.test(k) && ACCOUNTS[Number(k) - 1]) this.pickAccount(ACCOUNTS[Number(k) - 1].id, cx);
        else if (k === "up" || k === "down") {
          const i = ACCOUNTS.findIndex((a) => a.id === this.account);
          this.pickAccount(ACCOUNTS[(i + (k === "down" ? 1 : ACCOUNTS.length - 1)) % ACCOUNTS.length].id, cx);
        } else if (k === "left" || k === "right") {
          const by = k === "right" ? 1 : -1;
          if (e.modifiers.shift) this.step("effort", EFFORTS, by, cx); else this.step("model", MODELS, by, cx);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(live ? "Claude in this tab" : "New Claude tab"))
      .child(this.heading(t, "Account", accountNote))
      .child(v_flex().gap(6).children(ACCOUNTS.map((a, i) => this.accountRow(t, a, i))))
      .child(this.heading(t, "Model", live && status === "working" ? "applies after this turn" : ""))
      .child(h_flex().flex_wrap().gap(6).children(MODELS.map((m) =>
        this.chip(t, `model-${m.value || "default"}`, m.name, m.value === this.model, (cx) => this.pick("model", m.value, cx)))))
      .child(this.heading(t, "Effort"))
      .child(h_flex().flex_wrap().gap(6).children(EFFORTS.map((x) =>
        this.chip(t, `effort-${x.value || "auto"}`, x.name, x.value === this.effort, (cx) => this.pick("effort", x.value, cx)))))
      .child(h_flex().pt(8).gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(live ? "Claude also saves these as its default for new sessions" : "↑ ↓ account · ← → model · ⇧← → effort"))
        .when(!live, (el) => el
          .child(div().id("cancel").h(28).px(12).flex().items_center().rounded(6).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click(() => this.dismiss()).child("Cancel")))
        .child(div().id("go").h(28).px(14).flex().items_center().rounded(6).cursor_pointer().bg(t.solid).text_color(t.solid_foreground).font_medium()
          .on_click((_e, cx) => this.confirm(cx)).child(!live ? "Start  ↵" : this.switching ? "Restarting…" : pending ? "Switch account  ↵" : "Done")));
  }
}
