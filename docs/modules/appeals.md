# Ban appeals

When Sylo bans a member (via `/ban` or a warning auto-action), it DMs them a link
to an appeal form. Staff read submissions and accept or deny them from the
dashboard.

**Dashboard:** `/guilds/<id>/appeals`.

## Needs

- **Ban Members** (to lift a ban on accept).
- A reachable `DASHBOARD_URL` — the appeal form is served at
  `<DASHBOARD_URL>/appeal/<token>`.
- No privileged intents.

## Settings

- **Questions** — 1–5 prompts shown on the appeal form.
- **Auto-unban on accept** — lift the ban automatically when an appeal is
  accepted (otherwise staff unban manually).

## How it works

The pre-ban DM carries the appeal link (this replaces Sylo's plain "you were
banned" notice). The member fills in the form once. On the **Ban appeals** page,
staff **Accept** or **Deny** with a reason; the member is DM'd the decision (and,
on accept, a rejoin invite) — or sees it on the appeal link if there's no shared
server.
