// Revv in Herdr: the pull request the focused space is working on, and its
// review — risk, findings, conversations, scorecard, and a live view of a
// review in progress — with the actions that hand findings to a coding agent.
//
// Three roles share this mod: the panel (default), the agent picker popup
// (props.mode = "menu") and the code peek window (props.mode = "peek").
// Data contract: packages/shared/src/herdr.ts in the Revv repository.

import { h_flex, v_flex } from "gpui-base";
import { div, image, svg, View } from "gpui-kit";
import {
  closeOverlay,
  exec,
  focused,
  nextCommand,
  notify,
  openOverlay,
  panes,
  playSound,
  props,
  run,
  setShared,
  shared,
  spaces,
  theme,
} from "herdr";
import {
  cachedLaunchables,
  copyText,
  defaultTarget,
  handOff,
  launchables,
  leadTerminal,
  PROVIDER_NAMES,
  preferredProvider,
  rememberProvider,
  residentAgents,
  spawnWatcher,
  watcherFor,
} from "./agents.js";
import { PeekState, renderPeek } from "./peek.js";
import {
  emptyState,
  findingsSection,
  notReviewedCard,
  prHeader,
  runCard,
  runErrorCard,
  scorecardSection,
  skeleton,
  staleStrip,
  threadsSection,
  verdictCard,
} from "./sections.js";
import { Store } from "./store.js";
import { btn, iconBtn, kbd, rule } from "./ui.js";
import { alpha, clip, icon, palette, plural, RISK } from "./util.js";

const MAX_NOTIFIED = 80;
const notifiedIds = () => {
  const list = shared("revv.notified");
  return Array.isArray(list) ? list : [];
};

function programIcon(program, size, color) {
  if (!program?.icon) return null;
  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).w(size).h(size).flex_none();
}

/** The floating Revv window: opened by `mod.open revv`, kept across restarts. */
const WINDOW = { mod: "revv", kind: "window", key: "revv", keep: true, width: 392, height: 0.82 };

/** `mod.open revv` (the palette, or `herdr-app do mod.open`) shows or hides the window. */
function toggleWindow() {
  const open = shared("revv.window");
  if (typeof open === "string" && open) {
    closeOverlay(open);
    setShared("revv.window", null);
    return;
  }
  setShared("revv.window", openOverlay({ ...WINDOW, props: { window: true } }));
}

export default class Revv extends View {
  init(_props, cx) {
    const given = props() ?? {};
    const mode = given.mode;
    // The launcher: mod.json's 2×2 frameless popup. It only toggles the window.
    if (given.overlay && !mode && !given.window) {
      this.mode = "launcher";
      const launcher = given.overlay;
      cx.spawn(async () => {
        toggleWindow();
        closeOverlay(launcher);
      });
      return;
    }
    if (mode === "peek") {
      this.mode = "peek";
      this.peekState = new PeekState(cx);
      return;
    }
    if (mode === "menu") {
      this.mode = "menu";
      this.options = cachedLaunchables(props().connected ?? []);
      cx.spawn(async (cx) => {
        this.options = await launchables(props().connected ?? []);
        cx.notify();
      });
      return;
    }
    this.mode = "panel";
    // A window copy (kept windows come back with a new id); a pane copy
    // (`pane.split {mod: "revv"}`) follows its own tab's space.
    this.windowed = Boolean(given.window && given.overlay);
    if (this.windowed) setShared("revv.window", given.overlay);
    this.paneId = typeof given.pane === "string" ? given.pane : null;
    this.pinnedSpace = typeof given.space === "string" ? given.space : null;
    this.store = new Store();
    this.expanded = new Set();
    this.filter = localStorage.getItem("filter") ?? "open";
    this.summaryOpen = false;
    this.busy = null;
    this.selected = null;
    this.focusedPanel = false;
    this.visibleIssues = [];
    this.w = 360;
    this.generatingBySpace = new Map();
    this.spawned = new Set();
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(1000, (cx) => {
      if (this.store.due()) this.refresh(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.handle.focus();
          this.focusedPanel = true;
        } else if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  async close(_cx) {
    if (this.windowed && shared("revv.window") === props()?.overlay) setShared("revv.window", null);
  }

  // ── Data ────────────────────────────────────────────────────────────────

  refresh(cx) {
    if (this.store.loading) {
      this.pending = true;
      return;
    }
    this.store.focus = focused();
    cx.spawn(async (cx) => {
      await this.store.refresh();
      this.afterRefresh();
      cx.notify();
      // Which agents are installed is asked of the login shell: slow the first
      // time, cached after. Paint the review first, then the agent buttons.
      await launchables(this.store.agents);
      cx.notify();
      if (this.pending) {
        this.pending = false;
        this.refresh(cx);
      }
    });
  }

  /** Starts status terminals for new runs, and says when a watched run finishes. */
  afterRefresh() {
    const allSpaces = spaces();
    const allPanes = panes();
    const shownSpace = focused()?.space;
    for (const [spaceId, { review, account }] of this.store.results) {
      if (review.state !== "pr") continue;
      const space = allSpaces.find((s) => s.id === spaceId);
      const was = this.generatingBySpace.get(spaceId);
      const run = review.run;
      if (run?.status === "generating") {
        this.generatingBySpace.set(spaceId, run.walkthroughId);
        const checkout = this.store.checkouts.get(spaceId);
        if (space && !this.spawned.has(run.walkthroughId) && !watcherFor(run.walkthroughId)) {
          const parent = leadTerminal(space, allPanes);
          if (parent && checkout?.root) {
            this.spawned.add(run.walkthroughId);
            void spawnWatcher({
              account,
              walkthroughId: run.walkthroughId,
              parent,
              cwd: checkout.root,
            });
          }
        }
        continue;
      }
      this.generatingBySpace.delete(spaceId);
      if (!was || notifiedIds().includes(was)) continue;
      if (review.review?.walkthroughId === was) {
        const open = review.review.issues.filter((i) => i.resolution.status === "open").length;
        const risk = RISK[review.review.riskLevel]?.label ?? "Reviewed";
        this.remember(was);
        notify({
          title: `Review ready: #${review.pr.number}`,
          body: `${risk} · ${open === 0 ? "nothing to fix" : plural(open, "finding")}. ${clip(review.pr.title, 60)}`,
          level: review.review.riskLevel === "high" ? "warning" : "success",
          ...(spaceId === shownSpace
            ? {}
            : { action: { name: "space.select", args: { id: spaceId } } }),
        });
        playSound("done");
      } else if (run?.status === "error" && run.walkthroughId === was) {
        this.remember(was);
        notify({
          title: `Review stopped: #${review.pr.number}`,
          body: clip(run.error || "Revv couldn't finish the review.", 120),
          level: "error",
        });
      }
    }
  }

  remember(id) {
    // Shared, not per copy: a panel and a pane copy must not both toast.
    setShared("revv.notified", [...notifiedIds().filter((x) => x !== id), id].slice(-MAX_NOTIFIED));
  }

  /** The space this copy is about: its own pane's for a pane copy, else the focused one. */
  spaceId() {
    if (this.pinnedSpace) return this.pinnedSpace;
    if (this.paneId) {
      const tab = panes().find((p) => p.pane === this.paneId)?.tab;
      const own = tab ? spaces().find((s) => s.tabs.some((t) => t.id === tab)) : null;
      if (own) return own.id;
    }
    return focused()?.space ?? null;
  }

  current() {
    const id = this.spaceId();
    const space = spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active) ?? null;
    return {
      space,
      checkout: space ? this.store.checkouts.get(space.id) : null,
      held: space ? this.store.results.get(space.id) : null,
    };
  }

  // ── Actions (called by sections.js) ─────────────────────────────────────

  target() {
    const { space } = this.current();
    return space ? defaultTarget(space.id, this.store.agentsFor(space.id)) : null;
  }

  handOffArgs(issue) {
    const { space, checkout, held } = this.current();
    const pr = held?.review?.pr;
    return {
      spaceId: space?.id,
      prompt: issue ? issue.fixPrompt : pr?.fixPrompt,
      tabName: issue ? `Fix: ${clip(issue.title, 28)}` : `Fix #${pr?.number}`,
      folder: checkout?.root ?? null,
    };
  }

  fix(issue, cx) {
    const args = this.handOffArgs(issue);
    if (!args.prompt) return;
    const target = this.target();
    this.busy = issue ? `fix-${issue.id}` : "fix-all";
    cx.notify();
    cx.spawn(async (cx) => {
      const error = await handOff(target, args);
      if (error) notify({ title: "Couldn't hand it off", body: error, level: "error" });
      else
        notify({
          title: target.kind === "send" ? `Sent to ${target.label}` : `Started ${target.label}`,
          body: issue ? clip(issue.title, 80) : "Working through the open findings.",
          level: "success",
          timeout: 3500,
        });
      this.busy = null;
      cx.notify();
    });
  }

  openAgentMenu(issue, _e) {
    const { space } = this.current();
    if (!space) return;
    const connected = this.store.agentsFor(space.id);
    const resident = residentAgents(space.id, connected);
    const options = cachedLaunchables(connected);
    const rows = resident.length + options.length;
    openOverlay({
      mod: "revv",
      kind: "popup",
      width: 268,
      height: Math.min(
        420,
        52 + rows * 34 + (resident.length && options.length ? 30 : 0) + (rows === 0 ? 60 : 0),
      ),
      props: { mode: "menu", connected, ...this.handOffArgs(issue) },
    });
  }

  peek(issue) {
    const { checkout } = this.current();
    if (!issue.filePath || !checkout?.root) return;
    openOverlay({
      mod: "revv",
      kind: "window",
      key: "revv-peek",
      width: 700,
      height: 460,
      props: {
        mode: "peek",
        root: checkout.root,
        filePath: issue.filePath,
        startLine: issue.startLine,
        endLine: issue.endLine,
        title: issue.title,
        severity: issue.severity,
      },
    });
  }

  copyPrompt(issue, cx) {
    cx.spawn(async () => {
      await copyText(issue.fixPrompt);
      notify({
        title: "Fix prompt copied",
        body: clip(issue.title, 80),
        level: "info",
        timeout: 2500,
      });
    });
  }

  reReview(mode, cx) {
    const { space } = this.current();
    if (!space || this.busy === "review") return;
    this.busy = "review";
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.store.requestReview(space.id, mode);
      if (!result.ok) {
        const titles = {
          head_mismatch: "Push your commits first",
          stopped_by_user: "Stopped in Revv",
          budget_exhausted: "Review budget used up",
        };
        notify({
          title: titles[result.reason] ?? "Revv couldn't start the review",
          body: result.message,
          level: result.reason === "head_mismatch" ? "warning" : "error",
        });
      } else if (result.outcome === "already_complete") {
        notify({
          title: "Already reviewed",
          body: "Revv has a finished review of this commit.",
          level: "info",
          timeout: 3000,
        });
      }
      this.busy = null;
      this.store.fetchedAt = 0;
      this.refresh(cx);
      cx.notify();
    });
  }

  openInRevv(pr) {
    // Only Revv's own scheme: never hand `open` a URL or path from the network.
    if (typeof pr?.deepLink === "string" && pr.deepLink.startsWith("revv://")) {
      void exec("open", [pr.deepLink]);
    }
  }

  peekTerminal(address) {
    run("terminal.peek", { terminal: address });
  }

  toggleIssue(id, cx) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.selected = id;
    cx.notify();
  }

  toggleSummary(cx) {
    this.summaryOpen = !this.summaryOpen;
    cx.notify();
  }

  setFilter(id, cx) {
    this.filter = id;
    localStorage.setItem("filter", id);
    cx.notify();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  onKey(e, cx) {
    const list = this.visibleIssues;
    const at = list.indexOf(this.selected);
    const { held } = this.current();
    const review = held?.review?.state === "pr" ? held.review : null;
    const issue =
      review?.review?.issues.find((i) => i.id === this.selected) ??
      review?.run?.issues.find((i) => i.id === this.selected);
    switch (e.key) {
      case "j":
      case "down":
        if (list.length) this.selected = list[Math.min(list.length - 1, at + 1)];
        break;
      case "k":
      case "up":
        if (list.length) this.selected = list[Math.max(0, at - 1)];
        break;
      case "enter":
      case "space":
        if (this.selected) this.toggleIssue(this.selected, cx);
        break;
      case "f":
        if (issue && issue.resolution.status === "open") this.fix(issue, cx);
        else if (!issue && review) this.fix(null, cx);
        break;
      case "p":
        if (issue) this.peek(issue);
        break;
      case "r":
        if (review) this.reReview("incremental", cx);
        break;
      case "o":
        if (review) this.openInRevv(review.pr);
        break;
      case "escape":
        if (this.selected && this.expanded.has(this.selected)) this.expanded.delete(this.selected);
        else {
          this.focusedPanel = false;
          run("pane.go", { direction: "left" });
        }
        break;
      default:
        return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  render(cx) {
    const t = theme();
    if (this.mode === "launcher") return div();
    if (this.mode === "peek") return renderPeek(this.peekState, t);
    if (this.mode === "menu") return this.renderMenu(t);

    const { space, checkout, held } = this.current();
    const following = !this.paneId && !this.pinnedSpace;
    const contextKey = following
      ? `${space?.id}|${focused()?.pane}|${focused()?.cwd}`
      : `${space?.id}`;
    if (contextKey !== this.contextKey) {
      if (this.contextKey && this.contextKey.split("|")[0] !== space?.id) {
        this.expanded.clear();
        this.summaryOpen = false;
        this.selected = null;
      }
      this.contextKey = contextKey;
      this.refresh(cx);
    }
    this.visibleIssues = [];
    const c = { t, p: palette(t), w: this.w, now: Date.now(), ui: this };
    const review = held?.review ?? null;
    const pr = review?.state === "pr" ? review : null;

    return (
      v_flex()
        .id("revv")
        .size_full()
        .min_h(0)
        .overflow_hidden()
        .bg(t.background)
        // Herdr frames a window itself; docked and pane copies draw their card.
        .when(!this.windowed, (el) => el.rounded(10).border_1().border_color(t.border))
        .text_color(t.foreground)
        .text_size(13)
        .track_focus(this.handle)
        .on_key_down((e, cx) => this.onKey(e, cx))
        .on_size_change((size, cx) => {
          if (Math.abs(size.width - this.w) > 1) {
            this.w = size.width;
            cx.notify();
          }
        })
        .child(this.renderTopBar(c, space, checkout, pr))
        .child(
          v_flex()
            .id("revv-body")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .child(
              v_flex()
                .w_full()
                .px(14)
                .pt(14)
                .pb(18)
                .gap(16)
                .children(this.renderBody(c, space, checkout, review)),
            ),
        )
        .when(Boolean(pr), (el) => el.child(this.renderFooter(c, space, pr)))
    );
  }

  renderTopBar(c, space, checkout, pr) {
    const { t } = c;
    const offline = this.store.status === "offline";
    const repo = checkout?.identity?.repositoryFullName ?? null;
    const branch = checkout?.identity?.branch ?? null;
    // In the window this bar is the title strip: a press on it drags the window.
    const subtitle = this.windowed
      ? [...new Set([space?.name, branch].filter(Boolean))].join(" · ")
      : (branch ?? space?.name ?? "");
    return h_flex()
      .h(42)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .size(22)
          .flex_none()
          .rounded(7)
          .bg(t.solid)
          .flex()
          .items_center()
          .justify_center()
          .child(icon("revv", 13, t.solid_foreground)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            div()
              .text_size(12.5)
              .font_semibold()
              .text_color(t.foreground)
              .truncate()
              .child(repo ? repo.split("/").pop() : "Revv"),
          )
          .when(Boolean(subtitle), (el) =>
            el.child(div().text_size(10.5).text_color(t.dim).truncate().child(subtitle)),
          ),
      )
      .when(offline, (el) =>
        el.child(
          h_flex()
            .gap(5)
            .px(7)
            .h(20)
            .items_center()
            .rounded(10)
            .bg(alpha(c.p.warning, 0.12))
            .child(div().size(6).rounded_full().bg(c.p.warning))
            .child(div().text_size(10.5).font_medium().text_color(c.p.warning).child("Offline")),
        ),
      )
      .child(
        iconBtn(
          t,
          "top-refresh",
          "refresh",
          (cx) => {
            this.store.fetchedAt = 0;
            this.refresh(cx);
          },
          "Refresh",
          { spin: this.store.loading ? 900 : 0 },
        ),
      )
      .when(Boolean(pr), (el) =>
        el.child(iconBtn(t, "top-open", "external", () => this.openInRevv(pr.pr), "Open in Revv")),
      )
      .when(this.windowed, (el) =>
        el.child(iconBtn(t, "top-close", "x", () => closeOverlay(props()?.overlay), "Close")),
      );
  }

  renderBody(c, space, checkout, review) {
    const { t } = c;
    const status = this.store.status;
    const startRevv = btn(t, "start-revv", "Open Revv", () => void exec("open", ["-a", "Revv"]), {
      kind: "primary",
      icon: "power",
    });
    if (!space)
      return [
        emptyState(c, {
          icon: "folder",
          title: "No space",
          body: "Open a space to see its review.",
        }),
      ];
    if (space.machine != null)
      return [
        emptyState(c, {
          icon: "folder",
          title: "On another machine",
          body: `Revv reviews checkouts on this computer. ${space.name} lives on ${space.machine}.`,
        }),
      ];
    if (status === "no-credentials")
      return [
        emptyState(c, {
          icon: "plug",
          title: "Connect Revv to Herdr",
          body: "In Revv, open Settings → Integrations and connect Herdr. This panel lights up as soon as it's done.",
          actions: [startRevv],
        }),
      ];
    if (status === "unauthorized")
      return [
        emptyState(c, {
          icon: "plug",
          tint: c.p.warning,
          title: "Reconnect Herdr in Revv",
          body: "This panel's Revv credential expired or was revoked. Reconnect Herdr in Revv → Settings → Integrations.",
          actions: [startRevv],
        }),
      ];
    if (!checkout) return [skeleton(c)];
    if (!checkout.identity && checkout.reason === "pending") return [skeleton(c)];
    if (!checkout.identity) {
      const states = {
        "no-folder": {
          icon: "folder",
          title: "No folder here",
          body: "Focus a terminal in a git checkout to see its pull request.",
        },
        "not-git": {
          icon: "folder",
          title: "Not a git checkout",
          body: "Revv follows the repository the focused terminal is in.",
          code: checkout.cwd,
        },
        "no-remote": {
          icon: "branch",
          title: "No origin remote",
          body: "Revv matches checkouts to GitHub through their origin remote.",
        },
        "no-commits": {
          icon: "branch",
          title: "No commits yet",
          body: "Commit and push to open a pull request Revv can review.",
        },
      };
      return [emptyState(c, states[checkout.reason] ?? states["no-folder"])];
    }
    if (status === "offline" && !review)
      return [
        emptyState(c, {
          icon: "power",
          tint: c.p.warning,
          title: "Revv isn't running",
          body: "Start Revv and keep it in the tray; this panel reconnects by itself.",
          actions: [startRevv],
        }),
      ];
    if (!review) return [skeleton(c)];
    if (review.state === "untracked")
      return [
        emptyState(c, {
          icon: "plus",
          title: "Not in Revv yet",
          body: "Add this repository in Revv to review its pull requests here.",
          code: review.repositoryFullName,
          actions: [startRevv],
        }),
      ];
    if (review.state === "no_pr")
      return [
        emptyState(c, {
          icon: "pr",
          title: "No pull request for this branch",
          body: "Push the branch and open a pull request. Revv picks it up within a few minutes.",
          code: review.branch ?? checkout.identity.headCandidates[0].slice(0, 7),
        }),
      ];

    const { pr, review: done, run, threads } = review;
    const generating = run?.status === "generating";
    const out = [prHeader(c, pr)];
    if (generating) out.push(runCard(c, run, watcherFor(run.walkthroughId)));
    else if (run?.status === "error" && !done) out.push(runErrorCard(c, run));
    if (done) {
      out.push(verdictCard(c, done, { previous: generating }));
      if (!generating) {
        const strip = staleStrip(c, pr, done);
        if (strip) out.push(strip);
        if (run?.status === "error") out.push(runErrorCard(c, run));
      }
    } else if (!generating && run?.status !== "error") out.push(notReviewedCard(c));
    if (generating && run.issues.length > 0)
      out.push(findingsSection(c, run.issues, { live: true }));
    if (done && done.issues.length > 0) out.push(findingsSection(c, done.issues));
    const conversations = threadsSection(c, threads, pr);
    if (conversations) out.push(conversations);
    if (done) {
      const scorecard = scorecardSection(c, done.ratings);
      if (scorecard) out.push(scorecard);
    }
    if (this.focusedPanel && done?.issues.length) out.push(this.renderKeys(c));
    return out;
  }

  renderKeys(c) {
    const { t } = c;
    const pair = (k, label) =>
      h_flex()
        .gap(4)
        .items_center()
        .child(kbd(t, k))
        .child(div().text_size(10.5).text_color(t.dim).child(label));
    return h_flex()
      .flex_wrap()
      .gap(10)
      .pt(4)
      .child(pair("j k", "move"))
      .child(pair("↵", "open"))
      .child(pair("f", "fix"))
      .child(pair("p", "peek"))
      .child(pair("r", "re-review"))
      .child(pair("o", "Revv"));
  }

  renderFooter(c, space, held) {
    const { t } = c;
    const { pr, review, run, threads } = held;
    const generating = run?.status === "generating";
    const open = review?.issues.filter((i) => i.resolution.status === "open").length ?? 0;
    const target = defaultTarget(space.id, this.store.agentsFor(space.id));
    const work = open + threads.length;
    const bar = h_flex()
      .flex_none()
      .px(12)
      .py(10)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .bg(t.background);
    if (generating) {
      const watcher = watcherFor(run.walkthroughId);
      return bar.child(
        btn(
          t,
          "foot-watch",
          watcher ? "Watch the review" : "Open in Revv",
          () => (watcher ? this.peekTerminal(watcher.address) : this.openInRevv(pr)),
          { icon: watcher ? "terminal" : "external", grow: true },
        ),
      );
    }
    if (review && work > 0) {
      const what = open > 0 ? plural(open, "finding") : plural(threads.length, "thread");
      const roomy = this.w >= 360;
      const label = target
        ? target.kind === "send"
          ? roomy
            ? `Send ${what} to ${target.label}`
            : `Send ${what}`
          : roomy
            ? `Fix ${what} with ${target.label}`
            : `Fix ${what}`
        : "Connect an agent to fix";
      const program = target
        ? target.kind === "send"
          ? target.agent.program
          : target.launch.program
        : null;
      return bar
        .child(
          btn(t, "foot-fix", label, (cx) => this.fix(null, cx), {
            kind: "primary",
            size: "lg",
            grow: true,
            disabled: !target,
            busy: this.busy === "fix-all",
            icon: "sparkles",
            iconEl: programIcon(program, 15, t.solid_foreground) ?? undefined,
            tooltip: target
              ? target.kind === "send"
                ? `Pastes the fix request into ${target.label} in this space`
                : `Starts ${target.label} in a new tab with the fix request`
              : "Revv → Settings → Integrations",
          }),
        )
        .child(
          iconBtn(
            t,
            "foot-menu",
            "chevron-down",
            (_cx, e) => this.openAgentMenu(null, e),
            "Choose the agent",
            { size: 36, icon: 13 },
          ),
        )
        .child(
          iconBtn(
            t,
            "foot-rereview",
            "refresh",
            (cx) => this.reReview("incremental", cx),
            "Re-review the pushed head",
            { size: 36, spin: this.busy === "review" ? 900 : 0 },
          ),
        );
    }
    if (review) {
      return bar
        .child(
          btn(t, "foot-rereview", "Re-review", (cx) => this.reReview("incremental", cx), {
            size: "lg",
            grow: true,
            icon: "refresh",
            busy: this.busy === "review",
          }),
        )
        .child(
          iconBtn(t, "foot-open", "external", () => this.openInRevv(pr), "Open in Revv", {
            size: 36,
          }),
        );
    }
    return bar.child(
      btn(t, "foot-open", "Open in Revv", () => this.openInRevv(pr), {
        size: "lg",
        grow: true,
        icon: "external",
      }),
    );
  }

  // ── Agent picker popup ──────────────────────────────────────────────────

  renderMenu(t) {
    const { spaceId, prompt, tabName, folder, connected = [], overlay } = props() ?? {};
    const resident = residentAgents(spaceId, connected);
    const options = this.options ?? [];
    const preferred = preferredProvider();
    const pick = (target, cx) => {
      rememberProvider(target.provider);
      closeOverlay(overlay);
      cx.spawn(async () => {
        const error = await handOff(target, { spaceId, prompt, tabName, folder });
        if (error) notify({ title: "Couldn't hand it off", body: error, level: "error" });
      });
    };
    const row = (id, program, label, hint, onPick, o = {}) =>
      h_flex()
        .id(id)
        .h(32)
        .px(8)
        .gap(9)
        .items_center()
        .rounded(7)
        .when(Boolean(o.disabled), (el) => el.opacity(0.45))
        .when(!o.disabled, (el) =>
          el
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => onPick(cx)),
        )
        .child(programIcon(program, 16, t.foreground) ?? icon("terminal", 15, t.muted))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(div().truncate().text_size(12.5).text_color(t.foreground).child(label)),
        )
        .child(div().text_size(10.5).text_color(t.dim).child(hint))
        .when(Boolean(o.check), (el) => el.child(icon("check", 12, t.accent)));
    const header = (label) =>
      div().px(8).pt(6).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(label);
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.5)
      .when(resident.length > 0, (el) =>
        el.child(header("In this space")).children(
          resident.map((a) => {
            const free = a.status === "idle" || a.status === "done";
            return row(
              `menu-send-${a.address}`,
              a.program,
              a.program?.name ?? PROVIDER_NAMES[a.provider],
              free ? "send" : "busy",
              (cx) =>
                pick(
                  {
                    kind: "send",
                    agent: a,
                    provider: a.provider,
                    label: a.program?.name ?? PROVIDER_NAMES[a.provider],
                  },
                  cx,
                ),
              { disabled: !free },
            );
          }),
        ),
      )
      .when(resident.length > 0 && options.length > 0, (el) => el.child(div().py(4).child(rule(t))))
      .when(options.length > 0, (el) =>
        el
          .child(header("New tab"))
          .children(
            options.map((o) =>
              row(
                `menu-new-${o.provider}`,
                o.program,
                o.name,
                "new tab",
                (cx) => pick({ kind: "spawn", launch: o, provider: o.provider, label: o.name }, cx),
                { check: o.provider === preferred },
              ),
            ),
          ),
      )
      .when(resident.length === 0 && options.length === 0, (el) =>
        el.child(
          div()
            .p(10)
            .text_size(12)
            .line_height(1.45)
            .text_color(t.muted)
            .whitespace_normal()
            .child(
              "No connected coding agent is installed. Connect one in Revv → Settings → Integrations.",
            ),
        ),
      );
  }
}
