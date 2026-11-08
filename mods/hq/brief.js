// Brief: what happened since the person last looked, set like a morning briefing. A dateline,
// the master's headline, a lede in plain sentences, then what needs them, what landed, what
// each manager is on, what the org learned, and how the day went. The data is `hq brief`.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";

import { openLink } from "./shared/viewer-link.js";
import { ago, alpha, btn, chip, clip, icon, kbd, mono, ok, row, scrollY, SP, statusGlyph, statusLook, TYPE, tint } from "./ui.js";

const SEEN = "brief.seen";
const HOUR = 3600_000;
const COLUMN = 720;
const RANGES = [
  { id: "seen", label: "Since last visit" },
  { id: "today", label: "Today" },
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 d" },
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = n => String(n).padStart(2, "0");
const hhmm = ms => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayWord = ms => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
/** Prose from agent text: no markdown marks, one line. */
const plain = s => (s ?? "").replace(/\*\*|`|__/g, "").replace(/\s+/g, " ").trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "3 working, 2 idle and 1 gone" */
const listing = parts => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** The first sentence of agent prose, plain; long ones are cut at a word with the rest in a tooltip. */
const first = (s, max = 200) => {
  const p = plain(s).replace(/^\(([\w-]+), \d{4}-\d\d-\d\d\)\s*/, "");
  if (!p) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(p);
  const one = m ? m[1] : p;
  return one.length > max ? `${one.slice(0, max).replace(/\s+\S*$/, "")}…` : one;
};

export class BriefView {
  constructor(app) {
    this.app = app;
    this.range = localStorage.getItem("brief.range") ?? "seen";
    this.data = null;
    this.error = null;
    this.loading = false;
    this.sel = 0; // index into actionable rows (needs you, landed, managers)
    this.allLessons = false;
    this.allLanded = false;
  }

  typing() {
    return false;
  }

  seen() {
    const v = Number(localStorage.getItem(SEEN));
    return Number.isFinite(v) && v > 0 ? v : Date.now() - 12 * HOUR;
  }

  since() {
    const now = Date.now();
    if (this.range === "today") {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    if (this.range === "24h") return now - 24 * HOUR;
    if (this.range === "7d") return now - 7 * 24 * HOUR;
    return this.seen();
  }

  onShow(cx) {
    this.load(cx);
  }

  /** The host calls this when the person leaves the Brief: what they saw counts as read. */
  onHide(_cx) {
    if (this.data) this.markRead();
  }

  markRead(cx) {
    localStorage.setItem(SEEN, String(Date.now()));
    if (cx) {
      this.range = "seen";
      localStorage.setItem("brief.range", "seen");
      this.load(cx);
    }
  }

  setRange(id, cx) {
    this.range = id;
    localStorage.setItem("brief.range", id);
    this.load(cx);
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    const since = this.since();
    cx.notify();
    cx.spawn(async cx => {
      try {
        this.data = await this.app.hq(["brief", "--since", String(Math.floor(since))]);
        this.error = null;
        this.sel = 0;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  /** Rows j/k step through, in reading order, and what enter does on each. */
  actionable() {
    const d = this.data;
    if (!d) return [];
    return [
      ...d.needsYou.map(i => ({ key: `need-${i.id}`, open: cx => this.app.go("review", cx, { id: i.id }) })),
      ...d.landed.map(l => ({ key: `landed-${l.pr}`, open: () => l.url && openLink(l.url) })),
      ...this.managers().map(m => ({ key: `mgr-${m.id}`, open: cx => this.app.go("org", cx, { id: m.id }) })),
    ];
  }

  managers() {
    const order = { blocked: 0, working: 1, done: 2, idle: 3 };
    return [...(this.data?.managers ?? [])].sort(
      (a, b) => (a.live ? order[a.status] ?? 4 : 5) - (b.live ? order[b.status] ?? 4 : 5) || (a.kind === "merge-queue" ? -1 : 1),
    );
  }

  onKey(e, cx) {
    const rows = this.actionable();
    if (e.key === "j" || e.key === "down") {
      this.sel = Math.min(rows.length - 1, this.sel + 1);
      cx.notify();
      return true;
    }
    if (e.key === "k" || e.key === "up") {
      this.sel = Math.max(0, this.sel - 1);
      cx.notify();
      return true;
    }
    if (e.key === "enter" && rows[this.sel]) {
      rows[this.sel].open(cx);
      return true;
    }
    if (e.key === "m") {
      this.markRead(cx);
      return true;
    }
    return false;
  }

  isSel(key) {
    return this.actionable()[this.sel]?.key === key;
  }

  // ---- drawing

  render(t, cx) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .min_w(0)
      .child(this.toolbar(t))
      .child(
        this.data
          ? scrollY("brief-scroll", v_flex().items_center().px(32).pt(32).pb(64).child(this.column(t)))
          : v_flex()
              .flex_1()
              .items_center()
              .justify_center()
              .gap(6)
              .child(div().text_size(TYPE.body).text_color(this.error ? t.blocked : t.muted).child(this.error ? "Couldn't write the brief" : "Writing the brief…"))
              .when(!!this.error, el => el.child(div().max_w(520).text_size(TYPE.meta).text_color(t.dim).child(this.error))),
      );
  }

  toolbar(t) {
    return h_flex()
      .flex_none()
      .h(44)
      .px(16)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(alpha(t.border, 0.7))
      .child(
        h_flex()
          .p(3)
          .gap(2)
          .rounded(8)
          .bg(alpha(t.foreground, 0.055))
          .children(
            RANGES.map(r => {
              const on = this.range === r.id;
              return div()
                .id(`brief-range-${r.id}`)
                .h(24)
                .px(10)
                .flex()
                .items_center()
                .rounded(6)
                .text_size(TYPE.ui)
                .cursor_pointer()
                .when(on, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
                .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
                .on_click((_e, cx) => this.setRange(r.id, cx))
                .child(r.label);
            }),
          ),
      )
      .child(div().flex_1())
      .when(this.loading, el => el.child(div().text_size(TYPE.meta).text_color(t.dim).child("updating…")))
      .child(btn(t, "brief-read", "Mark as read", cx => this.markRead(cx), { size: "sm", icon: "check", kbd: "M" }));
  }

  column(t) {
    const d = this.data;
    const quiet = !d.needsYou.length && !d.landed.length && !d.lessons.length && !d.memory.length && !d.headlines.length && !d.decided.length && !d.done.length;
    return v_flex()
      .w_full()
      .max_w(COLUMN)
      .child(this.masthead(t))
      .when(quiet, el => el.child(this.quiet(t)))
      .when(d.needsYou.length > 0, el => el.child(this.needsYou(t)))
      .when(d.landed.length > 0 || (d.trunk?.commits?.length ?? 0) > 0, el => el.child(this.landed(t)))
      .when(d.managers.length > 0, el => el.child(this.inFlight(t)))
      .when(d.lessons.length > 0 || d.memory.length > 0, el => el.child(this.learned(t)))
      .when(d.headlines.length > 0 || d.decided.length > 0 || d.done.length > 0, el => el.child(this.day(t)));
  }

  masthead(t) {
    const d = this.data;
    const h = d.headline ?? {};
    const sinceWord = this.range === "seen" ? "since you last looked" : this.range === "today" ? "today" : `in the last ${this.range === "24h" ? "24 hours" : "7 days"}`;
    const own = plain(h.text);
    const said = own ? null : first(d.master?.said, 180);
    return v_flex()
      .gap(SP.md)
      .child(div().text_size(TYPE.meta).text_color(t.muted).child(`${dayWord(d.now)} · ${sinceWord}, from ${hhmm(d.since)}`))
      .child(
        div()
          .id("brief-headline")
          .text_size(own ? TYPE.display : TYPE.heading)
          .line_height(1.3)
          .font_semibold()
          .text_color(own || said ? t.foreground : t.muted)
          .when(!!(said && plain(d.master?.said) !== said), el => el.tooltip(plain(d.master?.said)))
          .child(own || said || "No headline yet."),
      )
      .child(
        div()
          .text_size(TYPE.meta)
          .text_color(t.muted)
          .child(own ? `The master's headline, ${ago(h.at, d.now)}` : said ? `No headline set; this is the master's last message, ${ago(d.master?.lastAt, d.now)}` : "The master sets one each tick with hq status."),
      )
      .child(div().pt(SP.xs).max_w(680).text_size(14).line_height(1.6).text_color(t.foreground).child(this.lede()));
  }

  /** The state of things in plain sentences, from counts. */
  lede() {
    const d = this.data;
    const live = d.managers.filter(m => m.live);
    const by = st => live.filter(m => m.status === st).length;
    const idle = by("idle") + by("done");
    const gone = d.managers.length - live.length;
    const out = [];
    const parts = [by("working") && `${by("working")} working`, idle && `${idle} idle`, by("blocked") && `${by("blocked")} waiting on a question`, gone && `${gone} gone`].filter(Boolean);
    if (d.managers.length) out.push(`Of ${plural(d.managers.length, "manager")}, ${listing(parts)}.`);
    const merged = d.landed.filter(l => l.state === "merged").length;
    const green = d.landed.length - merged;
    if (merged || green)
      out.push(`${cap(listing([merged && `${plural(merged, "PR")} landed`, green && `${green} ${green === 1 ? "is" : "are"} green in the queue`].filter(Boolean)))}.`);
    const waits = d.needsYou.length;
    out.push(waits ? `${plural(waits, "decision")} ${waits === 1 ? "waits" : "wait"} for you.` : "Nothing waits for you.");
    if (d.decided.length) out.push(`You decided ${plural(d.decided.length, "thing")} in this stretch.`);
    const dreams = d.memory.filter(m => m.dream).length;
    if (d.lessons.length || d.memory.length)
      out.push(
        `${cap(listing([d.lessons.length && `the org sent ${plural(d.lessons.length, "lesson")}`, d.memory.length && `memory took ${plural(d.memory.length, "commit")}${dreams ? ` (${plural(dreams, "Dream")})` : ""}`].filter(Boolean)))}.`,
      );
    const loop = d.loop;
    if (loop && !loop.stopped && loop.wakeAt)
      out.push(loop.wakeAt > d.now ? `The master's next tick is ${ago(2 * d.now - loop.wakeAt, d.now).replace(" ago", "").replace("just now", "under a minute")} away.` : "The master's tick is overdue.");
    else out.push("The master isn't looping right now.");
    return out.join(" ");
  }

  head(t, title, count) {
    return row()
      .mt(36)
      .pt(SP.lg)
      .pb(SP.sm)
      .gap(SP.sm)
      .items_center()
      .border_t(1)
      .border_color(alpha(t.border, 0.8))
      .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(title))
      .when(count != null, el => el.child(div().text_size(TYPE.ui).text_color(t.muted).child(String(count))));
  }

  /** A manager's id for a terminal address, so rows say "wrappers", not "t77". */
  nameOf(addr) {
    return this.data?.managers?.find(m => m.terminal === addr)?.id ?? addr ?? "";
  }

  line(t, key, children, o = {}) {
    const on = this.isSel(key);
    return row()
      .id(key)
      .mx(-10)
      .px(10)
      .py(o.py ?? 7)
      .gap(12)
      .items_start()
      .rounded(8)
      .when(on, el => el.bg(alpha(t.accent, 0.1)))
      .when(!!o.tooltip, el => el.tooltip(o.tooltip))
      .when(!!o.open, el => el.cursor_pointer().hover(s => s.bg(tint(t).hover)).on_click((_e, cx) => o.open(cx)))
      .children(children);
  }

  needsYou(t) {
    const d = this.data;
    return v_flex()
      .child(this.head(t, "Needs you", d.needsYou.length))
      .children(
        d.needsYou.map(i =>
          this.line(
            t,
            `need-${i.id}`,
            [
              div().pt(3).child(icon(i.kind === "approval" ? "alert" : "user", 13, i.kind === "approval" ? t.blocked : t.accent)),
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(2)
                .child(div().text_size(TYPE.body).font_medium().text_color(t.foreground).child(plain(i.title)))
                .child(
                  div()
                    .text_size(TYPE.meta)
                    .text_color(t.muted)
                    .child(`${i.kind === "approval" ? "Approval" : "Question"} from ${i.from?.role ?? i.from?.terminal ?? "the org"}, waiting ${ago(i.createdAt, d.now).replace(" ago", "")}`),
                ),
              div().pt(1).child(btn(t, `need-go-${i.id}`, "Review", cx => this.app.go("review", cx, { id: i.id }), { size: "sm", kind: "primary" })),
            ],
            { open: cx => this.app.go("review", cx, { id: i.id }) },
          ),
        ),
      );
  }

  landed(t) {
    const d = this.data;
    const commits = d.trunk?.commits ?? [];
    const all = this.allLanded ? d.landed : d.landed.slice(0, 8);
    return v_flex()
      .child(this.head(t, "Landed", d.landed.length || null))
      .children(
        all.map(l =>
          this.line(
            t,
            `landed-${l.pr}`,
            [
              div().w(64).flex_none().text_size(TYPE.body).font_medium().text_color(l.url ? t.accent : t.foreground).child(`#${l.pr}`),
              div()
                .flex_1()
                .min_w(0)
                .text_size(TYPE.body)
                .text_color(t.foreground)
                .child(l.state === "green" ? "Green in the merge queue" : "Merged"),
              div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(`reported by ${this.nameOf(l.who)} · ${ago(l.at, d.now)}`),
            ],
            { py: 6, open: l.url ? () => openLink(l.url) : null, tooltip: plain(l.text) },
          ),
        ),
      )
      .when(d.landed.length > 8, el => el.child(this.more(t, "brief-landed-more", this.allLanded, d.landed.length, "PRs", () => (this.allLanded = !this.allLanded))))
      .when(commits.length > 0, el =>
        el.child(
          v_flex()
            .pt(SP.md)
            .gap(SP.xs)
            .child(div().text_size(TYPE.ui).text_color(t.muted).child(`${d.trunk.ref} gained ${plural(commits.length, "commit")}`))
            .children(
              commits.slice(0, 8).map(c =>
                row()
                  .gap(SP.md)
                  .child(div().w(64).flex_none().text_size(TYPE.meta).font_family(mono()).text_color(t.muted).child(c.sha.slice(0, 8)))
                  .child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(t.foreground).child(c.subject)),
              ),
            ),
        ),
      );
  }

  more(t, id, open, n, what, toggle) {
    return div()
      .id(id)
      .py(SP.xs)
      .text_size(TYPE.ui)
      .text_color(t.accent)
      .cursor_pointer()
      .hover(s => s.underline())
      .on_click((_e, cx) => {
        toggle();
        cx.notify();
      })
      .child(open ? "Show fewer" : `Show all ${n} ${what}`);
  }

  inFlight(t) {
    const d = this.data;
    return v_flex()
      .child(this.head(t, "In flight", d.managers.length))
      .children(
        this.managers().map(m => {
          const status = m.live ? m.status : "gone";
          const look = statusLook(status, t);
          // "doing" is a tool line; only a phrase ("Record the fresh build") reads as news.
          const phrase = /\s\S+\s/.test(plain(m.doing)) ? m.doing : null;
          const working = m.status === "working" && !!phrase;
          const now = first(working ? phrase : m.said, 180);
          return this.line(
            t,
            `mgr-${m.id}`,
            [
              div().pt(4).child(statusGlyph(status, t, 12)),
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(3)
                .child(
                  row()
                    .gap(SP.sm)
                    .items_center()
                    .child(div().text_size(TYPE.body).font_semibold().text_color(t.foreground).child(m.name))
                    .child(div().text_size(TYPE.meta).text_color(look.color).child(look.label))
                    .child(div().flex_1())
                    .child(div().text_size(TYPE.meta).text_color(t.muted).child(m.lastAt ? ago(m.lastAt, d.now) : "")),
                )
                .when(!!now, el => el.child(div().text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(`${working ? "Now: " : ""}${now}`)))
                .when(!!m.goal, el => el.child(div().text_size(TYPE.ui).line_height(1.45).text_color(t.muted).child(first(m.goal, 160)))),
            ],
            { py: 9, open: cx => this.app.go("org", cx, { id: m.id }), tooltip: working ? plain(m.doing) : plain(m.said) },
          );
        }),
      );
  }

  learned(t) {
    const d = this.data;
    const lessons = this.allLessons ? d.lessons : d.lessons.slice(0, 5);
    return v_flex()
      .child(this.head(t, "Learned", d.lessons.length || null))
      .children(
        lessons.map((l, i) =>
          row()
            .id(`brief-lesson-${i}`)
            .py(6)
            .gap(SP.md)
            .tooltip(plain(l.text))
            .child(div().w(84).flex_none().pt(1).truncate().text_size(TYPE.ui).font_medium().text_color(t.foreground).child(this.nameOf(l.peer)))
            .child(div().flex_1().min_w(0).text_size(TYPE.body).line_height(1.5).text_color(t.foreground).child(first(l.text, 220)))
            .child(div().flex_none().pt(1).text_size(TYPE.meta).text_color(t.muted).child(ago(l.at, d.now))),
        ),
      )
      .when(d.lessons.length > 5, el => el.child(this.more(t, "brief-lessons-more", this.allLessons, d.lessons.length, "lessons", () => (this.allLessons = !this.allLessons))))
      .when(d.memory.length > 0, el =>
        el.child(
          v_flex()
            .pt(SP.md)
            .gap(SP.xs)
            .child(
              div()
                .text_size(TYPE.ui)
                .text_color(t.muted)
                .child(`Memory took ${plural(d.memory.length, "commit")}${d.memory.some(m => m.dream) ? `, ${plural(d.memory.filter(m => m.dream).length, "Dream")}` : ""}`),
            )
            .children(
              d.memory.slice(0, 5).map(c =>
                row()
                  .gap(SP.md)
                  .items_center()
                  .child(div().w(84).flex_none().text_size(TYPE.meta).text_color(t.muted).child(hhmm(c.at)))
                  .child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(c.dream ? t.foreground : t.muted).child(c.subject))
                  .when(c.dream, el => el.child(icon("sparkles", 12, t.accent))),
              ),
            )
            .when(d.memory.length > 5, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(`${d.memory.length - 5} more in Memory`))),
        ),
      );
  }

  day(t) {
    const d = this.data;
    const verdict = { approve: "approved", reject: "rejected", answer: "answered", ack: "looked over", reopen: "reopened" };
    const events = [
      ...d.headlines.map(h => ({ at: h.at, text: plain(h.text), kind: "headline" })),
      ...d.decided.map(i => ({ at: i.decision?.at, text: `You ${verdict[i.decision?.verdict] ?? "decided"} “${plain(i.title)}”`, kind: "you" })),
      ...d.done.map(i => ({ at: i.createdAt, text: `${i.from?.role ?? "The org"} finished: ${plain(i.title)}`, kind: "done" })),
    ]
      .filter(e => e.at)
      .sort((a, b) => a.at - b.at);
    return v_flex()
      .child(this.head(t, "How the day went", null))
      .children(
        events.map((e, i) =>
          row()
            .gap(14)
            .child(div().w(44).flex_none().pt(1).text_size(TYPE.meta).text_color(t.muted).child(hhmm(e.at)))
            .child(
              v_flex()
                .flex_none()
                .w(9)
                .items_center()
                .child(div().mt(6).w(7).h(7).rounded_full().bg(e.kind === "you" ? t.accent : e.kind === "done" ? ok(t) : alpha(t.foreground, 0.28)))
                .when(i < events.length - 1, el => el.child(div().w(1).flex_1().min_h(10).bg(alpha(t.border, 0.9)))),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .pb(12)
                .text_size(TYPE.body)
                .line_height(1.5)
                .text_color(e.kind === "headline" ? t.muted : t.foreground)
                .child(e.text),
            ),
        ),
      );
  }

  quiet(t) {
    return v_flex()
      .mt(40)
      .pt(16)
      .gap(8)
      .border_t(1)
      .border_color(alpha(t.border, 0.8))
      .child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child("A quiet stretch"))
      .child(
        div()
          .text_size(14)
          .line_height(1.6)
          .text_color(t.muted)
          .child(
            "Nothing landed and nothing waits for you in this window. The Brief fills as the org works: headlines, merged PRs, your decisions and new lessons. Try a longer range above.",
          ),
      );
  }
}
