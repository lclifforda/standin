/**
 * Keyless Linear connection via Linear's OFFICIAL MCP server (mcp.linear.app).
 *
 * The OAuth dance (dynamic client registration, browser consent, token cache,
 * refresh) is handled by the public `mcp-remote` library — the same machinery
 * MCP clients use everywhere. First connect opens the browser on Linear's own
 * consent screen; tokens land in ~/.mcp-auth, never in our files. We only
 * store a boolean: "linear is connected via OAuth".
 *
 * Tool names are discovered at runtime (the server's catalog can evolve), so
 * ingest prefers a notifications tool and falls back to assigned issues.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RawItem } from "@standin/core";

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

async function withLinear<T>(
  fn: (client: Client) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-remote", LINEAR_MCP_URL],
    stderr: "ignore",
  });
  const client = new Client({ name: "standin", version: "0.1.0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Linear MCP timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    return await Promise.race([fn(client), timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

/**
 * Trigger the OAuth flow (opens the browser on first run) and prove the
 * connection by listing tools. Generous timeout: a human is clicking consent.
 */
export async function connectLinearOAuth(): Promise<string> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    return `OAuth via Linear MCP (${tools.length} tools)`;
  }, 180_000);
}

/** Quick health check once connected — cached tokens make this silent. */
export async function linearOAuthStatus(): Promise<string | null> {
  try {
    return await withLinear(async (client) => {
      const { tools } = await client.listTools();
      return `OAuth via Linear MCP (${tools.length} tools)`;
    }, 20_000);
  } catch {
    return null;
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

/** Best-effort mapping of a Linear MCP JSON payload into RawItems. */
function normalize(text: string, kindFallback: string): RawItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : ((obj.notifications ?? obj.issues ?? obj.nodes ?? obj.items ?? []) as Record<
        string,
        unknown
      >[]);
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    const issue = (e.issue ?? {}) as Record<string, unknown>;
    const comment = (e.comment ?? {}) as Record<string, unknown>;
    const actor = (e.actor ?? {}) as Record<string, unknown>;
    return {
      source: "linear" as const,
      externalId: String(e.id ?? e.identifier ?? JSON.stringify(e).slice(0, 40)),
      title: String(
        e.title ??
          (issue.identifier && issue.title ? `${issue.identifier}: ${issue.title}` : null) ??
          e.identifier ??
          e.type ??
          kindFallback,
      ),
      url: (comment.url as string) ?? (issue.url as string) ?? (e.url as string) ?? null,
      actor: (actor.name as string) ?? (e.actorName as string) ?? null,
      kind: String(e.type ?? kindFallback),
      body: (comment.body as string) ?? (e.body as string) ?? (e.description as string) ?? null,
      createdAt: String(e.createdAt ?? e.updatedAt ?? new Date().toISOString()),
    };
  });
}

export async function ingestLinearOAuth(): Promise<RawItem[]> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const notif = names.find((n) => /notification/i.test(n));
    const mine = names.find((n) => /my_issues|assigned/i.test(n));
    const pick = notif ?? mine;
    if (!pick)
      throw new Error(
        `Linear MCP exposes no notifications/my-issues tool (saw: ${names.join(", ")})`,
      );
    const result = await client.callTool({ name: pick, arguments: {} });
    return normalize(textOf(result), pick);
  }, 60_000);
}

/** Issue + comments via MCP tool discovery, for the ask/chat context. */
export async function getIssueContextOAuth(identifier: string): Promise<string> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    const parts: string[] = [];
    const issueTool = tools.find((t) => /^get_issue$|(^|_)issue$/i.test(t.name));
    if (issueTool) {
      const r = await client.callTool({ name: issueTool.name, arguments: { id: identifier } });
      parts.push(textOf(r));
    }
    const commentsTool = tools.find((t) => /list_comments/i.test(t.name));
    if (commentsTool) {
      const r = await client.callTool({
        name: commentsTool.name,
        arguments: { issueId: identifier },
      });
      parts.push("COMMENTS:\n" + textOf(r));
    }
    if (parts.length === 0) throw new Error("Linear MCP exposes no issue/comments tools");
    return parts.join("\n\n");
  }, 60_000);
}

/** Assigned-and-unfinished issues via MCP tool discovery. */
export async function fetchAssignedOAuth(): Promise<
  { identifier: string; title: string; url: string; state: string; project: string | null; updatedAt: string }[]
> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => /list_my_issues/i.test(t.name)) ?? tools.find((t) => /^list_issues$/i.test(t.name));
    if (!tool) throw new Error("Linear MCP exposes no issues-list tool");
    const args = /my_issues/i.test(tool.name) ? {} : { assignee: "me" };
    const result = await client.callTool({ name: tool.name, arguments: args });
    let parsed: unknown;
    try { parsed = JSON.parse(textOf(result)); } catch { return []; }
    const obj = parsed as Record<string, unknown>;
    const list = (Array.isArray(parsed) ? parsed : obj.issues ?? obj.nodes ?? []) as Record<string, unknown>[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => {
        const st = String((e.status as string) ?? (e.state as { name?: string })?.name ?? "");
        return !/done|completed|canceled|cancelled|duplicate/i.test(st);
      })
      .map((e) => ({
        identifier: String(e.identifier ?? e.id ?? ""),
        title: String(e.title ?? ""),
        url: String(e.url ?? ""),
        state: String((e.status as string) ?? (e.state as { name?: string })?.name ?? "?"),
        project: ((e.project as { name?: string })?.name ?? null) as string | null,
        updatedAt: String(e.updatedAt ?? new Date().toISOString()),
      }))
      .filter((e) => e.identifier && e.title);
  }, 60_000);
}

/** Status change via MCP tool discovery (save_issue/update_issue take a state name). */
export async function setLinearStatusOAuth(identifier: string, status: string): Promise<string> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => /save_issue|update_issue/i.test(t.name));
    if (!tool) throw new Error("Linear MCP exposes no issue-update tool");
    const result = await client.callTool({
      name: tool.name,
      arguments: { id: identifier, state: status },
    });
    if ((result as { isError?: boolean }).isError)
      throw new Error(`Linear MCP status change failed: ${textOf(result).slice(0, 200)}`);
    return `moved ${identifier} to ${status} via Linear MCP`;
  }, 60_000);
}

export async function sendLinearCommentOAuth(issueId: string, body: string): Promise<string> {
  return withLinear(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => /create_comment|save_comment/i.test(t.name));
    if (!tool) throw new Error("Linear MCP exposes no comment tool");
    const result = await client.callTool({ name: tool.name, arguments: { issueId, body } });
    const text = textOf(result);
    if ((result as { isError?: boolean }).isError)
      throw new Error(`Linear MCP comment failed: ${text.slice(0, 200)}`);
    return `commented on ${issueId} via Linear MCP`;
  }, 60_000);
}
