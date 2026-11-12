// The epic switcher: one master per epic (a worktree group), and HQ shows one epic at a time. The
// strip carries it as a dropdown: the trigger names the epic shown; the menu lists every epic with
// its master's state, switches on a click or ↑ ↓ Enter, and offers to start a master where none runs.
// Data: the snapshot's `epics` (hq.py's roadmap.epics_snapshot), the one list of epics HQ reads.

import { Popover, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { alpha, btn, icon, row, statusGlyph, tint, TYPE } from "./ui.js";

/** The epic a master's terminal runs, from its `herdr.master` label (its registry key). */
export function epicOfMaster(data, label) {
  return label ? ((data?.epics ?? []).find(e => e.key === label)?.name ?? null) : null;
}

/** The strip's epic dropdown: the trigger, and the menu anchored under it while it's open. */
export function epicMenu(app, d, t) {
  const epics = d.epics ?? [];
  if (!epics.length) return null;
  const open = !!app.epicMenu;
  const running = epics.filter(x => x.master).length;
  const trigger = row()
    .id("strip-epic")
    .flex_none()
    .h(26)
    .pl(8)
    .pr(6)
    .gap(5)
    .items_center()
    .rounded(7)
    .border(1)
    .border_color(open ? t.accent : alpha(t.border, 0.9))
    .when(open, el => el.bg(tint(t).on))
    .hover(s => s.bg(open ? tint(t).on : tint(t).hover))
    .cursor_pointer()
    .tooltip(open ? "" : `Epic: each has its own master, org, inbox and queue (${running} of ${epics.length} running)`)
    .child(div().flex_none().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(d.epic ?? "Main"))
    .child(icon("chevron-down", 11, open ? t.foreground : t.muted));
  return Popover.new("strip-epic-menu")
    .anchor("top_left")
    .open(open)
    .track_focus(app.epicFocus)
    .on_open_change((v, cx) => {
      app.epicMenu = v;
      if (v) app.epicSel = Math.max(0, epics.findIndex(e => e.current));
      cx.notify();
    })
    .trigger(trigger)
    .content(menu(app, epics, t));
}

function menu(app, epics, t) {
  const sel = Math.min(app.epicSel ?? 0, epics.length - 1);
  return v_flex()
    .id("strip-epic-list")
    .mt(6)
    .w(300)
    .p(4)
    .gap(1)
    .rounded(10)
    .bg(t.popover ?? t.surface)
    .border(1)
    .border_color(t.border)
    .shadow_lg()
    .track_focus(app.epicFocus)
    .on_key_down((e, cx) => {
      cx.stop_propagation(); // the menu has the keyboard; HQ's view keys wait until it closes
      if (e.key === "down" || e.key === "up") {
        app.epicSel = (sel + (e.key === "down" ? 1 : epics.length - 1)) % epics.length;
        cx.notify();
      } else if (e.key === "enter") app.pickEpic(epics[sel].name, cx);
    })
    .child(div().px(8).pt(4).pb(6).text_size(TYPE.meta).text_color(t.muted).child("Switch epic"))
    .children(
      epics.map((e, i) => {
        const gone = e.status === "gone";
        const busy = app.busy?.has(`master-open-${e.name}`);
        return row()
          .id(`epic-${e.name}`)
          .h(32)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .when(i === sel, el => el.bg(tint(t).hover))
          .on_mouse_move((_e, cx) => {
            if (app.epicSel === i) return;
            app.epicSel = i;
            cx.notify();
          })
          .on_click((_e, cx) => app.pickEpic(e.name, cx))
          .child(div().flex_none().w(14).child(e.current ? icon("check", 13, t.accent) : div()))
          .child(statusGlyph(e.master ? e.status : "gone", t, 11, { still: true }))
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(e.label ?? e.name))
          .when(!!e.master, el => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(e.master)))
          .when(!e.master, el =>
            el.child(
              btn(
                t,
                `epic-start-${e.name}`,
                busy ? "Starting…" : gone ? "Restart" : "Start master",
                cx => {
                  cx.stop_propagation(); // not also a pick of the row under it
                  app.startEpicMaster(e.name, cx);
                },
                { size: "sm", kind: "ghost", disabled: busy },
              ),
            ),
          );
      }),
    );
}
