/** The core loop: ingest (deterministic) → classify (model) → queue (DB). */
import {
  audit,
  hasItem,
  insertItem,
  laneCounts,
  loadBrain,
  openDb,
  type Lane,
  type RawItem,
} from "@standin/core";
import type { Config } from "./config.ts";
import { classify } from "./classify.ts";
import { ingestLinear } from "./connectors/linear.ts";
import { ingestLinearOAuth } from "./connectors/linear-mcp.ts";

export interface TriageResult {
  ingested: number;
  new: number;
  counts: Record<Lane, number>;
}

export async function runTriage(config: Config): Promise<TriageResult> {
  const brain = loadBrain(config.brainDir);
  const db = openDb(config.dbPath);

  const raw: RawItem[] = [];
  if (config.linearApiKey) {
    raw.push(...(await ingestLinear(config.linearApiKey)));
  } else if (config.linearMcp) {
    raw.push(...(await ingestLinearOAuth()));
  } else {
    console.warn("Linear not connected — open the Connections panel in the web UI");
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
  return { ingested: raw.length, new: fresh.length, counts: laneCounts(db) };
}
