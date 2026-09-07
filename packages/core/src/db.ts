import { DatabaseSync } from "node:sqlite";
import type {
  ActionSpec,
  Approval,
  AuditEvent,
  InboxItem,
  ItemStatus,
  Lane,
  RawItem,
} from "./types.ts";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      actor TEXT,
      kind TEXT NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL,
      lane INTEGER NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      draft TEXT,
      action_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      triaged_at TEXT NOT NULL,
      UNIQUE(source, external_id)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      action_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      minted_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      item_id INTEGER,
      approval_id TEXT,
      detail TEXT NOT NULL
    );
  `);
  return db;
}

function rowToItem(r: Record<string, unknown>): InboxItem {
  return {
    id: r.id as number,
    source: r.source as InboxItem["source"],
    externalId: r.external_id as string,
    title: r.title as string,
    url: (r.url as string) ?? null,
    actor: (r.actor as string) ?? null,
    kind: r.kind as string,
    body: (r.body as string) ?? null,
    createdAt: r.created_at as string,
    lane: r.lane as Lane,
    summary: r.summary as string,
    reason: r.reason as string,
    draft: (r.draft as string) ?? null,
    action: r.action_json ? (JSON.parse(r.action_json as string) as ActionSpec) : null,
    status: r.status as ItemStatus,
    triagedAt: r.triaged_at as string,
  };
}

export function hasItem(db: DB, source: string, externalId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM items WHERE source = ? AND external_id = ?")
    .get(source, externalId);
  return row !== undefined;
}

export interface TriagedFields {
  lane: Lane;
  summary: string;
  reason: string;
  draft: string | null;
  action: ActionSpec | null;
}

export function insertItem(db: DB, raw: RawItem, t: TriagedFields): number {
  const res = db
    .prepare(
      `INSERT INTO items
        (source, external_id, title, url, actor, kind, body, created_at,
         lane, summary, reason, draft, action_json, status, triaged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
       ON CONFLICT(source, external_id) DO NOTHING`,
    )
    .run(
      raw.source,
      raw.externalId,
      raw.title,
      raw.url,
      raw.actor,
      raw.kind,
      raw.body,
      raw.createdAt,
      t.lane,
      t.summary,
      t.reason,
      t.draft,
      t.action ? JSON.stringify(t.action) : null,
      new Date().toISOString(),
    );
  return Number(res.lastInsertRowid);
}

export function getItem(db: DB, id: number): InboxItem | null {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToItem(row) : null;
}

export function listItems(db: DB, opts: { lanes?: Lane[]; status?: ItemStatus } = {}): InboxItem[] {
  const status = opts.status ?? "open";
  const lanes = opts.lanes ?? [1, 2, 3, 4];
  const placeholders = lanes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM items WHERE status = ? AND lane IN (${placeholders})
       ORDER BY lane DESC, created_at DESC`,
    )
    .all(status, ...lanes) as Record<string, unknown>[];
  return rows.map(rowToItem);
}

export function laneCounts(db: DB): Record<Lane, number> {
  const rows = db
    .prepare("SELECT lane, COUNT(*) AS n FROM items WHERE status = 'open' GROUP BY lane")
    .all() as { lane: Lane; n: number }[];
  const counts: Record<Lane, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) counts[r.lane] = r.n;
  return counts;
}

export function setItemStatus(db: DB, id: number, status: ItemStatus): void {
  db.prepare("UPDATE items SET status = ? WHERE id = ?").run(status, id);
}

export function updateItemDraft(db: DB, id: number, draft: string, action: ActionSpec | null): void {
  db.prepare("UPDATE items SET draft = ?, action_json = ? WHERE id = ?").run(
    draft,
    action ? JSON.stringify(action) : null,
    id,
  );
}

// --- approvals (written only by contract.ts) ---

export function insertApproval(db: DB, a: Approval): void {
  db.prepare(
    `INSERT INTO approvals (id, item_id, action_json, content_hash, approved_by, minted_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(a.id, a.itemId, a.actionJson, a.contentHash, a.approvedBy, a.mintedAt);
}

export function getApproval(db: DB, id: string): Approval | null {
  const r = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    itemId: r.item_id as number,
    actionJson: r.action_json as string,
    contentHash: r.content_hash as string,
    approvedBy: r.approved_by as string,
    mintedAt: r.minted_at as string,
    usedAt: (r.used_at as string) ?? null,
  };
}

export function markApprovalUsed(db: DB, id: string): void {
  db.prepare("UPDATE approvals SET used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

// --- audit ---

export function audit(
  db: DB,
  type: string,
  detail: string,
  ids: { itemId?: number; approvalId?: string } = {},
): void {
  db.prepare(
    "INSERT INTO audit (ts, type, item_id, approval_id, detail) VALUES (?, ?, ?, ?, ?)",
  ).run(new Date().toISOString(), type, ids.itemId ?? null, ids.approvalId ?? null, detail);
}

export function listAudit(db: DB, limit = 200): AuditEvent[] {
  const rows = db
    .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    ts: r.ts as string,
    type: r.type as string,
    itemId: (r.item_id as number) ?? null,
    approvalId: (r.approval_id as string) ?? null,
    detail: r.detail as string,
  }));
}
