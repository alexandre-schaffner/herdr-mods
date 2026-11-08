// Opens the master chat of the repository you're in: goes to it, or starts (or resumes) it
// in a pinned Master tab. The work is in master.py; this is its key.

import { div, View } from "gpui-kit";
import { appHome, closeOverlay, exec, focused, home, notify, panes, props } from "herdr";

export default class Master extends View {
  init(_props, cx) {
    // Only when opened (its key, mod.open): a check or a stray layout copy has no overlay.
    const overlay = props()?.overlay;
    if (!overlay) return;
    cx.spawn(async () => {
      const f = focused();
      const folder = f?.cwd ?? panes().find(p => p.tab === f?.tab && p.cwd)?.cwd ?? home();
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/master/master.py`, "open", folder, f?.space ?? ""]);
        const out = JSON.parse(r.stdout || "{}");
        if (out.error || r.code !== 0) throw new Error(out.error || r.stderr.trim() || `master.py exited ${r.code}`);
        if (out.started)
          notify({ title: `${out.resumed ? "Resumed" : "Started"} the master chat for ${out.repo.name}`, body: out.address, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: "No master chat", body: String(e?.message ?? e), level: "error" });
      }
      closeOverlay(overlay);
    });
  }

  render() {
    return div();
  }
}
