// Claude Reader: a Claude Code chat as a clean, live document you can drive.
//
// Opens as a dialog over the focused Claude terminal (`mod.open:claude-reader`, ⌘⇧M), or
// docked beside it as a pane (props: { terminal }). The chat itself is shared code
// (shared/js/claude-chat.js, also in HQ): the whole conversation from the session's JSONL
// transcript (read.py), a composer with slash commands (commands.py), Stop, the permission
// mode, model and effort, dialogs answered with buttons, the todo list and background work.

import { View } from "gpui-kit";
import { agents, closeOverlay, focused, nextCommand, panes, props, run, theme } from "herdr";
import { ClaudeChat } from "./shared/claude-chat.js";

const isClaude = (a) => a && (a.app === "claude-code" || a.program?.key === "claude");

export default class ClaudeReader extends View {
  init(_props, cx) {
    this.chat = new ClaudeChat(cx, {
      pick: () => pickTarget(),
      onGoToTerminal: (addr) => {
        const p = props() ?? {};
        if (p.overlay) closeOverlay(p.overlay);
        run("pane.focus", { terminal: addr });
      },
      actions: (t, chat) => {
        const p = props() ?? {};
        return [
          p.overlay
            ? chat.iconButton(t, "cr-dock", "layers", "Dock beside the terminal", () => this.dock())
            : chat.iconButton(t, "cr-zoom", panes().find((x) => x.mod === "claude-reader" && x.zoomed) ? "shrink" : "expand", "Focus", () => run("pane.zoom", {})),
          chat.iconButton(t, "cr-close", "x", p.overlay ? "Close  esc" : "Close", () => this.close()),
        ];
      },
    });
    cx.timer.every(1000, (cx) => this.chat.poll(cx));
    this.chat.refresh(cx);
    if (props()?.overlay) this.chat.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.chat.focus();
        cx.notify();
      }
    });
  }

  dock() {
    const p = props() ?? {};
    const addr = this.chat.addr;
    const pane = panes().find((x) => x.terminal === addr);
    if (p.overlay) closeOverlay(p.overlay);
    run("pane.split", { direction: "right", ...(pane ? { pane: pane.pane } : {}), mod: "claude-reader", props: { terminal: addr } });
  }

  close() {
    const p = props() ?? {};
    if (p.overlay) closeOverlay(p.overlay);
    else run("pane.close", {});
  }

  render(cx) {
    return this.chat.render(theme(), cx);
  }
}

function pickTarget() {
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
