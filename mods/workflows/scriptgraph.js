// A hand-written Workflow script read as a graph, without running it: its meta phases are
// lanes and every agent() call site is a node, with the label, phase and options written
// there. Labels built at run time show their fixed part ("status:${id}" is "status"); a call
// inside pipeline/map/Array.from is marked as fanned out, one inside for/while/do as looping,
// one behind an if or ?: as conditional.

import { metaOf } from "./model.js";

/** The script with every string, template, comment and regex body blanked to spaces, so
 * brackets and words in it are code. Same length, newlines kept. */
function codeMask(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // `stack` holds what an unmatched `}` closes: "{" a block, or "${" a template expression.
  const stack = [];
  let i = 0;
  let prev = ""; // last significant code character, to tell a regex from a division
  const skipString = (q, at) => {
    let k = at + 1;
    while (k < n && src[k] !== q && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
    return Math.min(k + 1, n);
  };
  // From inside a template's text: to its closing backtick, or into a `${` expression.
  const templateText = at => {
    let k = at;
    while (k < n) {
      if (src[k] === "\\") k += 2;
      else if (src[k] === "`") return { end: k + 1, expr: false };
      else if (src[k] === "$" && src[k + 1] === "{") return { end: k + 2, expr: true };
      else k++;
    }
    return { end: n, expr: false };
  };
  const enterTemplate = from => {
    const r = templateText(from);
    blank(from, r.expr ? r.end - 2 : r.end - 1);
    if (r.expr) stack.push("${");
    i = r.end;
    prev = r.expr ? "{" : "`";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      blank(i, e < 0 ? n : e + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"') {
      const e = skipString(c, i);
      blank(i + 1, e - 1);
      i = e;
      prev = c;
    } else if (c === "`") {
      enterTemplate(i + 1);
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let k = i + 1;
      let cls = false;
      while (k < n && src[k] !== "\n" && (cls || src[k] !== "/")) {
        if (src[k] === "\\") k++;
        else if (src[k] === "[") cls = true;
        else if (src[k] === "]") cls = false;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      prev = "/";
    } else if (c === "{") {
      stack.push("{");
      i++;
      prev = c;
    } else if (c === "}") {
      if (stack.pop() === "${") enterTemplate(i + 1);
      else {
        i++;
        prev = c;
      }
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join("");
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** For each bracket in the masked script, where it closes (`close[i]`), and for each position
 * the brackets it sits in, innermost last (`at(i)`). */
function brackets(mask) {
  const close = new Map();
  const opens = []; // [start, end] of every bracket pair
  const st = [];
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (OPEN[c]) st.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const o = st.pop();
      if (o !== undefined) {
        close.set(o, i);
        opens.push([o, i]);
      }
    }
  }
  opens.sort((a, b) => a[0] - b[0]);
  return { close, at: i => opens.filter(([o, e]) => o < i && e > i) };
}

/** `text` split at its top-level commas (inside the masked `mask` of the same range); each
 * part knows where it sits in the script (`start`, `end`), `base` being where `text` starts. */
function splitTop(text, mask, base = 0) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (OPEN[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, mask.length]);
  return parts
    .map(([a, b]) => ({ text: text.slice(a, b), mask: mask.slice(a, b), start: base + a, end: base + b }))
    .filter(p => p.text.trim());
}

/** A part with its surrounding whitespace and comments dropped (read from the mask, where
 * comments are blank), keeping where it sits. */
function trimmed(p) {
  const lead = p.mask.length - p.mask.trimStart().length;
  const len = p.mask.trim().length;
  return { text: p.text.slice(lead, lead + len), mask: p.mask.slice(lead, lead + len), start: p.start + lead, end: p.start + lead + len };
}

/** `{ key: value, ... }` as key → the value (text, mask, start, end) and `whole`, the entry's
 * range between its commas. Shorthand and spread entries are skipped. */
function props(obj) {
  const o = trimmed(obj);
  const out = {};
  for (const p of splitTop(o.text.slice(1, -1), o.mask.slice(1, -1), o.start + 1)) {
    const m = p.mask.match(/^\s*(['"]?)([\w$]+)\1\s*:/) ?? p.text.match(/^\s*(['"])([\w$]+)\1\s*:/);
    if (!m) continue;
    const value = trimmed({ text: p.text.slice(m[0].length), mask: p.mask.slice(m[0].length), start: p.start + m[0].length });
    out[m[2]] = { ...value, whole: { start: p.start, end: p.end } };
  }
  return out;
}

const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

/** The escape sequence at `s[k]` (a backslash): what it stands for and where it ends. A line
 * continuation stands for nothing; an unknown escape for the character itself. */
function readEscape(s, k) {
  const c = s[k + 1] ?? "";
  if (c in SIMPLE_ESCAPES) return { text: SIMPLE_ESCAPES[c], end: k + 2 };
  if (c === "\r") return { text: "", end: s[k + 2] === "\n" ? k + 3 : k + 2 };
  if (c === "\n" || c === "\u2028" || c === "\u2029") return { text: "", end: k + 2 };
  if (c === "0" && !/[0-9]/.test(s[k + 2] ?? "")) return { text: "\0", end: k + 2 };
  if (c === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(k + 2, k + 4)))
    return { text: String.fromCharCode(parseInt(s.slice(k + 2, k + 4), 16)), end: k + 4 };
  if (c === "u" && s[k + 2] === "{") {
    const close = s.indexOf("}", k + 3);
    const hex = close < 0 ? "" : s.slice(k + 3, close);
    if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff)
      return { text: String.fromCodePoint(parseInt(hex, 16)), end: close + 1 };
  }
  if (c === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(k + 2, k + 6)))
    return { text: String.fromCharCode(parseInt(s.slice(k + 2, k + 6), 16)), end: k + 6 };
  return { text: c, end: k + 2 };
}

/** The string or template literal opening at `s[at]`: where it ends, and its text (escapes
 * decoded) with each interpolation as "…". */
function readLiteral(s, at) {
  const q = s[at];
  let text = "";
  let k = at + 1;
  let dynamic = false;
  while (k < s.length && s[k] !== q) {
    if (s[k] === "\\") {
      const e = readEscape(s, k);
      text += e.text;
      k = e.end;
    } else if (q === "`" && s[k] === "$" && s[k + 1] === "{") {
      let depth = 1;
      k += 2;
      while (k < s.length && depth) {
        if ("'\"`".includes(s[k])) k = readLiteral(s, k).end;
        else {
          if (s[k] === "{") depth++;
          else if (s[k] === "}") depth--;
          k++;
        }
      }
      text += "…";
      dynamic = true;
    } else if (q === "`" && s[k] === "\r") {
      // A template reads a line break written CRLF or CR as LF.
      text += "\n";
      k += s[k + 1] === "\n" ? 2 : 1;
    } else text += s[k++];
  }
  return { end: k + 1, text, dynamic };
}

/** The first string or template literal in an expression: its text, where it sits (`start`,
 * `end`, when the expression knows its place), whether it interpolates (`interp`), and whether
 * the expression adds anything to it (`dynamic`: an interpolation, a concatenation, a call). */
function literal(expr) {
  const s = expr.text.trim();
  const base = expr.start === undefined ? undefined : expr.start + (expr.text.length - expr.text.trimStart().length);
  const at = s.search(/['"`]/);
  if (at < 0) return { text: "", dynamic: true, interp: false };
  const r = readLiteral(s, at);
  return {
    text: r.text,
    interp: r.dynamic,
    dynamic: r.dynamic || (s.slice(0, at) + s.slice(r.end)).trim() !== "",
    ...(base === undefined ? {} : { start: base + at, end: base + r.end }),
  };
}

/** An option written as a plain string; anything computed is "" (it's decided at run time). */
const word = v => (v && /^(['"`])[^'"`$]*\1$/.test(v.text.trim()) ? v.text.trim().slice(1, -1) : "");

/**
 * `{ name, description, lanes: [{ title, steps: [step] }] }`, where a step is
 * `{ id, title, label, line, phase, model, effort, schema, agentType, isolation, each, loop,
 *    cond, prompt }`. `label` is the label as written; `title` its fixed part.
 */
export function scriptGraph(script) {
  const src = String(script ?? "");
  const mask = codeMask(src);
  const { close, at } = brackets(mask);
  const lineOf = i => src.slice(0, i).split("\n").length;
  const meta = metaOf(src);

  const phaseCalls = [...mask.matchAll(/(^|[^\w$.])phase\s*\(/g)].map(m => {
    const open = m.index + m[0].length - 1;
    const end = close.get(open) ?? open;
    return { at: open, title: literal({ text: src.slice(open + 1, end) }).text };
  });
  const phaseAt = i => phaseCalls.filter(p => p.at < i).pop()?.title ?? "";

  // What a bracket opened at `o` means for calls inside it.
  const before = o => mask.slice(Math.max(0, o - 60), o).replace(/\s+$/, "");
  const headOf = o => {
    // A block's `{` after `for (...)`, `while (...)` or `if (...)`: the word before that `(`.
    const b = before(o);
    if (/\bdo$/.test(b)) return "loop";
    if (/\belse$/.test(b)) return "cond";
    if (!b.endsWith(")")) return null;
    const end = mask.lastIndexOf(")", o);
    for (const [s, e] of close) if (e === end) {
      const w = before(s);
      if (/\b(for|while)$/.test(w)) return "loop";
      if (/\bif$/.test(w)) return "cond";
    }
    return null;
  };

  const steps = [];
  for (const m of mask.matchAll(/(^|[^\w$.])agent\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    if (/\bfunction\s*$/.test(mask.slice(Math.max(0, m.index - 12), m.index + m[1].length))) continue;
    const end = close.get(open);
    if (end === undefined) continue;
    const args = splitTop(src.slice(open + 1, end), mask.slice(open + 1, end), open + 1);
    const last = args.length > 1 ? args[args.length - 1] : null;
    const opts = last && last.mask.trim().startsWith("{") ? props(last) : {};

    let each = false;
    let loop = false;
    let cond = false;
    for (const [o] of at(open)) {
      const b = before(o);
      // Once per item: a pipeline, a map, Array.from. A parallel([...]) of different calls isn't.
      if (mask[o] === "(" && (/\bpipeline$/.test(b) || /\.(map|flatMap|forEach)$/.test(b) || /\bArray\.from$/.test(b))) each = true;
      if (mask[o] === "(" && /\b(for|while)$/.test(b)) loop = true;
      if (mask[o] === "{") {
        const h = headOf(o);
        if (h === "loop") loop = true;
        if (h === "cond") cond = true;
      }
    }
    // `if (x) R.a = await agent(...)` or `x ? agent(...) : ...` without a block.
    const stmt = mask.slice(Math.max(0, open - 300), open);
    const tail = stmt.slice(Math.max(stmt.lastIndexOf(";"), stmt.lastIndexOf("{"), stmt.lastIndexOf("}")) + 1);
    if (/\bif\s*\(|\?/.test(tail)) cond = true;

    const label = opts.label ? literal(opts.label) : { text: "", dynamic: false, interp: false };
    const fixed = label.text.split(/[:#]|…/)[0].trim();
    const title = !label.text ? "agent" : label.dynamic ? fixed || label.text : label.text;
    const prompt = args[0] ? literal(args[0]) : { text: "", interp: true };
    const schema = opts.schema
      ? opts.schema.mask.trim().startsWith("{")
        ? "inline"
        : opts.schema.text.trim()
      : "";
    const range = k => (opts[k] ? { start: opts[k].start, end: opts[k].end, whole: opts[k].whole, plain: !!word(opts[k]) || literal(opts[k]).dynamic === false } : null);
    steps.push({
      id: `call-${steps.length}`,
      // Where the call's pieces are, for editCall(): a value is editable when it's absent or
      // written as a plain string.
      at: {
        close: end,
        opts: last && last.mask.trim().startsWith("{") ? { start: trimmed(last).start, end: trimmed(last).end } : null,
        model: range("model"),
        effort: range("effort"),
        phase: range("phase"),
        label: range("label"),
        prompt: prompt.start !== undefined && !prompt.interp ? { start: prompt.start, end: prompt.end } : null,
      },
      title,
      label: opts.label ? opts.label.text.trim() : "",
      line: lineOf(m.index + m[1].length),
      phase: opts.phase ? literal(opts.phase).text || word(opts.phase) : phaseAt(open),
      model: word(opts.model),
      effort: word(opts.effort),
      agentType: word(opts.agentType ?? opts.subagent_type),
      isolation: word(opts.isolation),
      schema,
      each,
      loop,
      cond,
      prompt: prompt.text.replace(/^[\s…]+/, "").trim(),
      promptText: prompt.text,
      // Options as written, for what's computed at run time (effort: u.effort).
      written: Object.fromEntries(["model", "effort", "phase", "label"].filter(k => opts[k]).map(k => [k, opts[k].text])),
    });
  }

  const titles = [...meta.phases];
  for (const s of steps) if (s.phase && !titles.includes(s.phase)) titles.push(s.phase);
  const lanes = titles.map(title => ({ title, steps: steps.filter(s => s.phase === title) }));
  const loose = steps.filter(s => !s.phase);
  if (loose.length) lanes.push({ title: titles.length ? "Other" : "Agents", steps: loose });
  return { name: meta.name, description: meta.description, lanes };
}

const EDITABLE = ["model", "effort", "phase", "label"];

/** Whether `key` of a parsed call can be changed in place: absent, or written as a plain string. */
export function editable(step, key) {
  if (key === "prompt") return !!step.at.prompt;
  const v = step.at[key];
  return EDITABLE.includes(key) && (!v || v.plain);
}

/** `text` as a template literal that reads back as exactly `text`: backslashes, backticks and
 * `${` escaped, and a carriage return written `\r` (a template would read it as a newline). */
const asTemplate = text =>
  "`" +
  String(text)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${")
    .replace(/\r/g, "\\r") +
  "`";

/** The last code character before `at` (not space, not a comment), searching back to `floor`. */
function lastCode(mask, at, floor) {
  let k = at - 1;
  while (k > floor && /\s/.test(mask[k])) k--;
  return k;
}

/**
 * The script with one option of one agent() call changed, touching nothing else: `key` is
 * model, effort, phase or label (value "" removes it) or prompt (its literal is rewritten).
 * `step` comes from scriptGraph(src). Returns null when that piece is computed in code.
 */
export function editCall(src, step, key, value) {
  if (!editable(step, key)) return null;
  const splice = (a, b, text) => src.slice(0, a) + text + src.slice(b);
  if (key === "prompt") return splice(step.at.prompt.start, step.at.prompt.end, asTemplate(value));
  const v = step.at[key];
  const lit = JSON.stringify(String(value));
  if (v && value !== "") return splice(v.start, v.end, lit);
  if (v) {
    // Remove the entry with one of its commas.
    const { start, end } = v.whole;
    if (src[end] === ",") return splice(start, end + 1, "");
    if (src[start - 1] === ",") return splice(start - 1, end, "");
    return splice(start, end, "");
  }
  if (value === "") return src;
  // Comments are blanked in the mask, so the new entry goes after the last code, before any
  // trailing `// comment` that would otherwise swallow it.
  const mask = codeMask(src);
  const o = step.at.opts;
  if (!o) {
    const k = lastCode(mask, step.at.close, -1);
    const entry = `{ ${key}: ${lit} }`;
    return src[k] === "," ? splice(k + 1, k + 1, ` ${entry}`) : splice(k + 1, k + 1, `, ${entry}`);
  }
  const k = lastCode(mask, o.end - 1, o.start); // o.end - 1 is the closing brace
  if (k === o.start) return splice(o.start + 1, o.start + 1, ` ${key}: ${lit} `);
  return src[k] === "," ? splice(k + 1, k + 1, ` ${key}: ${lit}`) : splice(k + 1, k + 1, `, ${key}: ${lit}`);
}
