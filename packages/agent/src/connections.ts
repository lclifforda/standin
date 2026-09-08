/**
 * Live connector status + authentication, backing the Connections UI.
 * A token is validated against the real API before it is ever stored,
 * so the UI can't save a key that doesn't work.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { writeSecret, type SecretName } from "./secrets.ts";
import { connectLinearOAuth as mcpConnect, linearOAuthStatus } from "./connectors/linear-mcp.ts";
import { slackGrantedScopes } from "./connectors/slack.ts";

const run = promisify(execFile);

export interface ConnectionStatus {
  id: "claude" | "github" | "linear" | "slack";
  name: string;
  connected: boolean;
  who: string | null; // "connected as …" once validated
  detail: string; // next step when not connected
  acceptsToken: boolean; // whether the UI shows a paste-token form
  tokenHelpUrl: string | null;
  steps?: string[]; // plain-language setup walkthrough, shown while disconnected
  permissions: string[]; // what connecting grants — always shown, never sugarcoated
  manifest?: string; // copy-paste app manifest (Slack) that pre-answers the permission screens
}

/** The Slack app, fully specified. Pasting this skips every permission screen —
 *  the review page shows exactly what it grants:
 *  - chat:write — post approved messages
 *  - channels:history / groups:history — read ONLY channels it's invited to
 *    (the owner controls coverage channel by channel, via /invite)
 *  - channels:read / groups:read — list channels to find its memberships
 *  - users:read (+email) — resolve user ids to names so triage reads humanly
 *  No DM scopes: it cannot read anyone's direct messages. */
export const SLACK_MANIFEST = JSON.stringify(
  {
    display_information: {
      name: "standin",
      description:
        "Personal assistant bot. Reads only channels it is invited to; posts only messages its owner explicitly approved.",
      background_color: "#0E7A5F",
    },
    features: { bot_user: { display_name: "standin", always_online: false } },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:history",
          "groups:history",
          "channels:read",
          "groups:read",
          "users:read",
          "users:read.email",
        ],
      },
    },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  },
  null,
  2,
);

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
  } else if (config.linearMcp) {
    linearWho = await linearOAuthStatus();
  }
  let slackWho: string | null = null;
  let slackSendOnly = false;
  if (config.slackBotToken) {
    slackWho = await validateSlackToken(config.slackBotToken).catch(() => null);
    if (slackWho) {
      const scopes = await slackGrantedScopes(config.slackBotToken).catch((): string[] => []);
      slackSendOnly = !scopes.includes("channels:history");
      if (slackSendOnly) slackWho += " · SEND-ONLY";
    }
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
      permissions: [
        "Runs on YOUR Claude account (subscription or API key) — usage bills to you.",
        "Sees what standin sends it: your inbox items, your profile, and repo code during work runs.",
      ],
    },
    {
      id: "github",
      name: "GitHub",
      connected: gh.connected,
      who: gh.who,
      detail: gh.connected
        ? "PR comments and merges go through your gh login"
        : "sign in through your browser — no token pasting:",
      acceptsToken: false,
      tokenHelpUrl: null,
      steps: gh.connected
        ? undefined
        : [
            "Install the GitHub CLI if needed: brew install gh",
            "In a terminal run: gh auth login → pick GitHub.com → HTTPS → “Login with a web browser”, and follow the code it shows.",
            "Come back here — the dot turns green on the next refresh.",
          ],
      permissions: [
        "Your gh login acts as YOU with your full GitHub rights — this is the broadest grant here.",
        "standin uses it to read PRs and, in yolo runs, to branch, commit, push, and open PRs.",
        "Merging a PR or commenting happens ONLY through your explicit Approve — enforced in code, not by promise.",
      ],
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
            ? "stored key no longer works — reconnect"
            : config.linearMcp
              ? "OAuth session lapsed — reconnect (opens your browser)"
              : "sign in with Linear (opens your browser — no key to paste); or paste an API key",
      acceptsToken: true,
      tokenHelpUrl: "https://linear.app/settings/account/security",
      permissions: [
        "Sign-in (OAuth): standin reads your issues, comments and notifications, and can create comments as you — creating is gated behind your Approve. Tokens live in mcp-remote's cache (~/.mcp-auth), not in standin's files.",
        "API key alternative: a personal key carries your FULL Linear permissions; it's stored on this machine only (secrets.json, owner-read-only) and validated before saving.",
      ],
    },
    {
      id: "slack",
      name: "Slack",
      connected: slackWho !== null,
      who: slackWho,
      detail:
        slackWho !== null
          ? slackSendOnly
            ? "the installed app has chat:write ONLY — it can post but not read your channels. Fix: open your app at api.slack.com/apps → “App Manifest” → paste the current manifest (setup guide below) → Save → reinstall (may need the admin's ok for the new read scopes) → done, same token gains the scopes."
            : "approved messages send through your bot; channels it's invited to are read on every triage"
          : "optional — lets Approve & send post to Slack. One-time setup (~5 min, may need an admin's ok):",
      acceptsToken: true,
      tokenHelpUrl: "https://api.slack.com/apps",
      steps:
        slackWho !== null && !slackSendOnly
          ? undefined
          : [
              "Open api.slack.com/apps → “Create New App” → choose “From a manifest” (NOT “From scratch” — the manifest below pre-answers every permission screen so you configure nothing by hand).",
              "Pick your workspace → paste the manifest below (copy button) → Next. The review screen shows exactly the scopes listed under “what connecting grants” here — post approved messages, read only invited channels, resolve names. If it shows anything beyond those, stop and don't create it.",
              "Click “Create”, then “Install to Workspace”. In an admin-restricted workspace this reads “Request to Install” — send it with: “personal assistant bot: posts only messages I explicitly approve, and reads only channels I invite it to — no DMs.” Wait for the ok, then install.",
              "Open “OAuth & Permissions” in the left sidebar and copy the “Bot User OAuth Token” (starts with xoxb-) → paste it below. It's validated with Slack before anything is saved.",
              "In Slack, open the channel it should post in (your profile's Delivery channel) and type: /invite @standin — a bot can only post where it's been invited.",
            ],
      manifest: slackWho !== null && !slackSendOnly ? undefined : SLACK_MANIFEST,
      permissions: [
        "Posts: chat:write — only what you approved, word for word, only where invited.",
        "Reads: history of channels the bot has been INVITED to — you control coverage channel by channel with /invite. It CANNOT read direct messages (no DM scopes at all).",
        "Names: users:read(+email) resolves ids to names so triage reads humanly.",
        "The token is stored on this machine only (secrets.json, owner-read-only).",
      ],
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
  if (id === "linear") {
    writeSecret(brainDir, "linearApiKey", null);
    writeSecret(brainDir, "linearMcp", null);
  } else {
    writeSecret(brainDir, "slackBotToken", null);
  }
}

/**
 * Keyless connect: opens the browser on Linear's own consent screen via the
 * official Linear MCP server. We store only the fact of the connection.
 */
export async function connectLinearOAuth(brainDir: string): Promise<string> {
  const who = await mcpConnect();
  writeSecret(brainDir, "linearMcp", "true");
  return who;
}
