# North Star — why this exists

> Keep this short and re-read it when things drift. Everything we build serves the one
> objective below or it's a distraction.

## The objective, in one line

**A triage brain that reads everything coming at you, quietly handles the noise, and only
puts the few things that actually need *you* in front of you — and never sends a reply or
merges/closes anything without your yes.**

The point isn't to *see* your work faster. It's to *not have to do most of it*, while
trusting nothing important slips past.

## The loop it runs

Every PR, ticket, message, or mention goes through four steps:

1. **See** — what landed.
2. **Decide** — what to do about it.
3. **Do** — the actual work (draft, prepare, take safe actions).
4. **Communicate** — say it in your voice.

## The four triage lanes

Every incoming item is sorted into exactly one:

1. **Noise — handle silently.** FYI feeds, "your PR was approved", bot subscriptions.
   Parked out of sight. *This is the whole win: inbox goes from ~30 to ~3.*
2. **Prep & park — low stakes.** Drafted and held; won't interrupt you.
3. **Bring to you — important.** The judgment calls (a scope question, a review blocker),
   surfaced with a draft ready.
4. **Escalate now — important AND urgent.** Prod-down, customer-facing, "before X merges".
   Taps you on the shoulder wherever you are.

**"Just ask me for my important things" = lanes 3 and 4.** Everything else disappears
until you go looking.

## The safety contract (law — see `triage/SAFETY_CONTRACT.md`)

- 🔒 Never merges or closes anything without an explicit yes.
- 🔒 Never sends any reply to a person without an explicit yes.
- ✅ Everything else — read, sort, draft, hide noise — it does on its own.

So its power is: **read, sort, draft, hide. Never send, never merge.**

## How it judges "important"

Weighs: *who* it's from (senior reviewer / manager / customer vs a bot), *what type*
(scope question or prod bug vs an approval), *judgment vs rote action*, and *urgency*
(prod, customer-facing, SLA, "before merge"). And it **learns**: every time you pull
something out of noise or push something down, the line moves (`memory/DECISIONS.md`).

## Roadmap

- **Now** — triage over Linear, run through Claude CLI. Inbox collapses to what matters.
- **Next** — pull Slack + GitHub into the same funnel.
- **Then** — the "reach you when away" layer (phone ping for lane 4).
- **Later** — let it take *reversible* actions itself (label, archive, prep a rebase);
  sending and merging stay behind your yes forever.
- **Throughout** — role-agnostic: a new person onboards in 5 minutes and gets their own
  triage tuned to their world.

## The mental shift

We're not building an inbox. We're building a **filter that makes most of your inbox
vanish.**
