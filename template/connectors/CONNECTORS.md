# Connectors — the platforms your stand-in plugs into

The stand-in reads your work through connectors. Two kinds:

- **MCP servers** — configured in the runtime (container/CLI) with YOUR tokens. Linear has
  an official MCP server; Slack and others have well-maintained ones. In the claude.ai/CLI
  flow, connectors added in claude.ai → Settings → Connectors work too.
- **CLI tools** — e.g. GitHub via `gh` (auth with `gh auth login`); often the most capable
  option for repos (read PRs, branch, push, open PRs).

## Status (fill in during onboarding — one row per platform)

| Platform | For | How | Status |
|----------|-----|-----|--------|
| **Linear** | issues, comments, review threads, notifications | MCP | ⬜ not connected |
| **Slack** | DMs + chosen channels | MCP | ⬜ not connected |
| **GitHub** | PRs you author / review; repo work | `gh` CLI | ⬜ not connected |
| **Notion / Jira / email / …** | role-dependent | MCP | ⬜ as needed |

## Adding a connector

1. Authorize it (claude.ai → Settings → Connectors, or configure the MCP server / CLI tool
   with your token).
2. Add it under your **Sources to watch** in `roles/<you>.md`, naming the *slices* (which
   channels, "assigned to me", "PRs I review") — not the whole firehose.
3. Record the exact read tools in the table above, so the stand-in never guesses a tool it
   hasn't seen respond.
4. If the stand-in will do repo work (yolo mode), list your local checkouts here.

## Rule

Connectors are **read + draft** for the stand-in. Write tools (send a message, comment,
merge) are only ever called **after an explicit yes** — see `triage/SAFETY_CONTRACT.md`.
