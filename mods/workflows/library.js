// The library: the two ways to start a workflow, then every saved one, by where it lives.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { home } from "herdr";
import { badge, btn } from "./ui.js";
import { ago, alpha, clip, icon, mix, mono, scrollArea, tildify } from "./util.js";

function startCard(t, id, o) {
  return v_flex()
    .id(id)
    .flex_1()
    .min_w(0)
    .p(20)
    .gap(14)
    .rounded(16)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .shadow_sm()
    .cursor_pointer()
    .hover(s => s.border_color(alpha(o.color, 0.6)).bg(mix(t.background, o.color, 0.03)))
    .on_click((_e, cx) => o.onClick(cx))
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .child(
          div()
            .w(38)
            .h(38)
            .rounded(11)
            .bg(alpha(o.color, 0.14))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(o.icon, 18, o.color)),
        )
        .child(
          v_flex()
            .flex_1()
            .gap(2)
            .child(div().text_size(15).font_semibold().text_color(t.foreground).child(o.title))
            .child(div().text_size(11.5).text_color(o.color).child(o.kicker)),
        )
        .child(icon("arrow-right", 14, t.dim)),
    )
    .child(div().text_size(12.5).line_height(1.55).text_color(t.muted).child(o.body))
    .child(
      h_flex()
        .gap(6)
        .flex_wrap()
        .children(o.points.map(p => badge(t, p, t.muted, { h: 22 }))),
    );
}

function row(t, w, ui) {
  const confirming = ui.confirmDelete === w.path;
  return h_flex()
    .id(`wf-${w.path}`)
    .px(16)
    .py(13)
    .gap(14)
    .items_center()
    .rounded(12)
    .bg(t.background)
    .border(1)
    .border_color(confirming ? alpha(t.blocked, 0.5) : t.border)
    .cursor_pointer()
    .hover(s => s.border_color(alpha(t.accent, 0.5)))
    .on_click((_e, cx) => ui.onOpen(w, cx))
    .child(
      div()
        .flex_none()
        .w(34)
        .h(34)
        .rounded(10)
        .bg(alpha(w.editable ? t.accent : t.muted, 0.12))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(w.editable ? "flow" : "code", 15, w.editable ? t.accent : t.muted)),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(4)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().font_family(mono()).text_size(13).font_semibold().text_color(t.foreground).child(`/${w.name}`))
            .child(badge(t, w.editable ? "designed" : "code", w.editable ? t.accent : t.muted))
            .child(
              div()
                .text_size(11)
                .text_color(t.dim)
                .child(`edited ${ago(w.mtime)}`),
            ),
        )
        .child(
          div()
            .truncate()
            .text_size(12)
            .text_color(t.muted)
            .child(clip(w.description, 160) || "No description"),
        )
        .when(w.phases.length > 0, el =>
          el.child(
            h_flex()
              .gap(4)
              .items_center()
              .children(
                w.phases.flatMap((p, i) => [
                  ...(i ? [icon("chevron-right", 10, t.dim)] : []),
                  div().text_size(10.5).text_color(t.dim).child(p),
                ]),
              ),
          ),
        ),
    )
    .child(
      confirming
        ? h_flex()
            .gap(6)
            .items_center()
            .child(div().text_size(12).text_color(t.blocked).child("Delete this file?"))
            .child(btn(t, `del-no-${w.path}`, "Keep", cx => ui.setConfirm(null, cx), { size: "sm", kind: "ghost" }))
            .child(btn(t, `del-yes-${w.path}`, "Delete", cx => ui.onDelete(w, cx), { size: "sm", kind: "danger" }))
        : h_flex()
            .gap(6)
            .child(btn(t, `run-${w.path}`, "Run", cx => ui.onRun(w, cx), { size: "sm", icon: "play" }))
            .child(
              btn(t, `dup-${w.path}`, "", cx => ui.onDuplicate(w, cx), {
                size: "sm",
                icon: "copy",
                kind: "ghost",
                tooltip: "Duplicate",
              }),
            )
            .child(
              btn(t, `del-${w.path}`, "", cx => ui.setConfirm(w.path, cx), {
                size: "sm",
                icon: "trash",
                kind: "ghost",
                tooltip: "Delete",
              }),
            ),
    );
}

/** `ui`: { workflows, roots, loading, error, confirmDelete, setConfirm, onNewAI, onNewManual, onOpen, onRun, onDuplicate, onDelete }. */
export function library(t, ui) {
  const all = ui.workflows ?? [];
  const here = ui.here?.key;
  const repoOf = r => ui.rootRepos?.[r];
  const rootGroup = r => ({
    key: r,
    title: repoOf(r)?.name ?? r.split("/").pop(),
    where: `${tildify(r, home())}/.claude/workflows`,
    icon: "folder",
    items: all.filter(w => w.scope === "project" && w.root === r),
  });
  const sameRepo = (ui.roots ?? []).filter(r => here && repoOf(r)?.key === here);
  // The checkout the person is in; other worktrees of the same repository only when they hold workflows.
  const cwd = ui.hereCwd ?? "";
  const current = sameRepo.filter(r => cwd === r || cwd.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? sameRepo[0];
  const checkouts = sameRepo.filter(r => r !== current).map(rootGroup).filter(g => g.items.length);
  const otherRoots = (ui.roots ?? []).filter(r => !sameRepo.includes(r));
  const groups = [
    ...(current ? [{ ...rootGroup(current), kicker: "This repository" }] : []),
    ...checkouts.map(g => ({ ...g, kicker: "Other checkout" })),
    { key: "user", title: "Yours", where: "~/.claude/workflows", icon: "user", items: all.filter(w => w.scope === "user") },
  ];
  // Every other repository open in a space: tidy, collapsed, and only when it has workflows.
  const others = otherRoots.map(rootGroup).filter(g => g.items.length);
  const otherCount = others.reduce((n, g) => n + g.items.length, 0);
  return scrollArea(
    "lib-scroll",
    "y",
    v_flex()
      .items_center()
      .child(
        v_flex()
          .w_full()
          .max_w(1040)
          .px(32)
          .pt(28)
          .pb(48)
          .gap(28)
          .child(
            v_flex()
              .gap(4)
              .child(div().text_size(22).font_semibold().text_color(t.foreground).child("Workflow library"))
              .child(
                div()
                  .text_size(12.5)
                  .text_color(t.muted)
                  .child("Design multi-agent workflows once, then run them from any Claude Code session as /name."),
              ),
          )
          .child(
            h_flex()
              .gap(16)
              .items_stretch()
              .child(
                startCard(t, "new-ai", {
                  icon: "sparkles",
                  color: t.accent,
                  title: "Describe it",
                  kicker: "AI-assisted",
                  body: "Say what you need in plain words. Claude reads your repo if it helps and drafts the phases, agent prompts and output schemas.",
                  points: ["One prompt", "Refine by chatting", "Every part editable"],
                  onClick: ui.onNewAI,
                }),
              )
              .child(
                startCard(t, "new-manual", {
                  icon: "square-pen",
                  color: t.ansi5 ?? t.accent,
                  title: "Build it",
                  kicker: "Manual",
                  body: "Start from a blank canvas and set every parameter: phases, fan-outs, prompts, models, effort, worktrees, schemas, arguments.",
                  points: ["Full control", "Live graph", "Validated as you type"],
                  onClick: ui.onNewManual,
                }),
              ),
          )
          .when(!!ui.error, el => el.child(div().text_size(12).text_color(t.blocked).child(ui.error)))
          .children(
            groups.map(g =>
              v_flex()
                .gap(10)
                .child(
                  h_flex()
                    .gap(8)
                    .items_center()
                    .child(icon(g.icon, 13, g.kicker ? t.accent : t.dim))
                    .when(!!g.kicker, el => el.child(div().text_size(10.5).font_semibold().text_color(t.accent).child(g.kicker.toUpperCase())))
                    .child(div().text_size(13).font_semibold().text_color(t.foreground).child(g.title))
                    .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(g.where))
                    .child(div().flex_1())
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(ui.loading ? "reading…" : `${g.items.length}`),
                    ),
                )
                .when(!g.items.length && !ui.loading, el =>
                  el.child(
                    div()
                      .px(16)
                      .py(14)
                      .rounded(12)
                      .border(1)
                      .border_dashed()
                      .border_color(alpha(t.muted, 0.35))
                      .text_size(12)
                      .text_color(t.dim)
                      .child(
                        g.key === "user"
                          ? "Nothing saved here yet. Workflows you save for yourself land here."
                          : "No workflows in this repository yet.",
                      ),
                  ),
                )
                .children(g.items.map(w => row(t, w, ui))),
            ),
          )
          .when(others.length > 0, el =>
            el.child(
              v_flex()
                .gap(10)
                .child(
                  h_flex()
                    .id("lib-others")
                    .h(40)
                    .px(14)
                    .gap(10)
                    .items_center()
                    .rounded(12)
                    .bg(alpha(t.foreground, 0.035))
                    .cursor_pointer()
                    .hover(s2 => s2.bg(alpha(t.foreground, 0.06)))
                    .on_click((_e, cx) => ui.toggleOthers(cx))
                    .child(icon(ui.othersOpen ? "chevron-down" : "chevron-right", 12, t.dim))
                    .child(div().text_size(12.5).font_medium().text_color(t.foreground).child("Other repositories"))
                    .child(
                      div()
                        .text_size(11.5)
                        .text_color(t.dim)
                        .child(`${otherCount} workflow${otherCount > 1 ? "s" : ""} in ${others.map(g => g.title).join(", ")}`),
                    ),
                )
                .when(!!ui.othersOpen, el2 =>
                  el2.children(
                    others.map(g =>
                      v_flex()
                        .pl(14)
                        .gap(8)
                        .child(
                          h_flex()
                            .gap(8)
                            .items_center()
                            .child(icon("folder", 12, t.dim))
                            .child(div().text_size(12).font_semibold().text_color(t.muted).child(g.title))
                            .child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(g.where)),
                        )
                        .children(g.items.map(w => row(t, w, ui))),
                    ),
                  ),
                ),
            ),
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(icon("terminal", 12, t.dim))
              .child(
                div()
                  .text_size(11.5)
                  .text_color(t.dim)
                  .child(
                    "Tip: in the Runs tab, open any past run and choose Edit as workflow to start from its script.",
                  ),
              ),
          ),
      ),
  );
}
