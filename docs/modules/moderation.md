# Moderation

A numbered **case log** covering every moderation action, with automatic warning
escalation, a moderation log, and channel-lock tools. **On by default.** The
moderation slash commands work even with the module off — the module adds the
warning thresholds and the audit embed.

**Dashboard:** `/v2/guilds/<id>/moderation` (Moderator page — Automod, Auto-actions,
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
| `/purge <amount> [user]` | Delete up to 100 recent messages, of any age (see below). |
| `/slowmode` | Per-user rate limit on a channel; `0` disables. |
| `/lock`, `/unlock` | Deny/restore @everyone's send permissions on a channel. `/unlock` restores the exact prior overwrite. |
| `/lockdown start\|end` | Lock or unlock every text channel at once. |
| `/modlog set\|disable\|status` | Configure the mod-log channel from Discord. |

The **Infractions** tab lists every case with edit-reason and soft-delete/restore
controls, alongside active bans, channel locks and pending temporary bans.

### Purging messages

`/purge` deletes up to 100 messages in the channel it is run in, optionally only those from one
user. It needs Manage Messages for the person who runs it and for Sylo in that channel, and every
purge that deletes something is written to the mod log.

- **Discord:** messages younger than 14 days are deleted in bulk. Older messages cannot be bulk
  deleted, so Sylo deletes them one at a time at the pace Discord allows (about one per second, and
  it waits whenever Discord asks it to slow down). While that runs, the reply is updated
  ("Deleted 40 of 100...") and has a **Stop** button. Only the person who ran the command and server
  admins can press it.
- **Fluxer:** Fluxer's bulk delete has no age limit, so every message is deleted in one go and
  there is nothing to wait for.
- Only one purge runs per channel at a time; a second `/purge` there is refused until the first has
  finished or been stopped.
- The final reply says how many messages were deleted and how many could not be (for example
  already deleted by someone else, or a missing permission).
