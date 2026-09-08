/** The core loop: ingest (deterministic) → classify (model) → queue (DB). */
import {
  audit,
  getSetting,
  hasItem,
  insertItem,
  laneCounts,
  loadBrain,
  openDb,
  setSetting,
  type Lane,
  type RawItem,
} from "@standin/core";
import type { Config } from "./config.ts";
import { classify } from "./classify.ts";
import { ingestLinear } from "./connectors/linear.ts";
import { ingestLinearOAuth } from "./connectors/linear-mcp.ts";
import { ingestGithub } from "./connectors/github.ts";
import { ingestSlack } from "./connectors/slack.ts";

export interface TriageResult {
  ingested: number;
  new: number;
  counts: Record<Lane, number>;
  warnings: string[]; // ingest problems belong on the owner's screen, not in a log
}

export async function runTriage(config: Config): Promise<TriageResult> {
  const brain = loadBrain(config.brainDir);
  const db = openDb(config.dbPath);

  const raw: RawItem[] = [];
  const warnings: string[] = [];
  if (config.linearApiKey) {
    raw.push(...(await ingestLinear(config.linearApiKey)));
  } else if (config.linearMcp) {
    raw.push(...(await ingestLinearOAuth()));
  } else {
    warnings.push("Linear not connected — nothing ingested from it");
  }

  // GitHub: PRs waiting on the owner's review + their own open PRs.
  try {
    raw.push(...(await ingestGithub()));
  } catch (err) {
    warnings.push(`GitHub ingest failed: ${String(err instanceof Error ? err.message : err)}`);
  }

  // Slack: channels the bot is invited to, since the last sweep (default 24h).
  if (config.slackBotToken) {
    const since =
      getSetting(db, "slackSince") ?? String(Date.now() / 1000 - 24 * 3600);
    try {
      const msgs = await ingestSlack(config.slackBotToken, since);
      raw.push(...msgs);
      setSetting(db, "slackSince", String(Date.now() / 1000));
      if (msgs.length === 0 && getSetting(db, "slackSweptOnce") !== "yes")
        warnings.push("Slack swept 0 messages — has the bot been /invited to your channels?");
      if (msgs.length > 0) setSetting(db, "slackSweptOnce", "yes");
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      warnings.push(
        msg.includes("missing_scope")
          ? "Slack read failed: the installed app is send-only (old manifest) — see the Slack card in Connections for the one-step fix"
          : `Slack ingest failed: ${msg}`,
      );
    }
  }

  const fresh = raw.filter((r) => !hasItem(db, r.source, r.externalId));
  const classified = await classify(brain, fresh, config.model);
  const byId = new Map(classified.map((c) => [c.externalId, c]));

  for (const item of fresh) {
    const c = byId.get(item.externalId)!;
    insertItem(db, item, {
      lane: c.lane,
      summary: c.summary,
      reason: c.reason,
      draft: c.draft,
      action: c.action,
    });
  }
  audit(
    db,
    "triage.run",
    `ingested ${raw.length}, new ${fresh.length} (profile: ${brain.profileName})`,
  );
  return { ingested: raw.length, new: fresh.length, counts: laneCounts(db), warnings };
}
