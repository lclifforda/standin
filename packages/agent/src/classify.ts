/**
 * Classification: the model's one job in the triage loop. It reads the brain
 * (profile, learned decisions, lane rules) and the new raw items, and returns
 * lanes + plain-language summaries + drafts in the owner's voice. It has NO
 * tools — reading happened deterministically in the connectors, and sending
 * only ever happens through the contract.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActionSpec, Brain, Lane, RawItem } from "@standin/core";

export interface Classification {
  externalId: string;
  lane: Lane;
  summary: string;
  reason: string;
  draft: string | null;
  action: ActionSpec | null;
}

function buildPrompt(brain: Brain, items: RawItem[]): string {
  return `You are ${brain.profileName}'s virtual stand-in, triaging their inbox.

THEIR PROFILE:
${brain.profile}

THEIR LEARNED CORRECTIONS (these override the general rules):
${brain.decisions}

THE LANE RULES:
${brain.triageRules}

THE SAFETY CONTRACT (you draft; you never send):
${brain.safetyContract}

NEW INBOX ITEMS (JSON):
${JSON.stringify(items, null, 2)}

For EVERY item, decide its lane (1=noise, 2=prep&park, 3=bring to you, 4=escalate now).
For lane 3-4 items write:
- "summary": one plain-language sentence a smart 18-year-old would get — who it's from, what they need, why it matters. Never jargon-first.
- "reason": why this lane, in a few words.
- "draft": a reply in the owner's voice IF one applies (else null). Never invent facts, dates, numbers, or commitments — if info is missing, say so in the draft.
- "action": what approving the draft would execute, or null. Allowed kinds:
  {"kind":"linear.comment","issueId":"<identifier like ABC-123>","body":"<same text as draft>"}
  {"kind":"slack.message","channel":"<channel or user id>","text":"<same text as draft>"}
  {"kind":"github.comment","prUrl":"<full PR url>","body":"<same text as draft>"}
For lane 1-2 items, summary = one short line; reason required; draft and action null.
When unsure between two lanes, pick the HIGHER one (surfacing costs a glance; hiding costs a miss).

Respond with ONLY a JSON array, one object per item:
[{"externalId": "...", "lane": 3, "summary": "...", "reason": "...", "draft": null, "action": null}, ...]`;
}

function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start)
    throw new Error(`classifier returned no JSON array:\n${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

export async function classify(
  brain: Brain,
  items: RawItem[],
  model?: string,
): Promise<Classification[]> {
  if (items.length === 0) return [];
  const q = query({
    prompt: buildPrompt(brain, items),
    options: {
      model,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      settingSources: [],
      maxTurns: 1,
    },
  });
  let text = "";
  for await (const message of q) {
    if (message.type === "result") {
      if (message.subtype !== "success")
        throw new Error(`classifier failed: ${message.subtype}`);
      text = message.result;
    }
  }
  const parsed = extractJsonArray(text) as Classification[];
  const byId = new Map(parsed.map((c) => [c.externalId, c]));
  // Every item must come back classified; anything missing surfaces (lane 3),
  // per the safety default: unsure → show it.
  return items.map(
    (item) =>
      byId.get(item.externalId) ?? {
        externalId: item.externalId,
        lane: 3 as Lane,
        summary: `${item.actor ?? "Someone"}: ${item.title} (classifier skipped this — surfacing to be safe)`,
        reason: "unclassified → surface by default",
        draft: null,
        action: null,
      },
  );
}
