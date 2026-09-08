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
  executedKinds,
  getChat,
  getItem,
  getQuestion,
  getRun,
  getSetting,
  insertChat,
  insertHomeChat,
  listBySource,
  listHomeChats,
  resolveHomeChat,
  listChats,
  pendingQuestion,
  resolveChat,
  laneCounts,
  listAudit,
  listItems,
  listRuns,
  loadBrain,
  mintApproval,
  openDb,
  setItemStatus,
  setRunStatus,
  setSetting,
  updateChatProposals,
  type ActionSpec,
  updateItemDraft,
  withBody,
} from "@standin/core";
import {
  askAboutItem,
  askGlobal,
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

/** The one grouping rule (queue, autopilot, and task chat all share it). */
function groupKeyOf(i: { source: string; title: string; body: string | null; url: string | null; externalId: string }): string {
  const ident =
    i.source === "linear"
      ? issueIdentifier({ title: i.title, body: null, url: i.url })
      : issueIdentifier({ title: i.title, body: i.body, url: null });
  return ident ?? (i.source === "linear" ? `linear-title:${i.title}` : `${i.source}:${i.externalId}`);
}

/** Turn an agent proposal into a concrete ActionSpec — or refuse. */
function proposalToAction(p: Record<string, unknown>): ActionSpec | null {
  const s = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  switch (p.kind) {
    case "linear.comment": {
      const issueId = s("issueId"), body = s("body");
      return issueId && body ? { kind: "linear.comment", issueId, body } : null;
    }
    case "linear.status": {
      const issueId = s("issueId"), status = s("status");
      return issueId && status ? { kind: "linear.status", issueId, status } : null;
    }
    case "github.comment": {
      const prUrl = s("prUrl"), body = s("body");
      return prUrl && body ? { kind: "github.comment", prUrl, body } : null;
    }
    case "github.close": {
      const prUrl = s("prUrl");
      return prUrl ? { kind: "github.close", prUrl } : null;
    }
    case "github.merge": {
      const prUrl = s("prUrl");
      return prUrl ? { kind: "github.merge", prUrl } : null;
    }
    case "slack.message": {
      const channel = s("channel"), text = s("text");
      return channel && text ? { kind: "slack.message", channel, text } : null;
    }
    default:
      return null;
  }
}

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
const OWNER = (() => {
  try {
    const n = loadBrain(config.brainDir).profileName.split(".")[0] ?? "you";
    return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {
    return "you";
  }
})();

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
  const itemAction = url.pathname.match(/^\/api\/items\/(\d+)\/(approve|dismiss|noise|ask|action)$/);

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
        const key = groupKeyOf(i);
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
      }
      const tasks = [...groups.entries()].map(([key, list]) => {
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const primary = list[0]!;
        // The Linear item is the task's face (title/link); freshness from newest.
        const face = list.find((l) => l.source === "linear") ?? primary;
        const withDraft = list.find((x) => x.draft && x.action);
        return {
          key,
          id: primary.id, // chat + work runs anchor on the newest item
          source: face.source,
          lane: Math.max(...list.map((l) => l.lane)),
          title: face.title,
          summary: primary.summary,
          reason: primary.reason,
          url: face.url,
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
          // loop closure, from spent approvals — a ✓ means actually sent
          sent: executedKinds(db, list.map((l) => l.id)),
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
    } else if (req.method === "GET" && url.pathname === "/api/feeds") {
      const slim = (i: ReturnType<typeof listBySource>[number]) => ({
        id: i.id, title: i.title, actor: i.actor, url: i.url,
        kind: i.kind, lane: i.lane, status: i.status, createdAt: i.createdAt,
      });
      json(res, 200, {
        linear: listBySource(db, "linear").map(slim),
        slack: listBySource(db, "slack").map(slim),
        github: listBySource(db, "github").map(slim),
        slackConnected: !!config.slackBotToken,
        chat: listHomeChats(db),
      });
    } else if (req.method === "GET" && url.pathname === "/api/yolo") {
      json(res, 200, {
        on: getSetting(db, "yolo") === "on",
        autopilot: getSetting(db, "autopilot") === "on",
        workspaces: config.workspaces,
        brain: config.brainDir.split("/").at(-1),
        owner: OWNER,
      });
    } else if (req.method === "POST" && url.pathname === "/api/ask") {
      const body = await readBody(req);
      if (typeof body.question !== "string" || !body.question.trim())
        return json(res, 400, { error: "question required" });
      const question = body.question.trim();
      // Persistent, reload-safe — same pattern as per-task chats.
      const history = listHomeChats(db)
        .filter((m) => m.status === "done" && m.content)
        .map((m) => ({ role: m.role, content: m.content }));
      insertHomeChat(db, "owner", question);
      const pendingId = insertHomeChat(db, "standin", "", "pending");
      void askGlobal(db, config, question, history)
        .then((answer) => resolveHomeChat(db, pendingId, answer, "done"))
        .catch((err) =>
          resolveHomeChat(db, pendingId, String(err instanceof Error ? err.message : err), "failed"),
        );
      json(res, 200, { chat: listHomeChats(db) });
    } else if (req.method === "POST" && url.pathname === "/api/autopilot") {
      const body = await readBody(req);
      setSetting(db, "autopilot", body.on ? "on" : "off");
      audit(db, "autopilot.toggled", body.on ? "auto-brief ON" : "auto-brief OFF");
      json(res, 200, { on: body.on === true });
    } else if (req.method === "POST" && url.pathname === "/api/yolo") {
      const body = await readBody(req);
      setSetting(db, "yolo", body.on ? "on" : "off");
      audit(db, "yolo.toggled", body.on ? "yolo mode ON" : "yolo mode OFF");
      json(res, 200, { on: body.on === true });
    } else if (req.method === "GET" && url.pathname === "/api/runs") {
      const itemIdParam = url.searchParams.get("itemId");
      const runs = listRuns(db, itemIdParam ? { itemId: Number(itemIdParam) } : {})
        .filter((r) => r.status !== "archived") // closed runs leave every list
        .map((r) => ({
          ...r,
          question: r.status === "waiting" ? pendingQuestion(db, r.id) : null,
        }));
      json(res, 200, { runs });
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/chats\/\d+\/approve$/)) {
      // The owner clicked an agent-proposed action: that click IS the yes.
      const chatId = Number(url.pathname.split("/")[3]);
      const body = await readBody(req);
      const idx = Number(body.index ?? 0);
      const msg = getChat(db, chatId);
      const proposal = msg?.proposals?.[idx];
      if (!msg || !proposal) return json(res, 404, { error: "no such proposal (already used?)" });
      let note: string;
      if (proposal.kind === "agent.run") {
        if (getSetting(db, "yolo") !== "on")
          return json(res, 403, { error: "yolo is off — flip it to let agents work" });
        startWorkRun(db, config, { itemId: msg.itemId });
        note = "agent started — it will brief you before touching anything";
      } else {
        const action = proposalToAction(proposal);
        if (!action) return json(res, 400, { error: `proposal is missing params for ${proposal.kind}` });
        const approval = mintApproval(db, msg.itemId, action, "web-ui:proposal");
        note = await executeApproved(db, approval.id, executors);
      }
      const remaining = (msg.proposals ?? []).filter((_, i) => i !== idx);
      updateChatProposals(db, chatId, remaining);
      insertChat(db, msg.itemId, "standin", `✓ ${note}`);
      json(res, 200, { ok: true, note, chat: listChats(db, msg.itemId) });
    } else if (req.method === "POST" && url.pathname.match(/^\/api\/runs\/\d+\/close$/)) {
      const runId = Number(url.pathname.split("/")[3]);
      const run = getRun(db, runId);
      if (!run) return json(res, 404, { error: "no such run" });
      if (run.status === "running" || run.status === "waiting")
        return json(res, 400, { error: "run is still active — answer or wait, then close" });
      setRunStatus(db, runId, "archived");
      audit(db, "run.closed", `run #${runId} closed by owner`);
      json(res, 200, { ok: true });
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
      // Autopilot: every surfaced task gets its agent automatically. Safe by
      // design — the pipeline's ALIGN checkpoint stops each run at a brief
      // until the owner says go. Requires yolo AND auto-brief, capped per run.
      let briefed = 0;
      if (getSetting(db, "yolo") === "on" && getSetting(db, "autopilot") === "on") {
        // group open items the same way the queue does, so one TASK gets one agent
        const open = listItems(db, { lanes: [3, 4] });
        const byKey = new Map<string, typeof open>();
        for (const i of open) {
          const key = groupKeyOf(i);
          (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i);
        }
        for (const list of byKey.values()) {
          if (briefed >= 3) break;
          if (list.some((i) => listRuns(db, { itemId: i.id, limit: 1 }).length > 0)) continue;
          list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          startWorkRun(db, config, { itemId: list[0]!.id });
          briefed++;
        }
      }
      json(res, 200, { ...r, briefed });
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
        // hand the agent the whole grouped task, not just the anchor item
        const members = listItems(db, { lanes: [3, 4] }).filter(
          (x) => groupKeyOf(x) === groupKeyOf(item),
        );
        const taskContext = members
          .map((m) => `- [${m.source}] ${m.title}${m.url ? ` (${m.url})` : ""} — ${m.summary}`)
          .join("\n");
        insertChat(db, id, "owner", question);
        const pendingId = insertChat(db, id, "standin", "", "pending");
        void askAboutItem(db, config, id, question, history, taskContext)
          .then((r) => resolveChat(db, pendingId, r.text, "done", r.proposals))
          .catch((err) =>
            resolveChat(db, pendingId, String(err instanceof Error ? err.message : err), "failed"),
          );
        return json(res, 200, { ok: true, chat: listChats(db, id) });
      }
      if (verb === "action") {
        // Quick actions: the click in the UI IS the explicit yes — the action
        // is minted and executed through the contract like any other send.
        const kind = body.kind;
        const text = typeof body.body === "string" ? body.body.trim() : "";
        const ident = issueIdentifier({ title: item.title, body: item.body, url: item.url });
        let action;
        if (kind === "github.close" && item.source === "github") {
          action = { kind: "github.close" as const, prUrl: item.url ?? "" };
        } else if (kind === "github.comment" && item.source === "github" && text) {
          action = { kind: "github.comment" as const, prUrl: item.url ?? "", body: text };
        } else if (kind === "linear.status" && item.source === "linear" && ident && text) {
          action = { kind: "linear.status" as const, issueId: ident, status: text };
        } else if (kind === "linear.comment" && item.source === "linear" && ident && text) {
          action = { kind: "linear.comment" as const, issueId: ident, body: text };
        } else if (kind === "slack.message" && item.source === "slack" && text) {
          const channel = item.externalId.split(":")[0] ?? "";
          action = { kind: "slack.message" as const, channel, text };
        } else {
          return json(res, 400, { error: `can't build ${String(kind)} from this item` });
        }
        const approval = mintApproval(db, id, action, `web-ui:quick-action`);
        const note = await executeApproved(db, approval.id, executors);
        return json(res, 200, { ok: true, note });
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
