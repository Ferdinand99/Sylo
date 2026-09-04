# Moderation

A numbered **case log** covering every moderation action, with automatic warning
escalation, a moderation log, and channel-lock tools. **On by default.** The
moderation slash commands work even with the module off — the module adds the
warning thresholds and the audit embed.

**Dashboard:** `/guilds/<id>/moderation` (Moderator page — Automod, Auto-actions,
Admin, Infractions, Audit logging, Commands tabs).

## Needs

- **Ban Members**, **Kick Members**, **Moderate Members** (timeout), **Manage
  Messages** (`/purge`) — whichever actions you use.
- **Manage Channels** for `/lock`, `/unlock`, `/lockdown`, `/slowmode`.
- Sylo's highest role must sit **above** the members it moderates.
- No privileged intents.

## Settings

- **DM the user when they are punished** — on/off.
- **Warning thresholds** — "at warning #N, do X": `timeout` (with a minutes
  value), `kick`, or `ban`. The strictest matching rule wins. Immunity roles
  (shared with Auto-moderation, set on the Admin tab) are never auto-punished.
- **Mod-log channel** — set under *General*; every moderation action posts an
  embed there.
- **Delete inactive cases after** — days. A daily job removes cases that have
  been deleted (`/case delete`) or resolved (an unban / untimeout) once they are
  older than this. `0` (the default) keeps them forever; active warnings and the
  visible history are never auto-removed.

## Case log

Every action — `warn`, `note`, `timeout`, `untimeout`, `kick`, `ban`, `unban` —
is recorded as an `infractions` row with a **per-server sequential case number**.
`/unban` and `/untimeout` also mark the matching ban/timeout case inactive.
`/case delete` is a **soft** delete: the row stays for audit but drops out of
`/history` and the warning count. (Migration 35 folded the old flat `warnings`
table in as `warn` cases.)

## Commands

| Command | |
|---|---|
| `/history <user> [page]` | The member's case log, newest first (paginated, ephemeral). |
| `/case view\|reason\|delete <#>` | Inspect a case, edit its reason, or soft-delete it. |
| `/case note <user> <text>` | Attach a private note (a case with no DM / no punishment). |
| `/warn add\|list\|remove\|clear` | Issue and manage warnings. Escalation runs after `add`. |
| `/ban`, `/unban` | Ban a member or a user id; `/ban duration:2h` schedules an auto-unban. |
| `/kick`, `/timeout`, `/untimeout` | Standard actions; `/timeout` takes `10m`, `2h`, `1d` (max 28d). |
| `/purge` | Delete up to 100 messages younger than 14 days. |
| `/slowmode` | Per-user rate limit on a channel; `0` disables. |
| `/lock`, `/unlock` | Deny/restore @everyone's send permissions on a channel. `/unlock` restores the exact prior overwrite. |
| `/lockdown start\|end` | Lock or unlock every text channel at once. |
| `/modlog set\|disable\|status` | Configure the mod-log channel from Discord. |

The **Infractions** tab lists every case with edit-reason and soft-delete/restore
controls, alongside active bans, channel locks and pending temporary bans.
