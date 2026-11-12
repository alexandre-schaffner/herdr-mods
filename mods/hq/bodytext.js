// Inbox bodies as readable Markdown. Agents often file one long line ("… Options: (1) …; (2) ….
// Recommendation: (1), …") because shell quotes lose line breaks. Bodies that already have
// structure pass through untouched; a single line is split into short paragraphs, its options
// become a numbered list and the recommendation its own line. `options()` returns the choices,
// so a question can be answered with one click.

const OPT = /(?:^|[\s;:,])\((\d{1,2})\)\s+/g;

/** The body's options as [{ n, text }], from "(1) …" items or a Markdown "1. …" list. */
export function options(body) {
  const text = body ?? "";
  const list = [...text.matchAll(/^\s*(\d{1,2})[.)]\s+(.+)$/gm)].map(m => ({ n: Number(m[1]), text: m[2].trim() }));
  if (list.length >= 2) return list;
  const marks = [...text.matchAll(OPT)];
  if (marks.length < 2) return [];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    let opt = text.slice(start, end).trim();
    // The last option ends where the recommendation (or the next sentence group) starts.
    opt = opt.split(/\s+(?:Recommendation|Recommended|I recommend|My recommendation)\b/i)[0];
    out.push({ n: Number(marks[i][1]), text: opt.replace(/[;,.]\s*$/, "").trim() });
  }
  return out;
}

/** A one-line body as Markdown paragraphs; anything already multi-line is returned as is. */
export function structure(body) {
  const text = (body ?? "").trim();
  if (!text || text.includes("\n")) return text;
  let head = text;
  let rec = "";
  const r = /\s+(Recommendation|Recommended|My recommendation|I recommend)\s*:?\s*/i.exec(head);
  if (r) {
    rec = head.slice(r.index + r[0].length).trim();
    head = head.slice(0, r.index).trim();
  }
  let opts = "";
  const marks = [...head.matchAll(OPT)];
  if (marks.length >= 2) {
    const lead = head.slice(0, marks[0].index).replace(/\s*Options?\s*:?\s*$/i, "").trim();
    const items = options(head);
    opts = items.map(o => `${o.n}. ${o.text}`).join("\n");
    head = lead;
  }
  const paras = sentences(head);
  return [paras, opts && `**Options**\n\n${opts}`, rec && `**Recommendation:** ${rec}`].filter(Boolean).join("\n\n");
}

/** Sentences grouped into paragraphs of about two or three. */
function sentences(text) {
  // Split only at ". " before a capital or an opening mark: "campaignStatus.computedUntil" stays whole.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(*'"`\d])/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let cur = [];
  let len = 0;
  for (const s of parts) {
    cur.push(s);
    len += s.length;
    if (cur.length >= 3 || len > 260) {
      out.push(cur.join(" "));
      cur = [];
      len = 0;
    }
  }
  if (cur.length) out.push(cur.join(" "));
  return out.join("\n\n");
}
