/**
 * Linear connector: deterministic ingest (GraphQL, your API key) and the
 * comment executor. Reading is free; the executor only ever runs through the
 * contract (core/contract.ts).
 */
import type { RawItem } from "@standin/core";

const ENDPOINT = "https://api.linear.app/graphql";

async function gql<T>(apiKey: string, query: string, variables?: object): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length)
    throw new Error(`Linear API: ${json.errors?.[0]?.message ?? res.statusText}`);
  return json.data as T;
}

interface NotificationNode {
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  actor: { name: string } | null;
  issue: { identifier: string; title: string; url: string } | null;
  comment: { body: string; url: string } | null;
}

export async function ingestLinear(apiKey: string, unreadOnly = true): Promise<RawItem[]> {
  const data = await gql<{ notifications: { nodes: NotificationNode[] } }>(
    apiKey,
    `query {
      notifications(first: 100) {
        nodes {
          id type createdAt readAt
          actor { name }
          ... on IssueNotification {
            issue { identifier title url }
            comment { body url }
          }
        }
      }
    }`,
  );
  return data.notifications.nodes
    .filter((n) => !unreadOnly || n.readAt === null)
    .map((n) => ({
      source: "linear" as const,
      externalId: n.id,
      title: n.issue ? `${n.issue.identifier}: ${n.issue.title}` : n.type,
      url: n.comment?.url ?? n.issue?.url ?? null,
      actor: n.actor?.name ?? null,
      kind: n.type,
      body: n.comment?.body ?? null,
      createdAt: n.createdAt,
    }));
}

/** Resolve an issue identifier like "ABC-123" to its UUID for mutations. */
async function issueUuid(apiKey: string, identifier: string): Promise<string> {
  const data = await gql<{ issue: { id: string } }>(
    apiKey,
    `query($id: String!) { issue(id: $id) { id } }`,
    { id: identifier },
  );
  return data.issue.id;
}

export async function sendLinearComment(
  apiKey: string,
  issueId: string,
  body: string,
): Promise<string> {
  const uuid = /^[0-9a-f-]{36}$/i.test(issueId) ? issueId : await issueUuid(apiKey, issueId);
  const data = await gql<{ commentCreate: { success: boolean; comment: { url: string } } }>(
    apiKey,
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { url } }
    }`,
    { input: { issueId: uuid, body } },
  );
  if (!data.commentCreate.success) throw new Error("Linear commentCreate returned success=false");
  return `commented: ${data.commentCreate.comment.url}`;
}
