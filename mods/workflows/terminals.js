// Terminals: a run's shells. The session that owns the run is a real Herdr terminal, opened
// live in a window; each agent's commands and their output read as a terminal of their own.

import { h_flex, Scrollbar, v_flex, v_virtual_list } from "gpui-base";
import { div } from "gpui-kit";
import { closeOverlay, home, openOverlay, panes, props, run, spaces } from "herdr";
import { glyph } from "./graph.js";
import { splitLabel } from "./runs.js";
import { btn, iconBtn, seg } from "./ui.js";
import { ago, alpha, duration, host, icon, kindColor, look, mix, mono, ok, scrollArea, tildify } from "./util.js";

/** px per terminal line; every line is one, so the list can be virtual. */
const LH = 18;
const FONT = 12;
const CHAR_W = FONT * 0.6;
const RAIL_W = 292;
const PAD_X = 16;
const EXIT = /^Exit code (\d+)/;

// ---- the owning session's live terminal ---------------------------------------------

/** Brings a terminal forward where it lives: its tab when it has a pane, else a peek. */
export function focusTerminal(addr) {
  host.leave();
  const pane = panes().find(p => p.terminal === addr);
  if (!pane) return run("terminal.peek", { terminal: addr });
  const space = spaces().find(s => s.tabs.some(tab => tab.id === pane.tab));
  if (space && !space.active) run("space.select", { id: space.id });
  run("tab.select", { id: pane.tab });
  run("pane.focus", { pane: pane.pane });
}

/** A Herdr window: this mod's bar over the session's real terminal (typing goes to it). */
export function openSessionWindow(plan, runName) {
  return openOverlay({
    kind: "window",
    key: "workflows-session",
    width: 0.64,
    height: 0.74,
    layout: {
      type: "column",
      children: [
        {
          type: "block",
          size: { px: 46 },
          content: {
            mod: "workflows",
            props: {
              part: "session-bar",
              address: plan.terminal.address,
              where: plan.terminal.where,
              name: plan.session.name,
              runName,
              cwd: plan.cwd,
            },
          },
        },
        { type: "block", content: { terminal: plan.terminal.address } },
      ],
    },
  });
}

function tile(name, color, size = 26) {
  return div()
    .flex_none()
    .w(size)
    .h(size)
    .rounded(7)
    .bg(alpha(color, 0.14))
    .border(1)
    .border_color(alpha(color, 0.35))
    .flex()
    .items_center()
    .justify_center()
    .child(icon(name, size * 0.52, color));
}

/** The session window's title bar (this mod, `props().part === "session-bar"`). Drags the window. */
export function sessionBar(t, p) {
  return h_flex()
    .id("session-bar")
    .size_full()
    .pl(12)
    .pr(8)
    .gap(10)
    .items_center()
    .bg(t.chrome ?? t.surface)
    .border_b(1)
    .border_color(t.border)
    .child(tile("terminal", t.accent))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(1)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(p.name || "Claude Code"))
            .when(!!p.runName, el => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`runs ${p.runName}`))),
        )
        .child(
          div()
            .font_family(mono())
            .text_size(10.5)
            .text_color(t.dim)
            .truncate()
            .child([p.address, p.where, tildify(p.cwd, home())].filter(Boolean).join("  ·  ")),
        ),
    )
    .child(
      btn(t, "bar-tab", "Open in its tab", () => {
        focusTerminal(p.address);
        closeOverlay(props().overlay);
      }, { kind: "ghost", size: "sm", icon: "external" }),
    )
    .child(iconBtn(t, "bar-close", "x", () => closeOverlay(props().overlay), "Close"));
}

// ---- an agent's shell as terminal lines -----------------------------------------------

function wrap(text, cols) {
  if (text.length <= cols) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
  return out;
}

/** The last two folders of a path, as a prompt shows it. */
function promptDir(path, homeDir) {
  const p = tildify(path || "", homeDir) || "~";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/**
 * The shell as lines `{ key, segs: [{ text, tone }], stamp?, prompt?, since? }`, wrapped at
 * `o.cols`. `o.filter` "shell" keeps commands; "all" adds every other tool as one line.
 */
function shellLines(data, o) {
  const lines = [];
  const push = (key, segs, extra) => lines.push({ key, segs, ...extra });
  const entries = (data?.entries ?? []).filter(e => o.filter === "all" || e.kind === "bash");
  if (data?.truncated)
    push("trunc", [{ text: "… older commands are further back than the part of the transcript read", tone: "dim" }]);
  let first = true;
  entries.forEach((e, i) => {
    const k = e.id ?? `e${i}`;
    if (e.kind === "tool") {
      push(k, [
        { text: "· ", tone: "dim" },
        { text: `${e.name} `, tone: e.error ? "err" : "tool" },
        { text: e.error && e.result ? e.result : (e.summary ?? ""), tone: e.error ? "err" : "dim" },
      ], { stamp: e });
      first = false;
      return;
    }
    if (!first) push(`${k}-gap`, []);
    first = false;
    if (e.description) wrap(`# ${e.description}`, o.cols).forEach((l, j) => push(`${k}-d${j}`, [{ text: l, tone: "comment" }]));
    const dir = promptDir(e.cwd ?? data.cwd, o.home);
    const cmd = (e.command ?? "").replace(/\t/g, "  ").split("\n");
    const lead = dir.length + 3;
    const head = wrap(cmd[0], Math.max(12, o.cols - lead - 18));
    push(`${k}-p`, [
      { text: dir, tone: "cwd" },
      { text: " ❯ ", tone: e.pending ? "live" : e.error ? "err" : "prompt" },
      { text: head[0], tone: "cmd" },
    ], { stamp: e, prompt: true });
    const rest = [...head.slice(1).map(l => " ".repeat(lead) + l), ...cmd.slice(1).flatMap(l => wrap(`  ${l}`, o.cols))];
    rest.forEach((l, j) => push(`${k}-c${j}`, [{ text: l, tone: "cmd" }], { prompt: true }));
    if (e.clipped) push(`${k}-clip`, [{ text: `… ${e.clipped} earlier lines`, tone: "dim" }]);
    const out = e.output ? e.output.split("\n") : [];
    out.forEach((line, j) =>
      wrap(line, o.cols).forEach((w, m) =>
        push(`${k}-o${j}-${m}`, [{ text: w, tone: e.error && j === 0 && EXIT.test(line) ? "err" : "out" }]),
      ),
    );
    if (e.pending)
      push(`${k}-run`, [{ text: "", tone: "spinner" }, { text: e.background ? " starting in the background" : " running", tone: "live" }], { since: e.ts });
    else if (e.error) {
      const code = (e.output ?? "").match(EXIT)?.[1];
      push(`${k}-x`, [{ text: code ? `✗ exit ${code}` : "✗ failed", tone: "err" }]);
    } else if (e.background) push(`${k}-bg`, [{ text: "↳ running in the background", tone: "dim" }]);
  });
  if (o.running && !entries.some(e => e.pending)) {
    if (!first) push("cursor-gap", []);
    push("cursor", [{ text: "", tone: "cursor" }]);
  } else if (!o.running && lines.length && o.endLabel) {
    push("end-gap", []);
    push("end", [{ text: o.endLabel, tone: "end" }]);
  }
  return lines;
}

/** The lines as plain text, for the clipboard. */
export function shellText(lines) {
  return lines.map(l => l.segs.map(s => s.text).join("")).join("\n");
}

function toneColor(tone, t) {
  switch (tone) {
    case "cwd":
      return t.ansi4 ?? t.accent;
    case "prompt":
      return ok(t);
    case "err":
      return t.blocked;
    case "live":
      return t.working;
    case "cmd":
      return t.foreground;
    case "out":
      return mix(t.foreground, t.background, 0.2);
    case "tool":
      return t.ansi6 ?? t.accent;
    default:
      return t.dim;
  }
}

const clock = ms => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
};

function lineRow(line, t, now) {
  const e = line.stamp;
  const stamp = e
    ? [e.ts ? clock(e.ts) : null, e.pending ? duration(now - (e.ts ?? now)) : e.endTs && e.ts ? duration(e.endTs - e.ts) : null]
        .filter(Boolean)
        .join("  ")
    : null;
  const last = line.segs.length - 1;
  return h_flex()
    .h(LH)
    .w_full()
    .px(PAD_X)
    .items_center()
    .overflow_hidden()
    .whitespace_nowrap()
    .when(!!line.prompt, el => el.bg(alpha(t.foreground, 0.035)))
    .children(
      line.segs.map((s, i) => {
        if (s.tone === "spinner") return icon("spinner", 11, t.working).spin(900);
        if (s.tone === "cursor")
          return div().flex_none().w(CHAR_W).h(14).bg(t.foreground).loop("opacity", { from: 0, to: 0.85, period: 1100 });
        if (s.tone === "end")
          return h_flex()
            .flex_1()
            .gap(8)
            .items_center()
            .child(div().h(1).w(18).bg(alpha(t.border, 1)))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s.text))
            .child(div().h(1).flex_1().bg(alpha(t.border, 1)));
        const el = div()
          .text_color(toneColor(s.tone, t))
          .when(s.tone === "cmd" && !!line.prompt, d => d.font_medium())
          .child(s.text);
        return i === last ? el.flex_1().min_w(0).truncate() : el.flex_none();
      }),
    )
    .when(!!line.since, el => el.child(div().flex_none().pl(10).text_size(10.5).text_color(t.working).child(duration(now - line.since))))
    .when(!!stamp, el => el.child(div().flex_none().pl(14).text_size(10.5).text_color(t.dim).child(stamp)));
}

// ---- the view ---------------------------------------------------------------------------

function label(text, t) {
  return div().px(16).pt(16).pb(8).text_size(10).font_medium().text_color(t.dim).child(text);
}

function sessionCard(t, run, ui) {
  const st = ui.session;
  const card = v_flex()
    .id("term-session")
    .mx(12)
    .p(12)
    .gap(10)
    .rounded(11)
    .bg(t.background)
    .border(1)
    .border_color(t.border);
  if (!st || st.loading)
    return card.child(
      h_flex()
        .gap(8)
        .items_center()
        .child(icon("spinner", 12, t.muted).spin(900))
        .child(div().text_size(11.5).text_color(t.muted).child("Finding its terminal…")),
    );
  if (st.error) return card.child(div().text_size(11.5).text_color(t.blocked).child(st.error));
  const p = st.plan;
  const term = p.terminal;
  const state = term?.state;
  const color = !p.session.alive ? t.dim : state === "working" ? t.working : state === "blocked" ? t.blocked : ok(t);
  const status = !p.session.alive ? "ended" : term ? (state ?? "live") : "outside Herdr";
  return card
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(tile(p.master ? "crown" : "terminal", p.session.alive ? t.accent : t.dim, 30))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(div().text_size(12.5).font_semibold().text_color(t.foreground).truncate().child(p.master ? `Master chat${p.session.name ? ` · ${p.session.name}` : ""}` : p.session.name || "Claude Code"))
            .child(
              div()
                .font_family(mono())
                .text_size(10.5)
                .text_color(t.dim)
                .truncate()
                .child(term ? [term.address, term.where].filter(Boolean).join(" · ") : p.session.alive ? `pid ${p.session.pid}` : p.sessionId.slice(0, 8)),
            ),
        )
        .child(
          h_flex()
            .flex_none()
            .gap(5)
            .items_center()
            .child(
              div()
                .w(7)
                .h(7)
                .rounded_full()
                .bg(color)
                .when(state === "working" && p.session.alive, el => el.loop("opacity", { from: 0.25, to: 1, period: 1000 })),
            )
            .child(div().text_size(10.5).text_color(color).child(status)),
        ),
    )
    .child(
      div()
        .text_size(11)
        .line_height(1.45)
        .text_color(t.muted)
        .child(
          !p.session.alive
            ? p.master
              ? "The repository's master chat owns this run and has ended. Reopening brings it back in its Master tab."
              : `The session that ran this workflow has ended. \`${p.openCommand}\` reopens it.`
            : term
              ? p.master
                ? "The repository's master chat owns this run. Its agents work inside it."
                : "The Claude Code session running this workflow. Its agents work inside it."
              : "The session is alive, but no Herdr terminal shows it.",
        ),
    )
    .when(!p.session.alive, el =>
      el.child(h_flex().child(btn(t, "term-reopen", p.master ? "Reopen the master chat" : "Reopen its session", cx => ui.onReopenOwner(cx), { kind: "primary", size: "sm", icon: "play" }))),
    )
    .when(p.session.alive && !!term, el =>
      el.child(
        h_flex()
          .gap(6)
          .child(btn(t, "term-open", "Open live terminal", cx => ui.onOpenSession(cx), { kind: "primary", size: "sm", icon: "terminal" }))
          .child(iconBtn(t, "term-goto", "external", () => focusTerminal(term.address), "Go to its tab")),
      ),
    );
}

function agentRow(s, t, selected, onPick) {
  const lk = look(s.state, t);
  const { kind, key } = splitLabel(s.label);
  const kc = kindColor(kind, t);
  const sub = s.waiting
    ? `${s.waiting.tool === "Bash" ? "$ " : `${s.waiting.tool} `}${s.waiting.description ?? s.waiting.summary ?? ""}`
    : s.lastToolName === "Bash"
      ? `$ ${s.lastToolSummary ?? ""}`
      : s.lastToolName
        ? `${s.lastToolName} ${s.lastToolSummary ?? ""}`
        : lk.label.toLowerCase();
  return h_flex()
    .id(`term-a-${s.agentId}`)
    .px(10)
    .py(7)
    .gap(10)
    .items_center()
    .rounded(9)
    .border(1)
    .border_color(selected ? alpha(t.accent, 0.55) : alpha(t.border, 0))
    .bg(selected ? mix(t.chrome ?? t.surface ?? t.background, t.accent, 0.1) : alpha(t.foreground, 0))
    .cursor_pointer()
    .hover(st => st.bg(selected ? mix(t.chrome ?? t.surface ?? t.background, t.accent, 0.1) : alpha(t.foreground, 0.045)))
    .on_click((_e, cx) => onPick(s.agentId, cx))
    .child(
      div()
        .flex_none()
        .w(14)
        .flex()
        .justify_center()
        .child(
          lk.key === "running"
            ? icon("spinner", 12, t.working).spin(900)
            : div().w(7).h(7).rounded_full().bg(lk.color),
        ),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().flex_none().px(5).h(16).rounded(4).bg(alpha(kc, 0.14)).text_size(10).text_color(kc).flex().items_center().child(kind))
            .when(key !== kind, el => el.child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(key))),
        )
        .child(
          div()
            .truncate()
            .font_family(mono())
            .text_size(10.5)
            .text_color(lk.key === "running" ? mix(t.foreground, t.background, 0.3) : t.dim)
            .child(sub),
        ),
    );
}

function rail(t, run, lanes, ui) {
  const groups = lanes
    .map(l => ({ lane: l, sessions: l.nodes.flatMap(n => n.sessions).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)) }))
    .filter(g => g.sessions.length);
  const count = groups.reduce((n, g) => n + g.sessions.length, 0);
  const live = groups.reduce((n, g) => n + g.sessions.filter(s => look(s.state, t).key === "running").length, 0);
  return v_flex()
    .id("term-rail")
    .flex_none()
    .w(RAIL_W)
    .min_h(0)
    .bg(t.chrome ?? t.surface)
    .border_r(1)
    .border_color(alpha(t.border, 0.8))
    .child(label("SESSION", t))
    .child(sessionCard(t, run, ui))
    .child(
      h_flex()
        .pr(16)
        .items_center()
        .child(div().flex_1().child(label(`AGENTS · ${count}`, t)))
        .when(live > 0, el => el.child(div().pt(8).text_size(10.5).text_color(t.working).child(`${live} running`))),
    )
    .child(
      scrollArea(
        "term-agents",
        "y",
        v_flex()
          .px(8)
          .pb(16)
          .children(
            groups.map(g =>
              v_flex()
                .gap(1)
                .mb(8)
                .child(
                  h_flex()
                    .px(10)
                    .py(5)
                    .gap(7)
                    .child(div().font_family(mono()).text_size(10).text_color(g.lane.look.color).child(String(g.lane.index).padStart(2, "0")))
                    .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_medium().text_color(t.muted).child(g.lane.title)),
                )
                .children(g.sessions.map(s => agentRow(s, t, s.agentId === ui.agent?.agentId, ui.onPick))),
            ),
          ),
      ),
    );
}

function centered(t, text, spin, hint) {
  return v_flex()
    .flex_1()
    .items_center()
    .justify_center()
    .gap(8)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .when(!!spin, el => el.child(icon("spinner", 13, t.muted).spin(900)))
        .child(div().text_size(12).text_color(t.muted).child(text)),
    )
    .when(!!hint, el => el.child(div().text_size(11).text_color(t.dim).child(hint)));
}

function terminalWindow(t, run, ui, now) {
  const s = ui.agent;
  if (!s) return centered(t, "No agents yet", false);
  const lk = look(s.state, t);
  const running = lk.key === "running";
  const state = ui.shell?.agentId === s.agentId ? ui.shell : null;
  const data = state?.data;
  const cols = Math.max(24, Math.floor(((ui.width ?? 900) - PAD_X * 2 - 8) / CHAR_W));
  const lines = data
    ? shellLines(data, {
        filter: ui.filter,
        cols,
        home: home(),
        running,
        endLabel: `${lk.label.toLowerCase()} ${s.lastProgressAt ? ago(s.lastProgressAt, now) : ""}`.trim(),
      })
    : [];
  ui.lines = lines;
  const commands = data?.entries?.filter(e => e.kind === "bash") ?? [];
  const pending = data?.entries?.find(e => e.pending);
  const { kind, key } = splitLabel(s.label);
  const kc = kindColor(kind, t);
  const bar = h_flex()
    .flex_none()
    .h(42)
    .pl(12)
    .pr(8)
    .gap(10)
    .items_center()
    .bg(mix(t.background, t.foreground, 0.035))
    .border_b(1)
    .border_color(alpha(t.border, 0.9))
    .child(glyph(lk, t, 22))
    .child(div().flex_none().px(6).h(18).rounded(5).bg(alpha(kc, 0.14)).text_size(10.5).text_color(kc).flex().items_center().child(kind))
    .when(key !== kind, el => el.child(div().flex_none().max_w(220).truncate().text_size(13).font_semibold().text_color(t.foreground).child(key)))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .font_family(mono())
        .text_size(10.5)
        .text_color(t.dim)
        .child(tildify(data?.cwd ?? "", home())),
    )
    .child(
      seg(t, "term-filter", [
        { id: "shell", label: "Shell", icon: "terminal", hint: "Commands and their output" },
        { id: "all", label: "All", icon: "list", hint: "Every tool call, commands in full" },
      ], ui.filter, (id, cx) => ui.onFilter(id, cx), { size: "sm" }),
    )
    .child(iconBtn(t, "term-copy", "copy", cx => ui.onCopy(cx), "Copy this terminal's text", { disabled: !lines.length }))
    .child(
      iconBtn(t, "term-follow", "arrow-down", cx => ui.onFollow(!ui.follow, cx), ui.follow ? "Following the latest output" : "Follow the latest output", {
        color: ui.follow ? t.accent : t.muted,
      }),
    )
    .child(btn(t, "term-tx", "Transcript", cx => ui.onTranscript(s.agentId, cx), { kind: "ghost", size: "sm", icon: "file-text" }));

  let body;
  if (!state) body = centered(t, "Reading its shell…", true);
  else if (state.error) body = centered(t, state.error, false);
  else if (!lines.length)
    body = centered(
      t,
      ui.filter === "shell" ? "No shell commands yet" : "No tool calls yet",
      running,
      ui.filter === "shell" && data?.entries?.length ? `It used ${data.entries.length} other tools: switch to All to see them.` : null,
    );
  else
    body = div()
      .relative()
      .flex_1()
      .min_h(0)
      .pt(8)
      .font_family(mono())
      .text_size(FONT)
      .on_scroll_wheel((e, cx) => {
        if (e.delta.y > 0 && ui.follow) ui.onFollow(false, cx);
      })
      .child(
        v_virtual_list("term-lines", lines.length, LH, i => lines[i].key, range =>
          lines.slice(range.start, range.end).map(l => lineRow(l, t, now)),
        )
          .track_scroll(ui.handle)
          .size_full(),
      )
      .child(Scrollbar.vertical("term-lines").viewport_from_layout().absolute().inset_0());

  const status = running
    ? pending
      ? `${pending.kind === "bash" ? "running" : pending.name} · ${duration(now - (pending.ts ?? now))}`
      : "thinking…"
    : `${lk.label.toLowerCase()} · ${ago(s.lastProgressAt, now)}`;
  const foot = h_flex()
    .flex_none()
    .h(28)
    .px(12)
    .gap(8)
    .items_center()
    .border_t(1)
    .border_color(alpha(t.border, 0.8))
    .bg(mix(t.background, t.foreground, 0.02))
    .font_family(mono())
    .text_size(10.5)
    .child(div().w(6).h(6).rounded_full().bg(lk.color).when(running, el => el.loop("opacity", { from: 0.25, to: 1, period: 1000 })))
    .child(div().text_color(running ? t.working : t.muted).child(status))
    .child(div().flex_1())
    .child(div().text_color(t.dim).child(`${commands.length} command${commands.length === 1 ? "" : "s"}${commands.some(c => c.error) ? ` · ${commands.filter(c => c.error).length} failed` : ""}`))
    .when(!ui.follow && lines.length > 0, el =>
      el.child(
        h_flex()
          .id("term-jump")
          .px(8)
          .h(20)
          .gap(5)
          .items_center()
          .rounded(6)
          .bg(alpha(t.accent, 0.14))
          .text_color(t.accent)
          .cursor_pointer()
          .hover(st => st.bg(alpha(t.accent, 0.22)))
          .on_click((_e, cx) => ui.onFollow(true, cx))
          .child(icon("arrow-down", 10, t.accent))
          .child("Jump to latest"),
      ),
    );

  return v_flex()
    .flex_1()
    .min_w(0)
    .min_h(0)
    .p(16)
    .child(
      v_flex()
        .id("term-window")
        .flex_1()
        .min_h(0)
        .rounded(12)
        .overflow_hidden()
        .border(1)
        .border_color(running ? alpha(t.working, 0.45) : t.border)
        .bg(t.background)
        .shadow_lg()
        .on_size_change((size, cx) => ui.onWidth(size.width, cx))
        .child(bar)
        .child(body)
        .child(foot),
    );
}

/**
 * The Terminals tab. `ui`: `agent` (the picked session), `shell` ({agentId, data|error}),
 * `session` ({loading} | {plan} | {error}), `filter`, `follow`, `width`, `handle`, and the
 * `onPick`, `onFilter`, `onFollow`, `onCopy`, `onWidth`, `onOpenSession`, `onTranscript`
 * callbacks. Sets `ui.lines` to what it drew.
 */
export function terminalsView(t, run, lanes, ui, now) {
  return h_flex()
    .flex_1()
    .min_h(0)
    .min_w(0)
    .items_stretch()
    .border_t(1)
    .border_color(alpha(t.border, 0.6))
    .bg(t.canvas ?? mix(t.background, t.foreground, 0.02))
    .child(rail(t, run, lanes, ui))
    .child(terminalWindow(t, run, ui, now));
}
