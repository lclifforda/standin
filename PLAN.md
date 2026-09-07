# PLAN.md — the build plan

> PRODUCT.md is the what. This is the how-and-when, sequenced around user zero's three calls
> (2026-09-07): **local web UI in the container · hybrid runtime (laptop + scheduled
> cloud triage) · v1 = decision queue + approve-to-send, onboarding/training wizard,
> audit log.** Yolo-from-the-UI is phase 5. For now the users are user zero + one friend;
> everything is built replicable so "us two" can become more without rework.

## Decisions locked

| Decision | Choice | Consequence |
|---|---|---|
| UI | Local Next.js app served by each person's container (localhost) | Private by construction; no auth/tenancy work in v1; hosting can come later |
| Runtime | Hybrid: laptop container is the source of truth; a scheduled cloud agent runs read-only triage a few times a day and notifies | Off-hours lane-4 pings without a VM; no two-writer state problem (cloud never writes) |
| V1 scope | Decision queue + approve-to-send · onboarding + training wizard · history/audit | Yolo mode stays CLI-only until phase 5 |

## Architecture

```
standin/  (new monorepo)
├── template/            # the brain template (today's repo, owner-free):
│                        #   CLAUDE.md · NORTH_STAR · ONBOARDING · TRAINING ·
│                        #   triage/ · connectors/ · roles/_TEMPLATE
├── packages/core/       # TypeScript: brain file I/O, the 4 lanes, profile schema,
│                        #   THE CONTRACT IN CODE (see below), audit writer
├── packages/agent/      # Claude Agent SDK runner: triage / draft / train / execute
│                        #   sessions, each loading the brain as system context
├── apps/web/            # Next.js UI (see screens below)
├── docker/              # one image: node + claude code + gh + git
└── scripts/standin-init # clone template into /data, first-run checks
```

**State — two kinds, both on the `/data` volume:**
- **Brain** (plain markdown, human-editable): `roles/`, `memory/`, `triage/` — unchanged
  from today. Git-inited so the clone's memory has history and rollback.
- **Operational DB** (SQLite file): inbox items + lane assignments, drafts, approvals,
  sends, audit events. Things the UI lists and the contract audits — wrong shape for
  markdown. SQLite because it's a file: same volume, same backup, zero infra.

**The contract in code (the load-bearing design):** `packages/core` exposes exactly one
function that can call an outbound tool (send message / comment / merge), and it requires
an `approval_id` that only the UI's Approve button (or an explicit CLI yes) can mint —
recorded with the exact content approved, then hash-checked at send time so what goes out
is what was approved. The agent literally cannot send without one; every mint and every
send lands in the audit log. That's SAFETY_CONTRACT.md as an API, not a promise.

**Connectors — the one honest hard part:** today's prototype rides claude.ai's hosted
connectors, which exist only inside a claude.ai session. The packaged agent instead runs
standard MCP servers configured in the container — Linear's official MCP server, a Slack
MCP server, `gh` CLI — each with the *owner's* token in the volume's env. Same tools,
per-person credentials, no dependency on claude.ai session state. This is phase 1's main
integration work and the main setup step for each new user.

**Hybrid runtime:** the container on the laptop owns all state. Separately, a scheduled
cloud agent (Claude Code routines) runs a *stateless, read-only* triage a few times a day
with the same connectors: it sorts, and if lane 4 appears it notifies (Slack DM to self /
email) — it never drafts into the DB, never writes the brain, so there is nothing to
reconcile. The laptop session that follows the ping does the real work.

## UI screens (v1)

0. **First-run setup** (before anything else, the UI gets the person *powered*): detect or
   launch Claude login (subscription OAuth or API key), GitHub auth via `gh` device flow,
   per-connector token entry with a live "test connection" check (Linear, Slack, …), and a
   repo picker — which checkouts the clone is allowed to work in. Nothing proceeds until
   the checks are green; re-runnable from settings when a token expires.
1. **Decision queue** (home): lanes 3–4 as cards — plain-language summary on top, draft
   below, buttons: **Approve & send** (mints the approval) / **Edit then approve** /
   **Not now** / **This is noise** (writes a DECISIONS.md rule). Collapsed "handled
   quietly: N" row expands to the noise list + ready-to-merge list.
2. **Onboarding wizard**: the ONBOARDING.md interview as forms + a connector checklist
   with live "test connection" buttons; ends by writing `roles/<name>.md`.
3. **Training review**: "run training" button → shows what was read (message counts per
   source) and the distilled Voice section as an editable diff → person approves it into
   their profile.
4. **History / audit**: every triage run, draft, approval, send, override — filterable,
   with the "nothing ever sent without a yes" ledger front and center.

## Phases

**Phase 0 — extract the template (an evening).** New `standin` repo; `template/` =
today's repo minus user zero's profile/memory; `standin-init` script; user zero's own `/data`
migrated first so the product is self-hosting from day one.

**Phase 1 — core + agent + connectors (the real week of work).** `packages/core`
(brain I/O, SQLite schema, contract API), `packages/agent` (Agent SDK triage session
producing structured lane output into the DB; draft + train sessions), MCP servers wired
with per-user tokens. Exit test: CLI `standin triage` fills the DB and the contract API
refuses a send without an approval.

**Phase 2 — the UI (week 2).** The four screens against the DB; approve-to-send live
end-to-end on Linear comments + Slack messages (merge approval via `gh`). Exit test:
user zero clears a real morning inbox entirely from the UI.

**Phase 3 — Docker + the friend (weekend + a coffee).** One image, volume, `.env` for
tokens; friend onboards through the wizard, trains, runs their first triage. The friend
is the test: everything owner-specific the template still smuggles in gets found here.

**Phase 4 — the away layer.** Scheduled cloud triage (read-only) + lane-4 notification
leg. Now the clone taps your shoulder when the laptop is closed.

**Phase 5 — yolo in the UI + polish.** Ticket picker, progress view, batched decision
queue as a UI screen. Then revisit: hosted option? more roles? pricing? (PRODUCT.md's
open questions.)

## Risks, named early

- **Per-user MCP auth** is fiddly (token scopes, Slack app installs). Mitigation: the
  connector checklist in the wizard tests each one live, and CONNECTORS.md documents the
  exact setup per platform as we do it for the friend.
- **Anthropic auth in the container**: Claude Code supports subscription OAuth or API
  key; each owner uses their own. Cost stays on the owner (fine at two users).
- **Voice drift / stale profile**: training refresh is a button, and draft edits keep
  feeding DECISIONS.md — the loop we already run.
- **Scope creep**: the north star line still rules — anything that isn't "read, sort,
  draft, hide; never send without a yes, now with a screen" waits.

## First concrete step

Phase 0 tonight-sized: create the `standin` repo with `template/` extracted, and
`standin-init`. Say "go" and it happens.
