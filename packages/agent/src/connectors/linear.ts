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

/** Full issue context (description, state, people, comments) for ask/chat. */
export async function getIssueContext(apiKey: string, identifier: string): Promise<string> {
  const data = await gql<{
    issue: {
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      state: { name: string };
      assignee: { name: string } | null;
      creator: { name: string } | null;
      comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] };
    };
  }>(
    apiKey,
    `query($id: String!) {
      issue(id: $id) {
        identifier title description url
        state { name }
        assignee { name }
        creator { name }
        comments(first: 25) { nodes { body createdAt user { name } } }
      }
    }`,
    { id: identifier },
  );
  const i = data.issue;
  const comments = i.comments.nodes
    .map((c) => `--- ${c.user?.name ?? "someone"} (${c.createdAt}):\n${c.body}`)
    .join("\n\n");
  return `${i.identifier}: ${i.title} [${i.state.name}]
assignee: ${i.assignee?.name ?? "none"} · created by: ${i.creator?.name ?? "unknown"} · ${i.url}

DESCRIPTION:
${i.description ?? "(none)"}

COMMENTS (newest last):
${comments || "(none)"}`;
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

/** Move an issue to a workflow state by (case-insensitive) name. */
export async function setLinearStatus(
  apiKey: string,
  identifier: string,
  statusName: string,
): Promise<string> {
  const data = await gql<{
    issue: { id: string; team: { states: { nodes: { id: string; name: string }[] } } };
  }>(
    apiKey,
    `query($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }`,
    { id: identifier },
  );
  const states = data.issue.team.states.nodes;
  const target = states.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
  if (!target)
    throw new Error(
      `no state "${statusName}" on this team (has: ${states.map((s) => s.name).join(", ")})`,
    );
  const upd = await gql<{ issueUpdate: { success: boolean } }>(
    apiKey,
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    { id: data.issue.id, input: { stateId: target.id } },
  );
  if (!upd.issueUpdate.success) throw new Error("Linear issueUpdate returned success=false");
  return `moved ${identifier} to ${target.name}`;
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
