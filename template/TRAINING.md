# Training mode — learn the person from their real writing

Run this when the person says **"train on my voice"**, **"go training mode"**, or right
after onboarding. Onboarding captures how they *describe* themselves; training captures how
they *actually* operate. Both matter; when they conflict, trust the samples.

This playbook is user zero's first training session (Sep 2026), made repeatable.

## What training produces

Updates to `roles/<name>.md`:
- **Voice** section: registers (casual vs technical), verbatim excerpts as calibration,
  concrete patterns (openers, emoji, punctuation habits, how asks are framed), and a
  "never in their voice" list.
- Sharpened triage seeds: who they actually talk to most, what they ignore, what they
  escalate.

Plus a `DECISIONS.md` line recording that training ran and from what sources.

## The procedure

1. **Harvest, through their own connectors** (read-only, with them present):
   - Slack: `slack_search_public_and_private` with `from:<their user id>`, last 30–60
     days, ~20–40 messages. Get both registers: channel posts *and* DMs.
   - Linear/Jira: their comments on recent issues and reviews (`list_comments` on issues
     they were active in).
   - GitHub: `gh search prs --author @me` → PR descriptions and review comments.
   - Email/Notion if that's where their role lives.
2. **Distill, don't transcribe.** Look for: how they open and close; formality per
   audience; sentence length; emoji/punctuation habits; how they ask for things (do asks
   carry the *why*? a deadline? an out for the other person?); how they deliver pushback
   and admit mistakes; what they always make explicit (tests run, evidence, numbers);
   pet phrases.
3. **Quote 2–4 short real excerpts** into the Voice section — excerpts calibrate a model
   better than any description.
4. **Write the "never" list** — fluff, hedging, invented specifics, whatever is absent
   from every sample.
5. **Confirm back in one paragraph** ("here's how you write, per your own messages") and
   let them correct it. Corrections → `memory/DECISIONS.md` as VOICE rules.

## Rules

- **Explicit and visible.** Training runs when invoked, tells the person what it read, and
  writes only to files they can open. No silent background profiling.
- **Their credentials only.** Harvest exclusively through connectors the person authorized
  themselves. Never train one person's clone on another person's private messages —
  channel messages *to* them are context; only their own words define their voice.
- **Drafts are the test.** The profile is good when they stop editing the drafts. If they
  edit, log the edit as a VOICE rule and re-run training on fresher samples.
- **Refresh:** monthly, or when the person says a draft "doesn't sound like me."
