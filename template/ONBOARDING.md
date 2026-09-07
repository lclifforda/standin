# Onboarding — set up a new person or role

Run this when someone new adopts the stand-in (they said "onboard me", or no real profile
exists yet). Ask these in plain language, a few at a time — don't dump all at once. Then
write the answers into `roles/<their-name>.md` using `roles/_TEMPLATE.md`.

Keep it to ~5 minutes. Every question has a sensible default; offer it so they can just say
"that's fine."

## 1. Who and what

- **Your name / handle?**
- **Your role?** (e.g. software engineer, PM, designer, sales, support) — this shapes what
  counts as "your work".
- **In one line, what does "doing your job" mean day to day?** What lands on you that you
  respond to?

## 2. Where your work comes from (connectors)

- **Which tools should I watch?** (Linear, GitHub, Slack, Notion, Jira, email, calendar…)
- For each: **which slices?** e.g. Slack → which channels + DMs; Linear → issues assigned
  to you; GitHub → PRs where you're a reviewer. (A firehose of everything = noise.)
- See `connectors/CONNECTORS.md` for what's available and how each connects.

## 3. What matters vs. what's noise

- **Who are the people whose messages always matter?** (manager, key reviewers, top
  customers)
- **What kinds of things are urgent for you?** (prod issues, customer escalations, a
  deadline, a specific label/keyword)
- **What can I always hide?** (digests, bot notifications, FYIs, specific channels)

## 4. How you want to be reached (notifications)

- **When something's just "important" (lane 3), how do you want it?** (only when you open
  the tool / a daily digest / a Slack DM)
- **When something's "urgent" (lane 4), how should I reach you — even off-hours?**
  (Telegram, WhatsApp, Slack DM, phone push, email — see `connectors/NOTIFICATIONS.md`)
- **Your hours?** So I only escalate off-hours for true lane-4 urgency.

## 5. Your voice

- **Paste 2–3 real replies you've written** (Slack, review comments, email). I'll match
  your tone. Or describe it (e.g. "warm, direct, no corporate fluff").

## 6. Safety additions

- The two hard rules always apply: **I never send and never merge/close without your yes.**
- **Anything else I must always check with you on?** (e.g. never post in #leadership,
  never reply to a customer, never change a due date.)

## After onboarding

Save the profile, confirm it back in one short paragraph ("Here's your setup — I'll watch
X and Y, hide Z, ping you on <channel> for urgent things, in your voice. Sound right?"),
then run a first triage so they see it work.
