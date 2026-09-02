# AFK

Members run `/afk` to mark themselves away. Sylo replies to anyone who mentions
them, and clears the status when they next speak.

**Dashboard:** `/guilds/<id>/m/afk`.

## Needs

- **Manage Nicknames** (optional) to prefix `[AFK]` on the member's nickname.
- No privileged intents (the module reads mentions, not message content).

## Settings

- **Set nickname** — add/remove an `[AFK]` prefix while away.
- **Reply to mentions** — post "X is AFK: reason" when an AFK member is pinged.
- **Ignore channels** — don't act in these.

## Commands

| Command | |
|---|---|
| `/afk [reason]` | Mark yourself away. |

## Notes

- `/forget` clears a member's AFK status.
