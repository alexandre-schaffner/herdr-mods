// A Mermaid diagram to an image: drawn by the system's Chrome (headless, through puppeteer-core),
// saved as a PNG a mod shows. GPUI has no web view.
//
//   node render.mjs mermaid <input file> <output .png> [--width 760] [--max-height 2400] [--dark]
//
// Prints {"width", "height"} (CSS pixels; the PNG is twice that) or {"error"}. An output that
// already exists is reused. The page runs offline: every request but data: URLs is blocked.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const [kind, input, output, ...rest] = process.argv.slice(2);
const width = Number(rest[rest.indexOf("--width") + 1]) || 760;
const dark = rest.includes("--dark");
// Where a tall diagram is cut.
const MAX_HEIGHT = Math.min(Number(rest[rest.indexOf("--max-height") + 1]) || 2400, 30000);
const say = (o) => process.stdout.write(JSON.stringify(o));

/** A PNG's size from its header, halved (it is drawn at 2x). */
function pngSize(file) {
  const b = readFileSync(file);
  return { width: Math.round(b.readUInt32BE(16) / 2), height: Math.round(b.readUInt32BE(20) / 2) };
}

async function main() {
  if (kind !== "mermaid" || !input || !output) return say({ error: "usage: render.mjs mermaid <input> <output.png>" });
  if (existsSync(output) && statSync(output).size > 0) return say(pngSize(output));
  const chrome = CHROMES.find((p) => existsSync(p));
  if (!chrome) return say({ error: "No Chrome, Chromium, Edge or Brave found to draw it with." });
  const source = readFileSync(input, "utf8");
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--disable-gpu", "--hide-scrollbars"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 600, deviceScaleFactor: 2 });
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()));
    {
      // A clear background: the chat's own shows through, light or dark.
      await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;background:transparent"><div id="c" style="display:inline-block"></div></body></html>`);
      const mermaidJs = join(dirname(createRequire(import.meta.url).resolve("mermaid")), "mermaid.min.js");
      await page.addScriptTag({ content: readFileSync(mermaidJs, "utf8") });
      const err = await page.evaluate(async (code, theme) => {
        try {
          window.mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
          const { svg } = await window.mermaid.render("diagram", code);
          document.getElementById("c").innerHTML = svg;
          return null;
        } catch (e) {
          return String(e?.message ?? e);
        }
      }, source, dark ? "dark" : "default");
      if (err) return say({ error: err.split("\n")[0].slice(0, 300) });
      const el = await page.$("body");
      const box = await page.evaluate(() => {
        const r = document.getElementById("c").getBoundingClientRect();
        return { width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 32 };
      });
      await page.setViewport({ width: Math.max(box.width, 40), height: Math.min(box.height, MAX_HEIGHT), deviceScaleFactor: 2 });
      await el.screenshot({ path: output, omitBackground: true, clip: { x: 0, y: 0, width: box.width, height: Math.min(box.height, MAX_HEIGHT) } });
    }
    say(pngSize(output));
  } finally {
    await browser.close();
  }
}

main().catch((e) => say({ error: String(e?.message ?? e).split("\n")[0].slice(0, 300) }));
