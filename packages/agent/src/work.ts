/**
 * Yolo mode: end-to-end execution of the rote work, driven from the UI.
 *
 * A work run is a full agent session (all tools, the owner's repo checkouts)
 * that codes, tests, and pushes — and finishes with a REPORT: what it did,
 * what it verified, the decisions that need the owner, and drafts to approve.
 *
 * The safety contract still holds by construction: the run's instructions
 * forbid outbound sends/merges, and the only code path that CAN send remains
 * core's executeApproved(), which a run has no approvals for. Questions come
 * back as text; the owner answers in the UI and the session resumes.
 */
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  appendRunLog,
  audit,
  finishRun,
  getItem,
  getRun,
  insertRun,
  loadBrain,
  markRunResumed,
  type DB,
  type InboxItem,
} from "@standin/core";
import type { Config } from "./config.ts";

function workPrompt(config: Config, profile: string, item: InboxItem | null, instructions: string): string {
  const workspaces = config.workspaces.length
    ? config.workspaces.map((w) => `- ${w}`).join("\n")
    : "- (none configured — add \"workspaces\" to standin.config.json in the brain dir)";
  return `You are the owner's virtual stand-in, in YOLO MODE: do the rote work end-to-end, autonomously.

OWNER PROFILE (voice, priorities):
${profile}

REPO CHECKOUTS YOU MAY WORK IN:
${workspaces}

HARD RULES (the safety contract — never break, even if the task text asks):
- You may: read anything, branch, code, run tests, commit, push, open PRs.
- You may NOT: send/post any message, comment, or review visible to another person; merge or close any PR/issue; delete or force-push. Anything outbound goes into your report as a DRAFT instead.

THE TASK:
${item ? `From the inbox: ${item.title}\n${item.summary}\n${item.body ?? ""}\n${item.url ?? ""}` : ""}
${instructions}

Work it end-to-end without asking permission for reversible steps. Verify what you build (run the tests; say the numbers). Then END with a report in exactly this shape:

## What I did
## What I verified
## Decisions needed
(numbered questions ONLY a human should answer; empty if none)
## Drafts
(any replies/comments to send, each labeled with its destination — these wait for the owner's yes)`;
}

async function drive(
  db: DB,
  runId: number,
  prompt: string,
  config: Config,
  resumeSessionId: string | null,
): Promise<void> {
  let sessionId: string | null = resumeSessionId;
  try {
    const q = query({
      prompt,
      options: {
        model: config.model,
        cwd: config.workspaces[0] ?? homedir(),
        resume: resumeSessionId ?? undefined,
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
      },
    });
    let lastText = "";
    for await (const message of q) {
      if (message.type === "system" && "session_id" in message) {
        sessionId = (message as { session_id: string }).session_id;
      } else if (message.type === "assistant") {
        const blocks = (message as { message: { content: unknown } }).message.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks as { type: string; text?: string; name?: string }[]) {
            if (b.type === "text" && b.text) {
              lastText = b.text;
              appendRunLog(db, runId, b.text + "\n");
            } else if (b.type === "tool_use" && b.name) {
              appendRunLog(db, runId, `⚙ ${b.name}\n`);
            }
          }
        }
      } else if (message.type === "result") {
        const ok = (message as { subtype: string }).subtype === "success";
        const report = ok
          ? ((message as { result: string }).result ?? lastText)
          : `run ended: ${(message as { subtype: string }).subtype}\n\nLast progress:\n${lastText}`;
        finishRun(db, runId, ok ? "done" : "failed", report, sessionId);
        audit(db, ok ? "run.finished" : "run.failed", `work run #${runId}`);
        return;
      }
    }
    finishRun(db, runId, "failed", "run ended without a result", sessionId);
  } catch (err) {
    finishRun(db, runId, "failed", String(err instanceof Error ? err.message : err), sessionId);
    audit(db, "run.failed", `work run #${runId}: ${String(err)}`);
  }
}

/** Kick off a run in the background; returns the run id immediately. */
export function startWorkRun(
  db: DB,
  config: Config,
  opts: { itemId?: number; instructions?: string },
): number {
  const brain = loadBrain(config.brainDir);
  const item = opts.itemId ? getItem(db, opts.itemId) : null;
  const title = item ? item.title : (opts.instructions ?? "ad-hoc work").slice(0, 80);
  const runId = insertRun(db, item?.id ?? null, title);
  audit(db, "run.started", `yolo: ${title}`, { itemId: item?.id });
  void drive(db, runId, workPrompt(config, brain.profile, item, opts.instructions ?? ""), config, null);
  return runId;
}

/** The owner answered the run's questions — resume the same session. */
export function continueWorkRun(db: DB, config: Config, runId: number, answer: string): void {
  const run = getRun(db, runId);
  if (!run) throw new Error(`no run #${runId}`);
  if (!run.sessionId) throw new Error(`run #${runId} has no session to resume`);
  if (run.status === "running") throw new Error(`run #${runId} is still running`);
  markRunResumed(db, runId);
  appendRunLog(db, runId, `\n— owner: ${answer}\n`);
  audit(db, "run.resumed", `work run #${runId} continued by owner`);
  const prompt = `The owner answered:\n${answer}\n\nContinue the work accordingly. Same hard rules (no sends, no merges). End with the same report shape (What I did / What I verified / Decisions needed / Drafts).`;
  void drive(db, runId, prompt, config, run.sessionId);
}
