import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, nextCommand } from "herdr";

// Each side panel keeps its own width: Workflows needs room for its graph and drawer,
// Files and Changes stay narrow.
const PANEL_W = { files: 368, changes: 368, workflows: 900 };
// The terminals beside the panel keep at least this much room.
const MAIN_MIN = 320;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// HQ is a main view in the layout's `center` stack: a tab click goes back to the workspace.
const toWorkspace = () => { if (find(layout(), "center")?.active === "hq") run("layout.select", { stack: "center", child: "workspace" }); };

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // "my-tabs.files" / ".changes" / ".workflows" (keys, other mods) open that panel.
    // Uses its cx each time round, so a reload ends the old build's loop.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (PANEL_W[c]) this.openPanel(c);
        cx.notify();
      }
    });
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.widths = JSON.parse(localStorage.getItem("panel-widths") ?? "{}");
    this.sizing = null;
  }

  width(id) {
    return this.fit(this.widths[id] ?? PANEL_W[id] ?? 368);
  }

  /** `px` limited to what the window has beside the sidebar and MAIN_MIN of terminals, and to
   *  the panel's own min/max: Herdr applies a saved or requested width as is, even one wider
   *  than the window, which pushes the panel off screen. */
  fit(px) {
    const panel = find(layout(), "panel");
    // This bar spans the work area that the panel and the terminals share.
    const room = this.barWidth ? this.barWidth - MAIN_MIN - 24 : Infinity;
    const max = Math.min(panel?.max ?? Infinity, room);
    return Math.round(Math.max(panel?.min ?? 280, Math.min(px, max)));
  }

  /** Shows panel `id` at its own width. */
  openPanel(id) {
    const px = this.width(id);
    this.sizing = { id, px, until: Date.now() + 1000 };
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.resize", { id: "panel", px });
    run("layout.show", { id: "panel" });
  }

  // A drag on the panel's edge is that panel's new width.
  noteWidth(panel, body) {
    if (!panel || panel.hidden || !body?.active) return;
    const px = panel.size?.px;
    if (!px) return;
    // Too wide for the window (a saved width, a smaller screen, a zoom): bring it back in.
    const fits = this.fit(px);
    if (px > fits + 1) {
      if (!this.sizing || Date.now() >= this.sizing.until) {
        this.sizing = { id: body.active, px: fits, until: Date.now() + 1000 };
        run("layout.resize", { id: "panel", px: fits });
      }
      return;
    }
    if (this.sizing) {
      if (body.active !== this.sizing.id || Math.abs(px - this.sizing.px) > 1) {
        if (Date.now() < this.sizing.until) return;
      }
      this.sizing = null;
    }
    if (this.widths[body.active] === px) return;
    this.widths[body.active] = px;
    localStorage.setItem("panel-widths", JSON.stringify(this.widths));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) this.openPanel(want);
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else { run("tab.select", { id: c.id }); toWorkspace(); }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Workflows is offered wherever this layout has its panel block.
    const withWorkflows = Boolean(body?.children?.some(c => c.id === "workflows"));
    const enabled = [...new Set([...(shared("workspace.panels") ?? ["files", "changes"]), ...(withWorkflows ? ["workflows"] : [])])];
    this.syncPanel(space, panel, body, enabled);
    this.noteWidth(panel, body);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else this.openPanel(id);
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().id("tabs-root").on_size_change((size, cx) => {
        if (Math.abs((this.barWidth ?? 0) - size.width) < 1) return;
        this.barWidth = size.width;
        cx.notify();
      }).size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .when(Boolean(find(root, "center")?.children?.some(c => c.id === "hq")), el => el.child(
        h_flex().id("tab-hq").h(29).px(10).gap(6).flex_none().items_center().rounded(7).text_size(12.8).text_color(t.muted)
          .tooltip("HQ: the master's desk (⌘⇧H)").hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
          .on_click(() => run("layout.select", { stack: "center", child: "hq" }))
          .child(svg("shared/icons/crown.svg").size(13)).child("HQ")))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "my-new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("workflows"), el => el.child(panelButton("workflows", "Workflows", "shared/icons/flow.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
