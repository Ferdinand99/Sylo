# Moderation

Warning records with automatic escalation, a moderation log, and channel
lock tools. **On by default.** The moderation slash commands work even with the
module off — the module adds the warning thresholds and the audit embed.

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

## Commands

| Command | |
|---|---|
| `/warn add\|list\|remove\|clear` | Issue and manage warnings. Escalation runs after `add`. |
| `/ban`, `/unban` | Ban a member or a user id; `/ban duration:2h` schedules an auto-unban. |
| `/kick`, `/timeout`, `/untimeout` | Standard actions; `/timeout` takes `10m`, `2h`, `1d` (max 28d). |
| `/purge` | Delete up to 100 messages younger than 14 days. |
| `/slowmode` | Per-user rate limit on a channel; `0` disables. |
| `/lock`, `/unlock` | Deny/restore @everyone's send permissions on a channel. `/unlock` restores the exact prior overwrite. |
| `/lockdown start\|end` | Lock or unlock every text channel at once. |
| `/modlog set\|disable\|status` | Configure the mod-log channel from Discord. |

Warnings and bans can also be added, removed, and cleared from the **Infractions**
tab, along with a list of active channel locks and pending temporary bans.
