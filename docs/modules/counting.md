# Counting

A channel where members count upward one number at a time. Sylo tracks the
current number and the record.

**Dashboard:** `/guilds/<id>/m/counting`.

## Needs

- **Message Content** intent (`INTENT_MESSAGE_CONTENT`).
- **Manage Messages** if you want wrong entries deleted.
- **Add Reactions** for the confirmation tick.
- **Manage Roles** if you use the penalty role (below), with Sylo's top role
  above the penalty role.

## Settings

- **Counting channel** — where the game runs.
- **Allow the same person to count multiple times in a row** — on/off (default
  off). Off means each number must come from someone other than whoever posted
  the previous one; on removes that restriction entirely (no limit).
- **Reset on a mistake** — start over at 0, or just ignore the bad message.
- **React** — add a ✅ to each correct count.
- **Penalty role** — optional. When someone breaks the streak, Sylo removes this
  role from them and gives it back after **Bench for (minutes)**. Point it at
  whatever role lets people type in the counting channel: everyone still *sees*
  the channel, but the offender can't post until the bench is up. This is **not**
  a ban or a Discord timeout and creates no moderation case — only this one role
  is ever touched.

## Notes

- The running number, record and last counter live in the database; correct it or
  reset to 0 from the dashboard.
- `/forget` clears a member from the "last counter" slot.
- Benched members are listed on the dashboard with a **Release now** button. A
  member who leaves the server forfeits any pending bench (the role is gone with
  them); rejoining does not restore it early.
