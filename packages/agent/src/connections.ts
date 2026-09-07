/**
 * Live connector status + authentication, backing the Connections UI.
 * A token is validated against the real API before it is ever stored,
 * so the UI can't save a key that doesn't work.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { writeSecret, type SecretName } from "./secrets.ts";

const run = promisify(execFile);

export interface ConnectionStatus {
  id: "claude" | "github" | "linear" | "slack";
  name: string;
  connected: boolean;
  who: string | null; // "connected as …" once validated
  detail: string; // next step when not connected
  acceptsToken: boolean; // whether the UI shows a paste-token form
  tokenHelpUrl: string | null;
}

export async function validateLinearKey(apiKey: string): Promise<string> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query: "{ viewer { name email } }" }),
  });
  const json = (await res.json()) as {
    data?: { viewer: { name: string; email: string } };
    errors?: { message: string }[];
  };
  if (!res.ok || !json.data?.viewer)
    throw new Error(json.errors?.[0]?.message ?? "Linear rejected this key");
  return `${json.data.viewer.name} (${json.data.viewer.email})`;
}

export async function validateSlackToken(token: string): Promise<string> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { ok: boolean; error?: string; user?: string; team?: string };
  if (!json.ok) throw new Error(`Slack rejected this token (${json.error})`);
  return `${json.user} @ ${json.team}`;
}

async function githubStatus(): Promise<{ connected: boolean; who: string | null }> {
  try {
    const { stdout } = await run("gh", ["api", "user", "--jq", ".login"]);
    return { connected: true, who: stdout.trim() };
  } catch {
    return { connected: false, who: null };
  }
}

async function claudeStatus(): Promise<{ connected: boolean; who: string | null }> {
  try {
    const { stdout } = await run("claude", ["--version"]);
    return { connected: true, who: stdout.trim().split("\n")[0] ?? "installed" };
  } catch {
    return { connected: false, who: null };
  }
}

export async function listConnections(config: Config): Promise<ConnectionStatus[]> {
  const [gh, claude] = await Promise.all([githubStatus(), claudeStatus()]);

  let linearWho: string | null = null;
  if (config.linearApiKey) {
    linearWho = await validateLinearKey(config.linearApiKey).catch(() => null);
  }
  let slackWho: string | null = null;
  if (config.slackBotToken) {
    slackWho = await validateSlackToken(config.slackBotToken).catch(() => null);
  }

  return [
    {
      id: "claude",
      name: "Claude",
      connected: claude.connected,
      who: claude.who,
      detail: claude.connected
        ? "the brain's runtime"
        : "install Claude Code: npm install -g @anthropic-ai/claude-code — first run walks you through login",
      acceptsToken: false,
      tokenHelpUrl: null,
    },
    {
      id: "github",
      name: "GitHub",
      connected: gh.connected,
      who: gh.who,
      detail: gh.connected
        ? "PR comments and merges go through your gh login"
        : "run `gh auth login` in a terminal (device flow, no token pasting)",
      acceptsToken: false,
      tokenHelpUrl: null,
    },
    {
      id: "linear",
      name: "Linear",
      connected: linearWho !== null,
      who: linearWho,
      detail:
        linearWho !== null
          ? "inbox ingest + approved comments"
          : config.linearApiKey
            ? "stored key no longer works — paste a fresh one"
            : "paste a personal API key; it is checked against Linear before being saved",
      acceptsToken: true,
      tokenHelpUrl: "https://linear.app/settings/account/security",
    },
    {
      id: "slack",
      name: "Slack",
      connected: slackWho !== null,
      who: slackWho,
      detail:
        slackWho !== null
          ? "approved messages send through your bot"
          : "optional in v1 — paste a bot token (xoxb-…) to enable approved Slack sends",
      acceptsToken: true,
      tokenHelpUrl: "https://api.slack.com/apps",
    },
  ];
}

/** Validate first, store only on success. Returns "connected as …". */
export async function connectWithToken(
  brainDir: string,
  id: "linear" | "slack",
  token: string,
): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("empty token");
  const name: SecretName = id === "linear" ? "linearApiKey" : "slackBotToken";
  const who = id === "linear" ? await validateLinearKey(trimmed) : await validateSlackToken(trimmed);
  writeSecret(brainDir, name, trimmed);
  return who;
}

export function disconnect(brainDir: string, id: "linear" | "slack"): void {
  writeSecret(brainDir, id === "linear" ? "linearApiKey" : "slackBotToken", null);
}
