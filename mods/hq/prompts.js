// Prompts: the texts that steer the master and its managers, each with when it takes effect,
// and the autopilot's settings. Files are read when first shown and written with a stale check.

import { Editor as CodeView, EditorState, h_flex, Input, InputState, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home, readTextFile, settings as appSettings, writeTextFile } from "herdr";

import { alpha, banner, btn, chip, dot, frame, icon, label, loading, mdBlock, mono, ok, row, scrollY, SP, tildify, tint, tone, TYPE } from "./ui.js";

const DOCS = [
  {
    id: "master",
    title: "Master system prompt",
    icon: "crown",
    applies: "When the master (re)starts",
    note: "Shared by every repository's master. A running master keeps the old text until it restarts, or until you tell it to re-read.",
  },
  {
    id: "runner",
    title: "Loop runner prompt",
    icon: "repeat",
    applies: "When the runner (re)starts",
    note: "Shared by every repository. The cheap session (Haiku by default) that runs the master's tick and escalates judgment to it with `hq escalate`. Turn it off per repository with `runner: false` in settings.json.",
  },
  {
    id: "style",
    title: "Communication style",
    icon: "message",
    applies: "Within one tick",
    note: "Shared by every repository: how the master, managers, units and workflow owners write (general messages: bro; observability: ASD-STE100; handovers: BLUF + SBAR). Briefs carry it at launch; `hq tick` flags a change.",
  },
  {
    id: "orders",
    title: "Standing orders",
    icon: "list",
    applies: "Within one tick",
    note: "This repository's current instructions. The master re-reads them on every tick; `hq tick` flags the change.",
  },
  {
    id: "policy",
    title: "Approval policy",
    icon: "circle-check",
    applies: "Within one tick",
    note: "What needs your approval card before it happens. Keep it to outward-facing actions; the rest is reviewed after the fact.",
  },
  {
    id: "base",
    title: "Manager brief template",
    icon: "user",
    applies: "At the next launch or respawn",
    note: "Every manager's brief is this plus its charter and team. Placeholders: {repo} {repo_dir} {id} {master} {label} {policy}.",
  },
  {
    id: "owner",
    title: "Workflow owner brief",
    icon: "flow-down",
    applies: "At the next owner's launch",
    note: "What each workflow run's owner session is told. Placeholders: {name} {repo} {id} {master} {policy} {folder} {call} {note}; double the braces of literal ones ({{ }}).",
  },
  {
    id: "handoff",
    title: "Master handoff",
    icon: "file-text",
    applies: "Kept by the master",
    note: "The master rewrites this at the end of every tick; it is what a compacted or fresh master starts from.",
    readonly: true,
  },
  { id: "autopilot", title: "Autopilot", icon: "settings", applies: "Within a minute", form: true },
];

const NUMBERS = [
  { key: "masterCompactAt", label: "Compact the master at", unit: "tokens", hint: "Context size above which an idle master is compacted (needs a handoff from the last 3 h)." },
  { key: "managerWarnAt", label: "Warn on a manager at", unit: "tokens", hint: "A manager's context above this shows amber and raises a Pulse signal." },
  { key: "quietMinutes", label: "Quiet after", unit: "min", hint: "A working session with no transcript write for this long is flagged as quiet." },
  { key: "idleMinutes", label: "Idle after", unit: "min", hint: "A manager idle this long raises an info signal." },
  { key: "dreamEvery", label: "Dream every", unit: "commits", hint: "Memory commits since the last Dream before the master is told to dream." },
  { key: "unitIdleMinutes", label: "End idle units after", unit: "min", hint: "A manager's unit session that finished and sat idle this long is ended (its worktree, commits and report stay). Pinned units, and ones labelled herdr.hq.keep, stay." },
];

const TOGGLES = [
  { key: "autoRearm", label: "Keep the master's loop armed", hint: "Types `/loop master tick` back in when the loop lapses and the master is idle." },
  { key: "autoCompactMaster", label: "Compact the master when idle and large", hint: "Runs /compact on an idle master over the threshold below." },
  { key: "freeUnits", label: "End finished unit sessions", hint: "Ends managers' unit sessions left idle past the time below, so they stop holding memory and tabs." },
];

export class PromptsView {
  constructor(app) {
    this.app = app;
    this.sel = "orders";
    this.focus = null;
    this.docs = {};
    const font = appSettings()?.font_family || "JetBrains Mono";
    const make = readonly => {
      const st = EditorState.new({ language: "markdown", value: "", soft_wrap: true, line_numbers: false, readonly, font_family: font, font_size: 12.5 });
      return st;
    };
    for (const d of DOCS) {
      if (d.form) continue;
      const doc = { def: d, st: make(!!d.readonly), loaded: false, disk: null, stale: false, error: null };
      // A read-only doc gets a second, editable state for "Edit anyway".
      if (d.readonly) doc.edit = make(false);
      doc.editing = false;
      for (const st of [doc.st, doc.edit].filter(Boolean)) this.track(d.id, st);
      this.docs[d.id] = doc;
    }
    // Autopilot form: one input per number, toggles held as values.
    this.form = { loaded: false, toggles: {}, inputs: {}, dirty: false, error: null };
    for (const n of NUMBERS) {
      const st = InputState.new({ placeholder: "", value: "" });
      this.track(`num:${n.key}`, st, () => {
        this.form.dirty = true;
      });
      this.form.inputs[n.key] = st;
    }
  }

  track(key, st, onChange) {
    st.on("focus", (_e, cx) => {
      this.focus = key;
      cx.notify();
    });
    st.on("blur", (_e, cx) => {
      if (this.focus === key) this.focus = null;
      cx.notify();
    });
    st.on("change", (_e, cx) => {
      onChange?.();
      cx.notify();
    });
  }

  typing() {
    return !!this.focus;
  }

  path(id) {
    return this.app.data?.paths?.[id];
  }

  // ---- loading and saving

  onShow(cx, arg) {
    if (arg?.id && DOCS.some(d => d.id === arg.id)) this.sel = arg.id;
    this.ensure(this.sel, cx);
    for (const doc of Object.values(this.docs)) if (doc.loaded) this.reread(doc, cx);
  }

  onData(data, cx) {
    // The first snapshot brings the paths; load what's showing.
    if (data && !this.docs[this.sel]?.loaded) this.ensure(this.sel, cx);
    if (data && !this.form.loaded && this.sel === "autopilot") this.loadForm(data);
  }

  ensure(id, cx) {
    if (id === "autopilot") {
      if (!this.form.loaded && this.app.data) this.loadForm(this.app.data);
      return;
    }
    const doc = this.docs[id];
    if (!doc || doc.loaded || doc.loading || !this.path(id)) return;
    doc.loading = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.path(id));
        doc.disk = text;
        doc.st.set_value(text ?? "");
        doc.edit?.set_value(text ?? "");
        doc.loaded = true;
        doc.error = null;
      } catch (e) {
        doc.error = `Couldn't read: ${e?.message ?? e}`;
      }
      doc.loading = false;
      cx.notify();
    });
  }

  /** Picks up an edit made outside HQ: replaces a clean doc, flags a dirty one. */
  reread(doc, cx) {
    cx.spawn(async cx => {
      let text;
      try {
        text = await readTextFile(this.path(doc.def.id));
      } catch {
        return;
      }
      if (text === doc.disk) return;
      if (!this.dirty(doc)) {
        doc.disk = text;
        doc.st.set_value(text ?? "");
        doc.edit?.set_value(text ?? "");
        doc.stale = false;
      } else doc.stale = true;
      cx.notify();
    });
  }

  active(doc) {
    return doc.editing && doc.edit ? doc.edit : doc.st;
  }

  dirty(doc) {
    return doc.loaded && this.active(doc).value() !== (doc.disk ?? "");
  }

  save(doc, cx) {
    const text = this.active(doc).value();
    const path = this.path(doc.def.id);
    if (!path || doc.saving) return;
    doc.saving = true;
    cx.spawn(async cx => {
      try {
        await writeTextFile(path, text, doc.disk);
        doc.disk = text;
        doc.stale = false;
        doc.error = null;
        // Keep the other state of a read-only doc in step.
        if (doc.edit) (doc.editing ? doc.st : doc.edit).set_value(text);
        if (doc.def.id === "master") doc.tellPending = true;
        doc.savedAt = Date.now();
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/stale|changed|expected|match/i.test(msg)) doc.stale = true;
        else doc.error = `Couldn't save: ${msg}`;
      }
      doc.saving = false;
      cx.notify();
    });
  }

  reload(doc, cx) {
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.path(doc.def.id));
        doc.disk = text;
        doc.st.set_value(text ?? "");
        doc.edit?.set_value(text ?? "");
        doc.stale = false;
      } catch (e) {
        doc.error = `Couldn't read: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  revert(doc, cx) {
    this.active(doc).set_value(doc.disk ?? "");
    cx.notify();
  }

  tellMaster(doc, cx) {
    const term = this.app.data?.master?.terminal;
    if (!term) return;
    const msg = `The person edited your system prompt (${this.path("master")}). Re-read it now and follow it from here on.`;
    this.app.act(cx, "tell-master", ["send", term, msg], {
      done: "Told the master to re-read its prompt",
      fail: "Couldn't reach the master",
      then: () => {
        doc.tellPending = false;
      },
    });
  }

  loadForm(data) {
    const s = data.settings ?? {};
    for (const n of NUMBERS) this.form.inputs[n.key].set_value(String(s[n.key] ?? ""));
    for (const tg of TOGGLES) this.form.toggles[tg.key] = !!s[tg.key];
    this.form.loaded = true;
    this.form.dirty = false;
  }

  saveForm(cx) {
    const path = this.path("settings");
    if (!path) return;
    const vals = {};
    for (const n of NUMBERS) {
      const raw = this.form.inputs[n.key].value().replace(/[_,\s]/g, "");
      const v = Number(raw.replace(/k$/i, "")) * (/k$/i.test(raw) ? 1000 : 1);
      if (!raw || !Number.isFinite(v) || v < 0) {
        this.form.error = `${n.label}: enter a number`;
        return;
      }
      vals[n.key] = Math.round(v);
    }
    for (const tg of TOGGLES) vals[tg.key] = !!this.form.toggles[tg.key];
    this.form.error = null;
    this.form.saving = true;
    cx.spawn(async cx => {
      try {
        const cur = await readTextFile(path);
        let base = {};
        try {
          base = cur ? JSON.parse(cur) : {};
        } catch {
          base = {};
        }
        await writeTextFile(path, JSON.stringify({ ...base, ...vals }, null, 1), cur);
        this.form.dirty = false;
        this.form.savedAt = Date.now();
        this.app.refresh(cx);
      } catch (e) {
        this.form.error = `Couldn't save: ${e?.message ?? e}`;
      }
      this.form.saving = false;
      cx.notify();
    });
  }

  select(id, cx) {
    this.sel = id;
    this.ensure(id, cx);
    cx.notify();
  }

  onKey(e, cx) {
    const cur = this.docs[this.sel];
    if (e.key === "e" && cur && !this.editing(cur)) {
      this.setMode(cur, "edit", cx);
      return true;
    }
    if (e.key === "escape" && cur && this.editing(cur)) {
      this.setMode(cur, "preview", cx);
      return true;
    }
    if (e.key === "j" || e.key === "down" || e.key === "k" || e.key === "up") {
      const i = DOCS.findIndex(d => d.id === this.sel);
      const next = DOCS[(i + (e.key === "j" || e.key === "down" ? 1 : DOCS.length - 1)) % DOCS.length];
      this.select(next.id, cx);
      return true;
    }
    return false;
  }

  // ---- drawing

  render(t, cx) {
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.list(t))
      .child(this.sel === "autopilot" ? this.autopilot(t) : this.editor(t, this.docs[this.sel]));
  }

  list(t) {
    return v_flex()
      .flex_none()
      .w(250)
      .p(10)
      .gap(3)
      .border_r(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(div().px(6).pb(6).child(label(t, "Prompts")))
      .children(
        DOCS.map(d => {
          const on = d.id === this.sel;
          const doc = this.docs[d.id];
          const dirty = d.form ? this.form.dirty : doc && this.dirty(doc);
          return h_flex()
            .id(`doc-${d.id}`)
            .px(8)
            .py(7)
            .gap(9)
            .items_start()
            .rounded(8)
            .cursor_pointer()
            .when(on, el => el.bg(tint(t).on))
            .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
            .on_click((_e, cx) => this.select(d.id, cx))
            .child(div().pt(1).child(icon(d.icon, 14, on ? t.accent : t.muted)))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(2)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).truncate().child(d.title))
                    .when(!!dirty, el => el.child(dot(tone(t).warn, 6))),
                )
                .child(div().text_size(10.5).text_color(t.muted).truncate().child(d.applies)),
            );
        }),
      );
  }

  /** Preview (rendered markdown) or edit. A doc opens as a preview; Edit, `e` or a
   *  double-click switches to the editor; Done goes back, keeping unsaved edits. */
  editing(doc) {
    return doc.mode === "edit";
  }

  setMode(doc, mode, cx) {
    const d = doc.def;
    if (mode === "edit" && d.readonly && !doc.editing) {
      doc.edit.set_value(doc.st.value());
      doc.editing = true;
    }
    doc.mode = mode;
    cx.notify();
  }

  editor(t, doc) {
    if (!doc) return div();
    const d = doc.def;
    const path = this.path(d.id);
    const dirty = this.dirty(doc);
    const st = this.active(doc);
    const edit = this.editing(doc);
    const canSave = !d.readonly || doc.editing;
    const actions = edit
      ? [
          btn(t, `done-${d.id}`, "Done", cx => this.setMode(doc, "preview", cx), { kind: "ghost", size: "sm", icon: "eye", tooltip: "Back to the preview (unsaved edits stay)" }),
          ...(canSave
            ? [
                btn(t, `revert-${d.id}`, "Revert", cx => this.revert(doc, cx), { kind: "ghost", size: "sm", icon: "undo", disabled: !dirty }),
                btn(t, `save-${d.id}`, doc.saving ? "Saving…" : "Save", cx => this.save(doc, cx), {
                  kind: "primary",
                  size: "sm",
                  icon: "save",
                  disabled: !dirty || doc.saving || doc.stale,
                }),
              ]
            : []),
        ]
      : [
          ...(dirty && canSave
            ? [btn(t, `save-${d.id}`, doc.saving ? "Saving…" : "Save", cx => this.save(doc, cx), { kind: "primary", size: "sm", icon: "save", disabled: doc.saving || doc.stale })]
            : []),
          btn(t, `edit-${d.id}`, d.readonly ? "Edit anyway" : "Edit", cx => this.setMode(doc, "edit", cx), { size: "sm", icon: "square-pen", kbd: "E" }),
        ];
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        v_flex()
          .px(SP.xl)
          .pt(SP.lg)
          .pb(SP.md)
          .gap(SP.xs)
          .border_b(1)
          .border_color(alpha(t.border, 0.8))
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .child(div().text_size(TYPE.title).font_semibold().child(d.title))
              .child(chip(t, d.applies, d.id === "master" ? tone(t).warn : t.accent))
              .when(dirty, el => el.child(chip(t, "Unsaved", tone(t).warn)))
              .when(!dirty && !!doc.savedAt && Date.now() - doc.savedAt < 8000, el => el.child(chip(t, "Saved", ok(t))))
              .child(div().flex_1())
              .children(actions),
          )
          .child(
            h_flex()
              .gap(SP.sm)
              .items_center()
              .min_w(0)
              .child(div().flex_none().text_size(TYPE.ui).text_color(t.muted).child(d.note))
              .child(
                div()
                  .id(`path-${d.id}`)
                  .min_w(0)
                  .truncate()
                  .text_size(TYPE.meta)
                  .font_family(mono())
                  .text_color(t.muted)
                  .tooltip(path ?? "")
                  .child(tildify(path, home()) || ""),
              ),
          ),
      )
      .when(doc.stale, el =>
        el.child(
          banner(t, {
            tone: tone(t).warn,
            text: "This file changed on disk since you opened it.",
            action: btn(t, `reload-${d.id}`, "Reload (drop my edits)", cx => this.reload(doc, cx), { size: "sm" }),
          }),
        ),
      )
      .when(!!doc.tellPending && d.id === "master", el =>
        el.child(
          banner(t, {
            icon: "send",
            text: this.app.data?.master?.terminal
              ? `Saved. The running master (${this.app.data.master.terminal}) still has the old prompt.`
              : "Saved. It applies when the master next starts.",
            action: this.app.data?.master?.terminal
              ? btn(t, "tell-master", this.app.isBusy("tell-master") ? "Telling…" : "Tell the master", cx => this.tellMaster(doc, cx), {
                  kind: "primary",
                  size: "sm",
                  icon: "send",
                  disabled: this.app.isBusy("tell-master"),
                })
              : null,
          }),
        ),
      )
      .when(!!doc.error, el => el.child(banner(t, { tone: t.blocked, icon: "x", text: doc.error })))
      .child(
        !doc.loaded
          ? loading(t, path ? "Reading…" : "Waiting for HQ's first snapshot…")
          : edit
            ? div()
                .flex_1()
                .min_h(0)
                .m(SP.md)
                .rounded(10)
                .overflow_hidden()
                .border(1)
                .border_color(this.focus === d.id ? t.accent : t.border)
                .bg(t.background)
                .child(CodeView.new(st).size_full())
            : v_flex()
                .id(`preview-${d.id}`)
                .flex_1()
                .min_h(0)
                .on_click((e, cx) => {
                  if (e.click_count > 1) this.setMode(doc, "edit", cx);
                })
                .child(
                  scrollY(
                    `preview-scroll-${d.id}`,
                    v_flex()
                      .px(SP.xl)
                      .py(SP.lg)
                      .child(
                        (st.value() ?? "").trim()
                          ? mdBlock(t, `md-${d.id}`, st.value(), { maxW: 680 })
                          : div().text_size(TYPE.ui).text_color(t.muted).child("Empty. Press E to write it."),
                      ),
                  ),
                ),
      );
  }

  autopilot(t) {
    const f = this.form;
    const body = v_flex()
      .p(16)
      .gap(18)
      .max_w(640)
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(14).font_semibold().child("Autopilot"))
              .child(chip(t, "Within a minute", t.accent))
              .when(f.dirty, el => el.child(chip(t, "Unsaved", tone(t).warn)))
              .when(!f.dirty && !!f.savedAt && Date.now() - f.savedAt < 8000, el => el.child(chip(t, "Saved", ok(t))))
              .child(div().flex_1())
              .child(
                btn(t, "autopilot-revert", "Revert", cx => {
                  if (this.app.data) this.loadForm(this.app.data);
                  cx.notify();
                }, { kind: "ghost", size: "sm", icon: "undo", disabled: !f.dirty }),
              )
              .child(
                btn(t, "autopilot-save", f.saving ? "Saving…" : "Save", cx => this.saveForm(cx), {
                  kind: "primary",
                  size: "sm",
                  icon: "save",
                  disabled: !f.dirty || f.saving,
                }),
              ),
          )
          .child(div().text_size(11).font_family(mono()).text_color(t.muted).child(tildify(this.path("settings"), home()) || "—"))
          .child(
            div()
              .text_size(11.5)
              .text_color(t.muted)
              .child("Chores HQ does by itself while it's open, once a minute. They remove typing, never a decision."),
          ),
      )
      .when(!!f.error, el => el.child(banner(t, { tone: t.blocked, icon: "x", text: f.error }).mx(0).mt(0)))
      .child(
        v_flex()
          .gap(12)
          .children(
            TOGGLES.map(tg =>
              this.toggleRow(t, `tg-${tg.key}`, !!f.toggles[tg.key], (v, cx) => {
                f.toggles[tg.key] = v;
                f.dirty = true;
                cx.notify();
              }, tg.label, tg.hint),
            ),
          ),
      )
      .child(
        v_flex()
          .gap(12)
          .children(
            NUMBERS.map(n =>
              h_flex()
                .gap(14)
                .items_start()
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(2)
                    .child(div().text_size(12.5).text_color(t.foreground).child(n.label))
                    .child(div().text_size(11).text_color(t.muted).child(n.hint)),
                )
                .child(
                  h_flex()
                    .flex_none()
                    .gap(6)
                    .items_center()
                    .child(div().w(110).child(frame(t, Input.new(f.inputs[n.key]), this.focus === `num:${n.key}`, { mono: true })))
                    .child(div().w(50).text_size(11).text_color(t.muted).child(n.unit)),
                ),
            ),
          ),
      );
    return v_flex().flex_1().min_w(0).min_h(0).child(scrollY("autopilot-scroll", v_flex().child(body)));
  }

  toggleRow(t, id, on, onChange, text, hint) {
    return h_flex()
      .id(id)
      .gap(12)
      .items_start()
      .cursor_pointer()
      .on_click((_e, cx) => onChange(!on, cx))
      .child(
        div()
          .flex_none()
          .mt(1)
          .w(32)
          .h(18)
          .rounded_full()
          .bg(on ? t.accent : alpha(t.foreground, 0.15))
          .relative()
          .child(
            div()
              .absolute()
              .top(2)
              .left(on ? 16 : 2)
              .transition("left", { duration: 140, easing: "ease-out" })
              .w(14)
              .h(14)
              .rounded_full()
              .bg("#ffffff")
              .shadow_sm(),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .gap(2)
          .min_w(0)
          .child(div().text_size(12.5).text_color(t.foreground).child(text))
          .child(div().text_size(11).text_color(t.muted).child(hint)),
      );
  }
}
