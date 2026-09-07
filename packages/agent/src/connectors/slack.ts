/** Slack connector: the message executor (ingest lands in a later phase). */

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
