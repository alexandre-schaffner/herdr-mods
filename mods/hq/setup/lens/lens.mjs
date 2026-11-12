// PR Lens for HQ: validate an org/work graph body and render it to SVG.
//
//   node lens.mjs <body.json> <outdir>
//
// The body is a PR Lens graph document without the contract fields (schemaVersion, kind,
// provenance), which are ours to state. Prints one JSON line: {ok, issues?} or
// {ok, hash, lenses: {architecture: {light, dark, width, height}, "data-flow"?: {...}}}.
// Files are named by content hash so a viewer never shows a cached stale picture; older
// renders in <outdir> are removed.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeParseGraphDoc, SCHEMA_VERSION } from "@coldtea/pr-lens-schema";
import { render, graphContentHash } from "@coldtea/pr-lens-renderer";

const [bodyPath, outDir] = process.argv.slice(2);
const say = obj => process.stdout.write(JSON.stringify(obj) + "\n");

let body;
try {
  body = JSON.parse(readFileSync(bodyPath, "utf8"));
} catch (e) {
  say({ ok: false, issues: [{ path: "", message: `not JSON: ${e.message}` }] });
  process.exit(1);
}

const doc = {
  ...body,
  schemaVersion: SCHEMA_VERSION,
  kind: "graph",
  provenance: body.provenance ?? { repo: { owner: "hq", name: "org" }, base: { sha: "0000000" }, head: { sha: "1111111" } },
};
const parsed = safeParseGraphDoc(doc);
if (!parsed.ok) {
  const issues = (parsed.error?.issues ?? [{ path: [], message: String(parsed.error?.message ?? parsed.error) }]).map(i => ({
    path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
    message: i.message,
  }));
  say({ ok: false, code: parsed.error?.code, issues });
  process.exit(1);
}

const graph = parsed.value;
const hash = graphContentHash(graph).slice(0, 12);
mkdirSync(outDir, { recursive: true });
const lenses = {};
const wanted = ["architecture", ...(graph.flows?.length ? ["data-flow"] : [])];
for (const lens of wanted) {
  lenses[lens] = {};
  for (const theme of ["light", "dark"]) {
    const { svg, width, height } = render(graph, { lens, theme });
    const file = `${lens}-${hash}-${theme}.svg`;
    writeFileSync(join(outDir, file), svg);
    Object.assign(lenses[lens], { [theme]: file, width, height });
  }
}
const keep = new Set(Object.values(lenses).flatMap(l => [l.light, l.dark]));
for (const f of readdirSync(outDir)) if (f.endsWith(".svg") && !keep.has(f)) unlinkSync(join(outDir, f));
say({ ok: true, hash, title: graph.title, lenses });
