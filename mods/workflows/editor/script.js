// A hand-written script in the editor: read as a graph, its selected agent() call, and the
// edits made to that call in place.

import { callPanel } from "../codegraph.js";
import { editable, editCall, scriptGraph } from "../scriptgraph.js";

/** A hand-written script read as a graph, re-read only when its text changes. */
export function parsed(ed) {
  const src = ed.code();
  if (ed._parsedSrc !== src) {
    ed._parsed = scriptGraph(src);
    ed._parsedSrc = src;
  }
  return ed._parsed;
}

export function pickCall(ed, cx, id) {
  ed.call = ed.call === id ? null : id;
  bindCall(ed);
  cx.notify();
}

function callStep(ed) {
  return ed.call ? parsed(ed).lanes.flatMap(l => l.steps).find(x => x.id === ed.call) : null;
}

/** The selected call's text fields; they write back when they lose focus. */
export function bindCall(ed) {
  for (const k of [...ed.f.keys()])
    if (k.startsWith("call:")) {
      ed.f.get(k).release();
      ed.f.delete(k);
    }
  const s = callStep(ed);
  if (!s) return;
  if (editable(s, "label"))
    ed.text(`call:${s.id}:label`, () => (s.at.label ? s.title : ""), null, {
      placeholder: "plan, review, gate…",
      blur: (v, cx) => patchCall(ed, cx, s.id, "label", v.trim()),
      submit: cx => patchCall(ed, cx, s.id, "label", ed.f.get(`call:${s.id}:label`).value().trim()),
    });
  if (editable(s, "prompt"))
    ed.text(`call:${s.id}:prompt`, () => s.promptText, null, {
      multiline: true,
      grow: [8, 24],
      blur: (v, cx) => patchCall(ed, cx, s.id, "prompt", v),
    });
}

/** Changes one option of one agent() call in the script, leaving the rest as written. */
function patchCall(ed, cx, id, key, value) {
  const src = ed.code();
  const s = parsed(ed).lanes.flatMap(l => l.steps).find(x => x.id === id);
  if (!s) return;
  if (key === "prompt" ? value === s.promptText : key === "label" ? value === (s.at.label ? s.title : "") : value === s[key])
    return;
  const next = editCall(src, s, key, value);
  if (next == null || next === src) return;
  ed.snapshot();
  ed.raw = next;
  ed.codeState?.set_value(next);
  ed.notice = null;
  cx.notify();
}

/** The selected call's panel beside the script's graph, or null with none selected. */
export function callInspector(ed, t) {
  const s = callStep(ed);
  if (!s) return null;
  return callPanel(t, s, {
    onClose: cx => pickCall(ed, cx, null),
    showCode: cx => ed.setView(cx, "code"),
    set: (key, value, cx) => patchCall(ed, cx, s.id, key, value),
    can: key => editable(s, key),
    input: key => ed.input(t, `call:${s.id}:${key}`, key === "prompt" ? { multiline: true, size: 12 } : {}),
    phases: parsed(ed).lanes.map(l => l.title).filter(x => x !== "Other" && x !== "Agents"),
  });
}
