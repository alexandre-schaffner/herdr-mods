// A run's owner, the session that started it and the only one that can resume it: going to
// it, reopening it when it ended, and the two-step Resume. Functions of the Workflows view.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home, notify, run, spaces } from "herdr";
import { collect, master } from "./io.js";
import { RESUMABLE } from "./runs.js";
import { focusTerminal } from "./terminals.js";
import { badge, btn } from "./ui.js";
import { alpha, clip, icon, mono, ok, tildify } from "./util.js";

/** Brings the run's owner forward: its terminal while it lives, else reopens it (a master
 *  through master.py, so it comes back as the Master tab; any other with `claude --resume`). */
export function goToOwner(app, cx) {
  const run = app.run;
  if (!run || app.owning) return;
  app.owning = run.id;
  cx.notify();
  cx.spawn(async cx => {
    try {
      const plan = await collect(["resume-plan", run.id]);
      if (plan.terminal) focusTerminal(plan.terminal.address);
      else if (plan.session.alive) throw new Error(`Session ${plan.session.name ?? plan.sessionId.slice(0, 8)} runs outside Herdr (pid ${plan.session.pid})`);
      else if (plan.master) {
        const out = await master(["open", plan.repoPath ?? plan.cwd, activeSpace(app), ""]);
        notify({ title: `Reopened the master chat (${out.address})`, body: run.name, level: "success", timeout: 3000 });
      } else {
        reopen(app, plan, run.name);
        notify({ title: "Reopened its session", body: plan.openCommand, level: "success", timeout: 3000 });
      }
      app.refreshSessionTerm(cx);
      app.refreshList(cx);
    } catch (e) {
      notify({ title: "Couldn't reach the run's owner", body: String(e?.message ?? e), level: "error" });
    }
    app.owning = null;
    cx.notify();
  });
}

function activeSpace(app) {
  return spaces().find(s => s.active)?.id ?? "";
}

export function ownerChip(app, t, run) {
  const o = run.owner;
  if (!o) return null;
  const who = o.master ? "Master chat" : (o.name ?? o.sessionId.slice(0, 8));
  const color = o.alive ? (o.master ? t.accent : ok(t)) : t.dim;
  const busy = app.owning === run.id;
  return h_flex()
    .id("run-owner")
    .flex_none()
    .gap(6)
    .px(8)
    .h(22)
    .rounded_full()
    .items_center()
    .border(1)
    .border_color(alpha(color, 0.45))
    .bg(alpha(color, 0.08))
    .cursor_pointer()
    .hover(s => s.bg(alpha(color, 0.16)))
    .on_click((_e, cx) => goToOwner(app, cx))
    .child(busy ? icon("spinner", 11, color).spin(900) : icon(o.master ? "crown" : "terminal", 11, color))
    .child(div().text_size(11).font_medium().text_color(color).child(`${who} · ${o.alive ? "go to it" : "ended, reopen"}`));
}

/** First click: look up who owns the run and where its session is, then ask. */
export function armResume(app, cx) {
  const run = app.run;
  if (!run || !RESUMABLE.includes(run.status)) return;
  app.resume = { runId: run.id, phase: "checking" };
  cx.notify();
  cx.spawn(async cx => {
    try {
      const plan = await collect(["resume-plan", run.id]);
      if (app.resume?.runId !== run.id) return;
      if (!plan.resumable) {
        app.resume = null;
        notify({ title: "Nothing to resume", body: `${run.name} is ${plan.status}.`, level: "info", timeout: 3000 });
      } else app.resume = { runId: run.id, name: run.name, phase: "armed", plan };
    } catch (e) {
      app.resume = null;
      notify({ title: "Couldn't check the run", body: String(e?.message ?? e), level: "error" });
    }
    cx.notify();
  });
}

function cancelResume(app, cx) {
  app.resume = null;
  cx.notify();
}

/** Second click: type the request into the session's terminal, or open the session first. */
export function confirmResume(app, cx) {
  const r = app.resume;
  if (r?.phase !== "armed") return;
  const { plan } = r;
  r.phase = plan.session.alive ? "sending" : "opening";
  cx.notify();
  cx.spawn(async cx => {
    try {
      if (plan.session.alive) {
        if (!plan.terminal) throw new Error(`No Herdr terminal shows session ${plan.session.name ?? plan.sessionId.slice(0, 8)}`);
        const out = await collect(["resume", plan.runId]);
        notify({ title: `Resume sent to ${out.terminal.where ?? out.terminal.address}`, body: out.text, level: "success", timeout: 5000 });
      } else if (plan.master) {
        const out = await master(["open", plan.repoPath ?? plan.cwd, activeSpace(app), plan.text]);
        notify({ title: `Reopened the master chat (${out.address}) to resume`, body: plan.text, level: "success", timeout: 5000 });
      } else {
        reopen(app, plan, r.name, plan.text);
        notify({ title: "Reopened its session to resume", body: plan.text, level: "success", timeout: 5000 });
      }
      app.refreshRun(cx);
      app.refreshList(cx);
    } catch (e) {
      notify({ title: "Resume not sent", body: String(e?.message ?? e), level: "error" });
    }
    app.resume = null;
    cx.notify();
  });
}

/** A new tab in the run's folder that reopens its ended session (in the account it ran in);
 *  Herdr types `task` once Claude Code is ready. */
function reopen(app, plan, name, task) {
  run("tab.new", { space: activeSpace(app) || undefined, folder: plan.cwd || undefined, name, argv: plan.openArgv, ...(task ? { task } : {}) });
}

export function resumeButton(app, t, run) {
  const r = app.resume?.runId === run.id ? app.resume : null;
  const busy = r && r.phase !== "armed";
  return btn(t, "resume-run", busy ? (r.phase === "checking" ? "Checking…" : r.phase === "opening" ? "Opening session…" : "Sending…") : "Resume", cx => (r ? null : armResume(app, cx)), {
    icon: busy ? "spinner" : "play",
    size: "sm",
    kind: r ? "secondary" : "primary",
    disabled: !!r,
    tooltip: "Ask the run's own Claude Code session to resume it (Workflow resumeFromRunId)",
  });
}

/** The confirm row under the header: what will be typed, and where. */
export function resumeConfirm(app, t, run) {
  const r = app.resume;
  if (r?.runId !== run.id || r.phase !== "armed") return null;
  const p = r.plan;
  const who = p.session.name ?? p.sessionId.slice(0, 8);
  const where = p.session.alive
    ? p.terminal
      ? `Type this into ${p.terminal.where ? `${p.terminal.where} (${p.terminal.address}` : `${p.terminal.address} (`}session ${who})?`
      : `Session ${who} is alive (pid ${p.session.pid}) but no Herdr terminal shows it. Copy the request and paste it there.`
    : p.master
      ? `The master chat has ended. Reopen it in its Master tab and type this into it?`
      : `Session gone. Open \`${p.openCommand}\` in a new tab in ${tildify(p.cwd, home())}, then type this into it? (Inferred: a resumed session keeps its id.)`;
  const canSend = !p.session.alive || !!p.terminal;
  return v_flex()
    .max_w(880)
    .gap(8)
    .px(12)
    .py(10)
    .rounded(9)
    .bg(alpha(t.accent, 0.07))
    .border(1)
    .border_color(alpha(t.accent, 0.4))
    .child(div().text_size(12).text_color(t.foreground).child(where))
    .child(div().font_family(mono()).text_size(10.5).text_color(t.muted).child(clip(p.text, 400)))
    .child(
      h_flex()
        .gap(8)
        .child(
          canSend
            ? btn(t, "resume-send", p.session.alive ? "Send resume" : "Open and resume", cx => confirmResume(app, cx), { icon: "play", kind: "primary", size: "sm" })
            : btn(t, "resume-copy", "Copy request", cx => {
                cx.write_to_clipboard(p.text);
                notify({ title: "Resume request copied", body: p.text, level: "success", timeout: 2500 });
                cancelResume(app, cx);
              }, { icon: "copy", kind: "primary", size: "sm" }),
        )
        .child(btn(t, "resume-cancel", "Cancel", cx => cancelResume(app, cx), { kind: "ghost", size: "sm" })),
    );
}

/** Why a run without a current record counts as running or stalled. */
export function livenessLine(app, t, run) {
  const lv = run.liveness;
  if (!lv?.text) return null;
  const color = lv.status === "running" ? t.working : lv.reason === "gone" ? t.blocked : (t.idle ?? t.muted);
  const name = lv.reason === "waiting" ? "wrench" : lv.reason === "gone" ? "x" : lv.reason === "quiet" ? "clock" : "bolt";
  return h_flex()
    .gap(8)
    .items_center()
    .max_w(880)
    .child(icon(name, 12, color))
    .when(!!run.resumed, el => el.child(badge(t, "resumed", t.accent)))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(color).child(lv.text));
}
