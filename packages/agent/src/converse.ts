/**
 * Conversations: the central terminal. Each conversation is a PERSISTENT agent
 * session (Claude Agent SDK, same engine as work.ts work runs) wearing the
 * owner's profile — it can read the owner's world live (git, gh, Linear),
 * remember across sessions (memory/REPLICA.md in the brain), spawn background
 * work runs, and propose outbound actions that only the owner's click executes
 * through the audited contract (core/contract.ts). A session can never send on
 * its own: executeApproved() is the single door out, and a session holds no
 * approvals.
 *
 * Code edits are yolo-gated: with yolo off the session is told it is
 * read-only — the same trust model the work runner uses for the send rules.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  audit,
  getConversation,
  getSetting,
  insertConvMsg,
  laneCounts,
  listItems,
  loadBrain,
  resolveConvMsg,
  setConvMsgContent,
  touchConversation,
  type DB,
} from "@standin/core";
import type { Config } from "./config.ts";
import { parseProposals } from "./ask.ts";
import { startWorkRun } from "./work.ts";

const MEMORY_FILE = "memory/REPLICA.md";

function readMemory(brainDir: string): string {
  const path = join(brainDir, MEMORY_FILE);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The session's own hands: long-term memory + dispatching background agents. */
function conversationTools(db: DB, config: Config, conversationId: number) {
  return createSdkMcpServer({
    name: "standin",
    version: "0.1.0",
    tools: [
      tool(
        "remember",
        "Save one durable fact to your long-term memory (memory/REPLICA.md in the brain) — something worth knowing in every future conversation: a preference the owner stated, a decision made, a recurring context. One short line per fact. Don't save session chatter.",
        { fact: z.string().describe("The fact, one line, self-contained") },
        async ({ fact }) => {
          const line = `- [${new Date().toISOString().slice(0, 10)}] ${fact.trim()}\n`;
          await appendFile(join(config.brainDir, MEMORY_FILE), line, "utf8");
          audit(db, "memory.saved", `conversation #${conversationId}: ${fact.slice(0, 120)}`);
          return { content: [{ type: "text" as const, text: "remembered" }] };
        },
      ),
      tool(
        "start_agent",
        "Kick off a background work run on a task (it gathers context, briefs the owner, and only proceeds after their go). Use when the owner asks you to 'go do X' and the work is bigger than this conversation — you keep talking while it works. Requires yolo mode; if it's off, tell the owner to flip it.",
        {
          instructions: z.string().describe("The task, self-contained — the run doesn't see this conversation"),
          itemId: z.number().optional().describe("Queue item id to anchor on, if the task came from the queue"),
        },
        async ({ instructions, itemId }) => {
          if (getSetting(db, "yolo") !== "on")
            return { content: [{ type: "text" as const, text: "yolo is off — ask the owner to flip the yolo switch, then try again" }] };
          const runId = startWorkRun(db, config, { itemId, instructions });
          audit(db, "run.started", `from conversation #${conversationId}: ${instructions.slice(0, 100)}`);
          return { content: [{ type: "text" as const, text: `agent run #${runId} started — it will brief the owner in the Work tab before touching anything. Tell the owner it's running and where to watch it.` }] };
        },
      ),
    ],
  });
}

const CONV_PROPOSAL_GUIDE = `
ACTING OUTWARD — proposals, never sends. When the owner asks you to send/post/merge something, or one obvious outbound action would close the topic, end your reply with ONE line:
PROPOSALS: [{"kind":"...","label":"...", ...params}]
Allowed kinds and required params:
  {"kind":"linear.comment","issueId":"ABC-123","body":"...","label":"Comment on ABC-123"}
  {"kind":"linear.status","issueId":"ABC-123","status":"In Review","label":"Move ABC-123 to In Review"}
  {"kind":"github.comment","prUrl":"https://github.com/...","body":"...","label":"Comment on the PR"}
  {"kind":"github.close","prUrl":"https://github.com/...","label":"Close the PR"}
  {"kind":"github.merge","prUrl":"https://github.com/...","label":"Merge the PR"}
  {"kind":"slack.message","channel":"C0123...","text":"...","label":"Reply in #channel"}
Rules: at most 3; every param from real context (never invent ids/urls); bodies in the owner's voice; the owner's click executes — say in your text what each proposal does. No proposals line when just talking.`;

function firstPrompt(db: DB, config: Config, message: string): string {
  const brain = loadBrain(config.brainDir);
  const memory = readMemory(config.brainDir);
  const counts = laneCounts(db);
  const open = listItems(db, { lanes: [3, 4] })
    .slice(0, 8)
    .map((i) => `- [lane ${i.lane}] #${i.id} ${i.title}`)
    .join("\n");
  const workspaces = config.workspaces.length
    ? config.workspaces.map((w) => `- ${w}`).join("\n")
    : "- (none configured)";
  const yolo = getSetting(db, "yolo") === "on";

  return `You are the owner's REPLICA — their virtual working copy, in an ongoing conversation. This is their central terminal: they think, plan, and dispatch work by talking to you. Be warm, brief, concrete; lead with the answer; work the way THEY work.

OWNER PROFILE (your specialization — their world, voice, priorities):
${brain.profile}

LEARNED DECISIONS (their triage line):
${brain.decisions}

LONG-TERM MEMORY (facts you saved in past conversations — use them; add to them with the remember tool):
${memory || "(empty — start remembering what matters)"}

YOUR HANDS:
- Read anything live rather than answering from stale context: git log/show in the checkouts, gh (PRs, reviews, CI), the linear tools for tickets. When asked "what happened / what did I do", go look.
- remember: save durable facts to long-term memory.
- start_agent: dispatch a background work run for bigger tasks while the conversation continues.
${yolo
    ? "- Code: you MAY edit, run tests, commit, push, and open PRs in the checkouts below (yolo is ON). Mid-work decisions still get asked here in the conversation."
    : "- Code: yolo is OFF — you are READ-ONLY today: no edits, no writes, no commits, no state-changing commands. Say so if asked to change things, and point at the yolo switch."}

REPO CHECKOUTS:
${workspaces}

HARD RULES (the safety contract):
- Nothing outbound from your own tools: no posting messages, comments, or reviews visible to another person, no merging/closing/deleting (that includes gh pr comment/merge/close, the linear write tools, git push --force). Outbound = a PROPOSAL; the owner's click executes it through the audited contract.
- Never invent facts, numbers, dates, or commitments. If you don't know, go read; if you can't, say what's missing.
${CONV_PROPOSAL_GUIDE}

THE QUEUE RIGHT NOW (${counts[3] + counts[4]} surfaced, ${counts[1] + counts[2]} quiet — the Queue tab has the cards):
${open || "(clear)"}

THE OWNER SAYS:
${message}`;
}

/**
 * Send a message into a conversation. Inserts the owner's message and a pending
 * reply immediately (reload-safe; the UI polls), then drives the session in the
 * background — resuming the conversation's existing session when there is one.
 */
export function sendToConversation(db: DB, config: Config, conversationId: number, message: string): void {
  const conv = getConversation(db, conversationId);
  if (!conv) throw new Error(`no conversation #${conversationId}`);
  if (conv.status === "running") throw new Error("still answering — wait for the reply");

  insertConvMsg(db, conversationId, "owner", message);
  const pendingId = insertConvMsg(db, conversationId, "standin", "", "pending");
  touchConversation(db, conversationId, { status: "running" });
  if (conv.title === "New conversation")
    touchConversation(db, conversationId, { title: message.slice(0, 64) });

  const prompt = conv.sessionId
    ? message // resumed session already carries the framing and history
    : firstPrompt(db, config, message);

  void drive(db, config, conversationId, pendingId, prompt, conv.sessionId);
}

async function drive(
  db: DB,
  config: Config,
  conversationId: number,
  pendingId: number,
  prompt: string,
  resumeSessionId: string | null,
): Promise<void> {
  const crumbs: string[] = [];
  try {
    const q = query({
      prompt,
      options: {
        model: config.model,
        cwd: config.workspaces[0] ?? homedir(),
        resume: resumeSessionId ?? undefined,
        // Same permission posture as work.ts runs: the session runs on the
        // owner's own machine, in their own checkouts, as their stand-in.
        // Outbound safety is structural (contract.ts), not permission-prompt
        // based; read-only mode is enforced by the session rules above.
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        mcpServers: {
          standin: conversationTools(db, config, conversationId),
          // Keyless Linear: the same OAuth MCP session the owner connected.
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
        // persist immediately: a server death mid-answer keeps the thread resumable
        touchConversation(db, conversationId, { sessionId: (message as { session_id: string }).session_id });
      } else if (message.type === "assistant") {
        const blocks = (message as { message: { content: unknown } }).message.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks as { type: string; text?: string; name?: string }[]) {
            if (b.type === "text" && b.text) lastText = b.text;
            else if (b.type === "tool_use" && b.name) {
              crumbs.push(b.name.replace(/^mcp__\w+__/, ""));
              setConvMsgContent(db, pendingId, `⚙ ${crumbs.slice(-4).join(" · ")}`);
            }
          }
        }
      } else if (message.type === "result") {
        const ok = (message as { subtype: string }).subtype === "success";
        const raw = ok
          ? ((message as { result: string }).result ?? lastText)
          : `session ended: ${(message as { subtype: string }).subtype}${lastText ? `\n\n${lastText}` : ""}`;
        const { text, proposals } = parseProposals(raw);
        resolveConvMsg(db, pendingId, text, ok ? "done" : "failed", proposals);
        touchConversation(db, conversationId, { status: "idle" });
        return;
      }
    }
    resolveConvMsg(db, pendingId, "session ended without a result", "failed");
    touchConversation(db, conversationId, { status: "idle" });
  } catch (err) {
    resolveConvMsg(db, pendingId, String(err instanceof Error ? err.message : err), "failed");
    touchConversation(db, conversationId, { status: "idle" });
  }
}
