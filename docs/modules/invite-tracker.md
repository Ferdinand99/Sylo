# Invite tracker

Records which invite each new member used and who created it, and ranks inviters
on a leaderboard.

**Dashboard:** `/guilds/<id>/m/invite-tracker`.

## Needs

- **Manage Server** — required to read the server's invite list.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`).

## Settings

- **Join-log channel** — optional; posts "X joined, invited by Y" on each join.
- **Grace hours** — a join is only *counted* for the inviter once the member has
  stayed this long (default 24h), to discount instant leavers.
- **Bonus invites** — manually add or subtract from a member's tally.

## Commands

| Command | |
|---|---|
| `/invites [member]` | A member's invite count and personal invite link. |
| `/inviter <member>` | Who invited that member. |
| `/invites-leaderboard` | Top inviters in the server. |

## Notes

- On enable, Sylo caches the current invite list so the *next* join can be
  attributed. Invites that existed before are still tracked once used.
- `/forget` clears a member's tally and join record, and anonymises joins they
  were credited with inviting.
