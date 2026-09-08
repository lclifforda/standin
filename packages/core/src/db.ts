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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      log TEXT NOT NULL DEFAULT '',
      report TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      question TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS home_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
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

/** Latest ingested items for one source, any lane/status — the raw feed. */
export function listBySource(db: DB, source: string, limit = 8): InboxItem[] {
  const rows = db
    .prepare("SELECT * FROM items WHERE source = ? ORDER BY created_at DESC LIMIT ?")
    .all(source, limit) as Record<string, unknown>[];
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

/** Action kinds actually EXECUTED for these items (spent approvals — the
 *  ledger's own evidence, not intentions). Feeds the task loop strip. */
export function executedKinds(db: DB, itemIds: number[]): string[] {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT action_json FROM approvals WHERE used_at IS NOT NULL AND item_id IN (${placeholders})`,
    )
    .all(...itemIds) as { action_json: string }[];
  return [...new Set(rows.map((r) => (JSON.parse(r.action_json) as { kind: string }).kind))];
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

// --- settings (tiny kv: yolo toggle & co) ---

export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// --- work runs (yolo mode executions) ---

export interface WorkRun {
  id: number;
  itemId: number | null;
  title: string;
  status: "running" | "waiting" | "done" | "failed";
  log: string;
  report: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToRun(r: Record<string, unknown>): WorkRun {
  return {
    id: r.id as number,
    itemId: (r.item_id as number) ?? null,
    title: r.title as string,
    status: r.status as WorkRun["status"],
    log: r.log as string,
    report: (r.report as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertRun(db: DB, itemId: number | null, title: string): number {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      "INSERT INTO runs (item_id, title, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
    )
    .run(itemId, title, now, now);
  return Number(res.lastInsertRowid);
}

export function appendRunLog(db: DB, id: number, chunk: string): void {
  db.prepare("UPDATE runs SET log = log || ?, updated_at = ? WHERE id = ?").run(
    chunk,
    new Date().toISOString(),
    id,
  );
}

export function finishRun(
  db: DB,
  id: number,
  status: "done" | "failed",
  report: string | null,
  sessionId: string | null,
): void {
  db.prepare(
    "UPDATE runs SET status = ?, report = ?, session_id = ?, updated_at = ? WHERE id = ?",
  ).run(status, report, sessionId, new Date().toISOString(), id);
}

export function markRunResumed(db: DB, id: number): void {
  db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}

export function setRunStatus(db: DB, id: number, status: WorkRun["status"]): void {
  db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    id,
  );
}

// --- owner questions (an agent mid-run asks; the owner answers in the UI) ---

export interface OwnerQuestion {
  id: number;
  runId: number;
  question: string;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

function rowToQuestion(r: Record<string, unknown>): OwnerQuestion {
  return {
    id: r.id as number,
    runId: r.run_id as number,
    question: r.question as string,
    answer: (r.answer as string) ?? null,
    createdAt: r.created_at as string,
    answeredAt: (r.answered_at as string) ?? null,
  };
}

export function insertQuestion(db: DB, runId: number, question: string): number {
  const res = db
    .prepare("INSERT INTO questions (run_id, question, created_at) VALUES (?, ?, ?)")
    .run(runId, question, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function getQuestion(db: DB, id: number): OwnerQuestion | null {
  const r = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToQuestion(r) : null;
}

export function answerQuestion(db: DB, id: number, answer: string): void {
  db.prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?").run(
    answer,
    new Date().toISOString(),
    id,
  );
}

// --- item chats (persistent per-card conversations with the stand-in) ---

export interface ChatMessage {
  id: number;
  itemId: number;
  role: "owner" | "standin";
  content: string;
  status: "done" | "pending" | "failed";
  createdAt: string;
}

function rowToChat(r: Record<string, unknown>): ChatMessage {
  return {
    id: r.id as number,
    itemId: r.item_id as number,
    role: r.role as ChatMessage["role"],
    content: r.content as string,
    status: r.status as ChatMessage["status"],
    createdAt: r.created_at as string,
  };
}

export function insertChat(
  db: DB,
  itemId: number,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "done",
): number {
  const res = db
    .prepare("INSERT INTO chats (item_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(itemId, role, content, status, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function resolveChat(
  db: DB,
  id: number,
  content: string,
  status: "done" | "failed",
): void {
  db.prepare("UPDATE chats SET content = ?, status = ? WHERE id = ?").run(content, status, id);
}

export function listChats(db: DB, itemId: number): ChatMessage[] {
  const rows = db
    .prepare("SELECT * FROM chats WHERE item_id = ? ORDER BY id ASC")
    .all(itemId) as Record<string, unknown>[];
  return rows.map(rowToChat);
}

// --- home chat (the replica's persistent conversation with the owner) ---

export interface HomeChatMessage {
  id: number;
  role: "owner" | "standin";
  content: string;
  status: "done" | "pending" | "failed";
  createdAt: string;
}

export function insertHomeChat(
  db: DB,
  role: HomeChatMessage["role"],
  content: string,
  status: HomeChatMessage["status"] = "done",
): number {
  const res = db
    .prepare("INSERT INTO home_chats (role, content, status, created_at) VALUES (?, ?, ?, ?)")
    .run(role, content, status, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function resolveHomeChat(db: DB, id: number, content: string, status: "done" | "failed"): void {
  db.prepare("UPDATE home_chats SET content = ?, status = ? WHERE id = ?").run(content, status, id);
}

export function listHomeChats(db: DB, limit = 60): HomeChatMessage[] {
  const rows = db
    .prepare("SELECT * FROM (SELECT * FROM home_chats ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    role: r.role as HomeChatMessage["role"],
    content: r.content as string,
    status: r.status as HomeChatMessage["status"],
    createdAt: r.created_at as string,
  }));
}

export function pendingQuestion(db: DB, runId: number): OwnerQuestion | null {
  const r = db
    .prepare(
      "SELECT * FROM questions WHERE run_id = ? AND answer IS NULL ORDER BY id ASC LIMIT 1",
    )
    .get(runId) as Record<string, unknown> | undefined;
  return r ? rowToQuestion(r) : null;
}

export function getRun(db: DB, id: number): WorkRun | null {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToRun(r) : null;
}

export function listRuns(db: DB, opts: { itemId?: number; limit?: number } = {}): WorkRun[] {
  const limit = opts.limit ?? 30;
  const rows = (
    opts.itemId !== undefined
      ? db
          .prepare("SELECT * FROM runs WHERE item_id = ? ORDER BY id DESC LIMIT ?")
          .all(opts.itemId, limit)
      : db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
  ) as Record<string, unknown>[];
  return rows.map(rowToRun);
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
