/**
 * Activity: what the owner ACTUALLY did — git commits in their workspaces,
 * PRs merged/open on GitHub, movement on their Linear plate, and this app's
 * own ledger. Gathered deterministically (no LLM), so it can ground both the
 * replica's chat ("what did I do yesterday?") and the standup wrap-up.
 * Read-only by construction: nothing here can send.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { listAudit, loadBrain, type DB } from "@standin/core";
import type { Config } from "./config.ts";
import { fetchAssignedIssues } from "./connectors/linear.ts";
import { fetchAssignedOAuth } from "./connectors/linear-mcp.ts";

const run = promisify(execFile);

/** A local YYYY-MM-DD (the owner's clock — this runs on their machine). */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayBounds(day: string): { since: Date; until: Date } {
  const since = new Date(`${day}T00:00:00`);
  if (Number.isNaN(since.getTime())) throw new Error(`bad day: ${day}`);
  return { since, until: new Date(since.getTime() + 24 * 60 * 60 * 1000) };
}

/** Commits by the repo's configured author, across all branches (unmerged evening work counts). */
async function gitCommits(workspace: string, since: Date, until: Date): Promise<string[]> {
  const repo = workspace.split("/").at(-1) ?? workspace;
  try {
    const { stdout: email } = await run("git", ["-C", workspace, "config", "user.email"]);
    const { stdout } = await run("git", [
      "-C", workspace, "log", "--all",
      `--author=${email.trim()}`,
      `--since=${since.toISOString()}`, `--until=${until.toISOString()}`,
      "--date=format-local:%H:%M", "--format=%ad %h %s", "--no-merges",
    ]);
    return stdout.trim() ? stdout.trim().split("\n").map((l) => `- [${repo}] ${l}`) : [];
  } catch {
    return [`- [${repo}] (couldn't read git history)`];
  }
}

interface SearchPr {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  closedAt: string | null;
}

/** Review state per open PR — "approved, waiting on your merge" is the standup-relevant fact.
 *  reviewDecision is "" on repos that don't require reviews, so fall back to actual reviews. */
async function reviewNote(prUrl: string): Promise<string> {
  try {
    const { stdout } = await run("gh", ["pr", "view", prUrl, "--json", "reviewDecision,latestReviews"]);
    const d = JSON.parse(stdout) as { reviewDecision: string; latestReviews: { state: string }[] };
    const states = new Set(d.latestReviews.map((r) => r.state));
    if (d.reviewDecision === "CHANGES_REQUESTED" || states.has("CHANGES_REQUESTED")) return " — changes requested";
    if (d.reviewDecision === "APPROVED" || states.has("APPROVED")) return " — APPROVED, waiting on merge";
    return "";
  } catch {
    return "";
  }
}

/** PRs the owner merged in the window + their currently open ones (the in-flight line). */
async function githubPrs(since: Date, until: Date): Promise<{ merged: string[]; open: string[] }> {
  const fields = "number,title,url,repository,closedAt";
  const range = `${since.toISOString().slice(0, 10)}..${until.toISOString().slice(0, 10)}`;
  try {
    const [m, o] = await Promise.all([
      run("gh", ["search", "prs", "--author=@me", "--merged", `--merged-at=${range}`, "--json", fields, "--limit", "30"]),
      run("gh", ["search", "prs", "--author=@me", "--state=open", "--json", fields, "--limit", "20"]),
    ]);
    const line = (p: SearchPr) => `- ${p.repository.nameWithOwner}#${p.number}: ${p.title}`;
    const openPrs = JSON.parse(o.stdout) as SearchPr[];
    const notes = await Promise.all(openPrs.slice(0, 10).map((p) => reviewNote(p.url)));
    return {
      // gh's date filter is day-granular; trim to the exact window here
      merged: (JSON.parse(m.stdout) as SearchPr[])
        .filter((p) => p.closedAt && p.closedAt >= since.toISOString() && p.closedAt < until.toISOString())
        .map(line),
      open: openPrs.map((p, ix) => line(p) + (notes[ix] ?? "")),
    };
  } catch (err) {
    const note = `- (couldn't reach GitHub: ${String(err instanceof Error ? err.message : err).split("\n")[0]})`;
    return { merged: [note], open: [] };
  }
}

/** Assigned Linear issues that moved in the window — the plate's churn. */
async function linearMovement(config: Config, since: Date, until: Date): Promise<string[]> {
  try {
    const rows = config.linearApiKey
      ? await fetchAssignedIssues(config.linearApiKey)
      : config.linearMcp
        ? await fetchAssignedOAuth()
        : [];
    return rows
      .filter((i) => i.updatedAt >= since.toISOString() && i.updatedAt < until.toISOString())
      .map((i) => `- ${i.identifier} (${i.state}): ${i.title}`);
  } catch {
    return [];
  }
}

/** What went through this app — approvals spent, items closed, lines moved. */
function ledgerEvents(db: DB, since: Date, until: Date): string[] {
  return listAudit(db, 500)
    .filter(
      (e) =>
        e.ts >= since.toISOString() &&
        e.ts < until.toISOString() &&
        ["send.executed", "item.done", "item.dismissed", "line.moved", "run.finished"].includes(e.type),
    )
    .map((e) => `- ${e.ts.slice(11, 16)}Z ${e.type}: ${e.detail ?? ""}`);
}

/**
 * One markdown block of everything the owner did in the window. Sections that
 * came up empty say so — the composer must never fill silence with guesses.
 */
export async function gatherActivity(db: DB, config: Config, since: Date, until: Date): Promise<string> {
  const [commitLists, prs, plate] = await Promise.all([
    Promise.all(config.workspaces.map((w) => gitCommits(w, since, until))),
    githubPrs(since, until),
    linearMovement(config, since, until),
  ]);
  const commits = commitLists.flat();
  const ledger = ledgerEvents(db, since, until);
  const sec = (title: string, lines: string[]) => `${title}:\n${lines.length ? lines.join("\n") : "- (none)"}`;
  return [
    sec("GIT COMMITS (all branches, owner-authored)", commits),
    sec("PRS MERGED in the window", prs.merged),
    sec("PRS STILL OPEN (in flight)", prs.open),
    sec("LINEAR PLATE — assigned issues that moved", plate),
    sec("STANDIN LEDGER — handled through this app", ledger),
  ].join("\n\n");
}

// The replica chats often; activity moves slowly. One shared 5-minute cache.
let cache: { at: number; text: string } = { at: 0, text: "" };

/** Last 48h of activity for the global chat — cached, and never throws. */
export async function recentActivity(db: DB, config: Config): Promise<string> {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.text;
  try {
    const until = new Date();
    const since = new Date(until.getTime() - 48 * 60 * 60 * 1000);
    cache = { at: Date.now(), text: await gatherActivity(db, config, since, until) };
  } catch (err) {
    cache = { at: Date.now(), text: `(activity unavailable: ${String(err instanceof Error ? err.message : err)})` };
  }
  return cache.text;
}

/**
 * The standup wrap-up: gather the day's facts, then one pure completion to
 * tell them the way the owner would in standup. Facts in, voice out —
 * anything not in the gathered block must not appear in the wrap-up.
 */
export async function composeWrapup(db: DB, config: Config, day: string): Promise<string> {
  const { since, until } = dayBounds(day);
  const activity = await gatherActivity(db, config, since, until);
  const brain = loadBrain(config.brainDir);

  const prompt = `You are the owner's replica writing their DAILY WRAP-UP for ${day} — the thing they read out (or paste) at standup.

OWNER PROFILE (for voice — first person, their register):
${brain.profile}

WHAT ACTUALLY HAPPENED THAT DAY (the only source of truth — if it's not here, it didn't happen):
${activity}

Write the wrap-up as short markdown:
- **Shipped** — merged PRs and landed commits, grouped by stream/repo, with PR numbers and ticket ids. Plain sentences, not commit-message dumps.
- **In flight** — branch work not yet merged, open PRs.
- **Handled** — anything notable from the ledger (approvals, closed items). Skip the section if empty.
- **For today** — only if the facts imply an obvious next step (an approved PR waiting on merge, a branch ready for PR). Never invent plans.
Rules: first person, the owner's voice, no corporate fluff. Never invent facts, numbers, or tickets — where a section came up "(none)", say "nothing" honestly, and never state a review/CI/merge status the facts above don't literally carry. Total length: what fits in a standup slot.`;

  const q = query({ prompt, options: { model: config.model, tools: [], settingSources: [], maxTurns: 4 } });
  for await (const message of q) {
    if (message.type === "result") {
      if ((message as { subtype: string }).subtype !== "success")
        throw new Error(`wrapup failed: ${(message as { subtype: string }).subtype}`);
      return (message as unknown as { result: string }).result;
    }
  }
  throw new Error("wrapup ended without a result");
}
