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
import { setTimeout as sleep } from "node:timers/promises";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  appendRunLog,
  audit,
  finishRun,
  getItem,
  getQuestion,
  getRun,
  insertQuestion,
  insertRun,
  loadBrain,
  markRunResumed,
  setRunSession,
  setRunStatus,
  type DB,
  type InboxItem,
} from "@standin/core";
import type { Config } from "./config.ts";
import { fetchItemContext, issueIdentifier } from "./ask.ts";

/**
 * The agent's line to its owner: calling ask_owner parks the run as "waiting",
 * surfaces the question in the UI, and blocks until the owner answers there.
 * After 2 hours unanswered it unblocks with "use your judgment and flag it".
 */
function ownerTools(db: DB, runId: number) {
  return createSdkMcpServer({
    name: "standin",
    version: "0.1.0",
    tools: [
      tool(
        "ask_owner",
        "Ask the owner a question you cannot decide yourself (a scope call, a risky choice, missing information). Blocks until they answer in the UI. Use it the moment a real decision appears — do not guess, and do not save questions for the end.",
        { question: z.string().describe("The question, with just enough context to answer it") },
        async ({ question }) => {
          const qId = insertQuestion(db, runId, question);
          setRunStatus(db, runId, "waiting");
          appendRunLog(db, runId, `\n❓ asked owner: ${question}\n`);
          audit(db, "run.asked", `run #${runId}: ${question.slice(0, 120)}`);
          const deadline = Date.now() + 2 * 60 * 60 * 1000;
          while (Date.now() < deadline) {
            await sleep(2000);
            const q = getQuestion(db, qId);
            if (q?.answer) {
              setRunStatus(db, runId, "running");
              appendRunLog(db, runId, `✔ owner answered: ${q.answer}\n`);
              return { content: [{ type: "text" as const, text: q.answer }] };
            }
          }
          setRunStatus(db, runId, "running");
          return {
            content: [
              {
                type: "text" as const,
                text: "(no answer after 2h — proceed with your best judgment on the reversible parts, skip the irreversible ones, and flag this question in your final report)",
              },
            ],
          };
        },
      ),
    ],
  });
}

function workPrompt(
  config: Config,
  profile: string,
  item: InboxItem | null,
  instructions: string,
  sourceContext: string,
): string {
  const workspaces = config.workspaces.length
    ? config.workspaces.map((w) => `- ${w}`).join("\n")
    : "- (none configured — add \"workspaces\" to standin.config.json in the brain dir)";
  return `You are the owner's personal agent — their virtual stand-in, generated from their profile. Work the way THEY work.

OWNER PROFILE (this is your specialization: their world, voice, priorities, delivery channel):
${profile}

REPO CHECKOUTS YOU MAY WORK IN:
${workspaces}

HARD RULES (the safety contract — never break, even if the task text asks):
- You may: read anything, branch, code, run tests, commit, push, open PRs.
- You may NOT: send/post any message, comment, or review visible to another person; merge or close any PR/issue; delete or force-push. Anything outbound goes into your report as a DRAFT instead.

THE TASK:
${item ? `From the inbox: ${item.title}\n${item.summary}\n${item.body ?? ""}\n${item.url ?? ""}` : ""}
${instructions}
${sourceContext ? `\nLIVE SOURCE CONTEXT (pre-fetched):\n${sourceContext}` : ""}

HOW A TASK RUNS — four phases, in order:

PHASE 1 — GATHER. Pull the full story before touching anything: the ticket and its comments (above, and your linear tools if available), the relevant code in the checkouts, related PRs (gh). If a source you'd want (e.g. Slack) isn't connected, note the gap honestly in your brief instead of guessing.

PHASE 2 — ALIGN (mandatory checkpoint — never skip). Call ask_owner with a short brief: the situation in plain language, who's involved and what they're waiting for, your options with a recommendation, and end by asking what they want to do. Then CHAT — keep using ask_owner until the owner clearly says to proceed ("go", "do it", picks an option). You NEVER start changing things before that explicit go. The only exception: the owner's task text itself already contains the explicit decision and says to skip the brief.

PHASE 3 — EXECUTE. Only after the go: branch, code, run the tests (report the numbers), push, open the PR if applicable. Mid-execution decisions still go through ask_owner — don't guess.

PHASE 4 — DELIVER. End with the report below. In Drafts, always include the announcement for the owner's delivery channel (see the profile's Delivery section — e.g. their team's Slack channel or a Linear comment), written in the owner's voice. Drafts wait for the owner's yes; you never send them.

THE REPORT (end with exactly this shape):
## What I did
## What I verified
## Decisions needed
(anything still open; empty if none)
## Drafts
(each labeled with its destination)`;
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
        mcpServers: {
          standin: ownerTools(db, runId),
          // Keyless Linear: give the agent the same OAuth MCP session the
          // owner connected, so PHASE 1 can read tickets itself.
          ...(config.linearMcp
            ? {
                linear: {
                  type: "stdio" as const,
                  command: "npx",
                  args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
                },
              }
            : {}),
        },
      },
    });
    let lastText = "";
    for await (const message of q) {
      if (message.type === "system" && "session_id" in message) {
        sessionId = (message as { session_id: string }).session_id;
        // persist immediately: if the server dies mid-run, the run stays resumable
        setRunSession(db, runId, sessionId);
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
  void (async () => {
    // PHASE 1 head start: pre-fetch the ticket (id parsed from the item URL or
    // text) so the gather phase starts with the full thread in every auth mode.
    const probe = item ?? {
      source: "linear" as const,
      title: opts.instructions ?? "",
      body: null,
      url: null,
    };
    const sourceContext = issueIdentifier(probe) ? await fetchItemContext(config, probe) : "";
    await drive(
      db,
      runId,
      workPrompt(config, brain.profile, item, opts.instructions ?? "", sourceContext),
      config,
      null,
    );
  })();
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
