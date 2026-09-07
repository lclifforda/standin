/** The four triage lanes. 1–2 stay quiet; 3–4 are surfaced. */
export type Lane = 1 | 2 | 3 | 4;

export type ItemStatus = "open" | "done" | "dismissed" | "noise";

/**
 * An outbound action the stand-in may perform ONLY through the contract
 * (see contract.ts). Adding a kind here means adding an executor — nothing
 * else in the system is allowed to talk outward.
 */
export type ActionSpec =
  | { kind: "linear.comment"; issueId: string; body: string }
  | { kind: "slack.message"; channel: string; text: string }
  | { kind: "github.comment"; prUrl: string; body: string }
  | { kind: "github.merge"; prUrl: string };

/** What each action sends as human-editable text (shown/edited in the UI). */
export function actionBody(action: ActionSpec): string {
  switch (action.kind) {
    case "linear.comment":
      return action.body;
    case "slack.message":
      return action.text;
    case "github.comment":
      return action.body;
    case "github.merge":
      return `Merge ${action.prUrl}`;
  }
}

/** Replace an action's outgoing text after the owner edits the draft. */
export function withBody(action: ActionSpec, body: string): ActionSpec {
  switch (action.kind) {
    case "linear.comment":
      return { ...action, body };
    case "slack.message":
      return { ...action, text: body };
    case "github.comment":
      return { ...action, body };
    case "github.merge":
      return action; // a merge has no editable text
  }
}

/** A raw item pulled from a connector, before triage. */
export interface RawItem {
  source: "linear" | "slack" | "github";
  externalId: string;
  title: string;
  url: string | null;
  actor: string | null;
  kind: string; // connector-native type, e.g. "pullRequestApproved"
  body: string | null;
  createdAt: string; // ISO
}

/** A triaged inbox item as stored and shown. */
export interface InboxItem extends RawItem {
  id: number;
  lane: Lane;
  summary: string; // plain-language, jargon-free
  reason: string; // why this lane
  draft: string | null; // proposed reply text, if one applies
  action: ActionSpec | null; // what "approve" would execute
  status: ItemStatus;
  triagedAt: string;
}

export interface Approval {
  id: string;
  itemId: number;
  actionJson: string;
  contentHash: string;
  approvedBy: string;
  mintedAt: string;
  usedAt: string | null;
}

export interface AuditEvent {
  id: number;
  ts: string;
  type: string;
  itemId: number | null;
  approvalId: string | null;
  detail: string;
}
