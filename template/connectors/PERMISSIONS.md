# Permissions — what your stand-in can actually touch

Plain answers, no sugarcoating. Read this before connecting anything; the same
text appears on each connection card in the app.

## The one rule over everything

Reading, sorting, drafting, and working in your repos happens freely once you
allow it (the yolo switch). **Speaking as you does not**: sending any message,
comment, or review, and merging or closing anything, only ever happens through
one code path that requires an approval minted by your explicit yes — recorded,
single-use, and hash-checked so what goes out is exactly what you approved.
That's `packages/core/src/contract.ts`, and tests pin it.

## Per connection

**Claude** — the runtime. Runs on your own account; usage bills to you. It sees
what standin sends it: your inbox items, your profile, and your repo code
during work runs. It holds no credentials of yours.

**GitHub (`gh` CLI)** — the broadest grant here: your `gh` login acts as you
with your full GitHub rights. standin uses it to read PRs and, in yolo runs,
to branch, commit, push, and open PRs. Merging and commenting go through your
explicit Approve only. If that grant is too broad for your taste, a
fine-grained PAT limited to specific repos can back `gh` instead.

**Linear** — two options. *Sign-in (OAuth via Linear's official MCP)*: read
issues/comments/notifications, create comments as you (gated behind Approve);
tokens live in `mcp-remote`'s own cache (`~/.mcp-auth`), not standin's files.
*API key*: acts as you with your full Linear permissions; stored only on your
machine (`secrets.json`, owner-read-only), validated before saving.

**Slack** — invited-channels only, by design. The manifest requests:
`chat:write` (post approved messages — word for word what you approved, only
where invited), `channels:history` + `groups:history` (read ONLY channels the
bot has been invited to — you control coverage channel by channel with
`/invite @standin`), `channels:read`/`groups:read` (find its memberships), and
`users:read`(+email) (turn user ids into names). **It has no DM scopes: it
cannot read anyone's direct messages.** If the app-creation review screen
shows scopes beyond these, stop — that's not our manifest. Reading your
personal DMs would require user-level scopes — a separate, explicit decision
we have deliberately not bundled in.

## Where secrets live

- `secrets.json` in your brain dir — owner-read-only (0600), gitignored.
- `~/.mcp-auth` — OAuth token cache owned by the public `mcp-remote` library.
- Nothing is ever committed, uploaded, or shared between users. One clone,
  one owner, one set of tokens.

## What to tell an admin who must approve something

"It's a personal assistant bot. Slack: it posts only messages I explicitly
approved, and reads only channels I invite it to — it has no DM scopes at all.
It runs on my machine, not a third-party server."
