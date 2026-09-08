/**
 * The local decision-queue UI. Localhost only — this is each person's own
 * container/machine; there is no server-side product and no accounts in v1.
 *
 * The Approve button here is the owner's explicit yes: it mints the approval
 * and executes it through the contract. Nothing else in this file can send.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionBody,
  appendDecision,
  audit,
  executeApproved,
  answerQuestion,
  getItem,
  getQuestion,
  getRun,
  getSetting,
  insertChat,
  listChats,
  pendingQuestion,
  resolveChat,
  laneCounts,
  listAudit,
  listItems,
  listRuns,
  mintApproval,
  openDb,
  setItemStatus,
  setSetting,
  updateItemDraft,
  withBody,
} from "@standin/core";
import {
  askAboutItem,
  issueIdentifier,
  buildExecutors,
  connectLinearOAuth,
  connectWithToken,
  continueWorkRun,
  disconnect,
  listConnections,
  loadConfig,
  runTriage,
  startWorkRun,
} from "@standin/agent";

let config = loadConfig(process.env.STANDIN_BRAIN);
const db = openDb(config.dbPath);
let executors = buildExecutors(config);

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveStatic(res: ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const abs = resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + sep)) return json(res, 404, { error: "not found" });
  try {
    const body = readFileSync(abs);
    res.writeHead(200, {
      "Content-Type": MIME[extname(abs)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

/** Re-read secrets after the Connections UI changes them — no restart needed. */
function refreshConfig(): void {
  config = loadConfig(process.env.STANDIN_BRAIN);
  executors = buildExecutors(config);
}
const PORT = Number(process.env.STANDIN_PORT ?? 4180);
const BOOT = String(Date.now()); // clients reload themselves when this changes

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const itemAction = url.pathname.match(/^\/api\/items\/(\d+)\/(approve|dismiss|noise|ask)$/);

  try {
    if (req.method === "GET" && url.pathname === "/api/queue") {
      const counts = laneCounts(db);
      // One TASK per underlying ticket: multiple notifications about the same
      // issue group under one spine (the hook future Slack ingest joins too).
      const items = listItems(db, { lanes: [3, 4] }).map((i) => ({
        ...i,
        chat: listChats(db, i.id),
      }));
      const groups = new Map<string, typeof items>();
      for (const i of items) {
        // Group by ticket id from the URL (never the body — comment bodies
        // mention OTHER tickets); fall back to the exact issue title, which
        // Linear repeats verbatim across notifications for the same issue.
        const ident =
          i.source === "linear"
            ? issueIdentifier({ title: i.title, body: null, url: i.url })
            : null;
        const key =
          ident ?? (i.source === "linear" ? `linear-title:${i.title}` : `${i.source}:${i.externalId}`);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
      }
      const tasks = [...groups.entries()].map(([key, list]) => {
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const primary = list[0]!;
        const withDraft = list.find((x) => x.draft && x.action);
        return {
          key,
          id: primary.id, // chat + work runs anchor on the newest item
          source: primary.source,
          lane: Math.max(...list.map((l) => l.lane)),
          title: primary.title,
          summary: primary.summary,
          reason: primary.reason,
          url: primary.url,
          actor: primary.actor,
          createdAt: primary.createdAt,
          count: list.length,
          itemIds: list.map((l) => l.id),
          events: list.map((l) => ({
            id: l.id,
            kind: l.kind,
            actor: l.actor,
            summary: l.summary,
            createdAt: l.createdAt,
          })),
          draft: withDraft?.draft ?? null,
          draftItemId: withDraft?.id ?? null,
          chat: list
            .flatMap((l) => l.chat)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        };
      });
      tasks.sort((a, b) => b.lane - a.lane || b.createdAt.localeCompare(a.createdAt));
      json(res, 200, {
        v: BOOT,
        tasks,
        quiet: counts[1] + counts[2],
        noise: listItems(db, { lanes: [1, 2] }).map((i) => ({
          id: i.id,
          title: i.title,
          summary: i.summary,
        })),
      });
    } else if (req.method === "GET" && url.pathname.match(/^\/api\/items\/\d+\/chat$/)) {
      json(res, 200, { chat: listChats(db, Number(url.pathname.split("/")[3])) });
    } else if (req.method === "GET" && url.pathname.match(/^\/api\/items\/\d+$/)) {
      // Terminal-state lookup: a deep link to an approved/dismissed item still renders.
      const id = Number(url.pathname.split("/")[3]);
      const item = getItem(db, id);
      item
        ? json(res, 200, { item: { ...item, chat: listChats(db, id) } })
        : json(res, 404, { error: `no item #${id}` });
    } else if (req.method === "GET" && url.pathname === "/api/audit") {
      json(res, 200, { events: listAudit(db) });
    } else if (req.method === "GET" && url.pathname === "/api/yolo") {
      json(res, 200, {
        on: getSetting(db, "yolo") === "on",
        workspaces: config.workspaces,
        brain: config.brainDir.split("/").at(-1),
      });
    } else if (req.method === "POST" && url.pathname === "/api/yolo") {
      const body = await readBody(req);
      setSetting(db, "yolo", body.on ? "on" : "off");
      audit(db, "yolo.toggled", body.on ? "yolo mode ON" : "yolo mode OFF");
      json(res, 200, { on: body.on === true });
    } else if (req.method === "GET" && url.pathname === "/api/runs") {
      const itemIdParam = url.searchParams.get("itemId");
      const runs = listRuns(db, itemIdParam ? { itemId: Number(itemIdParam) } : {}).map((r) => ({
        ...r,
        question: r.status === "waiting" ? pendingQuestion(db, r.id) : null,
      }));
      json(res, 200, { runs });
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/questions\/\d+\/answer$/)) {
      const qId = Number(url.pathname.split("/")[3]);
      const body = await readBody(req);
      if (typeof body.answer !== "string" || !body.answer.trim())
        return json(res, 400, { error: "answer required" });
      if (!getQuestion(db, qId)) return json(res, 404, { error: "no such question" });
      answerQuestion(db, qId, body.answer.trim());
      audit(db, "run.answered", `question #${qId} answered by owner`);
      json(res, 200, { ok: true });
    } else if (req.method === "GET" && url.pathname.match(/^\/api\/runs\/\d+$/)) {
      const run = getRun(db, Number(url.pathname.split("/")[3]));
      run ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/runs\/\d+\/continue$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const body = await readBody(req);
      if (typeof body.answer !== "string" || !body.answer.trim())
        return json(res, 400, { error: "answer required" });
      continueWorkRun(db, config, id, body.answer.trim());
      json(res, 200, { ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/work") {
      if (getSetting(db, "yolo") !== "on")
        return json(res, 403, { error: "yolo mode is off — flip the switch to let me do the work" });
      const body = await readBody(req);
      const runId = startWorkRun(db, config, {
        itemId: typeof body.itemId === "number" ? body.itemId : undefined,
        instructions: typeof body.instructions === "string" ? body.instructions : undefined,
      });
      json(res, 200, { ok: true, runId });
    } else if (req.method === "GET" && url.pathname === "/api/connections") {
      json(res, 200, { connections: await listConnections(config) });
    } else if (req.method === "POST" && url.pathname === "/api/connections/linear-oauth") {
      // Keyless: opens the browser on Linear's consent screen; waits for the
      // user's approval (long timeout by design — a human is clicking).
      const who = await connectLinearOAuth(config.brainDir);
      refreshConfig();
      audit(db, "connector.linked", `linear connected: ${who}`);
      json(res, 200, { ok: true, who });
    } else if (
      req.method === "POST" &&
      (url.pathname === "/api/connections/linear" || url.pathname === "/api/connections/slack")
    ) {
      const id = url.pathname.endsWith("linear") ? ("linear" as const) : ("slack" as const);
      const body = await readBody(req);
      if (typeof body.token !== "string") return json(res, 400, { error: "token required" });
      // Validated against the live API before storing — a bad key never saves.
      const who = await connectWithToken(config.brainDir, id, body.token);
      refreshConfig();
      audit(db, "connector.linked", `${id} connected as ${who}`);
      json(res, 200, { ok: true, who });
    } else if (
      req.method === "DELETE" &&
      (url.pathname === "/api/connections/linear" || url.pathname === "/api/connections/slack")
    ) {
      const id = url.pathname.endsWith("linear") ? ("linear" as const) : ("slack" as const);
      disconnect(config.brainDir, id);
      refreshConfig();
      audit(db, "connector.unlinked", `${id} disconnected`);
      json(res, 200, { ok: true });
    } else if (req.method === "POST" && url.pathname === "/api/triage") {
      const r = await runTriage(config);
      json(res, 200, r);
    } else if (req.method === "POST" && itemAction) {
      const id = Number(itemAction[1]);
      const verb = itemAction[2];
      const item = getItem(db, id);
      if (!item) return json(res, 404, { error: `no item #${id}` });
      const body = await readBody(req);

      if (verb === "ask") {
        if (typeof body.question !== "string" || !body.question.trim())
          return json(res, 400, { error: "question required" });
        const question = body.question.trim();
        // Persist both sides immediately, answer asynchronously: the thread
        // survives a reload even mid-answer, and the UI polls until resolved.
        const history = listChats(db, id);
        insertChat(db, id, "owner", question);
        const pendingId = insertChat(db, id, "standin", "", "pending");
        void askAboutItem(db, config, id, question, history)
          .then((answer) => resolveChat(db, pendingId, answer, "done"))
          .catch((err) =>
            resolveChat(db, pendingId, String(err instanceof Error ? err.message : err), "failed"),
          );
        return json(res, 200, { ok: true, chat: listChats(db, id) });
      }
      if (verb === "approve") {
        if (!item.action) return json(res, 400, { error: "item has no drafted action" });
        let action = item.action;
        // An edited draft becomes the action body — the owner approves what they see.
        if (typeof body.draft === "string" && body.draft !== actionBody(action)) {
          action = withBody(action, body.draft);
          updateItemDraft(db, id, body.draft, action);
        }
        const approval = mintApproval(db, id, action, `web-ui:${config.brainDir}`);
        const note = await executeApproved(db, approval.id, executors);
        setItemStatus(db, id, "done");
        json(res, 200, { ok: true, note });
      } else if (verb === "dismiss") {
        setItemStatus(db, id, "dismissed");
        audit(db, "item.dismissed", `#${id} dismissed from web UI`, { itemId: id });
        json(res, 200, { ok: true });
      } else {
        // "this is noise" — hide it AND teach the brain.
        setItemStatus(db, id, "noise");
        const rule =
          typeof body.rule === "string" && body.rule.trim()
            ? body.rule.trim()
            : `HIDE: items like "${item.title}" (${item.kind} from ${item.actor ?? "unknown"}).`;
        appendDecision(config.brainDir, rule);
        audit(db, "line.moved", rule, { itemId: id });
        json(res, 200, { ok: true, rule });
      }
    } else if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      serveStatic(res, url.pathname);
    } else {
      json(res, 404, { error: "not found" });
    }
  } catch (err) {
    json(res, 500, { error: String(err instanceof Error ? err.message : err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`standin · decision queue → http://localhost:${PORT}`);
  console.log(`brain: ${config.brainDir}`);
});
