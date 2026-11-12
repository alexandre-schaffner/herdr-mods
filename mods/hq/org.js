// Org: the master, the managers it oversees (one merge queue, one per area of focus) and each
// one's team (its subagents, workflow runs and unit sessions). Select one to see what it's
// doing, its handoff, and to edit its charter and team, or launch, compact, respawn, retire it.

import { Editor, EditorState, h_flex, Input, InputState, Textarea, TextareaState, TextView, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec, home, readTextFile, settings, writeTextFile } from "herdr";

import { agentMark, ago, alpha, banner, btn, chip, clip, ctxLimits, drawer, empty, facts, frame, icon, inTime, lines, linkBtn, loading, mdBlock, meter, mono, pageHeader, pane, plain, row, scrollY, section, sectionHead, segmented, shortModel, SP, statusBadge, statusGlyph, tildify, timeAgo, tint, TYPE } from "./ui.js";

const FIELDS = [
  { key: "name", label: "Name", placeholder: "Hooks" },
  { key: "area", label: "Area of focus", placeholder: "What this manager owns, in one sentence", multiline: true },
  { key: "base", label: "Base branch", placeholder: "main" },
  { key: "model", label: "Model", placeholder: "opus (empty: the default)" },
  { key: "group", label: "Spaces group", placeholder: "epic name in the spaces sidebar" },
];

export class OrgView {
  constructor(app) {
    this.app = app;
    this.sel = null; // null (just the roster) | "master" | manager id | "new" | "discover"
    this.showRetired = false;
    this.focusKey = null;
    this.f = {};
    for (const d of [...FIELDS, { key: "id" }]) {
      if (d.multiline) {
        const st = TextareaState.new({ placeholder: d.placeholder ?? "", rows: 1 });
        st.set_auto_grow(1, 5);
        this.wire(d.key, st);
        this.f[d.key] = st;
        continue;
      }
      const st = InputState.new({ placeholder: d.placeholder ?? "lowercase-id" });
      this.wire(d.key, st);
      this.f[d.key] = st;
    }
    this.roster = TextareaState.new({ placeholder: "4 × implementer (sonnet, high): builds and compiles only", rows: 4 });
    this.roster.set_auto_grow(3, 10);
    this.wire("roster", this.roster);
    this.charter = EditorState.new({ language: "markdown", value: "", soft_wrap: true, line_numbers: false, font_family: settings()?.font_family || "JetBrains Mono", font_size: 12.5 });
    this.wire("charter", this.charter);
    this.kind = "area";
    this.confirm = null; // "respawn" | "retire" while armed
    this.candidates = null;
    this.adoptIds = {};
    this.expanded = new Set();
  }

  wire(key, st) {
    st.on("focus", (_e, cx) => {
      this.focusKey = key;
      cx.notify();
    });
    st.on("blur", (_e, cx) => {
      if (this.focusKey === key) this.focusKey = null;
      cx.notify();
    });
    st.on("change", (_e, cx) => {
      this.dirty = true;
      cx.notify();
    });
  }

  typing() {
    return this.focusKey != null;
  }

  managers() {
    return this.app.data?.managers ?? [];
  }

  onShow(cx, arg) {
    if (arg?.create) this.select("new", cx);
    else if (arg?.discover) this.select("discover", cx);
    else if (arg?.id) this.select(arg.id, cx);
  }

  /** Selecting fills the form states (handlers only: states can't be touched in render). */
  select(id, cx) {
    this.editCharter = false;
    if (id !== this.sel) this.tab = "overview";
    this.sel = id;
    this.confirm = null;
    this.dirty = false;
    this.error = null;
    const m = this.managers().find(x => x.id === id);
    if (id === "new") {
      for (const d of FIELDS) this.f[d.key].set_value("");
      this.f.id.set_value("");
      this.kind = this.managers().some(x => x.kind === "merge-queue" && x.status !== "retired") ? "area" : "merge-queue";
      this.roster.set_value(rosterText(DEFAULT_ROSTER));
      this.charter.set_value("");
    } else if (m) {
      for (const d of FIELDS) this.f[d.key].set_value(m[d.key] ?? "");
      this.kind = m.kind;
      this.roster.set_value(rosterText(m.roster ?? []));
      this.charter.set_value("");
      cx.spawn(async cx => {
        const text = await readTextFile(m.charterPath).catch(() => null);
        if (this.sel === id && !this.dirty) {
          this.charter.set_value(text ?? "");
          this.charterLoaded = text;
        }
        cx.notify();
      });
    } else if (id === "discover") {
      this.candidates = null;
      cx.spawn(async cx => {
        try {
          this.candidates = (await this.app.hq(["discover"])).candidates;
          for (const c of this.candidates) this.adoptIds[c.terminal] ??= c.suggestedId;
        } catch (e) {
          this.error = String(e?.message ?? e);
          this.candidates = [];
        }
        cx.notify();
      });
    }
    this.dirty = false;
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "escape" && this.sel) {
      this.sel = null;
      cx.notify();
      return true;
    }
    const ids = ["master", ...this.managers().filter(m => m.status !== "retired").map(m => m.id)];
    const i = ids.indexOf(this.sel);
    if (e.key === "j" || e.key === "down") return ids[i + 1] && this.select(ids[i + 1], cx), true;
    if (e.key === "k" || e.key === "up") return i > 0 && this.select(ids[i - 1], cx), true;
    const m = this.managers().find(x => x.id === this.sel);
    const term = this.sel === "master" ? this.app.data.master.terminal : m?.terminal;
    if (e.key === "enter" || e.key === "o") return this.app.focusTerminal(term), true;
    if (e.key === "p") return this.app.peek(term), true;
    return false;
  }

  // ---- actions

  async saveManager(cx, launch) {
    const isNew = this.sel === "new";
    const id = isNew ? this.f.id.value().trim() : this.sel;
    const body = { id, kind: this.kind, roster: parseRoster(this.roster.value()), charter: this.charter.value() };
    for (const d of FIELDS) body[d.key] = this.f[d.key].value().trim();
    const dir = `${appHome()}/data/hq/tmp`;
    await exec("mkdir", ["-p", dir]);
    const file = `${dir}/manager-${Date.now().toString(36)}.json`;
    await writeTextFile(file, JSON.stringify(body), null);
    this.app.act(cx, `save-${id}`, ["manager-save", file], {
      done: isNew ? `Added ${id}` : `Saved ${id}`,
      fail: "Couldn't save the manager",
      then: (_r, cx) => {
        this.dirty = false;
        exec("rm", ["-f", file]);
        if (isNew) this.sel = id;
        if (launch) this.app.act(cx, `launch-${id}`, ["manager-launch", id], { done: `Launched ${id}`, fail: "Couldn't launch" });
        cx.notify();
      },
      catch: () => exec("rm", ["-f", file]),
    });
  }

  armed(cx, what, fn) {
    if (this.confirm === what) {
      this.confirm = null;
      fn();
    } else {
      this.confirm = what;
    }
    cx.notify();
  }

  // ---- drawing

  /** The formal view: the roster as a table, full width; a row opens its page in a drawer. */
  render(t, cx) {
    const open = !!this.sel;
    const wide = this.sel === "new" || this.sel === "discover";
    return row()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.rosterTable(t))
      .when(!!open, el =>
        el.child(
          drawer(t, {
            id: "org-drawer",
            title: this.sel === "new" ? "New manager" : this.sel === "discover" ? "Adopt sessions" : "Manager",
            width: wide ? 680 : 600,
            onClose: cx => ((this.sel = null), cx.notify()),
            body: this.detail(t),
          }),
        ),
      );
  }

  // ---- the roster table

  rosterTable(t) {
    const d = this.app.data;
    const ms = this.managers();
    const mq = ms.filter(m => m.kind === "merge-queue" && m.status !== "retired");
    const areas = ms.filter(m => m.kind !== "merge-queue" && m.status !== "retired");
    const retired = ms.filter(m => m.status === "retired");
    const live = [...mq, ...areas];
    const count = st => live.filter(m => (m.live ? m.status : "gone") === st).length;
    const narrow = !!this.sel;
    const cols = narrow
      ? [["Status", 88], ["Manager", 0], ["Context", 72]]
      : [["Status", 116], ["Manager", 0], ["Now", 0], ["Team", 64], ["Context", 112], ["Session", 128], ["", 104]];
    const header = row()
      .flex_none()
      .h(32)
      .px(SP.xl)
      .gap(SP.md)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.7))
      .children(
        cols.map(([name, w]) =>
          div()
            .when(!!w, el => el.w(w).flex_none())
            .when(!w, el => el.flex_1().min_w(0))
            .when(narrow && name === "Context", el => el.text_right())
            .text_size(TYPE.meta)
            .font_semibold()
            .text_color(t.muted)
            .child(name),
        ),
      );
    const group = (title, items, o = {}) =>
      v_flex()
        .child(div().px(SP.xl).pt(SP.lg).pb(6).child(sectionHead(t, { id: `org-group-${title}`, level: "group", title, count: items.length, open: o.open, onToggle: o.toggle })))
        .when(o.open !== false, el => el.children(items));
    const m = d.master;
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        row()
          .flex_none()
          .flex_wrap()
          .px(SP.xl)
          .py(SP.md)
          .gap(SP.md)
          .items_center()
          .border_b(1)
          .border_color(alpha(t.border, 0.6))
          .child(
            v_flex()
              .flex_1()
              .min_w(260)
              .gap(2)
              .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("Org"))
              .child(
                div()
                  .text_size(TYPE.meta)
                  .text_color(t.muted)
                  .child(
                    `${live.length} manager${live.length === 1 ? "" : "s"} · ${count("working")} working · ${count("blocked")} need you · ${count("idle") + count("done")} idle${count("gone") ? ` · ${count("gone")} gone` : ""}`,
                  ),
              ),
          )
          .child(
            h_flex()
              .min_w(0)
              .flex_wrap()
              .gap(SP.sm)
              .items_center()
              .child(btn(t, "org-policy", "Approval policy", cx => this.app.go("prompts", cx, { id: "policy" }), { kind: "ghost", size: "sm" }))
              .child(btn(t, "org-template", "Brief template", cx => this.app.go("prompts", cx, { id: "base" }), { kind: "ghost", size: "sm" }))
              .child(btn(t, "org-adopt", "Adopt sessions", cx => this.select("discover", cx), { size: "sm", icon: "search" }))
              .child(btn(t, "org-new", "New manager", cx => this.select("new", cx), { kind: "primary", size: "sm", icon: "plus" })),
          ),
      )
      .child(header)
      .child(
        scrollY(
          "org-roster",
          v_flex()
            .pb(SP.xl)
            .child(
              group("Master", [
                this.rosterRow(t, cols, {
                  id: "master",
                  name: "Master",
                  lead: agentMark(t, { kind: "master" }),
                  area: "Coordinates the org, runs the merge queue's batches past you",
                  status: m.terminal ? m.status : "gone",
                  facts: m.facts,
                  team: (m.team ?? []).filter(x => !x.finished).length,
                  ctx: m.facts?.context,
                  lim: ctxLimits(d.settings, "master"),
                  terminal: m.terminal,
                }),
              ]),
            )
            .child(group("Merge queue", mq.length ? mq.map(x => this.managerRow(t, cols, x)) : [this.emptyRow(t, "No merge-queue manager yet", "Set one up", cx => this.select("new", cx))]))
            .child(group("Areas of focus", areas.length ? areas.map(x => this.managerRow(t, cols, x)) : [this.emptyRow(t, "No area managers yet", "Add one", cx => this.select("new", cx))]))
            .when(retired.length > 0, el =>
              el.child(
                group("Retired", retired.map(x => this.managerRow(t, cols, x)), {
                  open: this.showRetired,
                  toggle: cx => {
                    this.showRetired = !this.showRetired;
                    cx.notify();
                  },
                }),
              ),
            ),
        ),
      );
  }

  managerRow(t, cols, x) {
    const d = this.app.data;
    return this.rosterRow(t, cols, {
      id: x.id,
      name: x.name || x.id,
      lead: agentMark(t, { kind: x.kind }),
      area: x.area,
      status: x.status === "retired" ? "retired" : x.live ? x.status : "gone",
      facts: x.facts,
      team: (x.team ?? []).filter(u => !u.finished).length,
      ctx: x.facts?.context,
      lim: ctxLimits(d.settings, "manager"),
      terminal: x.terminal,
      manager: x,
    });
  }

  rosterRow(t, cols, r) {
    const d = this.app.data;
    const f = r.facts ?? {};
    const now = plain(r.status === "working" ? f.doing || f.said : f.said || f.doing) || "";
    const on = this.sel === r.id;
    const cell = (w, content) => div().when(!!w, el => el.w(w).flex_none()).when(!w, el => el.flex_1().min_w(0)).child(content);
    const narrow = cols.length < 5;
    const m = r.manager;
    return row()
      .id(`org-row-${r.id}`)
      .px(SP.xl)
      .py(10)
      .gap(SP.md)
      .items_start()
      .border_b(1)
      .border_color(alpha(t.border, 0.4))
      .cursor_pointer()
      .when(on, el => el.bg(tint(t).on))
      .when(!on, el => el.hover(s => s.bg(tint(t).hover)))
      .on_click((_e, cx) => (this.sel === r.id ? ((this.sel = null), cx.notify()) : this.select(r.id, cx)))
      .child(cell(cols[0][1], div().pt(2).child(statusBadge(t, r.status, { still: this.app.palette?.open }))))
      .child(
        cell(
          0,
          v_flex()
            .gap(2)
            .child(
              h_flex()
                .min_w(0)
                .gap(6)
                .items_center()
                .when(!!r.lead, el => el.child(r.lead))
                .child(div().flex_none().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(r.name))
                .when(r.id !== "master", el => el.child(div().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).child(r.id)))
                .when(narrow, el => el.child(div().flex_1()).child(div().flex_none().child(meter(t, r.ctx, r.lim, { w: 40 })))),
            )
            .when(!!r.area && narrow, el => el.child(lines(r.area, TYPE.ui, 2, 34, 1.4).text_color(t.muted)))
            .when(!!r.area && !narrow, el => el.child(div().text_size(TYPE.ui).line_height(1.4).text_color(t.muted).child(clip(r.area, 140)))),
        ),
      )
      .when(!narrow, el =>
        el
          .child(cell(0, div().pt(1).text_size(TYPE.ui).line_height(1.4).text_color(t.foreground).child(clip(now, 150) || "—")))
          .child(cell(64, div().pt(1).text_size(TYPE.ui).text_color(r.team ? t.foreground : t.muted).child(r.team ? String(r.team) : "—"))),
      )
      .when(!narrow, el => el.child(cell(112, div().pt(4).child(meter(t, r.ctx, r.lim, { w: 56 })))))
      .when(!narrow, el =>
        el
          .child(
            cell(
              128,
              v_flex()
                .gap(1)
                .child(div().text_size(TYPE.ui).font_family(mono()).text_color(t.foreground).child(r.terminal ?? "—"))
                .child(timeAgo(t, f.lastAt, d.now, { verb: "active" })),
            ),
          )
          .child(
            cell(
              104,
              h_flex()
                .gap(4)
                .justify_end()
                .when(!!r.terminal && r.status !== "retired", e2 =>
                  e2
                    .child(btn(t, `org-chat-${r.id}`, null, cx => this.app.chatWith(r.terminal, cx), { size: "sm", icon: "send", tooltip: "Chat" }))
                    .child(btn(t, `org-go-${r.id}`, null, () => this.app.focusTerminal(r.terminal), { size: "sm", kind: "ghost", icon: "terminal", tooltip: "Go to its terminal" })),
                )
                .when(!!m && !m.live && m.status !== "retired", e2 =>
                  e2.child(btn(t, `org-launch-${r.id}`, "Launch", cx => this.app.act(cx, `launch-${m.id}`, ["manager-launch", m.id], { done: `Launched ${m.id}`, fail: "Couldn't launch" }), { size: "sm", kind: "primary", icon: "play" })),
                ),
            ),
          ),
      );
  }

  emptyRow(t, text, action, onClick) {
    return row()
      .px(SP.xl)
      .py(10)
      .gap(SP.md)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.4))
      .child(div().flex_1().text_size(TYPE.ui).text_color(t.muted).child(text))
      .child(btn(t, `org-empty-${action}`, action, cx => onClick(cx), { size: "sm", kind: "ghost", icon: "plus" }));
  }

  detail(t) {
    if (this.sel === "new") return this.form(t);
    if (this.sel === "discover") return this.discover(t);
    if (this.sel === "master") return this.masterDetail(t);
    const m = this.managers().find(x => x.id === this.sel);
    return m ? this.managerDetail(t, m) : empty(t, "Pick a manager", null, { icon: "layers" });
  }

  // ---- shared detail blocks

  /** What it's doing this minute: the tool it's running, and what it last said, in prose. */
  nowBlock(t, f, now, status) {
    const doing = status === "working" ? plain(f.doing ?? "") : "";
    const said = plain(f.said ?? "");
    return section(
      t,
      "Now",
      v_flex()
        .gap(SP.sm)
        .when(!!doing, el =>
          el.child(
            row()
              .gap(SP.sm)
              .items_start()
              .child(div().pt(3).child(statusGlyph("working", t, 12, { still: this.app.palette?.open })))
              .child(div().flex_1().min_w(0).text_size(TYPE.body).font_medium().line_height(1.45).text_color(t.foreground).child(doing)),
          ),
        )
        .when(!!said, el => el.child(div().text_size(TYPE.body).line_height(1.55).text_color(doing ? t.muted : t.foreground).child(clip(said, 600))))
        .when(!doing && !said, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child("No transcript found for this session."))),
      { hint: f.lastAt ? `last activity ${ago(f.lastAt, now)}` : null },
    );
  }

  ctxValue(t, value, lim, note) {
    return h_flex()
      .gap(SP.sm)
      .items_center()
      .flex_wrap()
      .child(meter(t, value, lim, { w: 96 }))
      .when(!!note, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(note)));
  }

  teamSection(t, team, empty_) {
    const live = (team ?? []).filter(x => !x.finished);
    const done = (team ?? []).filter(x => x.finished);
    const showDone = this.expanded.has(`done-${this.sel}`);
    return section(
      t,
      "Team",
      v_flex()
        .gap(2)
        .children(live.map(x => this.teamRow(t, x)))
        .when(live.length === 0, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child(empty_ ?? "Nobody is working for it right now.")))
        .when(done.length > 0, el =>
          el
            .child(
              div()
                .pt(SP.sm)
                .child(
                  linkBtn(
                    t,
                    `org-done-${this.sel}`,
                    `${done.length} finished in the last day`,
                    cx => {
                      showDone ? this.expanded.delete(`done-${this.sel}`) : this.expanded.add(`done-${this.sel}`);
                      cx.notify();
                    },
                    { chevron: showDone },
                  ),
                ),
            )
            .when(showDone, el => el.children(done.slice(0, 12).map(x => this.teamRow(t, x)))),
        ),
      { hint: live.length ? `${live.length} working` : null },
    );
  }

  teamRow(t, x) {
    const unit = x.kind === "unit";
    const status = unit ? x.status : x.finished ? "idle" : "working";
    const ic = unit ? "terminal" : x.kind === "workflow" ? "flow" : "user";
    const what = [unit ? "unit session" : x.kind === "workflow" ? "workflow" : (x.type ?? "subagent"), x.model ? shortModel(x.model) : null].filter(Boolean).join(" · ");
    return row()
      .id(`team-${x.kind}-${x.id}`)
      .px(SP.sm)
      .py(6)
      .gap(SP.sm)
      .items_start()
      .rounded(6)
      .when(unit, el =>
        el
          .cursor_pointer()
          .hover(s => s.bg(tint(t).hover))
          .tooltip(`${x.terminal}: click to peek, double-click to go there`)
          .on_click((e, _cx) => (e.click_count > 1 ? this.app.focusTerminal(x.terminal) : this.app.peek(x.terminal))),
      )
      .child(div().pt(3).child(statusGlyph(status, t, 11, { still: this.app.palette?.open })))
      .child(icon(ic, 12, t.muted))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().text_size(TYPE.ui).line_height(1.4).text_color(x.finished ? t.muted : t.foreground).child(clip(x.description ?? x.id, 140)))
          .child(div().text_size(TYPE.meta).text_color(t.muted).child(what)),
      )
      .child(unit ? div().flex_none().pt(1).text_size(TYPE.meta).text_color(t.muted).child(x.terminal ?? "") : timeAgo(t, x.lastAt, this.app.data.now).pt(1));
  }

  /** "Overview | Charter and team" inside a manager page: reading first, editing one click away. */
  tabs(t) {
    const opts = [
      { id: "overview", label: "Overview" },
      { id: "edit", label: `Charter and team${this.dirty ? " •" : ""}` },
    ];
    return segmented(t, "org-tab", opts, this.tab ?? "overview", (id, cx) => {
      this.tab = id;
      cx.notify();
    });
  }

  // ---- the master

  masterDetail(t) {
    const d = this.app.data;
    const m = d.master;
    const f = m.facts ?? {};
    const loop = m.loop ?? {};
    const loopOn = ["running", "waiting", "overdue"].includes(loop.state);
    const overdue = loop.state === "overdue";
    const term = m.terminal;
    const status = term ? m.status : "gone";
    const idle = m.status === "idle" || m.status === "done";
    const lim = ctxLimits(d.settings, "master");
    return pane(
      "org-detail-master",
      v_flex()
        .gap(SP.xl)
        .child(
          pageHeader(t, {
            title: "Master",
            chips: [statusBadge(t, status, { size: 13, still: this.app.palette?.open }), chip(t, "perpetual", t.accent, { icon: "repeat" })],
            meta: `Coordinates every manager in ${d.repo.name}. It runs a tick on its own schedule and files what needs you in Review.`,
            actions: term
              ? [
                  btn(t, "m-chat", "Chat", cx => this.app.chatWith(term, cx), { icon: "send", kind: "primary" }),
                  btn(t, "m-go", "Go to terminal", () => this.app.focusTerminal(term), { icon: "terminal" }),
                  btn(t, "m-peek", "Peek", () => this.app.peek(term), { icon: "eye", kind: "ghost" }),
                ]
              : [btn(t, "m-start", "Start the master", cx => this.app.openMaster(cx), { kind: "primary", icon: "play" })],
          }),
        )
        .when(!!term, el => el.child(this.nowBlock(t, f, d.now, m.status)))
        .when(!!term, el =>
          el.child(
            section(
              t,
              "Session",
              facts(t, [
                [
                  "Loop",
                  h_flex()
                    .gap(SP.sm)
                    .items_center()
                    .flex_wrap()
                    .child(
                      div()
                        .text_size(TYPE.ui)
                        .text_color(loopOn && !overdue ? t.foreground : t.blocked)
                        .child(loopOn ? (overdue ? `Tick overdue by ${inTime(loop.wakeAt, d.now).replace(" overdue", "")}` : loop.wakeAt ? `Next tick ${inTime(loop.wakeAt, d.now)}` : "Ticking now") : loop.state === "stopped" ? "Stopped by the master" : "Not armed"),
                    )
                    .when(!loopOn || overdue, el =>
                      el.child(btn(t, "m-arm", this.app.isBusy("loop") ? "Arming…" : "Arm the loop", cx => this.app.doAction("loop-arm", "master", term, cx), { size: "sm", disabled: this.app.isBusy("loop") || !idle, tooltip: idle ? "Types /loop master tick" : "Once the master is idle" })),
                    ),
                ],
                ["Waiting for", loopOn && loop.reason ? plain(loop.reason) : null],
                [
                  "Context",
                  h_flex()
                    .gap(SP.sm)
                    .items_center()
                    .flex_wrap()
                    .child(this.ctxValue(t, f.context, lim, d.settings.autoCompactMaster ? `auto-compacts when idle above ${Math.round(d.settings.masterCompactAt / 1000)}k` : "auto-compaction off"))
                    .child(btn(t, "m-compact", "Compact now", cx => this.app.doAction("compact", "master", term, cx), { size: "sm", kind: "ghost", disabled: !idle || this.app.isBusy(`compact-${term}`), tooltip: idle ? "Types /compact" : "Only when the master is idle" })),
                ],
                ["Compacted", f.compactedAt ? ago(f.compactedAt, d.now) : null],
                ["Model", f.model ? shortModel(f.model) : null],
                ["Terminal", `${term}${m.where ? ` · ${m.where}` : ""}`],
                ["Session", m.sessionId ? m.sessionId.slice(0, 8) : null, { mono: true, tip: m.sessionId }],
              ]),
            ),
          ),
        )
        .child(this.teamSection(t, m.team, "No subagents or workflow runs of its own right now.")),
    );
  }

  // ---- a manager

  managerDetail(t, m) {
    const d = this.app.data;
    const f = m.facts ?? {};
    const term = m.terminal;
    const retired = m.status === "retired";
    const status = m.live ? m.status : retired ? "retired" : "gone";
    const idle = m.status === "idle" || m.status === "done";
    const lim = ctxLimits(d.settings, "manager");
    const busy = k => this.app.isBusy(`${k}-${m.id}`);
    const editing = (this.tab ?? "overview") === "edit";
    const actions = retired
      ? []
      : m.live
        ? [
            btn(t, "mg-chat", "Chat", cx => this.app.chatWith(term, cx), { icon: "send", kind: "primary" }),
            btn(t, "mg-go", "Go to terminal", () => this.app.focusTerminal(term), { icon: "terminal" }),
            btn(t, "mg-peek", "Peek", () => this.app.peek(term), { icon: "eye", kind: "ghost" }),
            btn(t, "mg-compact", "Compact", cx => this.app.doAction("compact", m.id, term, cx), {
              kind: "ghost",
              disabled: !idle || this.app.isBusy(`compact-${term}`),
              tooltip: idle ? "Types /compact into its session" : "Only when it's idle",
            }),
            btn(
              t,
              "mg-respawn",
              this.confirm === "respawn" ? "Confirm respawn" : "Respawn",
              cx => this.armed(cx, "respawn", () => this.app.act(cx, `respawn-${m.id}`, ["manager-respawn", m.id], { done: `Respawned ${m.id}`, fail: "Couldn't respawn" })),
              { kind: this.confirm === "respawn" ? "danger" : "ghost", disabled: busy("respawn") || !idle, tooltip: idle ? "A fresh session from its brief and handoff; the old tab closes" : "Only when it's idle" },
            ),
          ]
        : [btn(t, "mg-launch", busy("launch") ? "Launching…" : "Launch", cx => this.app.act(cx, `launch-${m.id}`, ["manager-launch", m.id], { done: `Launched ${m.id}`, fail: "Couldn't launch" }), { kind: "primary", icon: "play", disabled: busy("launch") })];
    const header = pageHeader(t, {
      title: m.name || m.id,
      chips: [statusBadge(t, status, { size: 13, still: this.app.palette?.open }), chip(t, m.kind === "merge-queue" ? "merge queue" : "area", t.accent, { icon: m.kind === "merge-queue" ? "git-branch" : "layers" })],
      meta: m.area || null,
      actions,
    });
    const overview = v_flex()
      .gap(SP.xl)
      .when(m.live, el => el.child(this.nowBlock(t, f, d.now, m.status)))
      .child(this.handoffBlock(t, m, d))
      .child(this.teamSection(t, m.team))
      .child(
        section(
          t,
          "Session",
          facts(t, [
            ["Context", m.live ? this.ctxValue(t, f.context, lim, (f.context ?? 0) > lim.warn ? "large: compact or respawn when idle" : null) : null],
            ["Model", f.model ? shortModel(f.model) : null],
            ["Terminal", term ? `${term}${m.where ? ` · ${m.where}` : ""}` : null],
            ["Worktree", m.worktree ? tildify(m.worktree, home()) : null, { mono: true }],
            ["Id", m.id, { mono: true }],
            ["Session", m.sessionId ? m.sessionId.slice(0, 8) : null, { mono: true, tip: m.sessionId }],
          ]),
        ),
      );
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        pane(
          `org-detail-${m.id}`,
          v_flex()
            .gap(SP.xl)
            .child(header)
            .when(!retired, el => el.child(h_flex().child(this.tabs(t))))
            .child(editing && !retired ? this.editSections(t, m) : overview),
        ),
      )
      .when(!retired && editing, el => el.child(this.saveBar(t, m)));
  }

  handoffBlock(t, m, d) {
    const text = m.handoff?.text ?? "";
    const open = this.expanded.has(`handoff-${m.id}`);
    const long = text.length > 1400;
    const shown = long && !open ? text.slice(0, 1400).replace(/\n[^\n]*$/, "") + "\n\n…" : text;
    return section(
      t,
      "Handoff",
      text
        ? v_flex()
            .gap(SP.sm)
            .child(div().text_size(TYPE.body).line_height(1.55).child(TextView.markdown(`handoff-${m.id}-${open ? 1 : 0}`, shown)))
            .when(long, el =>
              el.child(
                linkBtn(
                  t,
                  `handoff-more-${m.id}`,
                  open ? "Show less" : "Show the whole handoff",
                  cx => {
                    open ? this.expanded.delete(`handoff-${m.id}`) : this.expanded.add(`handoff-${m.id}`);
                    cx.notify();
                  },
                  { chevron: open },
                ),
              ),
            )
        : div().text_size(TYPE.ui).text_color(t.muted).child("Its report has no ## Handoff section yet."),
      { hint: m.handoff?.updatedAt ? `updated ${ago(m.handoff.updatedAt, d.now)}` : null },
    );
  }

  editSections(t, m) {
    const field = d =>
      v_flex()
        .gap(6)
        .child(div().text_size(TYPE.ui).text_color(t.muted).child(d.label))
        .child(
          d.multiline
            ? frame(t, Textarea.new(this.f[d.key]).w_full(), this.focusKey === d.key, { multiline: true })
            : frame(t, Input.new(this.f[d.key]).w_full(), this.focusKey === d.key),
        );
    return v_flex()
      .gap(SP.xl)
      .child(
        section(
          t,
          "Charter",
          // Read as rendered markdown; edit on demand (a new manager starts in the editor).
          !m || this.editCharter
            ? div().h(280).rounded(8).overflow_hidden().border(1).border_color(this.focusKey === "charter" ? t.accent : t.border).bg(t.background).child(Editor.new(this.charter).size_full())
            : this.charter.value().trim()
              ? div()
                  .id("charter-read")
                  .p(SP.lg)
                  .rounded(8)
                  .border(1)
                  .border_color(alpha(t.border, 0.7))
                  .cursor_pointer()
                  .tooltip("Double-click to edit")
                  .on_click((e, cx) => {
                    if (e.click_count > 1) this.startCharterEdit(cx);
                  })
                  .child(mdBlock(t, `charter-md-${m.id}`, this.charter.value()))
              : div().text_size(TYPE.ui).text_color(t.muted).child("No charter yet. It tells the manager what it owns and how."),
          {
            hint: m ? "goes into its brief at the next launch or respawn" : "what it owns and how",
            right: m
              ? btn(t, "charter-edit", this.editCharter ? "Preview" : "Edit", cx => (this.editCharter ? this.stopCharterEdit(cx) : this.startCharterEdit(cx)), {
                  size: "sm",
                  kind: "ghost",
                  icon: this.editCharter ? "eye" : "square-pen",
                })
              : null,
          },
        ),
      )
      .child(
        section(t, "Team", frame(t, Textarea.new(this.roster).w_full(), this.focusKey === "roster", { multiline: true, mono: true, size: 12 }), {
          hint: "one role per line: count × role (model, effort): notes",
        }),
      )
      .child(section(t, "Details", v_flex().gap(SP.md).children(FIELDS.map(field))));
  }

  startCharterEdit(cx) {
    this.editCharter = true;
    cx.notify();
  }

  stopCharterEdit(cx) {
    this.editCharter = false;
    cx.notify();
  }

  saveBar(t, m) {
    const busy = this.app.isBusy(`save-${m.id}`);
    return h_flex()
      .flex_none()
      .px(SP.xl)
      .py(SP.sm)
      .gap(SP.sm)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(this.dirty ? t.foreground : t.muted).child(this.dirty ? "Unsaved changes" : "Used at its next launch or respawn"))
      .child(
        btn(
          t,
          "mg-retire",
          this.confirm === "retire" ? "Confirm retire" : "Retire",
          cx => this.armed(cx, "retire", () => this.app.act(cx, `retire-${m.id}`, ["manager-retire", m.id], { done: `Retired ${m.id}` })),
          { size: "sm", kind: this.confirm === "retire" ? "danger" : "ghost", tooltip: "Takes it out of the org. Its session and its units end once they have sat idle for the time set in Prompts > Autopilot" },
        ),
      )
      .child(btn(t, "mg-save", busy ? "Saving…" : "Save changes", cx => this.saveManager(cx, false), { kind: "primary", size: "sm", disabled: busy || !this.dirty }));
  }

  // ---- new manager, adopt

  form(t) {
    const hasMq = this.managers().some(x => x.kind === "merge-queue" && x.status !== "retired");
    const id = this.f.id.value().trim();
    const valid = /^[a-z0-9][a-z0-9-]{0,40}$/.test(id) && !this.managers().some(x => x.id === id);
    const kinds = [
      { id: "area", label: "Area of focus", hint: "Owns one area end to end", ic: "layers", off: false },
      { id: "merge-queue", label: "Merge queue", hint: hasMq ? "There is already one" : "The only path to trunk", ic: "git-branch", off: hasMq },
    ];
    return v_flex()
      .flex_1()
      .min_w(0)
      .min_h(0)
      .child(
        pane(
          "org-new",
          v_flex()
            .gap(SP.xl)
            .child(
              pageHeader(t, {
                title: "New manager",
                meta: "It gets its own worktree, space and Claude session, briefed from the template plus the charter and team below.",
              }),
            )
            .child(
              row()
                .gap(SP.sm)
                .children(
                  kinds.map(k =>
                    row()
                      .id(`kind-${k.id}`)
                      .flex_1()
                      .min_w(0)
                      .p(SP.md)
                      .gap(SP.sm)
                      .items_start()
                      .rounded(8)
                      .border(1)
                      .border_color(this.kind === k.id ? t.accent : t.border)
                      .bg(this.kind === k.id ? alpha(t.accent, 0.08) : t.background)
                      .when(k.off, el => el.opacity(0.5))
                      .when(!k.off, el =>
                        el.cursor_pointer().on_click((_e, cx) => {
                          this.kind = k.id;
                          cx.notify();
                        }),
                      )
                      .child(div().pt(2).child(icon(k.ic, 14, this.kind === k.id ? t.accent : t.muted)))
                      .child(
                        v_flex()
                          .flex_1()
                          .gap(2)
                          .min_w(0)
                          .child(div().text_size(TYPE.body).font_medium().child(k.label))
                          .child(div().text_size(TYPE.meta).text_color(t.muted).child(k.hint)),
                      ),
                  ),
                ),
            )
            .child(
              v_flex()
                .gap(6)
                .child(div().text_size(TYPE.ui).text_color(t.muted).child("Id"))
                .child(frame(t, Input.new(this.f.id).w_full(), this.focusKey === "id", { mono: true }))
                .child(div().text_size(TYPE.meta).text_color(id && !valid ? t.blocked : t.muted).child(!id ? "Lowercase letters, digits and dashes. Also its worktree's name." : valid ? `Worktree: ~/.herdr/worktrees/<repo>/${id}` : "That id is taken or invalid.")),
            )
            .child(this.editSections(t, null)),
        ),
      )
      .child(
        h_flex()
          .flex_none()
          .px(SP.xl)
          .py(SP.sm)
          .gap(SP.sm)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .bg(t.surface)
          .child(div().flex_1())
          .child(btn(t, "new-save", "Save as planned", cx => this.saveManager(cx, false), { size: "sm", disabled: !valid }))
          .child(btn(t, "new-launch", "Save and launch", cx => this.saveManager(cx, true), { kind: "primary", size: "sm", icon: "play", disabled: !valid })),
      );
  }

  discover(t) {
    const c = this.candidates;
    const hasMq = this.managers().some(x => x.kind === "merge-queue" && x.status !== "retired");
    return pane(
      "org-discover",
      v_flex()
        .gap(SP.lg)
        .child(
          pageHeader(t, {
            title: "Adopt running sessions",
            meta: "Claude sessions in this repo's worktrees that aren't in the org yet. Adopting keeps the session running as it is; HQ starts tracking it as a manager.",
          }),
        )
        .when(!!this.error, el => el.child(banner(t, { tone: t.blocked, text: this.error }).mx(0).mt(0)))
        .when(c == null, el => el.child(loading(t, "Looking for sessions…")))
        .when(c != null && c.length === 0, el => el.child(empty(t, "Nothing to adopt", "Every running session in this repo's worktrees is already in the org.", { icon: "circle-check" })))
        .child(
          v_flex()
            .gap(2)
            .children(
              (c ?? []).map(x => {
                const kind = x.kind === "merge-queue" && !hasMq ? "merge-queue" : "area";
                const id = this.adoptIds[x.terminal] ?? x.suggestedId;
                return row()
                  .px(SP.md)
                  .py(SP.md)
                  .gap(SP.md)
                  .items_start()
                  .rounded(8)
                  .border_b(1)
                  .border_color(alpha(t.border, 0.6))
                  .child(div().pt(3).child(statusGlyph(x.status, t, 13, { still: this.app.palette?.open })))
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(4)
                      .child(
                        h_flex()
                          .gap(SP.sm)
                          .items_center()
                          .flex_wrap()
                          .child(div().text_size(TYPE.body).font_medium().child(x.suggestedId))
                          .when(kind === "merge-queue", el => el.child(chip(t, "merge queue", t.accent)))
                          .when(x.hasHandoff, el => el.child(chip(t, "has a handoff", t.muted))),
                      )
                      .when(!!x.goal, el => el.child(div().text_size(TYPE.ui).line_height(1.45).text_color(t.foreground).child(clip(plain(x.goal), 260))))
                      .child(div().text_size(TYPE.meta).text_color(t.muted).child(`${x.terminal} · turn ${x.turn ?? "?"} · ${tildify(x.cwd, home())}`)),
                  )
                  .child(
                    h_flex()
                      .flex_none()
                      .gap(SP.xs)
                      .child(btn(t, `peek-${x.terminal}`, "Peek", () => this.app.peek(x.terminal), { size: "sm", kind: "ghost" }))
                      .child(
                        btn(
                          t,
                          `adopt-${x.terminal}`,
                          "Adopt",
                          cx =>
                            this.app.act(cx, `adopt-${x.terminal}`, ["adopt", x.terminal, id, kind], {
                              done: `Adopted ${x.terminal} as ${id}`,
                              fail: "Couldn't adopt",
                              then: (_r, cx) => {
                                this.candidates = this.candidates.filter(y => y.terminal !== x.terminal);
                                cx.notify();
                              },
                            }),
                          { size: "sm", kind: "primary", disabled: this.app.isBusy(`adopt-${x.terminal}`) },
                        ),
                      ),
                  );
              }),
            ),
        ),
    );
  }
}

const DEFAULT_ROSTER = [
  { role: "implementer", model: "sonnet", effort: "high", count: 4, notes: "Builds and compiles only; no individual test runs." },
  { role: "advisor", model: "opus", effort: "xhigh", count: 1, notes: "Briefs the wave, runs all tests in one batch, fixes failures itself." },
  { role: "verifier", model: "opus", effort: "xhigh", count: 1, notes: "Fresh eyes on the three-dot diff; every safety claim backed by a test." },
];

function rosterText(roster) {
  return roster.map(r => `${r.count ?? 1} × ${r.role} (${[r.model, r.effort].filter(Boolean).join(", ")})${r.notes ? `: ${r.notes}` : ""}`).join("\n");
}

function parseRoster(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = l.match(/^(?:(\d+)\s*[×x*]\s*)?([^(:]+?)\s*(?:\(([^)]*)\))?\s*(?::\s*(.*))?$/);
      if (!m) return { role: l, count: 1 };
      const [model, effort] = (m[3] ?? "").split(",").map(s => s.trim());
      return { role: m[2].trim(), count: Number(m[1] ?? 1), model: model || null, effort: effort || null, notes: m[4] ?? "" };
    });
}
