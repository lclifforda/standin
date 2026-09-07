# Notifications — how each person gets pinged

Triage decides *whether* to interrupt (lane 3 = important, lane 4 = urgent). This file
decides *how* the person hears about it. Set per person in their `roles/<name>.md` →
Notifications. Onboarding asks for it.

## Channels available

| Channel | Good for | How it works | Notes |
|---------|----------|--------------|-------|
| **In Claude CLI / the board** | lane 3 when you're already working | You ask "who needs me?" and see it | Zero setup. The default. |
| **Daily digest** | lane 3, batched | One summary at a set time | Cheap, low-noise. |
| **Slack DM to yourself** | lane 3–4 while online | Stand-in posts to your own DM (via Slack connector, after your rule allows it) | Works today; great mobile push. |
| **Phone push / email** | lane 4 when away | Cowork scheduled-task notifications | Works from the cloud service. |
| **Telegram / WhatsApp** | lane 4, richest two-way | External bot | Needs the always-on service — the Cowork cloud can't reach Telegram/WhatsApp directly. |

## Recommended default (until the always-on service exists)

- **Lane 3 (important):** surfaced in Claude CLI / the board when you look; optional daily
  digest.
- **Lane 4 (urgent):** a **Slack DM to yourself** (works today) and/or **phone push**.
- **Off-hours:** only lane 4 breaks through; lane 3 waits for your hours.

## Escalation rules

- Respect the person's **hours**; only lane 4 escalates off-hours.
- One ping per item; don't re-ping the same thing.
- An escalation always links back to the item and, where relevant, a ready draft — the
  person decides; the stand-in never sends or merges on its own.
