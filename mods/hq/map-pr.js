// The Map's PR inspector: a PR's live state, CI and description (`hq pr`), loaded when its card
// is picked, and the PR body cut into sections the panel can draw.

import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { exec } from "herdr";

import { ago, alpha, btn, chip, clip, icon, mdBlock, mono, ok, row, SP, statusGlyph, TYPE } from "./ui.js";

/** Reads PR `num` into `view.prs`, at most every 30s unless `force`d. */
export function loadPr(view, num, cx, force) {
  view.prs ??= {};
  const cur = view.prs[num];
  if (!force && cur && (cur.loading || Date.now() - (cur.at ?? 0) < 30_000)) return;
  view.prs[num] = { ...(cur ?? {}), loading: true };
  cx.spawn(async cx => {
    try {
      const r = await view.app.hq(["pr", String(num)]);
      view.prs[num] = { data: r, at: Date.now(), loading: false };
    } catch (e) {
      view.prs[num] = { ...(view.prs[num] ?? {}), error: String(e?.message ?? e), loading: false, at: Date.now() };
    }
    cx.notify();
  });
}

/** The drawer body for PR `num` (`node` is its card on the map). The view keeps what the panel toggles. */
export function prPanel(view, t, num, node) {
  const st = view.prs?.[num] ?? {};
  const r = st.data;
  if (!r)
    return div()
      .text_size(TYPE.ui)
      .text_color(st.error ? t.blocked : t.muted)
      .child(st.error ? `Couldn't read PR #${num}: ${clip(st.error, 160)}` : `Reading PR #${num}…`);
  const pr = r.pr;
  const merged = !!pr.mergedAt || pr.state === "MERGED";
  const stateWord = merged ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open";
  const stateColor = merged ? (t.ansi5 ?? t.accent) : pr.state === "CLOSED" ? t.blocked : pr.isDraft ? t.muted : ok(t);
  const n = r.counts ?? {};
  const CK = {
    pass: { glyph: () => icon("check", 12, ok(t)), word: "passed" },
    fail: { glyph: () => icon("x", 12, t.blocked), word: "failed" },
    running: { glyph: () => statusGlyph("working", t, 12), word: "running" },
    queued: { glyph: () => icon("clock", 12, t.muted), word: "queued" },
    cancelled: { glyph: () => icon("minus", 12, t.muted), word: "cancelled" },
    skipped: { glyph: () => icon("minus", 12, t.muted), word: "skipped" },
  };
  const summary = ["fail", "running", "queued", "pass", "cancelled", "skipped"].filter(k => n[k]).map(k => `${n[k]} ${CK[k].word}`).join(" · ") || "No checks";
  const passCount = r.checks.filter(c => c.state === "pass").length;
  const shown = r.checks.filter(c => c.state !== "skipped" && (view.allChecks || c.state !== "pass" || passCount <= 6));
  const hiddenPass = passCount - shown.filter(c => c.state === "pass").length;
  const sections = prSections(pr.body);
  const brief = view.fullBody ? sections : clipSections(sections, 1400);
  const longBody = brief !== sections;
  const fact = (k, v) => row().gap(SP.md).items_center().child(div().w(64).flex_none().text_size(TYPE.meta).text_color(t.muted).child(k)).child(div().flex_1().min_w(0).text_size(TYPE.ui).text_color(t.foreground).child(v));
  const label = text => div().text_size(TYPE.meta).font_semibold().text_color(t.muted).child(text);
  const mapNote = node ? [node.label.replace(/^#\d+\s*/, ""), ...(node.badges ?? [])].filter(Boolean).join(" · ") : null;
  return v_flex()
    .gap(SP.xl)
    .child(
      v_flex()
        .gap(SP.sm)
        .child(
          h_flex()
            .gap(SP.sm)
            .items_center()
            .child(icon(null, 17, stateColor, "mods/hq/icons/git-pull-request.svg"))
            .child(div().flex_none().text_size(TYPE.heading).font_semibold().font_family(mono()).text_color(stateColor).child(`#${pr.number}`)),
        )
        .child(div().text_size(TYPE.title).font_semibold().line_height(1.4).text_color(t.foreground).child(pr.title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")))
        .when(!!mapNote, el => el.child(div().text_size(TYPE.meta).text_color(t.muted).child(`On the map: ${mapNote}`)))
        .child(
          h_flex()
            .gap(SP.sm)
            .flex_wrap()
            .items_center()
            .child(chip(t, stateWord, stateColor))
            .when(pr.mergeable === "CONFLICTING", el => el.child(chip(t, "Conflicts with its base", t.blocked)))
            .when(pr.reviewDecision === "APPROVED", el => el.child(chip(t, "Approved", ok(t))))
            .when(pr.reviewDecision === "CHANGES_REQUESTED", el => el.child(chip(t, "Changes requested", t.blocked)))
            .child(div().text_size(TYPE.meta).text_color(t.muted).child(`+${pr.additions} −${pr.deletions} · ${pr.changedFiles} files`)),
        )
        .child(fact("Branch", div().font_family(mono()).text_size(TYPE.meta).child(`${pr.headRefName} → ${pr.baseRefName}`)))
        .when(!!r.author, el => el.child(fact("Author", r.author)))
        .child(
          h_flex()
            .gap(SP.sm)
            .items_center()
            .pt(SP.xs)
            .child(btn(t, "pr-open", "Open on GitHub", () => exec("open", [pr.url]).catch(() => {}), { size: "sm", icon: "external" }))
            .child(btn(t, "pr-refresh", st.loading ? "Refreshing…" : "Refresh", cx => loadPr(view, num, cx, true), { size: "sm", kind: "ghost", icon: "redo", disabled: st.loading }))
            .child(div().text_size(TYPE.meta).text_color(t.muted).child(st.at ? `updated ${ago(st.at, Date.now())}` : "")),
        ),
    )
    .child(
      v_flex()
        .gap(6)
        .child(
          h_flex()
            .gap(SP.sm)
            .items_center()
            .child(label("Checks"))
            .child(div().flex_1().min_w(0).text_size(TYPE.meta).text_color(n.fail ? t.blocked : n.running ? t.working : t.muted).child(summary))
            .when(hiddenPass > 0 || (view.allChecks && passCount > 6), el =>
              el.child(
                div()
                  .id("pr-all-checks")
                  .flex_none()
                  .text_size(TYPE.meta)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover(s => s.text_color(t.foreground))
                  .on_click((_e, cx) => ((view.allChecks = !view.allChecks), cx.notify()))
                  .child(hiddenPass > 0 ? `Show ${hiddenPass} passed` : "Hide passed"),
              ),
            ),
        )
        .children(
          shown.map((c, i) =>
            row()
              .id(`pr-check-${i}`)
              .py(4)
              .gap(SP.sm)
              .items_start()
              .rounded(6)
              .when(!!c.url, el => el.cursor_pointer().hover(s => s.bg(alpha(t.foreground, 0.04))).on_click(() => exec("open", [c.url]).catch(() => {})))
              .child(div().flex_none().h(16).flex().items_center().child(CK[c.state]?.glyph() ?? icon("clock", 12, t.muted)))
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(1)
                  .child(div().min_w(0).truncate().text_size(TYPE.ui).text_color(t.foreground).child(c.workflow && c.workflow !== c.name ? `${c.workflow} / ${c.name}` : c.name))
                  .when(!!c.step?.name, el =>
                    el.child(
                      div()
                        .text_size(TYPE.meta)
                        .text_color(c.state === "fail" ? t.blocked : t.working)
                        .child(`${c.state === "fail" ? "Failed at" : "Now at"} step ${c.step.index}${c.step.total ? ` of ${c.step.total}` : ""}: ${c.step.name}`),
                    ),
                  ),
              ),
          ),
        )
    )
    .when(sections.length > 0, el =>
      el.child(
        v_flex()
          .gap(SP.sm)
          .child(label("Description"))
          .children(
            brief.map((sec, i) =>
              v_flex()
                .gap(4)
                .when(i > 0 && !!sec.title, e2 => e2.pt(SP.sm))
                .when(!!sec.title, e2 => e2.child(div().text_size(TYPE.title).font_semibold().text_color(t.foreground).child(sec.title)))
                .when(!!sec.text, e2 => e2.child(mdBlock(t, `pr-body-${pr.number}-${i}-${view.fullBody ? 1 : 0}`, sec.text, { maxW: 520, size: 13 }))),
            ),
          )
          .when(longBody || (view.fullBody && clipSections(sections, 1400) !== sections), e2 =>
            e2.child(
              div()
                .id("pr-body-more")
                .text_size(TYPE.meta)
                .text_color(t.muted)
                .cursor_pointer()
                .hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => ((view.fullBody = !view.fullBody), cx.notify()))
                .child(view.fullBody ? "Show less" : "Show the whole description"),
            ),
          ),
      ),
    );
}

/** A PR body as [{ title, text }] sections, split at its headings. The panel draws the headings
 *  itself (TextView's are body-sized, so "## What" read as a plain line), and the HTML GitHub
 *  renders but TextView can't (comments, <details>, <br>, images) is reduced to Markdown. */
function prSections(body) {
  const text = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi, "**$1**\n")
    .replace(/<\/?details[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<img[^>]*>/gi, "")
    .replace(/^.*Generated with \[Claude Code\].*$/gm, "")
    .replace(/\r/g, "");
  const out = [];
  let cur = { title: null, lines: [] };
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(cur);
      cur = { title: h[1].replace(/[`*_]/g, ""), lines: [] };
    } else cur.lines.push(line);
  }
  out.push(cur);
  return out.map(s => ({ title: s.title, text: s.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() })).filter(s => s.title || s.text);
}

/** The first `budget` characters of the sections, cut only between blocks (never inside a list,
 *  a code fence or a code span). Returns the same array when nothing was cut. */
function clipSections(sections, budget) {
  const out = [];
  let used = 0;
  for (const sec of sections) {
    const blocks = [];
    let open = "";
    for (const part of sec.text.split(/\n{2,}/)) {
      open = open ? `${open}\n\n${part}` : part;
      if (((open.match(/^\s*(```|~~~)/gm) ?? []).length % 2) === 0) {
        blocks.push(open);
        open = "";
      }
    }
    if (open) blocks.push(open);
    const kept = [];
    for (const b of blocks) {
      if (used > 0 && used + b.length > budget) break;
      kept.push(b);
      used += b.length;
    }
    if (kept.length) out.push({ title: sec.title, text: kept.join("\n\n") });
    if (kept.length < blocks.length || used >= budget) {
      return out.length === sections.length && kept.length === blocks.length ? sections : out;
    }
  }
  return sections;
}

/** A PR node's number: from its label ("#5329 …"), its subtitle, or a /pull/N link in its files. */
export function prNumber(n) {
  const m = /#(\d{2,7})\b/.exec(n.label ?? "") ?? /#(\d{2,7})\b/.exec(n.subtitle ?? "") ?? /\/pull\/(\d+)/.exec(JSON.stringify(n.files ?? []));
  return m ? Number(m[1]) : null;
}
