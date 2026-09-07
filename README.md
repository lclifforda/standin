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

## Running the coded pipeline (phase 1+)

```bash
pnpm install
cp template/.env.example ~/standin-data/.env   # add your LINEAR_API_KEY
pnpm triage                                    # ingest → classify → queue
pnpm web                                       # decision queue at http://localhost:4180
```

Or from the CLI: `standin triage · queue · approve <id> · dismiss <id> · audit`.

How it hangs together: connectors ingest deterministically (your tokens, no model);
the model's one job is judgment — lanes, plain-language summaries, drafts in your
voice; and the only door out is `executeApproved()` in `packages/core/src/contract.ts`,
which demands an approval minted by your explicit yes, spends it once, and hash-checks
that what sends is byte-for-byte what you approved. Six tests pin those guarantees.

## Status

Phase 1 shipped: core (SQLite + contract-as-API, tested), connectors (Linear ingest +
Linear/Slack/GitHub executors), agent classification, CLI, and the first slice of
phase 2 — the decision-queue web UI with approve-to-send and "this is noise" learning.
Next: onboarding/training wizard + audit screen, then Docker + the second user.
