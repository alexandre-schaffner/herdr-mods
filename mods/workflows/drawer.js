// The node drawer: its sessions as a timeline, then one session's prompt, transcript and result.

import { h_flex, TextView, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { glyph } from "./graph.js";
import { transcript } from "./transcript.js";
import { iconBtn } from "./ui.js";
import {
  alpha,
  clip,
  compact,
  duration,
  icon,
  kindColor,
  look,
  mix,
  mono,
  ok,
  scrollArea,
  sessionSpan,
  shortModel,
} from "./util.js";
import { openLink } from "./viewer.js";

export const DRAWER_W = 460;

function chip(text, fg, bg, t, id) {
  return div()
    .when(!!id, el => el.id(id))
    .flex_none()
    .px(7)
    .h(19)
    .rounded(6)
    .bg(bg)
    .text_size(10.5)
    .text_color(fg)
    .flex()
    .items_center()
    .child(text);
}

function stat(label, value, t) {
  return v_flex()
    .flex_1()
    .min_w(0)
    .gap(3)
    .px(12)
    .py(10)
    .rounded(10)
    .bg(alpha(t.foreground, 0.035))
    .border(1)
    .border_color(alpha(t.border, 0.7))
    .child(div().text_size(10).text_color(t.dim).child(label.toUpperCase()))
    .child(div().font_family(mono()).text_size(14).font_semibold().text_color(t.foreground).truncate().child(value));
}

function sessionRow(s, i, last, t, selected, onPick, now) {
  const lk = look(s.state, t);
  const kc = kindColor(s.kind, t);
  const meta = [
    duration(sessionSpan(s, now)),
    s.tokens != null ? `${compact(s.tokens)} tok` : null,
    s.toolCalls != null ? `${s.toolCalls} tools` : null,
    s.attempt > 1 ? `attempt ${s.attempt}` : null,
    s.cached ? "cached" : null,
  ].filter(Boolean);
  const detail = s.error
    ? div().text_size(11).text_color(t.blocked).child(clip(s.error, 160))
    : s.waiting
      ? h_flex()
          .gap(6)
          .min_w(0)
          .child(
            div()
              .flex_none()
              .font_family(mono())
              .text_size(10.5)
              .text_color(t.working)
              .child(`${s.waiting.tool} · waiting ${s.waiting.since ? duration(now - s.waiting.since) : ""}`),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(10.5)
              .text_color(t.muted)
              .child(s.waiting.description ?? s.waiting.summary ?? ""),
          )
      : s.lastToolName
        ? h_flex()
            .gap(6)
            .min_w(0)
            .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.accent).child(s.lastToolName))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .font_family(mono())
                .text_size(10.5)
                .text_color(t.muted)
                .child(s.lastToolSummary ?? ""),
            )
        : null;
  return h_flex()
    .id(`sess-${s.agentId}`)
    .items_start()
    .gap(12)
    .child(
      v_flex()
        .flex_none()
        .w(16)
        .items_center()
        .h_full()
        .child(
          div()
            .w(2)
            .h(14)
            .bg(i === 0 ? alpha(t.border, 0) : alpha(t.border, 1)),
        )
        .child(
          div()
            .w(10)
            .h(10)
            .rounded_full()
            .bg(lk.key === "queued" ? t.background : lk.color)
            .border(2)
            .border_color(lk.color)
            .when(lk.key === "running", el => el.loop("opacity", { from: 0.3, to: 1, period: 900 })),
        )
        .child(
          div()
            .w(2)
            .flex_1()
            .min_h(10)
            .bg(last ? alpha(t.border, 0) : alpha(t.border, 1)),
        ),
    )
    .child(
      v_flex()
        .id(`sess-card-${s.agentId}`)
        .flex_1()
        .min_w(0)
        .mb(10)
        .p(12)
        .gap(7)
        .rounded(11)
        .bg(selected ? mix(t.background, t.accent, 0.09) : t.background)
        .border(1)
        .border_color(selected ? t.accent : t.border)
        .cursor_pointer()
        .hover(st => st.border_color(selected ? t.accent : alpha(t.accent, 0.5)))
        .on_click((_e, cx) => onPick(s.agentId, cx))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .child(chip(s.kind, kc, alpha(kc, 0.14), t))
            .child(
              div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11).text_color(t.muted).child(s.label),
            )
            .when(!!s.model, el => el.child(chip(shortModel(s.model), t.muted, alpha(t.foreground, 0.06), t)))
            .child(
              h_flex()
                .flex_none()
                .gap(5)
                .items_center()
                .child(div().text_size(11).text_color(lk.color).child(lk.label)),
            ),
        )
        .child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(meta.join("  ·  ")))
        .when(!!detail, el => el.child(detail)),
    );
}

function tabs(active, t, onTab) {
  const item = (id, label) =>
    div()
      .id(`tab-${id}`)
      .px(11)
      .h(26)
      .rounded(7)
      .flex()
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .when(active === id, el => el.bg(t.background).text_color(t.foreground).font_medium().shadow_sm())
      .when(active !== id, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => onTab(id, cx))
      .child(label);
  return h_flex()
    .p(3)
    .gap(2)
    .rounded(9)
    .bg(alpha(t.foreground, 0.05))
    .child(item("transcript", "Transcript"))
    .child(item("prompt", "Prompt"))
    .child(item("result", "Result"));
}

function codeBlock(text, t, id) {
  return div()
    .id(id)
    .p(12)
    .rounded(9)
    .bg(alpha(t.foreground, 0.04))
    .border(1)
    .border_color(alpha(t.border, 0.8))
    .font_family(mono())
    .text_size(11)
    .line_height(1.5)
    .text_color(t.foreground)
    .child(text);
}

export function sessionBody(s, state, tab, t, tx) {
  if (tab === "prompt") {
    const text = state?.data?.prompt || s.promptPreview || "No prompt recorded.";
    return div()
      .text_size(12.5)
      .line_height(1.55)
      .text_color(t.foreground)
      .child(TextView.markdown(`prompt-${s.agentId}`, text).on_link_click(url => openLink(url, state?.data?.cwd)));
  }
  if (tab === "result") {
    if (s.error) return codeBlock(s.error, t, `res-${s.agentId}`);
    let text = s.resultPreview || "";
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // previews are cut at ~1 KB, so most are not valid JSON; show them raw
    }
    const output = state?.data?.items?.filter(i => i.kind === "output").pop();
    return codeBlock(output?.text || text || "No result yet.", t, `res-${s.agentId}`);
  }
  if (state?.error) return div().text_size(12).text_color(t.blocked).child(state.error);
  if (!state?.data) {
    return h_flex()
      .gap(8)
      .items_center()
      .py(20)
      .justify_center()
      .child(icon("spinner", 14, t.muted).spin(900))
      .child(div().text_size(12).text_color(t.muted).child("Reading transcript…"));
  }
  return transcript(state.data, t, { ...tx, running: look(s.state, t).key === "running", prefix: `tx-${s.agentId}` });
}

/** `onClose`, `onPick(agentId)`, `onTab(id)` take `(…, cx)`. */
export function drawer(node, t, ui, now) {
  if (!node) return div();
  const lk = node.look;
  const total = node.sessions.reduce((sum, s) => sum + (sessionSpan(s, now) ?? 0), 0);
  const picked = node.sessions.find(s => s.agentId === ui.session);
  return v_flex()
    .id("drawer")
    .w(DRAWER_W)
    .flex_1()
    .min_h(0)
    .bg(t.chrome ?? t.surface)
    .border_l(1)
    .border_color(t.border)
    .child(
      v_flex()
        .flex_none()
        .px(20)
        .pt(18)
        .pb(16)
        .gap(14)
        .border_b(1)
        .border_color(alpha(t.border, 0.8))
        .child(
          h_flex()
            .items_start()
            .gap(12)
            .child(glyph(lk, t, 34))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(3)
                .child(
                  div()
                    .font_family(mono())
                    .text_size(10)
                    .text_color(t.dim)
                    .child(`PHASE ${String(node.lane).padStart(2, "0")} · ${node.phase.toUpperCase()}`),
                )
                .child(div().text_size(19).font_semibold().text_color(t.foreground).truncate().child(node.title)),
            )
            .child(
              div()
                .id("drawer-close")
                .flex_none()
                .w(28)
                .h(28)
                .rounded(8)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(s => s.bg(alpha(t.foreground, 0.08)))
                .on_click((_e, cx) => ui.onClose(cx))
                .child(icon("x", 14, t.muted)),
            ),
        )
        .child(
          h_flex()
            .gap(8)
            .child(stat("Sessions", String(node.sessions.length), t))
            .child(stat("Time", duration(total), t))
            .child(stat("Tokens", node.tokens ? compact(node.tokens) : "—", t))
            .child(stat("Tools", node.tools ? String(node.tools) : "—", t)),
        ),
    )
    .child(
      scrollArea(
        "drawer-body",
        "y",
        v_flex()
          .px(20)
          .pt(16)
          .pb(24)
          .child(div().text_size(10).text_color(t.dim).mb(10).child("SESSIONS"))
          .children(
            node.sessions.map((s, i) =>
              sessionRow(s, i, i === node.sessions.length - 1, t, s.agentId === ui.session, ui.onPick, now),
            ),
          )
          .when(!!picked && !ui.reader, el =>
            el.child(
              v_flex()
                .mt(8)
                .gap(14)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(tabs(ui.tab, t, ui.onTab))
                    .child(
                      h_flex()
                        .gap(4)
                        .items_center()
                        .child(div().font_family(mono()).text_size(10).text_color(t.dim).child(picked.agentId))
                        .child(iconBtn(t, "drawer-term", "terminal", cx => ui.onTerminal(picked.agentId, cx), "Open its terminal"))
                        .child(iconBtn(t, "reader-open", "expand", cx => ui.onReader(cx), "Read wide")),
                    ),
                )
                .child(
                  sessionBody(
                    picked,
                    ui.transcript?.agentId === picked.agentId ? ui.transcript : null,
                    ui.tab,
                    t,
                    ui.tx,
                  ),
                ),
            ),
          ),
      ),
    );
}
