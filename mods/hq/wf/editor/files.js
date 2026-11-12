// Generated from mods/workflows/editor/files.js by shared/sync.sh: edit it there.

// Files attached to a step's prompt or to the AI request: chips, find in the repository, the
// macOS picker and drops. Paths inside the repository are stored relative to it, so every
// worktree finds them.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec, home } from "herdr";
import { collect } from "../io.js";
import { findStep } from "../model.js";
import { btn, iconBtn, kbd } from "../ui.js";
import { alpha, icon, mono, tildify } from "../util.js";
import { openViewer, viewable } from "../shared/viewer-link.js";

export function cwd(ed) {
  return ed.root ?? ed.host?.cwd?.() ?? home();
}

export function repoRoot(ed) {
  return ed.root ?? ed.host?.repoRoot?.() ?? cwd(ed);
}

function relPath(ed, p) {
  const root = repoRoot(ed);
  return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

export function absPath(ed, p) {
  if (p.startsWith("/")) return p;
  if (p.startsWith("~/")) return home() + p.slice(1);
  return `${repoRoot(ed)}/${p}`;
}

function filesOf(ed, target) {
  if (target === "ai") return ed.ai.files;
  return findStep(ed.model, ed.sel.id)?.step.files ?? [];
}

export function addFiles(ed, target, paths, cx) {
  const rel = paths.map(p => relPath(ed, p.trim())).filter(Boolean);
  if (!rel.length) return;
  if (target === "ai") ed.ai.files = [...new Set([...ed.ai.files, ...rel])];
  else ed.setStep(cx, ed.sel.id, s => (s.files = [...new Set([...(s.files ?? []), ...rel])]));
  checkFiles(ed, cx);
  cx.notify();
}

function removeFile(ed, target, path, cx) {
  if (target === "ai") ed.ai.files = ed.ai.files.filter(f => f !== path);
  else ed.setStep(cx, ed.sel.id, s => (s.files = s.files.filter(f => f !== path)));
  cx.notify();
}

/** Marks attached files that don't exist (moved, renamed, or in another checkout). */
export function checkFiles(ed, cx) {
  const all = [...new Set([...ed.ai.files, ...(ed.model?.phases.flatMap(p => p.steps.flatMap(s => s.files)) ?? [])])];
  if (!all.length) return;
  cx.spawn(async cx => {
    try {
      const r = await collect(["exists", repoRoot(ed), ...all]);
      ed.missing = new Set(Object.entries(r.exists).filter(([, ok]) => !ok).map(([f]) => f));
    } catch {
      // a failed check leaves the chips unmarked rather than all red
    }
    cx.notify();
  });
}

function openSearch(ed, target, cx) {
  ed.fs = ed.fs?.target === target ? null : { target, results: [], total: null, loading: false };
  if (ed.fs) {
    ed.f.get("fs:query")?.set_value("");
    ed.f.get("fs:query")?.focus();
  }
  cx.notify();
}

export function search(ed, cx) {
  if (!ed.fs) return;
  const q = ed.f.get("fs:query")?.value() ?? "";
  const token = (ed.fsToken = (ed.fsToken ?? 0) + 1);
  cx.timer.after(160, cx2 => {
    if (token !== ed.fsToken || !ed.fs) return;
    ed.fs.loading = true;
    cx2.spawn(async cx3 => {
      try {
        const r = await collect(["files", repoRoot(ed), q]);
        if (token === ed.fsToken && ed.fs) Object.assign(ed.fs, { results: r.files, total: r.total, error: null });
      } catch (e) {
        if (ed.fs) ed.fs.error = String(e?.message ?? e);
      }
      if (ed.fs) ed.fs.loading = false;
      cx3.notify();
    });
    cx2.notify();
  });
}

/** The macOS file picker, run detached; polled until it closes. */
function browse(ed, target, cx) {
  cx.spawn(async cx => {
    const dir = `${appHome()}/data/workflows/tmp`;
    const out = `${dir}/pick-${Date.now().toString(36)}.txt`;
    try {
      await exec("mkdir", ["-p", dir]);
      await collect(["pick-start", out, repoRoot(ed)]);
      for (let i = 0; i < 1500; i++) {
        await exec("sleep", ["0.4"]);
        const r = await collect(["pick-poll", out]);
        if (r.done) {
          addFiles(ed, target, r.paths, cx);
          break;
        }
      }
    } catch (e) {
      ed.notice = { level: "error", text: String(e?.message ?? e) };
    }
    cx.notify();
  });
}

function fileChip(ed, t, target, f) {
  const missing = ed.missing.has(f);
  const abs = absPath(ed, f);
  const view = !missing && viewable(abs);
  const slash = f.lastIndexOf("/");
  const name = f.slice(slash + 1);
  const dir = slash > 0 ? f.slice(0, slash) : "";
  return h_flex()
    .id(`chip-${target}-${f}`)
    .h(26)
    .pl(8)
    .pr(3)
    .gap(6)
    .items_center()
    .rounded(7)
    .bg(missing ? alpha(t.blocked, 0.08) : alpha(t.foreground, 0.05))
    .border(1)
    .border_color(missing ? alpha(t.blocked, 0.5) : alpha(t.border, 1))
    .tooltip(missing ? `${f} doesn't exist in ${tildify(repoRoot(ed), home())}` : view ? `${f} · click to view` : f)
    .child(
      h_flex()
        .id(`chip-open-${target}-${f}`)
        .gap(6)
        .items_center()
        .when(view, el => el.cursor_pointer().hover(s => s.opacity(0.75)).on_click(() => openViewer(abs)))
        .child(icon(missing ? "alert" : view ? "eye" : "file-text", 11, missing ? t.blocked : t.accent))
        .child(div().text_size(11.5).font_medium().text_color(missing ? t.blocked : t.foreground).child(name))
        .when(!!dir, el => el.child(div().max_w(180).truncate().font_family(mono()).text_size(10).text_color(t.dim).child(dir))),
    )
    .child(iconBtn(t, `chip-x-${target}-${f}`, "x", cx => removeFile(ed, target, f, cx), "Remove", { size: 20, icon: 10 }));
}

function searchPanel(ed, t, target) {
  const fs = ed.fs;
  const attached = new Set(filesOf(ed, target));
  const q = ed.f.get("fs:query")?.value() ?? "";
  return v_flex()
    .id(`fs-panel-${target}`)
    .p(8)
    .gap(4)
    .rounded(11)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .shadow_md()
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().flex_1().child(ed.input(t, "fs:query", { h: 30, size: 12 })))
        .when(fs.loading, el => el.child(icon("spinner", 12, t.muted).spin(900)))
        .child(iconBtn(t, `fs-close-${target}`, "x", cx => ((ed.fs = null), cx.notify()), "Close")),
    )
    .when(!!fs.error, el => el.child(div().px(4).text_size(11).text_color(t.blocked).child(fs.error)))
    .when(!q.trim() && !fs.error, el =>
      el.child(div().px(4).py(4).text_size(11).text_color(t.dim).child(`Type a few letters: “eng readme”, “v3state”. Searches ${tildify(repoRoot(ed), home())}.`)),
    )
    .when(!!q.trim() && !fs.loading && !fs.results.length && !fs.error, el =>
      el.child(div().px(4).py(4).text_size(11).text_color(t.dim).child("No file matches.")),
    )
    .children(
      fs.results.slice(0, 10).map((f, i) => {
        const slash = f.lastIndexOf("/");
        const has = attached.has(f);
        return h_flex()
          .id(`fs-r-${target}-${i}`)
          .h(28)
          .px(6)
          .gap(8)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .when(i === 0, el => el.bg(alpha(t.accent, 0.08)))
          .hover(s => s.bg(alpha(t.accent, 0.12)))
          .on_click((_e, cx) => addFiles(ed, target, [`${repoRoot(ed)}/${f}`], cx))
          .child(icon(has ? "check" : "file-text", 12, has ? t.ansi2 : t.dim))
          .child(div().flex_none().text_size(12).text_color(t.foreground).child(f.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(10.5).text_color(t.dim).child(slash > 0 ? f.slice(0, slash) : ""))
          .when(i === 0, el => el.child(kbd(t, "↵")));
      }),
    );
}

/** Attached files for a step or for the AI prompt: chips, find-in-repo, browse, and drop. */
export function filesBox(ed, t, target, o = {}) {
  const files = filesOf(ed, target);
  const searching = ed.fs?.target === target;
  return v_flex()
    .id(`files-${target}`)
    .gap(8)
    .on_drop((e, cx) => addFiles(ed, target, e.paths, cx))
    .when(files.length > 0, el => el.child(h_flex().flex_wrap().gap(6).children(files.map(f => fileChip(ed, t, target, f)))))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(btn(t, `fs-find-${target}`, o.compact ? "" : "Find in repo", cx => openSearch(ed, target, cx), { icon: "search", size: "sm", kind: searching ? "secondary" : "ghost", tooltip: "Find a file in the repository" }))
        .child(btn(t, `fs-browse-${target}`, o.compact ? "" : "Browse…", cx => browse(ed, target, cx), { icon: "folder", size: "sm", kind: "ghost", tooltip: "Pick files with the macOS picker" }))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(
              files.length
                ? target === "ai"
                  ? `${files.length} file${files.length > 1 ? "s" : ""} for the agent to read`
                  : `${files.length} file${files.length > 1 ? "s" : ""}, read before the prompt`
                : "or drop files here",
            ),
        ),
    )
    .when(searching, el => el.child(searchPanel(ed, t, target)));
}
