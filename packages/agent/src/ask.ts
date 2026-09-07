/**
 * Ask-about-this: per-card chat for context. Gathers the live source context
 * deterministically (the Linear issue, its people, its comments), then runs a
 * pure completion — no tools — to answer the owner's question in plain
 * language. Read-only by construction: nothing here can send.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getItem, loadBrain, type DB } from "@standin/core";
import type { Config } from "./config.ts";
import { getIssueContext } from "./connectors/linear.ts";
import { getIssueContextOAuth } from "./connectors/linear-mcp.ts";

function issueIdentifier(text: string): string | null {
  return text.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;
}

export async function askAboutItem(
  db: DB,
  config: Config,
  itemId: number,
  question: string,
): Promise<string> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`no item #${itemId}`);
  const brain = loadBrain(config.brainDir);

  let sourceContext = "";
  if (item.source === "linear") {
    const identifier = issueIdentifier(`${item.title} ${item.body ?? ""}`);
    if (identifier) {
      try {
        if (config.linearApiKey)
          sourceContext = await getIssueContext(config.linearApiKey, identifier);
        else if (config.linearMcp) sourceContext = await getIssueContextOAuth(identifier);
      } catch (err) {
        sourceContext = `(couldn't fetch the live issue: ${String(err)})`;
      }
    }
  }

  const prompt = `You are the owner's virtual stand-in. They are looking at ONE inbox item and asked a question about it. Answer plainly and concretely — who's involved, what happened, what their options are. Lead with the answer. Never invent facts; if the context doesn't say, say so. Do not send anything; you are read-only.

OWNER PROFILE (for what matters to them):
${brain.profile}

THE INBOX ITEM:
${item.title}
${item.summary}
${item.body ?? ""}
${item.url ?? ""}

LIVE SOURCE CONTEXT:
${sourceContext || "(no live context available — answer from the item alone and say what's missing)"}

OWNER'S QUESTION:
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
