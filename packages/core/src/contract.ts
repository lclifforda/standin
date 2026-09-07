/**
 * THE SAFETY CONTRACT, AS CODE.
 *
 * `executeApproved` is the only function in the system permitted to perform an
 * outbound action (send a message, post a comment, merge a PR). It requires an
 * approval minted by `mintApproval`, which is only ever called from an explicit
 * owner yes (the UI's Approve button, or a typed CLI confirmation).
 *
 * Guarantees:
 *  - no approval, no send (executors are never exported to callers);
 *  - single use — an approval spends itself;
 *  - what goes out is byte-for-byte what was approved (hash re-checked at
 *    execution time against the stored action);
 *  - every mint, execution, and failure lands in the audit log.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ActionSpec, Approval } from "./types.ts";
import {
  audit,
  getApproval,
  insertApproval,
  markApprovalUsed,
  type DB,
} from "./db.ts";

export type Executor = (action: ActionSpec) => Promise<string>; // returns a result note
export type ExecutorRegistry = Partial<Record<ActionSpec["kind"], Executor>>;

export class ContractViolation extends Error {}

function hashAction(actionJson: string): string {
  return createHash("sha256").update(actionJson, "utf8").digest("hex");
}

/** Record the owner's explicit yes for exactly this action. */
export function mintApproval(
  db: DB,
  itemId: number,
  action: ActionSpec,
  approvedBy: string,
): Approval {
  const actionJson = JSON.stringify(action);
  const approval: Approval = {
    id: randomUUID(),
    itemId,
    actionJson,
    contentHash: hashAction(actionJson),
    approvedBy,
    mintedAt: new Date().toISOString(),
    usedAt: null,
  };
  insertApproval(db, approval);
  audit(db, "approval.minted", `${action.kind} approved by ${approvedBy}`, {
    itemId,
    approvalId: approval.id,
  });
  return approval;
}

/** Execute a previously approved action. The only door out. */
export async function executeApproved(
  db: DB,
  approvalId: string,
  executors: ExecutorRegistry,
): Promise<string> {
  const approval = getApproval(db, approvalId);
  if (!approval) throw new ContractViolation(`no approval ${approvalId}`);
  if (approval.usedAt)
    throw new ContractViolation(`approval ${approvalId} already used at ${approval.usedAt}`);
  if (hashAction(approval.actionJson) !== approval.contentHash)
    throw new ContractViolation(
      `approval ${approvalId} content hash mismatch — stored action was altered after approval`,
    );

  const action = JSON.parse(approval.actionJson) as ActionSpec;
  const executor = executors[action.kind];
  if (!executor)
    throw new ContractViolation(`no executor configured for action kind "${action.kind}"`);

  // Spend the approval BEFORE executing so a crash can't double-send.
  markApprovalUsed(db, approvalId);
  try {
    const note = await executor(action);
    audit(db, "send.executed", `${action.kind}: ${note}`, {
      itemId: approval.itemId,
      approvalId,
    });
    return note;
  } catch (err) {
    audit(db, "send.failed", `${action.kind}: ${String(err)}`, {
      itemId: approval.itemId,
      approvalId,
    });
    throw err;
  }
}
