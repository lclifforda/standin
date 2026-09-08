/**
 * Ask-about-this: per-card chat for context. Gathers the live source context
 * deterministically (the Linear issue, its people, its comments), then runs a
 * pure completion — no tools — to answer the owner's question in plain
 * language. Read-only by construction: nothing here can send.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getItem,
  listItems,
  listRuns,
  loadBrain,
  type ActionProposal,
  type ChatMessage,
  type DB,
} from "@standin/core";

export interface AskResult {
  text: string;
  proposals: ActionProposal[] | null;
}

const PROPOSAL_KINDS = new Set([
  "linear.comment",
  "linear.status",
  "github.comment",
  "github.close",
  "github.merge",
  "slack.message",
  "agent.run",
]);

/** The agent may end its reply with `PROPOSALS: [...]` — parse and validate. */
export function parseProposals(raw: string): AskResult {
  const m = raw.match(/\nPROPOSALS:\s*(\[[\s\S]*?\])\s*$/);
  if (!m) return { text: raw.trim(), proposals: null };
  try {
    const arr = JSON.parse(m[1]!) as ActionProposal[];
    const ok = arr
      .filter((p) => p && typeof p.kind === "string" && PROPOSAL_KINDS.has(p.kind) && typeof p.label === "string")
      .slice(0, 3);
    return { text: raw.slice(0, m.index).trim(), proposals: ok.length ? ok : null };
  } catch {
    return { text: raw.trim(), proposals: null };
  }
}

const PROPOSAL_GUIDE = `
When the owner asks you to act — or one obvious action would resolve this — end your reply with ONE line:
PROPOSALS: [{"kind":"...","label":"...", ...params}]
Allowed kinds and their required params:
  {"kind":"linear.comment","issueId":"ABC-123","body":"...","label":"Comment on ABC-123"}
  {"kind":"linear.status","issueId":"ABC-123","status":"In Review","label":"Move ABC-123 to In Review"}
  {"kind":"github.comment","prUrl":"https://github.com/...","body":"...","label":"Comment on the PR"}
  {"kind":"github.close","prUrl":"https://github.com/...","label":"Close the PR"}
  {"kind":"github.merge","prUrl":"https://github.com/...","label":"Merge the PR"}
  {"kind":"slack.message","channel":"C0123...","text":"...","label":"Reply in #channel"}
  {"kind":"agent.run","label":"Start a coding agent on this"}
Rules: at most 3 proposals; every param fully specified from real context (never invent ids/urls); bodies written in the owner's voice; nothing executes until the owner clicks — say what you propose in the text too. No proposals line when just answering a question.`;
import type { Config } from "./config.ts";
import { getIssueContext } from "./connectors/linear.ts";
import { getIssueContextOAuth } from "./connectors/linear-mcp.ts";

/**
 * The ticket id usually lives in the item's URL (linear.app/<org>/issue/ABC-123/…),
 * not its title — Linear notification titles carry the issue *title* only.
 */
export function issueIdentifier(item: {
  title: string;
  body: string | null;
  url: string | null;
}): string | null {
  const fromUrl = item.url?.match(/\/issue\/([A-Z][A-Z0-9]*-\d+)/i)?.[1];
  if (fromUrl) return fromUrl.toUpperCase();
  return `${item.title} ${item.body ?? ""}`.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;
}

export async function fetchItemContext(config: Config, item: {
  source: string;
  title: string;
  body: string | null;
  url: string | null;
}): Promise<string> {
  if (item.source !== "linear") return "";
  const identifier = issueIdentifier(item);
  if (!identifier) return "";
  try {
    if (config.linearApiKey) return await getIssueContext(config.linearApiKey, identifier);
    if (config.linearMcp) return await getIssueContextOAuth(identifier);
    return `(Linear isn't connected — connect it to pull ${identifier} live)`;
  } catch (err) {
    return `(couldn't fetch ${identifier} live: ${String(err instanceof Error ? err.message : err)})`;
  }
}

/**
 * The copy itself: a conversation with the whole working world — queue, agents,
 * priorities — not one item. Read-only pure completion, like askAboutItem.
 */
export async function askGlobal(
  db: DB,
  config: Config,
  question: string,
  history: { role: string; content: string }[] = [],
): Promise<string> {
  const brain = loadBrain(config.brainDir);
  const open = listItems(db, { lanes: [3, 4] });
  const quietCount = listItems(db, { lanes: [1, 2] }).length;
  const runs = listRuns(db);
  const queueContext = open
    .map((i) => `- [lane ${i.lane}] ${i.title} — ${i.summary}${i.draft ? " (draft ready)" : ""}`)
    .join("\n");
  const runsContext = runs
    .slice(0, 10)
    .map((r) => `- [${r.status}] ${r.title}`)
    .join("\n");
  const conversation = history
    .slice(-8)
    .map((m) => `${m.role === "owner" ? "OWNER" : "YOU"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are the owner's REPLICA — their virtual working copy, speaking with their context. The owner is talking to you directly. Be warm, brief, concrete. Lead with the answer. When asked "what's going on" or "what should I do", give priorities in order with WHY, and point at the exact next click (approve the draft on X, answer the agent's question on Y, go do it on Z). Never invent facts; if you don't know, say what's missing. You cannot send or execute anything from this conversation — actions happen through the queue's Approve and the agents' runs.

OWNER PROFILE:
${brain.profile}

LEARNED DECISIONS:
${brain.decisions}

THE QUEUE RIGHT NOW (${open.length} open, ${quietCount} handled quietly):
${queueContext || "(empty — nothing needs the owner)"}

AGENT RUNS:
${runsContext || "(none)"}

${conversation ? `THE CONVERSATION SO FAR:\n${conversation}\n` : ""}
OWNER'S MESSAGE:
${question}`;

  const q = query({
    prompt,
    options: { model: config.model, tools: [], settingSources: [], maxTurns: 4 },
  });
  for await (const message of q) {
    if (message.type === "result") {
      if ((message as { subtype: string }).subtype !== "success")
        throw new Error(`ask failed: ${(message as { subtype: string }).subtype}`);
      return (message as unknown as { result: string }).result;
    }
  }
  throw new Error("ask ended without a result");
}

export async function askAboutItem(
  db: DB,
  config: Config,
  itemId: number,
  question: string,
  history: ChatMessage[] = [],
  taskContext = "",
): Promise<AskResult> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`no item #${itemId}`);
  const brain = loadBrain(config.brainDir);
  const sourceContext = await fetchItemContext(config, item);

  const conversation = history
    .filter((m) => m.status === "done" && m.content)
    .map((m) => `${m.role === "owner" ? "OWNER" : "YOU"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are this task's agent — the owner's stand-in on ONE task. Talk it through with them: who's involved, what happened, what the options are. Lead with the answer. Never invent facts; if the context doesn't say, say so. You never execute directly: you PROPOSE actions and the owner's click approves them through the audited contract.

OWNER PROFILE (their voice for any drafted body):
${brain.profile}

THE TASK (anchor item):
${item.title}
${item.summary}
${item.body ?? ""}
${item.url ?? ""}
${taskContext ? `\nEVERYTHING GROUPED UNDER THIS TASK:\n${taskContext}` : ""}

LIVE SOURCE CONTEXT (the actual ticket, people, and comments):
${sourceContext || "(no live context could be fetched — say so and answer from the item alone)"}

${conversation ? `THE CONVERSATION SO FAR:\n${conversation}\n` : ""}
${PROPOSAL_GUIDE}

OWNER'S NEW MESSAGE:
${question}`;

  const q = query({
    prompt,
    options: { model: config.model, tools: [], settingSources: [], maxTurns: 4 },
  });
  for await (const message of q) {
    if (message.type === "result") {
      if ((message as { subtype: string }).subtype !== "success")
        throw new Error(`ask failed: ${(message as { subtype: string }).subtype}`);
      return parseProposals((message as unknown as { result: string }).result);
    }
  }
  throw new Error("ask ended without a result");
}
