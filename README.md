# standin — a clone of your working self

**It reads everything coming at you, learns how you write from your real messages, does
the rote work end-to-end, and leaves you only the decisions. It never sends or merges
anything without your yes.**

## Try it (CLI, today)

```bash
git clone <this repo> && cd standin
scripts/standin-init            # creates your brain at ~/standin-data
cd ~/standin-data && claude     # then say: "onboard me"
```

Then: `"train on my voice"` → `"triage my inbox"` → watch a ~30-item inbox collapse to
the 3 things that actually need you, each with a draft ready in your voice.

## The idea in 30 seconds

- **Your clone's brain is a folder of markdown** you can read, edit, git-diff, and delete:
  a profile (who you are, what matters, how you write), a learning log (every correction
  you make moves its judgment), and a safety contract.
- **Four lanes:** noise (hidden) · prep & park · bring to you · escalate now. You only ever
  see the last two.
- **The safety contract is the product:** read, sort, draft, hide — freely. Send, merge,
  close — only after your explicit yes, enforced in code (see PLAN.md), not by promise.
- **Training mode** builds your voice from your real Slack/Linear/GitHub writing, not from
  how you describe yourself.
- **Yolo mode:** "go yolo on TICKET-123" → it does the whole job and returns one batched
  decision queue.

## Repo layout

```
template/    the brain template each new person starts from (CLAUDE.md, triage rules,
             safety contract, onboarding + training playbooks)
scripts/     standin-init — set up a new person
packages/    core (brain I/O, lanes, the contract-as-API, audit) + agent (Claude Agent
             SDK sessions)                      ← phase 1
apps/        web — local decision-queue UI      ← phase 2
docker/      one image, /data volume per person ← phase 3
```

Roadmap and architecture: **PLAN.md** (the build plan) and **PRODUCT.md** (the product
thinking). North star lives in `template/NORTH_STAR.md`.

## Status

Phase 0. The brain + CLI loop is proven on a real inbox (Linear + Slack + GitHub);
core/agent packages, the web UI, and Docker packaging are next — in that order.
