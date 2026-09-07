import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContractViolation,
  executeApproved,
  insertItem,
  mintApproval,
  openDb,
  type ActionSpec,
  type ExecutorRegistry,
  type RawItem,
} from "../src/index.ts";

const raw: RawItem = {
  source: "linear",
  externalId: "n-1",
  title: "test item",
  url: null,
  actor: "Reviewer",
  kind: "pullRequestCommented",
  body: null,
  createdAt: new Date().toISOString(),
};

const action: ActionSpec = { kind: "linear.comment", issueId: "ABC-1", body: "sounds good" };

function setup() {
  const db = openDb(":memory:");
  const itemId = insertItem(db, raw, {
    lane: 3,
    summary: "Reviewer left a comment",
    reason: "review push-back",
    draft: "sounds good",
    action,
  });
  return { db, itemId };
}

test("approve → execute runs the executor exactly once with the approved action", async () => {
  const { db, itemId } = setup();
  const calls: ActionSpec[] = [];
  const executors: ExecutorRegistry = {
    "linear.comment": async (a) => {
      calls.push(a);
      return "posted";
    },
  };
  const approval = mintApproval(db, itemId, action, "test-owner");
  const note = await executeApproved(db, approval.id, executors);
  assert.equal(note, "posted");
  assert.deepEqual(calls, [action]);
});

test("no approval, no send", async () => {
  const { db } = setup();
  await assert.rejects(
    executeApproved(db, "not-a-real-approval", { "linear.comment": async () => "posted" }),
    ContractViolation,
  );
});

test("an approval is single-use", async () => {
  const { db, itemId } = setup();
  let calls = 0;
  const executors: ExecutorRegistry = {
    "linear.comment": async () => {
      calls++;
      return "posted";
    },
  };
  const approval = mintApproval(db, itemId, action, "test-owner");
  await executeApproved(db, approval.id, executors);
  await assert.rejects(executeApproved(db, approval.id, executors), ContractViolation);
  assert.equal(calls, 1);
});

test("a stored action altered after approval is refused (hash check)", async () => {
  const { db, itemId } = setup();
  const approval = mintApproval(db, itemId, action, "test-owner");
  const tampered = JSON.stringify({ ...action, body: "something else entirely" });
  db.prepare("UPDATE approvals SET action_json = ? WHERE id = ?").run(tampered, approval.id);
  let executed = false;
  await assert.rejects(
    executeApproved(db, approval.id, {
      "linear.comment": async () => {
        executed = true;
        return "posted";
      },
    }),
    /content hash mismatch/,
  );
  assert.equal(executed, false);
});

test("an action kind with no configured executor is refused", async () => {
  const { db, itemId } = setup();
  const approval = mintApproval(db, itemId, action, "test-owner");
  await assert.rejects(executeApproved(db, approval.id, {}), /no executor configured/);
});

test("a failed send is auditable and does not crash the contract", async () => {
  const { db, itemId } = setup();
  const approval = mintApproval(db, itemId, action, "test-owner");
  await assert.rejects(
    executeApproved(db, approval.id, {
      "linear.comment": async () => {
        throw new Error("network down");
      },
    }),
    /network down/,
  );
  const failures = db
    .prepare("SELECT COUNT(*) AS n FROM audit WHERE type = 'send.failed'")
    .get() as { n: number };
  assert.equal(failures.n, 1);
});
