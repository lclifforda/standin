# Triage — how to sort what comes in

Sort **every** incoming item into exactly one lane. When unsure between two lanes, pick the
one that shows the person *more* (a false "important" costs a glance; a false "noise" costs
a miss).

## The four lanes

| Lane | Name | What goes here | What you do |
|------|------|----------------|-------------|
| 1 | **Noise** | FYI feeds/digests, "your PR was approved" (no action but a later merge), bot subscriptions, auto-notifications | Park out of sight. Count it, don't show it. |
| 2 | **Prep & park** | Low-stakes items the person will want but that aren't urgent | Draft a reply/action, hold it. Don't interrupt. |
| 3 | **Bring to you** | Judgment calls: scope questions, review push-back/blockers, decisions, assignments needing a real response | Surface with a ready draft + plain summary. |
| 4 | **Escalate now** | Important **and** urgent: prod-down, customer-facing, security, "needed before X merges", SLA risk | Surface AND ping per notification rules. |

## Signals that raise importance

- **Who**: a senior reviewer, your manager, a customer, or a named person waiting on you
  → up. A bot, an automated digest → down.
- **Type**: a question, a decision, push-back, a reopened/prod bug → up. An approval, an
  FYI, a subscribe → down.
- **Judgment vs rote**: needs your opinion/choice → up. A rote ack → down.
- **Urgency words**: prod, customer, outage, "blocking", "before merge", a due date/SLA
  → lane 4.
- **Directed at you**: an @mention or assignment → up vs. ambient channel chatter.

## Worked examples (fictional, engineer-flavored)

- A PM asks a scope question on a ticket you own and wants a yes/flag → **lane 3**
  (judgment, named person waiting).
- A senior reviewer blocks your PR pending a careful rebase → **lane 3** (blocker).
- Someone reopened a customer-prod database OOM assigned to you, data going stale →
  **lane 4** (prod + customer + assigned).
- "<Reviewer> approved your PR" → **lane 1** noise (nothing to do but merge, and merge
  needs the owner's yes — so it becomes a quiet "ready to merge" list, not an
  interruption).
- A daily feed-summary digest → **lane 1** noise.

## Learning the line

The lanes aren't fixed. When the person says "this is important" about a lane-1/2 item, or
"don't bug me with this" about a lane-3 item, write it to `memory/DECISIONS.md` as a rule
and apply it next time. Over weeks, you triage like they do.
