#!/usr/bin/env tsx
/**
 * standin CLI: triage | queue | approve <id> | audit
 * The web UI (apps/web) is the richer door; this is the same brain from a terminal.
 */
import { createInterface } from "node:readline/promises";
import {
  actionBody,
  audit,
  executeApproved,
  getItem,
  listAudit,
  listItems,
  mintApproval,
  openDb,
  setItemStatus,
} from "@standin/core";
import { loadConfig } from "./config.ts";
import { buildExecutors } from "./executors.ts";
import { runTriage } from "./triage.ts";

const LANE_LABEL: Record<number, string> = {
  1: "noise",
  2: "prep & park",
  3: "BRING TO YOU",
  4: "ESCALATE",
};

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadConfig(process.env.STANDIN_BRAIN);

  switch (cmd) {
    case "triage": {
      const r = await runTriage(config);
      console.log(
        `ingested ${r.ingested}, new ${r.new} · open queue — ` +
          `lane 4: ${r.counts[4]} · lane 3: ${r.counts[3]} · handled quietly: ${
            r.counts[1] + r.counts[2]
          }`,
      );
      if (r.counts[3] + r.counts[4] > 0) console.log(`run \`standin queue\` to see them`);
      break;
    }

    case "queue": {
      const db = openDb(config.dbPath);
      const items = listItems(db, { lanes: [3, 4] });
      if (items.length === 0) {
        console.log("nothing needs you — the queue is clear.");
        break;
      }
      for (const it of items) {
        console.log(`\n#${it.id} [${LANE_LABEL[it.lane]}] ${it.title}`);
        console.log(`   ${it.summary}`);
        if (it.draft) console.log(`   draft ready — approve with: standin approve ${it.id}`);
        if (it.url) console.log(`   ${it.url}`);
      }
      break;
    }

    case "approve": {
      const id = Number(arg);
      const db = openDb(config.dbPath);
      const item = getItem(db, id);
      if (!item) throw new Error(`no item #${id}`);
      if (!item.action || !item.draft)
        throw new Error(`item #${id} has no drafted action to approve`);
      console.log(`\n${item.summary}\n`);
      console.log(`--- exactly this will be sent (${item.action.kind}) ---`);
      console.log(actionBody(item.action));
      console.log(`---`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("send it? type yes to approve: ");
      rl.close();
      if (answer.trim().toLowerCase() !== "yes") {
        console.log("not sent.");
        break;
      }
      const approval = mintApproval(db, item.id, item.action, "cli:typed-yes");
      const note = await executeApproved(db, approval.id, buildExecutors(config));
      setItemStatus(db, item.id, "done");
      console.log(`✓ ${note}`);
      break;
    }

    case "audit": {
      const db = openDb(config.dbPath);
      for (const e of listAudit(db, 50).reverse())
        console.log(`${e.ts}  ${e.type.padEnd(16)} ${e.detail}`);
      break;
    }

    case "dismiss": {
      const db = openDb(config.dbPath);
      const id = Number(arg);
      setItemStatus(db, id, "dismissed");
      audit(db, "item.dismissed", `#${id} dismissed from CLI`, { itemId: id });
      console.log(`#${id} dismissed.`);
      break;
    }

    default:
      console.log(`standin — a clone of your working self
usage:
  standin triage        read your inbox, sort it, draft replies
  standin queue         show what needs you (lanes 3–4)
  standin approve <id>  review a draft and send it with your explicit yes
  standin dismiss <id>  clear an item without acting
  standin audit         the ledger: every mint, send, and failure`);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
