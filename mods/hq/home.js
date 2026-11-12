// Home: what's going on, in the master's words and in the org's live state. The strip above already
// carries the vitals (headline, loop, usage, what waits), so Home doesn't repeat them: it opens on
// the day in three signals (dash.js: merges, plan limits, the shown epic's roadmap), the master's update, then who's on what,
// and beside it what needs the person and what's next. Color only for identity and state.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { Dashboard } from "./dash.js";
import { agentHue, agentMark, ago, alpha, clip, icon, mdBlock, plain, row, scrollY, SP, statusLook, TYPE, viewHue } from "./ui.js";

const SIDE_W = 360;

export class HomeView {
  constructor(app) {
    this.app = app;
    this.w = 0;
    this.fullUpdate = false;
    this.dash = new Dashboard(app);
  }

  onKey(e, cx) {
    if (e.key === "u") return (this.fullUpdate = !this.fullUpdate), cx.notify(), true;
    return false;
  }

  render(t, cx) {
    const d = this.app.data;
    const wide = this.w === 0 || this.w > 1060;
    return v_flex()
      .id("home-root")
      .flex_1()
      .min_w(0)
      .min_h(0)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.w) < 2) return;
        this.w = size.width;
        cx.notify();
      })
      .child(
        scrollY(
          "home-scroll",
          v_flex()
            .w_full()
            .items_center()
            .px(SP.xxl)
            .pt(SP.xxl)
            .pb(48)
            .child(
              v_flex()
                .w_full()
                .max_w(1160)
                .gap(32)
                .child(this.greeting(t, d))
                .child(this.dash.render(t, d, wide))
                .child(this.update(t, d))
                .child(
                  wide
                    ? row()
                        .gap(48)
                        .items_start()
                        .child(div().flex_1().min_w(0).child(this.crew(t, d)))
                        .child(v_flex().w(SIDE_W).flex_none().gap(40).child(this.needs(t, d)).child(this.next(t, d)))
                    : v_flex().gap(40).child(this.needs(t, d)).child(this.crew(t, d)).child(this.next(t, d)),
                ),
            ),
        ),
      );
  }

  /** A section: its name in the foreground at title size, a quiet aside, a hairline, the body. */
  section(t, title, aside, body, action) {
    return v_flex()
      .gap(SP.sm)
      .child(
        row()
          .px(SP.xs)
          .pb(SP.xs)
          .gap(SP.sm)
          .items_end()
          .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(title))
          .when(!!aside, el => el.child(div().pb(1).text_size(TYPE.meta).text_color(t.muted).child(aside)))
          .child(div().flex_1())
          .when(!!action, el => el.child(action)),
      )
      .child(body);
  }

  link(t, id, text, onClick, color) {
    return div()
      .id(id)
      .pb(1)
      .text_size(TYPE.meta)
      .font_medium()
      .text_color(color ?? t.muted)
      .cursor_pointer()
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .child(text);
  }

  // ---- the greeting: who you are to HQ, and the moment in a few plain words

  greeting(t, d) {
    const hour = new Date(d.now).getHours();
    const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const c = d.counts ?? {};
    const waiting = (c.approvals ?? 0) + (c.questions ?? 0);
    const words = n => ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
    const working = c.working ?? 0;
    const mood = [
      working ? `${words(working)} agent${working === 1 ? " is" : "s are"} at work` : "everyone's resting",
      waiting ? `${words(waiting)} thing${waiting === 1 ? "" : "s"} could use you` : "nothing needs you",
    ].join(", ");
    const dt = new Date(d.now);
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const day = `${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
    return v_flex()
      .gap(6)
      .child(div().text_size(TYPE.ui).text_color(t.muted).child(day))
      .child(div().text_size(28).font_semibold().text_color(t.foreground).child(`${part}, Alex.`))
      .child(div().text_size(TYPE.body).text_color(t.muted).child(`${mood[0].toUpperCase()}${mood.slice(1)}.`));
  }

  // ---- the master's update: a note from it, its opening at reading size, the rest on demand

  update(t, d) {
    const h = d.home ?? {};
    const text = (h.text ?? "").trim();
    const paras = text.split(/\n\s*\n/);
    const lead = paras[0] ?? "";
    const rest = paras.slice(1).join("\n\n");
    const warm = viewHue(t, "home");
    return row()
      .w_full()
      .p(SP.xl)
      .gap(SP.lg)
      .items_start()
      .rounded(12)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .child(div().flex_none().pt(2).child(agentMark(t, { id: "master", kind: "master", label: "Master", avatar: true, size: 34, status: d.master.terminal ? d.master.status : "gone", still: this.app.palette?.open, ring: t.raised })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(SP.md)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_baseline()
              .child(div().text_size(TYPE.ui).font_semibold().text_color(t.foreground).child("From the master"))
              .child(div().text_size(TYPE.meta).text_color(t.muted).child(h.at ? ago(h.at, d.now) : "")),
          )
          .child(
            text
              ? div().max_w(860).text_size(17).line_height(1.5).text_color(t.foreground).child(plain(lead))
              : div().text_size(17).line_height(1.5).text_color(t.muted).child("No note yet today. The master writes one as things move."),
          )
          .when(!!rest && this.fullUpdate, el => el.child(mdBlock(t, `home-md-${h.at}`, rest, { maxW: 720, size: 14 })))
          .child(
            h_flex()
              .gap(SP.lg)
              .items_center()
              .when(!!rest, el => el.child(this.link(t, "home-more", this.fullUpdate ? "Show less" : "Read the rest", cx => ((this.fullUpdate = !this.fullUpdate), cx.notify()), warm)))
              .when(!!d.master.terminal, el => el.child(this.link(t, "home-reply", "Write back", cx => this.app.chatWith(d.master.terminal, cx), warm))),
          ),
      );
  }

  // ---- who's on what

  crew(t, d) {
    const m = d.master;
    const live = (d.managers ?? []).filter(x => x.status !== "retired");
    const order = { blocked: 0, working: 1, done: 2, idle: 3, gone: 4 };
    const rows = [
      { id: "master", name: "Master", kind: "master", status: m.terminal ? m.status : "gone", terminal: m.terminal, f: m.facts, area: "Coordinates the org" },
      ...live
        .map(x => ({ id: x.id, name: x.name || x.id, kind: x.kind === "merge-queue" ? "merge-queue" : null, status: x.live ? x.status : "gone", terminal: x.terminal, f: x.facts, area: x.area, team: (x.team ?? []).filter(u => !u.finished).length }))
        .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5)),
    ];
    const working = rows.filter(r => r.status === "working").length;
    return this.section(
      t,
      "What everyone's up to",
      `${working} of ${rows.length} at work`,
      v_flex().children(rows.map(r => this.crewRow(t, d, r))),
      this.link(t, "home-roster", "Roster", cx => this.app.go("org", cx)),
    );
  }

  crewRow(t, d, r) {
    const st = statusLook(r.status, t);
    const f = r.f ?? {};
    const doing = plain(r.status === "working" ? f.doing || f.said || "" : f.said || f.doing || "");
    const alarm = r.status === "blocked" || r.status === "gone";
    const hue = agentHue(t, r.id);
    return row()
      .id(`home-crew-${r.id}`)
      .py(10)
      .px(SP.sm)
      .gap(SP.md)
      .items_start()
      .rounded(12)
      .when(alarm, el => el.bg(alpha(t.blocked, 0.06)))
      .cursor_pointer()
      .hover(s => s.bg(alpha(hue, 0.08)))
      .tooltip([`${r.name}${r.terminal ? ` · ${r.terminal}` : ""}`, r.area, r.team ? `Team of ${r.team}` : null, "Click to chat"].filter(Boolean).join("\n"))
      .on_click((_e, cx) => (r.terminal ? this.app.chatWith(r.terminal, cx) : null))
      .child(div().flex_none().pt(1).child(agentMark(t, { id: r.id, kind: r.kind, label: r.name, avatar: true, size: 26, status: r.status, still: this.app.palette?.open })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(SP.sm)
              .items_baseline()
              .child(div().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(r.name))
              .child(div().text_size(TYPE.meta).text_color(alarm ? t.blocked : r.status === "working" ? st.color : t.muted).child(st.label.toLowerCase()))
              .child(div().flex_1())
              .when(!!f.lastAt, el => el.child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(ago(f.lastAt, d.now)))),
          )
          .child(div().text_size(TYPE.ui).line_height(1.45).text_color(doing ? alpha(t.foreground, 0.88) : t.muted).child(clip(doing, 180) || (r.status === "gone" ? "Its session has ended." : "Nothing reported yet."))),
      );
  }

  // ---- what needs the person

  needs(t, d) {
    const items = (d.inbox ?? []).filter(i => i.state === "open" && i.kind !== "done");
    const toLook = (d.inbox ?? []).filter(i => i.state === "open" && i.kind === "done").length;
    const mine = (d.todo?.items ?? []).filter(x => ["person", "you", "alex"].includes(x.owner) && ["next", "doing", "blocked"].includes(x.status));
    const line = (id, o) =>
      row()
        .id(id)
        .my(2)
        .py(10)
        .px(SP.sm)
        .gap(SP.sm)
        .items_start()
        .rounded(12)
        .bg(alpha(o.hue, 0.06))
        .cursor_pointer()
        .hover(s => s.bg(alpha(o.hue, 0.11)))
        .on_click((_e, cx) => o.go(cx))
        .child(div().flex_none().pt(2).child(icon(o.icon, 12, o.hue)))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(div().text_size(TYPE.ui).font_medium().line_height(1.4).text_color(t.foreground).child(o.title))
            .when(!!o.sub, el => el.child(div().text_size(TYPE.meta).line_height(1.4).text_color(t.muted).child(o.sub))),
        )
        .child(div().flex_none().pt(1).text_size(TYPE.meta).font_medium().text_color(o.hue).child(o.verb));
    const n = items.length + mine.length;
    return this.section(
      t,
      "For you",
      n ? String(n) : null,
      n
        ? v_flex()
            .children(
              items.map(it =>
                line(`home-need-${it.id}`, {
                  icon: it.kind === "approval" ? "alert" : "user",
                  hue: it.kind === "approval" ? t.blocked : t.accent,
                  title: it.title,
                  sub: `${it.from?.role ?? "The org"}, ${ago(it.createdAt, d.now)}`,
                  verb: it.kind === "approval" ? "Decide" : "Answer",
                  go: cx => this.app.go("review", cx, { id: it.id }),
                }),
              ),
            )
            .children(
              mine.map(x =>
                line(`home-mine-${x.id}`, {
                  icon: "arrow-right",
                  hue: t.muted,
                  title: x.title,
                  sub: x.why ? clip(plain(x.why), 110) : null,
                  verb: "Open",
                  go: cx => this.app.go("next", cx),
                }),
              ),
            )
        : div().py(10).px(SP.sm).text_size(TYPE.ui).text_color(t.muted).child("Nothing waiting. The org will ask here when it needs you."),
      toLook ? this.link(t, "home-look", `${toLook} to look over`, cx => this.app.go("review", cx)) : null,
    );
  }

  // ---- what's next

  next(t, d) {
    const rank = { doing: 0, next: 1, blocked: 2 };
    const items = (d.todo?.items ?? [])
      .filter(x => x.status in rank && !["person", "you", "alex"].includes(x.owner))
      .map((x, i) => ({ x, i }))
      .sort((a, b) => rank[a.x.status] - rank[b.x.status] || a.i - b.i)
      .map(r => r.x)
      .slice(0, 5);
    if (!items.length) return div();
    let n = 0;
    return this.section(
      t,
      "Coming up",
      null,
      v_flex().children(
        items.map(x => {
          const mark = x.status === "doing" ? "now" : x.status === "blocked" ? "held" : `${++n}`;
          return row()
            .id(`home-next-${x.id}`)
            .py(8)
            .px(SP.sm)
            .rounded(10)
            .gap(SP.sm)
            .items_start()
            .cursor_pointer()
            .hover(s => s.bg(alpha(t.foreground, 0.03)))
            .on_click((_e, cx) => this.app.go("next", cx))
            .child(div().w(26).flex_none().pt(1).text_size(TYPE.meta).font_medium().text_color(x.status === "doing" ? t.working : x.status === "blocked" ? t.blocked : t.muted).child(mark))
            .child(div().flex_1().min_w(0).text_size(TYPE.ui).line_height(1.4).text_color(t.foreground).child(x.title))
            .when(!!x.owner, el => el.child(div().flex_none().pt(1).text_size(TYPE.meta).text_color(t.muted).child(x.owner)));
        }),
      ),
      this.link(t, "home-all-next", "All moves", cx => this.app.go("next", cx)),
    );
  }
}
