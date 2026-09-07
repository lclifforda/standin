# PRODUCT.md — from user zero's stand-in to everyone's stand-in

> NORTH_STAR.md says *what* this is (a triage brain behind a safety contract). This file
> says how it becomes a **product**: something a new person — starting with one friend —
> can adopt in an afternoon and trust with their inbox. Written 2026-09-07.

## The one-line pitch

**A clone of your working self:** it reads everything coming at you, learns how you write
and what you care about from your real messages, does the rote work end-to-end, and leaves
you only the decisions. It never sends or merges anything without your yes.

## What already works (proven on user zero, Sep 2026)

| Piece | Status |
|---|---|
| Onboarding interview → profile (`ONBOARDING.md` → `roles/<name>.md`) | ✅ works |
| 4-lane triage over Linear with per-person tuning | ✅ works |
| Training mode: voice distilled from real Slack/Linear writing, not self-description | ✅ done once by hand — formalized in `TRAINING.md` |
| Learning loop (`memory/DECISIONS.md`, corrections move the line) | ✅ wired |
| Safety contract (never send / never merge without a yes) | ✅ law |
| Yolo mode (end-to-end rote execution, batched decision queue) | ✅ defined, per-profile |
| Connectors: Linear + Slack (MCP), GitHub (`gh` CLI) | ✅ connected for user zero |

**The key insight the prototype proved:** the person's entire "clone" is a folder of
markdown — profile, decisions, safety additions. No database, no model training. That's
what makes it a product: portable, inspectable, owned by the user, and trivially persisted.

## Architecture: three layers

```
┌─────────────────────────────────────────────────────┐
│ BRAIN (persistent, per-person, plain files)          │
│   roles/<name>.md · memory/ · triage/ · connectors/  │
│   → a Docker volume / synced folder. THIS is the     │
│     product's state. Nothing else persists.          │
├─────────────────────────────────────────────────────┤
│ RUNTIME (stateless, replaceable)                     │
│   Claude Code / Claude Agent SDK + this repo's       │
│   instructions (CLAUDE.md). Today: interactive CLI.  │
│   Product: headless agent in a container.            │
├─────────────────────────────────────────────────────┤
│ HANDS (per-person credentials, never shared)         │
│   MCP connectors (Linear, Slack, Notion…) authorized │
│   by the person in claude.ai; gh CLI; repo checkouts.│
└─────────────────────────────────────────────────────┘
```

The Docker image ships layers 2 + tooling. Layer 1 mounts as a volume so the brain
survives image updates. Layer 3 is injected per person (env/secret mounts + their own
Claude account) — **a clone always runs as its owner, with its owner's credentials.**

## The user journey (product spec)

1. **Describe what you do** — the `ONBOARDING.md` interview, plain language, ~5 min.
   Output: `roles/<name>.md` from the template.
2. **Training mode** — the stand-in reads the person's *real* recent writing (Slack
   messages, review comments, tickets) through their connectors and distills: voice
   registers, triage seeds (who matters, what's noise), working rhythms. See
   `TRAINING.md`. Re-run monthly or when drafts feel off.
3. **Daily loop** — "triage my inbox" → lanes 3–4 only, drafts ready. Corrections land in
   `memory/DECISIONS.md`; the clone converges on their line.
4. **Yolo mode** — "go yolo on TICKET-123": end-to-end rote execution, one batched
   decision queue back. Decisions, analysis, sends, merges stay human.
5. **Always-on (later)** — the same loop on a schedule inside the container; lane 4
   reaches the person on their phone (NOTIFICATIONS.md).

## Packaging plan (the Docker story)

- **Image:** Claude Code (or Agent SDK) + git + gh + this repo as the baked-in template at
  `/app`. One image for everyone.
- **Volume:** `/data` holding the person's brain (their `roles/`, `memory/`, connector
  notes) + their repo checkouts. `CLAUDE.md` reads the profile from the volume.
- **Secrets:** their Anthropic auth + `gh` token as env/secret mounts. MCP connectors are
  authorized under *their* claude.ai account — the image never contains anyone's tokens.
- **Modes:** `docker run -it` → interactive CLI (MVP); `docker run -d` + cron → scheduled
  triage with push escalation (the "agent" phase).

## MVP for the friend (this month — no Docker needed yet)

Docker earns its place at the always-on phase; adoption doesn't wait for it:

1. Strip this repo to a **template**: keep `CLAUDE.md`, `NORTH_STAR.md`, `ONBOARDING.md`,
   `TRAINING.md`, `PRODUCT.md`, `triage/`, `connectors/`, `roles/_TEMPLATE.md` +
   `roles/EXAMPLES.md`, empty `memory/DECISIONS.md`. user zero's profile stays out (it's hers).
2. Friend: installs Claude Code, clones the template, connects their tools in claude.ai →
   Settings → Connectors, runs `claude` in the folder, says **"onboard me"**, then
   **"train on my voice"**, then **"triage my inbox"**.
3. Their brain lives in their copy of the folder (git-init it for history = free
   persistence and rollback of the clone's memory).

Watching a second person onboard is also the fastest way to find what's owner-specific in
the template.

## What makes this trustable as a product (don't compromise these)

1. **The safety contract is the product**, not a beta limitation. "It can do everything
   except speak as me or destroy state without my yes" is the reason a normal person will
   hand over their inbox. Yolo mode doesn't loosen it — sends/merges *are* the decision
   layer the human keeps.
2. **The brain is readable.** Anyone can open their `roles/` and `memory/` files and see
   exactly what their clone believes about them — and edit or delete it.
3. **Credentials never cross people.** One clone, one owner, one set of tokens.
4. **Training reads, never scrapes silently.** Training mode is an explicit, user-invoked
   step; what it learned is written to files the user reviews.

## Open product questions (decide when they hurt)

- **Notification leg for lane 4** — Telegram/WhatsApp are firewalled from the cloud
  runtime (see CONNECTORS.md); the always-on container solves this, or a phone-push
  fallback. Decide at the agent phase.
- **Multi-tenant hosting vs "everyone runs their own"** — start with everyone-runs-their-
  own (one container per person, their machine or a VM). Hosting is a later business
  question, not an MVP one.
- **Cost** — a clone runs on its owner's Claude subscription/API key. Fine for friends;
  pricing only matters if this becomes more than that.
