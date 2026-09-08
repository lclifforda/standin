/**
 * Slack connector. Send: chat.postMessage (contract-gated). Ingest: history of
 * the channels the bot has been INVITED to — the owner controls the firehose
 * by inviting it. Reading personal DMs would need user-level scopes; not here.
 */
import type { RawItem } from "@standin/core";

async function slack<T>(token: string, method: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}${qs ? "?" + qs : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

/** The scopes actually granted to this token (from Slack's response header). */
export async function slackGrantedScopes(token: string): Promise<string[]> {
  const res = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export async function sendSlackMessage(
  token: string,
  channel: string,
  text: string,
): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!json.ok) throw new Error(`Slack API: ${json.error}`);
  return `sent to ${channel} (ts ${json.ts})`;
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

/** Messages since `oldestTs` in every channel the bot is a member of. */
export async function ingestSlack(token: string, oldestTs: string): Promise<RawItem[]> {
  const auth = await slack<{ url: string; user_id: string }>(token, "auth.test");
  const workspaceUrl = auth.url.replace(/\/$/, "");

  // one users.list call → readable names instead of raw ids
  const names = new Map<string, string>();
  try {
    const users = await slack<{ members: { id: string; profile?: { real_name?: string }; name: string }[] }>(
      token, "users.list", { limit: "500" },
    );
    for (const u of users.members) names.set(u.id, u.profile?.real_name || u.name);
  } catch { /* users:read missing — fall back to ids */ }

  const chans = await slack<{ channels: { id: string; name: string; is_member: boolean }[] }>(
    token, "conversations.list", { types: "public_channel,private_channel", limit: "200" },
  );
  const items: RawItem[] = [];
  for (const ch of chans.channels.filter((c) => c.is_member)) {
    const hist = await slack<{ messages: SlackMessage[] }>(token, "conversations.history", {
      channel: ch.id,
      oldest: oldestTs,
      limit: "30",
    });
    for (const m of hist.messages) {
      if (m.bot_id || m.subtype || !m.text || m.user === auth.user_id) continue;
      const who = names.get(m.user ?? "") ?? m.user ?? "someone";
      // resolve <@U…> mentions to names so triage reads like a human wrote it
      const text = m.text.replace(/<@([A-Z0-9]+)>/g, (_, id) => "@" + (names.get(id) ?? id));
      items.push({
        source: "slack",
        externalId: `${ch.id}:${m.ts}`,
        title: `#${ch.name}: ${text.slice(0, 90)}`,
        url: `${workspaceUrl}/archives/${ch.id}/p${m.ts.replace(".", "")}`,
        actor: who,
        kind: "message",
        body: text,
        createdAt: new Date(Number(m.ts) * 1000).toISOString(),
      });
    }
  }
  return items;
}
