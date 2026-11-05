// Where the panel's data comes from: Revv credentials on disk, each space's git
// checkout, and Revv's loopback `/herdr/v1` routes. Nothing here is
// authoritative; Revv's database is. Every refresh rebuilds the picture.

import { exec, home, panes, readTextFile, shared, spaces } from "herdr";

/** Where Revv writes one `credential.json` per connected account. */
const credentialsRoot = () => shared("revv.credentialsRoot") || `${home()}/.revv/herdr`;

const IDENTITY_SCRIPT = [
  'cd "$1" 2>/dev/null || exit 3',
  "top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 4",
  'printf "%s\\n" "$top"',
  "git remote get-url origin 2>/dev/null || echo",
  "git branch --show-current 2>/dev/null || echo",
  "git --no-optional-locks rev-list --max-count=64 HEAD 2>/dev/null",
].join("\n");

const ACCOUNTS_TTL_MS = 30_000;
export const POLL_ACTIVE_MS = 3_000;
export const POLL_IDLE_MS = 15_000;

/** `git@github.com:owner/repo.git` or `https://host/owner/repo` → `owner/repo`. */
export function repositoryFullName(remoteUrl) {
  const trimmed = (remoteUrl ?? "").trim().replace(/\.git$/i, "");
  if (!trimmed) return null;
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(trimmed);
  let path = scp?.[1];
  if (!path) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(trimmed);
    path = m?.[1] ?? "";
  }
  const segments = path.split("/").filter(Boolean);
  return segments.length >= 2 ? `${segments.at(-2)}/${segments.at(-1)}` : null;
}

/** The folder a space is about: the focused pane's for the shown space, else its first terminal's. */
export function spaceFolder(space, allPanes, focus) {
  const tabIds = new Set(space.tabs.map((tab) => tab.id));
  const terminalsHere = allPanes.filter((p) => tabIds.has(p.tab) && p.terminal);
  const own = terminalsHere.filter((p) => p.cwd);
  if (focus?.space === space.id) {
    const focusedPane = own.find((p) => p.pane === focus.pane);
    if (focusedPane) return focusedPane.cwd;
  }
  const active = space.tabs.find((tab) => tab.active);
  const found = (own.find((p) => p.tab === active?.id) ?? own[0])?.cwd;
  if (found) return found;
  // Terminals whose folder Herdr hasn't learned yet (right after a start):
  // wait for it rather than guess from where the space was made.
  if (terminalsHere.length > 0) return undefined;
  return space.folder || null;
}

export class Store {
  constructor() {
    this.accounts = null; // [{ key, path, token, endpoints, runtime, watcher, preferred }]
    this.accountsAt = 0;
    /** spaceId → { cwd, identity | null, reason } */
    this.checkouts = new Map();
    /** spaceId → { review: HerdrCheckoutReview, account } */
    this.results = new Map();
    /** Every account's connected agents together (to warm the installed-agent cache). */
    this.agents = [];
    /** "loading" | "ready" | "no-credentials" | "offline" | "unauthorized" */
    this.status = "loading";
    this.loading = false;
    this.fetchedAt = 0;
    this.error = null;
  }

  /** Coding agents that can work on a space's PR: those of the account that resolved it. */
  agentsFor(spaceId) {
    return this.results.get(spaceId)?.account?.agents ?? [];
  }

  generating() {
    for (const { review } of this.results.values()) {
      if (review.state === "pr" && review.run?.status === "generating") return true;
    }
    return false;
  }

  due(now = Date.now()) {
    if (this.loading) return false;
    const pending = [...this.checkouts.values()].some((c) => c.reason === "pending");
    if (pending && now - this.fetchedAt >= 1_500) return true;
    return now - this.fetchedAt >= (this.generating() ? POLL_ACTIVE_MS : POLL_IDLE_MS) - 250;
  }

  async loadAccounts(force = false) {
    if (!force && this.accounts && Date.now() - this.accountsAt < ACCOUNTS_TTL_MS)
      return this.accounts;
    const root = credentialsRoot();
    const listed = await exec("sh", [
      "-c",
      'for f in "$1"/*/credential.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done; exit 0',
      "revv",
      root,
    ]);
    const files = listed.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const previous = new Map((this.accounts ?? []).map((a) => [a.path, a]));
    const accounts = [];
    for (const path of files) {
      try {
        const parsed = JSON.parse((await readTextFile(path)) ?? "null");
        if (!parsed || typeof parsed.token !== "string" || !Array.isArray(parsed.endpoints))
          continue;
        accounts.push({
          key: parsed.accountKey ?? path.split("/").at(-2),
          path,
          token: parsed.token,
          endpoints: parsed.endpoints
            .filter((e) => typeof e === "string")
            .map((e) => e.replace(/\/+$/, "")),
          runtime: parsed.runtime ?? null,
          watcher: parsed.watcher ?? null,
          preferred: previous.get(path)?.preferred ?? null,
        });
      } catch {
        // A half-written or foreign file: skip it, the next listing retries.
      }
    }
    this.accounts = accounts;
    this.accountsAt = Date.now();
    return accounts;
  }

  /** Calls one account, trying its endpoints in order; 401/403 means another channel. */
  async call(account, method, path, body) {
    const order =
      account.preferred == null
        ? account.endpoints.map((_, i) => i)
        : [
            account.preferred,
            ...account.endpoints.map((_, i) => i).filter((i) => i !== account.preferred),
          ];
    let reachable = false;
    let rejected = false;
    for (const i of order) {
      const options = {
        method,
        headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json" },
      };
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetch(`${account.endpoints[i]}${path}`, options);
      } catch {
        continue;
      }
      reachable = true;
      if (response.status === 401 || response.status === 403) {
        rejected = true;
        continue;
      }
      account.preferred = i;
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, json, text };
    }
    return { ok: false, status: 0, offline: !reachable, rejected, json: null, text: "" };
  }

  async identify(cwd) {
    if (cwd === undefined) return { identity: null, reason: "pending" };
    if (!cwd) return { identity: null, reason: "no-folder" };
    const r = await exec("sh", ["-c", IDENTITY_SCRIPT, "revv", cwd]).catch(() => null);
    if (!r || r.code === 3) return { identity: null, reason: "no-folder" };
    if (r.code === 4) return { identity: null, reason: "not-git" };
    const [root, remote, branch, ...rest] = r.stdout.split("\n");
    const headCandidates = rest.map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/i.test(s));
    const repo = repositoryFullName(remote);
    if (!repo) return { identity: null, reason: "no-remote", root: root?.trim() };
    if (headCandidates.length === 0)
      return { identity: null, reason: "no-commits", root: root?.trim() };
    return {
      identity: { repositoryFullName: repo, headCandidates, branch: branch?.trim() || null },
      root: root.trim(),
      reason: null,
    };
  }

  /** Re-reads every local space's checkout, then asks each account about them in one call. */
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    try {
      const accounts = await this.loadAccounts();
      const allPanes = panes();
      const local = spaces().filter((space) => space.machine == null);
      const checkouts = new Map();
      await Promise.all(
        local.map(async (space) => {
          const cwd = spaceFolder(space, allPanes, this.focus);
          const found = await this.identify(cwd);
          checkouts.set(space.id, { cwd, ...found });
        }),
      );
      this.checkouts = checkouts;
      if (accounts.length === 0) {
        this.status = "no-credentials";
        this.results = new Map();
        return;
      }
      const queries = [...checkouts.entries()]
        .filter(([, c]) => c.identity)
        .slice(0, 32)
        .map(([key, c]) => ({ key, ...c.identity }));
      const results = new Map();
      const agents = new Set();
      let offline = 0;
      let rejected = 0;
      for (const account of accounts) {
        if (queries.length === 0) break;
        const r = await this.call(account, "POST", "/herdr/v1/reviews", { checkouts: queries });
        if (!r.ok || !r.json) {
          if (r.offline) offline++;
          else if (r.rejected) rejected++;
          else this.error = r.json?.error ?? r.text ?? `Revv answered ${r.status}`;
          continue;
        }
        // Agents are per account: an agent connected to another Revv account
        // can't reach this account's pull requests through its MCP tools.
        account.agents = Array.isArray(r.json.agents) ? r.json.agents : [];
        for (const provider of account.agents) agents.add(provider);
        for (const [key, review] of Object.entries(r.json.results ?? {})) {
          const held = results.get(key);
          if (!held || RANK[review.state] > RANK[held.review.state])
            results.set(key, { review, account });
        }
      }
      this.agents = [...agents];
      if (queries.length > 0 && offline === accounts.length) {
        this.status = "offline";
        return; // keep the last results on screen, marked stale by status
      }
      if (queries.length > 0 && rejected + offline === accounts.length && rejected > 0) {
        this.status = "unauthorized";
        this.results = new Map();
        return;
      }
      this.results = results;
      this.status = "ready";
      this.error = null;
    } catch (error) {
      this.error = String(error?.message ?? error);
    } finally {
      this.fetchedAt = Date.now();
      this.loading = false;
    }
  }

  async requestReview(spaceId, generationMode = "incremental") {
    const held = this.results.get(spaceId);
    const checkout = this.checkouts.get(spaceId);
    if (!held || !checkout?.identity)
      return { ok: false, reason: "failed", message: "Revv can't see this checkout yet." };
    const r = await this.call(held.account, "POST", "/herdr/v1/reviews/request", {
      checkout: checkout.identity,
      headSha: checkout.identity.headCandidates[0],
      generationMode,
    });
    if (r.json && typeof r.json.ok === "boolean") return r.json;
    if (r.offline) return { ok: false, reason: "failed", message: "Revv isn't running." };
    if (r.rejected) {
      return {
        ok: false,
        reason: "failed",
        message:
          "Revv rejected this panel's credential. Reconnect Herdr in Revv → Settings → Integrations.",
      };
    }
    // 400 (bad commit) and 404 (no open PR for this checkout) answer `{ error }`.
    const message =
      typeof r.json?.error === "string"
        ? r.json.error
        : typeof r.json?.message === "string"
          ? r.json.message
          : `Revv answered ${r.status}.`;
    return { ok: false, reason: "failed", message };
  }
}

const RANK = { untracked: 0, no_pr: 1, pr: 2 };
