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
  // migration: chats.proposals (agent-proposed actions awaiting the owner's yes)
  try {
    db.exec("ALTER TABLE chats ADD COLUMN proposals TEXT");
  } catch { /* column already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_stats (
      week TEXT PRIMARY KEY,
      stats TEXT NOT NULL
    );
  `);
  // migration: approvals.item_id becomes nullable — conversations mint approvals
  // that aren't anchored to an inbox item. SQLite can't drop NOT NULL, so rebuild.
  const itemIdCol = db
    .prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('approvals') WHERE name = 'item_id'")
    .get() as { nn: number } | undefined;
  if (itemIdCol?.nn === 1) {
    db.exec(`
      BEGIN;
      ALTER TABLE approvals RENAME TO approvals_old;
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        item_id INTEGER REFERENCES items(id),
        action_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        minted_at TEXT NOT NULL,
        used_at TEXT
      );
      INSERT INTO approvals SELECT * FROM approvals_old;
      DROP TABLE approvals_old;
      COMMIT;
    `);
  }
  // conversations: the central terminal — each one is a persistent agent session
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'New conversation',
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_msgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      proposals TEXT,
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

// --- retention: 7 days of specifics, then weekly shipped-numbers forever ---

export function isoWeek(iso: string): string {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((+t - +new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

export type WeekStats = Record<string, number>; // linear/slack/github/sent/agents

export function listWeeklyStats(db: DB): { week: string; stats: WeekStats }[] {
  const rows = db
    .prepare("SELECT * FROM weekly_stats ORDER BY week DESC LIMIT 26")
    .all() as { week: string; stats: string }[];
  return rows.map((r) => ({ week: r.week, stats: JSON.parse(r.stats) as WeekStats }));
}

/**
 * Roll everything older than `days` into weekly counters, then prune the
 * specifics. Open lane-3/4 items NEVER expire — old-but-unhandled must not
 * vanish quietly. Approvals and the audit ledger are kept forever.
 */
export function pruneAndRollup(db: DB, days = 7): number {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  const acc = new Map<string, WeekStats>();
  const bump = (week: string, key: string, n = 1) => {
    const s = acc.get(week) ?? {};
    s[key] = (s[key] ?? 0) + n;
    acc.set(week, s);
  };

  const olds = db
    .prepare("SELECT id, source, created_at FROM items WHERE created_at < ? AND NOT (status = 'open' AND lane >= 3)")
    .all(cutoff) as { id: number; source: string; created_at: string }[];
  if (olds.length) {
    const ids = olds.map((o) => o.id);
    const ph = ids.map(() => "?").join(",");
    for (const o of olds) bump(isoWeek(o.created_at), o.source);
    const sends = db
      .prepare(`SELECT used_at FROM approvals WHERE used_at IS NOT NULL AND item_id IN (${ph})`)
      .all(...ids) as { used_at: string }[];
    for (const s of sends) bump(isoWeek(s.used_at), "sent");
    db.prepare(`DELETE FROM chats WHERE item_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM items WHERE id IN (${ph})`).run(...ids);
  }

  const oldRuns = db
    .prepare("SELECT id, updated_at FROM runs WHERE updated_at < ? AND status IN ('done','failed','archived')")
    .all(cutoff) as { id: number; updated_at: string }[];
  if (oldRuns.length) {
    const rids = oldRuns.map((r) => r.id);
    const ph = rids.map(() => "?").join(",");
    for (const r of oldRuns) bump(isoWeek(r.updated_at), "agents");
    db.prepare(`DELETE FROM questions WHERE run_id IN (${ph})`).run(...rids);
    db.prepare(`DELETE FROM runs WHERE id IN (${ph})`).run(...rids);
  }

  for (const [week, add] of acc) {
    const existing = db.prepare("SELECT stats FROM weekly_stats WHERE week = ?").get(week) as
      | { stats: string }
      | undefined;
    const merged: WeekStats = existing ? (JSON.parse(existing.stats) as WeekStats) : {};
    for (const [k, v] of Object.entries(add)) merged[k] = (merged[k] ?? 0) + v;
    db.prepare(
      "INSERT INTO weekly_stats (week, stats) VALUES (?, ?) ON CONFLICT(week) DO UPDATE SET stats = excluded.stats",
    ).run(week, JSON.stringify(merged));
  }
  return olds.length + oldRuns.length;
}

/** Current (unpruned) activity bucketed the same way, to show partial weeks. */
export function liveWeekStats(db: DB): { week: string; stats: WeekStats }[] {
  const acc = new Map<string, WeekStats>();
  const bump = (week: string, key: string) => {
    const s = acc.get(week) ?? {};
    s[key] = (s[key] ?? 0) + 1;
    acc.set(week, s);
  };
  for (const r of db.prepare("SELECT source, created_at FROM items").all() as { source: string; created_at: string }[])
    bump(isoWeek(r.created_at), r.source);
  for (const r of db
    .prepare("SELECT a.used_at FROM approvals a JOIN items i ON i.id = a.item_id WHERE a.used_at IS NOT NULL")
    .all() as { used_at: string }[])
    bump(isoWeek(r.used_at), "sent");
  for (const r of db
    .prepare("SELECT updated_at FROM runs WHERE status IN ('done','archived')")
    .all() as { updated_at: string }[])
    bump(isoWeek(r.updated_at), "agents");
  return [...acc.entries()].map(([week, stats]) => ({ week, stats }));
}

// --- audit ---

export function audit(
  db: DB,
  type: string,
  detail: string,
  ids: { itemId?: number | null; approvalId?: string } = {},
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
  status: "running" | "waiting" | "done" | "failed" | "archived";
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

export function setRunSession(db: DB, id: number, sessionId: string): void {
  db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(sessionId, id);
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

/** An action the task's agent proposed in chat; the owner's click approves it. */
export interface ActionProposal {
  kind: string; // an ActionSpec kind, or "agent.run" to start a coding agent
  label: string;
  [param: string]: unknown;
}

export interface ChatMessage {
  id: number;
  itemId: number;
  role: "owner" | "standin";
  content: string;
  status: "done" | "pending" | "failed";
  proposals: ActionProposal[] | null;
  createdAt: string;
}

function rowToChat(r: Record<string, unknown>): ChatMessage {
  let proposals: ActionProposal[] | null = null;
  if (r.proposals) {
    try { proposals = JSON.parse(r.proposals as string) as ActionProposal[]; } catch { /* ignore */ }
  }
  return {
    id: r.id as number,
    itemId: r.item_id as number,
    role: r.role as ChatMessage["role"],
    content: r.content as string,
    status: r.status as ChatMessage["status"],
    proposals: proposals?.length ? proposals : null,
    createdAt: r.created_at as string,
  };
}

export function getChat(db: DB, id: number): ChatMessage | null {
  const r = db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToChat(r) : null;
}

export function updateChatProposals(db: DB, id: number, proposals: ActionProposal[]): void {
  db.prepare("UPDATE chats SET proposals = ? WHERE id = ?").run(
    proposals.length ? JSON.stringify(proposals) : null,
    id,
  );
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
  proposals: ActionProposal[] | null = null,
): void {
  db.prepare("UPDATE chats SET content = ?, status = ?, proposals = ? WHERE id = ?").run(
    content,
    status,
    proposals?.length ? JSON.stringify(proposals) : null,
    id,
  );
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

// --- conversations (the central terminal: persistent agent sessions) ---

export interface Conversation {
  id: number;
  title: string;
  sessionId: string | null;
  status: "idle" | "running";
  createdAt: string;
  updatedAt: string;
}

export interface ConvMessage {
  id: number;
  conversationId: number;
  role: "owner" | "standin";
  content: string;
  status: "done" | "pending" | "failed";
  proposals: ActionProposal[] | null;
  createdAt: string;
}

function rowToConversation(r: Record<string, unknown>): Conversation {
  return {
    id: r.id as number,
    title: r.title as string,
    sessionId: (r.session_id as string) ?? null,
    status: r.status as Conversation["status"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertConversation(db: DB, title = "New conversation"): number {
  const now = new Date().toISOString();
  const res = db
    .prepare("INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)")
    .run(title, now, now);
  return Number(res.lastInsertRowid);
}

export function getConversation(db: DB, id: number): Conversation | null {
  const r = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToConversation(r) : null;
}

export function listConversations(db: DB, limit = 40): Conversation[] {
  const rows = db
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

export function touchConversation(
  db: DB,
  id: number,
  fields: { title?: string; sessionId?: string; status?: Conversation["status"] } = {},
): void {
  const now = new Date().toISOString();
  if (fields.title !== undefined)
    db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(fields.title, now, id);
  if (fields.sessionId !== undefined)
    db.prepare("UPDATE conversations SET session_id = ?, updated_at = ? WHERE id = ?").run(fields.sessionId, now, id);
  if (fields.status !== undefined)
    db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(fields.status, now, id);
  if (!Object.keys(fields).length)
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
}

function rowToConvMsg(r: Record<string, unknown>): ConvMessage {
  let proposals: ActionProposal[] | null = null;
  if (r.proposals) {
    try { proposals = JSON.parse(r.proposals as string) as ActionProposal[]; } catch { /* ignore */ }
  }
  return {
    id: r.id as number,
    conversationId: r.conversation_id as number,
    role: r.role as ConvMessage["role"],
    content: r.content as string,
    status: r.status as ConvMessage["status"],
    proposals: proposals?.length ? proposals : null,
    createdAt: r.created_at as string,
  };
}

export function insertConvMsg(
  db: DB,
  conversationId: number,
  role: ConvMessage["role"],
  content: string,
  status: ConvMessage["status"] = "done",
): number {
  const res = db
    .prepare(
      "INSERT INTO conversation_msgs (conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(conversationId, role, content, status, new Date().toISOString());
  touchConversation(db, conversationId);
  return Number(res.lastInsertRowid);
}

/** Live progress: swap the pending bubble's text (breadcrumbs) without resolving it. */
export function setConvMsgContent(db: DB, id: number, content: string): void {
  db.prepare("UPDATE conversation_msgs SET content = ? WHERE id = ?").run(content, id);
}

export function resolveConvMsg(
  db: DB,
  id: number,
  content: string,
  status: "done" | "failed",
  proposals: ActionProposal[] | null = null,
): void {
  db.prepare("UPDATE conversation_msgs SET content = ?, status = ?, proposals = ? WHERE id = ?").run(
    content,
    status,
    proposals?.length ? JSON.stringify(proposals) : null,
    id,
  );
}

export function getConvMsg(db: DB, id: number): ConvMessage | null {
  const r = db.prepare("SELECT * FROM conversation_msgs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToConvMsg(r) : null;
}

export function updateConvMsgProposals(db: DB, id: number, proposals: ActionProposal[]): void {
  db.prepare("UPDATE conversation_msgs SET proposals = ? WHERE id = ?").run(
    proposals.length ? JSON.stringify(proposals) : null,
    id,
  );
}

export function listConvMsgs(db: DB, conversationId: number): ConvMessage[] {
  const rows = db
    .prepare("SELECT * FROM conversation_msgs WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToConvMsg);
}
