// The sidebar as the person works in HQ, one list top to bottom:
//   Needs you   what waits on them: approvals and questions in HQ's inbox, agents blocked on
//               them, and how much finished work waits to be looked over. A click opens HQ.
//   Each epic   its master (with its headline), then each manager with what it's doing, its
//               live unit sessions folded under it, then the epic's parked worktrees (spaces
//               where only an idle shell is left) with a way to close them.
//   Workflows   the person's workflow runs' owner sessions.
//   Sessions    agents the person started outside the org.
//   Spaces      every other space, compact.
// Click a person to focus their terminal, a space to show it; right-click a space for its menu.
// The org comes from data/master/masters.json and data/hq/<org>/org.json (HQ writes them), what
// waits on the person from needs.py, live state from Herdr.

import { h_flex, v_flex } from "gpui-base";
import { div, svg, View } from "gpui-kit";
import { agents, appHome, exec, layout, openOverlay, panes, readTextFile, run, setAgentOrder, setShared, shared, spaces, terminals, theme } from "herdr";

const MASTER_LABEL = "herdr.master";
const WORKFLOW_LABEL = "herdr.hq.workflow";
const READ_EVERY = 5000;
const NEEDS_EVERY = 15000;
const ICON = name => `shared/icons/${name}.svg`;
const CHROME = name => `mods/workspace-chrome/${name}.svg`;

// One strong color per hue for space avatars, as every mod that draws them.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

// The sidebar's rail goes by its width: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Number.POSITIVE_INFINITY) < 160;
const slugify = s => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
const trim = p => (p ?? "").replace(/\/+$/, "");
const base = p => trim(p).split("/").pop();
const parent = p => trim(p).split("/").slice(0, -1).join("/");
const inside = (path, dir) => !!dir && (trim(path) === trim(dir) || trim(path).startsWith(`${trim(dir)}/`));
const tone = (t, status) => (status ? (t[status] ?? t.unknown) : t.dim);
// Agent titles carry a spinner or mark first ("✳ Fixing CI"): the words only.
const words = title => (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const WORD = { working: "working", blocked: "needs you", done: "done", idle: "idle" };

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// HQ is a main view in the layout's `center` stack: picking something here goes back to the workspace.
function toWorkspace() {
  if (find(layout(), "center")?.active === "hq") run("layout.select", { stack: "center", child: "workspace" });
}

/** Opens HQ, on one of its views (HQ watches "hq.goto"). */
function openHq(view) {
  if (view) setShared("hq.goto", { view, at: Date.now() });
  run("layout.select", { stack: "center", child: "hq" });
}

function focusAgent(address) {
  run("agent.focus", { terminal: address });
  toWorkspace();
}

export default class Org extends View {
  init(_props, cx) {
    this.repos = []; // [{ key, name, path, slug, master: entry, managers, headline }]
    this.needs = {}; // org folder → { asks, review }
    this.open = new Set(JSON.parse(localStorage.getItem("open") ?? "[]")); // folds the person opened
    this.confirmClose = null; // the org whose parked worktrees wait for a second click to close
    this.read(cx);
    this.readNeeds(cx);
    cx.timer.every(READ_EVERY, cx => this.read(cx));
    cx.timer.every(NEEDS_EVERY, cx => this.readNeeds(cx));
  }

  /** The org as HQ keeps it: a repository per master, its managers and the master's headline. */
  read(cx) {
    cx.spawn(async cx => {
      const home = appHome();
      const masters = parse(await readTextFile(`${home}/data/master/masters.json`)) ?? {};
      const repos = [];
      for (const [key, m] of Object.entries(masters)) {
        if (!m?.path) continue;
        const slug = slugify(m.name);
        const org = parse(await readTextFile(`${home}/data/hq/${slug}/org.json`)) ?? {};
        const status = parse(await readTextFile(`${home}/data/hq/${slug}/status.json`)) ?? {};
        repos.push({ key, name: m.name ?? base(m.path), path: m.path, slug, master: m, managers: org.managers ?? [], headline: status.text ?? "" });
      }
      const text = JSON.stringify(repos);
      if (text !== this.reposText) {
        this.reposText = text;
        this.repos = repos;
        cx.notify();
      }
    });
  }

  readNeeds(cx) {
    cx.spawn(async cx => {
      const r = await exec("python3", ["-I", `${appHome()}/mods/my-org/needs.py`]).catch(() => null);
      const got = parse(r?.stdout) ?? null;
      if (got && JSON.stringify(got) !== JSON.stringify(this.needs)) {
        this.needs = got;
        cx.notify();
      }
    });
  }

  fold(key, cx) {
    this.open.has(key) ? this.open.delete(key) : this.open.add(key);
    localStorage.setItem("open", JSON.stringify([...this.open]));
    cx.notify();
  }

  // ---- who sits where

  /** Every space given to its place: an epic (its master, managers, their live units and parked
   *  worktrees), a workflow owner, one of the person's own sessions, else the plain spaces. */
  model() {
    const sp = spaces();
    const ps = panes();
    const ags = agents();
    const terms = terminals();
    const agentAt = Object.fromEntries(ags.map(a => [a.address, a]));
    const spaceOfTab = new Map(sp.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, s])));
    const tabOf = new Map(sp.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, tab])));
    const spaceOfTerm = new Map(ps.filter(p => p.terminal).map(p => [p.terminal, spaceOfTab.get(p.tab)]));
    const panesOf = s => {
      const tabs = new Set((s.tabs ?? []).map(tab => tab.id));
      return ps.filter(p => tabs.has(p.tab));
    };
    const agentsOf = s => ags.filter(a => a.space === s.id);
    // Where a space is now: its first terminal's live folder, else where it was made.
    const placeOf = s => panesOf(s).find(p => p.cwd)?.cwd || s.folder;
    // Only an idle shell is left: no agent, and every terminal sits at its prompt.
    const parked = s => !agentsOf(s).length && panesOf(s).every(p => !p.terminal || p.program?.shell);
    const changedAt = a => tabOf.get(a?.tab)?.changed_at ?? null;
    const taken = new Set();
    const take = s => s && !taken.has(s.id) && (taken.add(s.id), true);

    const orgs = [];
    for (const r of this.repos) {
      const masterTerm = terms.find(x => x.labels?.[MASTER_LABEL] === r.key)?.address ?? null;
      const live = masterTerm && agentAt[masterTerm];
      const ms = live ? spaceOfTerm.get(masterTerm) : null;
      if (ms && inside(placeOf(ms), r.path)) take(ms);
      const master = { key: `${r.key}#master`, kind: "master", name: "Master", terminal: live ? masterTerm : null, agent: live ?? null,
                       note: r.headline, at: changedAt(live) };
      const people = [];
      const parkedHere = [];
      for (const m of r.managers) {
        const a = m.terminal ? agentAt[m.terminal] : null;
        const own = a ? spaceOfTerm.get(m.terminal) : null;
        const wt = trim(m.worktree);
        // Its worktree, and its units' sibling worktrees named after it (`hooks-seam` for `hooks`).
        const mine = s => {
          const at = placeOf(s);
          return !!wt && (inside(at, wt) || (parent(at) === parent(wt) && base(at).startsWith(`${base(wt)}-`)));
        };
        if (own) take(own);
        const units = [];
        for (const s of sp) {
          if (taken.has(s.id) || !(s.id === own?.id || mine(s))) continue;
          if (parked(s)) {
            take(s);
            parkedHere.push(s);
          } else if (agentsOf(s).length) {
            take(s);
            const ua = agentsOf(s)[0];
            units.push({ space: s, agent: ua, at: changedAt(ua) });
          }
        }
        const retired = m.status === "retired";
        if (retired && !a && !units.length) continue;
        people.push({ key: `${r.key}#${m.id}`, kind: m.kind === "merge-queue" ? "merge-queue" : "manager", name: m.name || m.id, retired,
                      terminal: a ? m.terminal : null, agent: a ?? null, note: a ? words(a.title) : retired ? "Retired" : "Its session is gone",
                      at: changedAt(a), units });
      }
      if (!master.terminal && !people.length) continue; // a repository with nobody at work
      orgs.push({ ...r, master, people, parked: parkedHere });
    }
    const owners = terms
      .filter(x => x.labels?.[WORKFLOW_LABEL] && agentAt[x.address])
      .map(x => {
        const a = agentAt[x.address];
        const s = spaceOfTerm.get(x.address);
        if (s && agentsOf(s).every(y => terms.find(z => z.address === y.address)?.labels?.[WORKFLOW_LABEL])) take(s);
        return { key: `wf#${x.address}`, kind: "workflow", name: x.labels[WORKFLOW_LABEL], terminal: x.address, agent: a, note: words(a.title), at: changedAt(a) };
      });
    const placed = new Set([...orgs.flatMap(o => [o.master.terminal, ...o.people.flatMap(p => [p.terminal, ...p.units.map(u => u.agent.address)])]), ...owners.map(o => o.terminal)]);
    const mine = ags.filter(a => !placed.has(a.address) && !taken.has(a.space));
    const shared_ = name => mine.filter(a => a.space_name === name).length > 1;
    const sessions = mine.map(a => {
      take(spaceOfTab.get(a.tab));
      // A space's name says little for sessions at home ("~") or sharing a space: lead with what
      // the session is about, and say where it is underneath.
      const vague = a.space_name === "~" || shared_(a.space_name);
      const title = words(a.title);
      return { key: `s#${a.address}`, kind: "session", name: vague && title ? title : a.space_name, terminal: a.address, agent: a,
               note: vague && title ? `${a.space_name} · tab ${a.tab_name}` : title, at: changedAt(a) };
    });
    const plain = sp.filter(s => !taken.has(s.id));
    return { orgs, owners, sessions, plain };
  }

  /** What waits on the person, as HQ counts it: open decisions (approvals and questions) in the
   *  epics shown, and the agents that talk to the person blocked on them: a master, a workflow
   *  owner, a session of their own. A blocked manager or unit is the org's to sort out (HQ raises
   *  it to the master), so it shows where it sits, not here. Work to look over isn't waiting on
   *  them either: each epic's header carries its count. */
  waiting(model) {
    const people = [...model.orgs.map(o => o.master), ...model.owners, ...model.sessions];
    const blocked = people.filter(p => p.agent?.status === "blocked");
    const asks = model.orgs.reduce((n, o) => n + (this.needs[o.slug]?.asks ?? 0), 0);
    return { blocked, asks };
  }

  // ---- drawing

  render() {
    const t = theme();
    this.paintColors();
    const model = this.model();
    const { orgs, owners, sessions } = model;
    setAgentOrder([
      ...orgs.flatMap(o => [o.master.terminal, ...o.people.flatMap(p => [p.terminal, ...p.units.map(u => u.agent.address)])]),
      ...owners.map(o => o.terminal),
      ...sessions.map(s => s.terminal),
    ].filter(Boolean));
    const collapsed = narrow();
    const body = collapsed ? this.rail(t, model) : this.list(t, model);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        v_flex()
          .id("org-scroll")
          .flex_1()
          .min_h(0)
          .px(collapsed ? 4 : 8)
          .pt(6)
          .pb(14)
          .overflow_y_scrollbar()
          .children(body),
      );
  }

  list(t, model) {
    const out = [];
    const w = this.waiting(model);
    if (w.blocked.length || w.asks) out.push(this.needsCard(t, w));
    for (const o of model.orgs) out.push(...this.epic(t, o));
    if (model.owners.length) {
      out.push(this.section(t, "Workflows", model.owners.length));
      for (const p of model.owners) out.push(this.person(t, p));
    }
    if (model.sessions.length) {
      out.push(this.section(t, "Your sessions", model.sessions.length));
      for (const p of model.sessions) out.push(this.person(t, p));
    }
    out.push(this.section(t, "Spaces", model.plain.length, this.newSpace(t)));
    out.push(this.chips(t, model.plain));
    return out;
  }

  /** On top while something waits on the person: their decisions, and who is blocked on them. */
  needsCard(t, w) {
    const n = w.asks + w.blocked.length;
    const parts = [w.asks ? `${w.asks} ${w.asks === 1 ? "decision" : "decisions"} in HQ` : null, w.blocked.length ? `${w.blocked.length} blocked on you` : null].filter(Boolean);
    return v_flex()
      .id("needs")
      .mt(2)
      .mb(6)
      .px(10)
      .py(8)
      .gap(4)
      .rounded(10)
      .cursor_pointer()
      .bg(mix(t.chrome, t.blocked, 0.14))
      .border(1)
      .border_color(mix(t.chrome, t.blocked, 0.45))
      .hover(s => s.bg(mix(t.chrome, t.blocked, 0.2)))
      .tooltip(w.asks ? "Open HQ's review" : "Go to it")
      .on_click(() => (w.asks || !w.blocked.length ? openHq("review") : focusAgent(w.blocked[0].terminal)))
      .child(
        row()
          .gap(7)
          .items_center()
          .child(svg(ICON("alert")).size(13).text_color(t.blocked))
          .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child(`Needs you · ${n}`))
          .child(svg(CHROME("chevron-right")).size(11).text_color(t.dim)),
      )
      .child(div().pl(20).text_size(11.5).text_color(t.muted).child(parts.join(" · ")))
      .children(
        w.blocked.slice(0, 4).map(p =>
          row()
            .id(`needs-${p.terminal}`)
            .ml(14)
            .h(24)
            .px(6)
            .gap(7)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover(s => s.bg(mix(t.chrome, t.blocked, 0.22)))
            .tooltip(p.note || p.name)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              focusAgent(p.terminal);
            })
            .child(svg(ICON("alert")).size(11).text_color(t.blocked))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(p.name)),
        ),
      );
  }

  /** An epic: its name and a way into its HQ, its master, its managers, its parked worktrees. */
  epic(t, o) {
    const out = [
      row()
        .id(`repo-${o.slug}`)
        .h(30)
        .mt(10)
        .pl(8)
        .pr(4)
        .gap(6)
        .items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.muted).child(o.name))
        .when((this.needs[o.slug]?.review ?? 0) > 0, el =>
          el.child(
            h_flex()
              .id(`repo-review-${o.slug}`)
              .flex_none()
              .h(22)
              .px(6)
              .gap(4)
              .rounded(6)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip(`${this.needs[o.slug].review} finished items to look over in HQ (no decision needed)`)
              .on_click(() => openHq("review"))
              .child(svg(ICON("eye")).size(11))
              .child(String(this.needs[o.slug].review)),
          ),
        )
        .child(
          h_flex()
            .id(`repo-hq-${o.slug}`)
            .flex_none()
            .h(22)
            .px(7)
            .gap(4)
            .rounded(6)
            .text_size(11)
            .text_color(t.dim)
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Open HQ (⌘⇧H)")
            .on_click(() => openHq())
            .child(svg(ICON("layers")).size(12))
            .child("HQ"),
        ),
      this.person(t, o.master),
    ];
    for (const p of o.people) {
      out.push(this.person(t, p));
      if (this.open.has(p.key)) for (const u of p.units) out.push(this.unit(t, u));
    }
    if (o.parked.length) out.push(...this.parkedRows(t, o));
    return out;
  }

  /** The master, a manager, a workflow owner or a session: state by shape and color, name, what
   *  it does, how long since it changed; a manager's live units fold under it. */
  person(t, p) {
    const status = p.agent?.status ?? null;
    const gone = !p.terminal;
    const focused = !!p.agent?.focused;
    const n = p.units?.length ?? 0;
    const stuck = (p.units ?? []).filter(u => u.agent.status === "blocked").length;
    const unfolded = this.open.has(p.key);
    const lead = p.kind === "master" ? svg(ICON("crown")).size(14).text_color(gone ? t.dim : tone(t, status)) : glyph(t, status, gone);
    return v_flex()
      .id(`who-${p.key}`)
      .px(8)
      .py(5)
      .gap(1)
      .rounded(8)
      .cursor_pointer()
      .when(focused, el => el.bg(t.selected))
      .when(!focused, el => el.hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => {
        if (p.terminal) focusAgent(p.terminal);
        else if (n) this.fold(p.key, cx);
        else openHq("org");
      })
      .child(
        row()
          .gap(8)
          .items_center()
          .child(div().w(14).flex_none().flex().items_center().justify_center().child(lead))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .font_medium()
              .text_color(gone || p.retired ? t.muted : t.foreground)
              .child(p.name),
          )
          .when(status === "blocked", el => el.child(div().flex_none().text_size(11).font_medium().text_color(t.blocked).child(WORD.blocked)))
          .when(!!status && status !== "blocked" && !!p.at, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(p.at))))
          .when(n > 0, el =>
            el.child(
              h_flex()
                .id(`fold-${p.key}`)
                .flex_none()
                .h(20)
                .px(5)
                .gap(3)
                .rounded(5)
                .text_size(11)
                .text_color(t.dim)
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .tooltip(`${unfolded ? "Hide its units" : `Show its ${n} unit${n > 1 ? "s" : ""}`}${stuck ? ` (${stuck} blocked: the manager's to sort out)` : ""}`)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.fold(p.key, cx);
                })
                .when(stuck > 0, el => el.child(svg(ICON("alert")).size(10).text_color(t.dim)))
                .child(`${n} unit${n > 1 ? "s" : ""}`)
                .child(svg(CHROME(unfolded ? "chevron-down" : "chevron-right")).size(10)),
            ),
          ),
      )
      .when(!!p.note, el => el.child(div().pl(22).truncate().text_size(11.5).text_color(t.dim).child(p.note)));
  }

  /** A manager's live unit session: its worktree, its state, what it's doing. */
  unit(t, u) {
    const s = u.space;
    const status = u.agent.status;
    return row()
      .id(`unit-${s.id}`)
      .h(26)
      .pl(30)
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(!!u.agent.focused, el => el.bg(t.selected))
      .when(!u.agent.focused, el => el.hover(x => x.bg(t.hover)))
      .tooltip(words(u.agent.title) || s.name)
      .on_click(() => focusAgent(u.agent.address))
      .on_mouse_down("right", () => spaceMenu(s))
      .child(glyph(t, status, false, 7))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(s.name))
      .when(status === "blocked", el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(WORD.blocked)))
      .when(status !== "blocked" && !!u.at, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(u.at))));
  }

  /** The epic's worktrees whose work ended: folded to one line, opened on demand, closed in one
   *  go (a second click confirms; the worktrees on disk stay). */
  parkedRows(t, o) {
    const key = `parked#${o.key}`;
    const unfolded = this.open.has(key);
    const n = o.parked.length;
    const arming = this.confirmClose === o.key;
    const head = row()
      .id(`parked-${o.slug}`)
      .h(28)
      .pl(8)
      .pr(4)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .tooltip("Worktrees whose sessions ended: only an idle shell is left in each")
      .on_click((_e, cx) => this.fold(key, cx))
      .child(div().w(14).flex_none().flex().justify_center().child(svg(ICON("archive")).size(12).text_color(t.dim)))
      .child(div().flex_1().text_size(12).text_color(t.dim).child(`${n} parked worktree${n > 1 ? "s" : ""}`))
      .child(
        div()
          .id(`parked-close-${o.slug}`)
          .flex_none()
          .h(22)
          .px(8)
          .flex()
          .items_center()
          .rounded(6)
          .text_size(11)
          .text_color(arming ? t.blocked : t.dim)
          .bg(arming ? mix(t.chrome, t.blocked, 0.15) : t.chrome)
          .hover(s => s.bg(arming ? mix(t.chrome, t.blocked, 0.25) : t.hover).text_color(arming ? t.blocked : t.foreground))
          .tooltip(arming ? "Closes these spaces and their idle shells; the worktrees on disk stay" : "Close these spaces")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (!arming) {
              this.confirmClose = o.key;
              cx.notify();
              cx.timer.after(4000, cx => {
                if (this.confirmClose === o.key) {
                  this.confirmClose = null;
                  cx.notify();
                }
              });
              return;
            }
            this.confirmClose = null;
            for (const s of o.parked) run("space.close", { id: s.id, confirmed: true });
            cx.notify();
          })
          .child(arming ? `Close ${n}?` : "Close"),
      );
    return [head, ...(unfolded ? o.parked.map(s => this.parkedSpace(t, s)) : [])];
  }

  parkedSpace(t, s) {
    return row()
      .id(`parked-space-${s.id}`)
      .h(24)
      .pl(30)
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(s.active, el => el.bg(t.selected))
      .when(!s.active, el => el.hover(x => x.bg(t.hover)))
      .on_click(() => {
        run("space.select", { id: s.id });
        toWorkspace();
      })
      .on_mouse_down("right", () => spaceMenu(s))
      .child(svg(CHROME("branch")).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(s.name));
  }

  section(t, title, n, extra) {
    return row()
      .h(26)
      .mt(12)
      .pl(8)
      .pr(4)
      .gap(6)
      .items_center()
      .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(n ? `${title} · ${n}` : title))
      .children(extra ? [extra] : []);
  }

  newSpace(t) {
    return div()
      .id("space-new")
      .size(22)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New space")
      .on_click(() => run("space.new"))
      .child(svg(CHROME("plus")).size(13));
  }

  /** The plain spaces, compact: an avatar and a name each, wrapping. */
  chips(t, list) {
    const colors = shared("space.colors") ?? {};
    return h_flex()
      .flex_wrap()
      .gap(4)
      .px(4)
      .children(
        list.map(s => {
          const c = colors[s.id] ?? "ansi6";
          const fill = c.startsWith("#") ? c : (MARK[c] ?? t[c]);
          return row()
            .id(`space-${s.id}`)
            .h(26)
            .max_w(232)
            .pl(4)
            .pr(8)
            .gap(6)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .when(s.active, el => el.bg(t.selected))
            .when(!s.active, el => el.hover(x => x.bg(t.hover)))
            .tooltip(s.branch && s.branch !== s.name ? `${s.name} · ${s.branch}` : s.name)
            .on_click(() => {
              run("space.select", { id: s.id });
              toWorkspace();
            })
            .on_mouse_down("right", () => spaceMenu(s))
            .child(
              h_flex()
                .size(16)
                .flex_none()
                .rounded(4)
                .bg(fill)
                .items_center()
                .justify_center()
                .text_size(10)
                .font_bold()
                .text_color("#ffffff")
                .child([...s.name][0]?.toUpperCase() ?? "?"),
            )
            .child(div().min_w(0).truncate().text_size(12.5).text_color(s.active ? t.foreground : t.muted).child(s.name));
        }),
      );
  }

  /** The narrow rail: what needs the person, then one mark per person. */
  rail(t, model) {
    const w = this.waiting(model);
    const mark = p => {
      const status = p.agent?.status ?? null;
      return div()
        .id(`rail-${p.key}`)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .cursor_pointer()
        .when(!!p.agent?.focused, el => el.bg(t.selected))
        .hover(s => s.bg(t.hover))
        .tooltip(`${p.name}${p.note ? ` · ${p.note}` : ""}`)
        .on_click(() => (p.terminal ? focusAgent(p.terminal) : openHq("org")))
        .child(p.kind === "master" ? svg(ICON("crown")).size(14).text_color(p.terminal ? tone(t, status) : t.dim) : glyph(t, status, !p.terminal, 9));
    };
    const n = w.asks + w.blocked.length;
    return [
      ...(n
        ? [
            div()
              .id("rail-needs")
              .h(28)
              .mb(4)
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .bg(mix(t.chrome, t.blocked, 0.16))
              .tooltip(`Needs you · ${n}`)
              .on_click(() => openHq("review"))
              .child(div().text_size(11).font_bold().text_color(t.blocked).child(String(n))),
          ]
        : []),
      ...model.orgs.flatMap(o => [o.master, ...o.people].map(mark)),
      ...model.owners.map(mark),
      ...(model.sessions.length ? [div().h(1).my(6).mx(6).bg(t.border), ...model.sessions.map(mark)] : []),
    ];
  }

  /** Stable avatar colors per space, shared with the other mods that draw spaces. */
  paintColors() {
    const sp = spaces();
    const ids = new Set(sp.map(s => s.id));
    const was = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(was).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(was).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[s.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }
}

/** A state as a shape and a color (never color alone): working spins, blocked alerts, done
 *  checks, idle is a filled dot, gone a hollow ring. */
function glyph(t, status, gone, size = 9) {
  if (gone) return div().size(size).rounded_full().border(1).border_color(t.dim);
  if (status === "working") return svg(ICON("spinner")).size(size + 3).text_color(t.working).spin(1000);
  if (status === "blocked") return svg(ICON("alert")).size(size + 3).text_color(t.blocked);
  if (status === "done") return svg(ICON("circle-check")).size(size + 3).text_color(t.done);
  return div().size(size - 1).rounded_full().bg(tone(t, status ?? "idle"));
}

function spaceMenu(s) {
  openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } });
}

/** Linear mix of two `#rrggbb` colors. */
function mix(a, b, f) {
  const p = h => [1, 3, 5].map(i => Number.parseInt(String(h).slice(i, i + 2), 16) || 0);
  const [x, y] = [p(a ?? "#000000"), p(b ?? "#ffffff")];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * f).toString(16).padStart(2, "0")).join("")}`;
}

function row() {
  return div().flex().flex_row();
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
