// Puts one worktree space into a sidebar group (an epic), another group, or none.
// Opened by my-spaces with props { file, top, name, current, groups }. Writes the groups file.

import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { closeOverlay, props, readTextFile, theme, writeTextFile } from "herdr";

export default class Group extends View {
  init(_props, cx) {
    this.input = InputState.new({ placeholder: "New group" });
    this.input.on("submit", (_e, cx) => this.choose(this.input.value().trim() || null, cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.error = null;
  }

  // The file maps a worktree's top folder to its group name; null removes the entry.
  choose(group, cx) {
    const p = props();
    cx.spawn(async cx => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(p.file);
        let map;
        try {
          map = before ? JSON.parse(before) : {};
        } catch {
          this.error = `Can't read ${p.file}: fix or delete it.`;
          cx.notify();
          return;
        }
        if (group) map[p.top] = group;
        else delete map[p.top];
        try {
          await writeTextFile(p.file, `${JSON.stringify(map, null, 2)}\n`, before);
          closeOverlay(p.overlay);
          return;
        } catch {
          // Someone wrote the file between the read and the write: read it again.
        }
      }
      this.error = "The groups file keeps changing. Try again.";
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      closeOverlay(props().overlay);
      cx.stop_propagation();
    }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const option = (id, label, active, group) =>
      h_flex()
        .id(id)
        .h(28)
        .px(10)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(12.5)
        .when(active, el => el.bg(t.selected))
        .when(!active, el => el.hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => this.choose(group, cx))
        .child(div().flex_1().truncate().child(label))
        .when(active, el => el.child(div().text_size(11).text_color(t.dim).child("current")));
    return v_flex()
      .id("my-spaces-group")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .p(8)
      .gap(2)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        div()
          .px(10)
          .pt(4)
          .pb(6)
          .text_size(11.5)
          .text_color(t.dim)
          .truncate()
          .child(`Group for ${p.name ?? "this worktree"}`),
      )
      .children((p.groups ?? []).map((g, n) => option(`group-${n}`, g, g === p.current, g)))
      .child(option("group-none", "No group", !p.current, null))
      .child(
        Input.new(this.input)
          .mt(6)
          .h(30)
          .px(10)
          .rounded(7)
          .border_1()
          .border_color(t.input)
          .bg(t.background)
          .text_size(12.5)
          .text_color(t.foreground),
      )
      .child(div().px(10).pt(4).text_size(11).text_color(t.dim).child("Enter makes the group · Esc closes"))
      .when(Boolean(this.error), el =>
        el.child(div().px(10).pt(4).text_size(11.5).text_color(t.blocked).child(this.error)),
      );
  }
}
