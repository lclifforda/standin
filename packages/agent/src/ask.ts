/**
 * Ask-about-this: per-card chat for context. Gathers the live source context
 * deterministically (the Linear issue, its people, its comments), then runs a
 * pure completion — no tools — to answer the owner's question in plain
 * language. Read-only by construction: nothing here can send.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getItem, loadBrain, type ChatMessage, type DB } from "@standin/core";
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

export async function askAboutItem(
  db: DB,
  config: Config,
  itemId: number,
  question: string,
  history: ChatMessage[] = [],
): Promise<string> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`no item #${itemId}`);
  const brain = loadBrain(config.brainDir);
  const sourceContext = await fetchItemContext(config, item);

  const conversation = history
    .filter((m) => m.status === "done" && m.content)
    .map((m) => `${m.role === "owner" ? "OWNER" : "YOU"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are the owner's virtual stand-in. They are looking at ONE inbox item and chatting with you about it. Answer plainly and concretely — who's involved, what happened, what their options are. Lead with the answer. Never invent facts; if the context doesn't say, say so. Do not send anything; you are read-only.

OWNER PROFILE (for what matters to them):
${brain.profile}

THE INBOX ITEM:
${item.title}
${item.summary}
${item.body ?? ""}
${item.url ?? ""}

LIVE SOURCE CONTEXT (the actual ticket, people, and comments):
${sourceContext || "(no live context could be fetched — say so and answer from the item alone)"}

${conversation ? `THE CONVERSATION SO FAR:\n${conversation}\n` : ""}
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
      return (message as unknown as { result: string }).result;
    }
  }
  throw new Error("ask ended without a result");
}
