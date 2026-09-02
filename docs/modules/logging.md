# Server logging

Sends server events to a log channel as embeds. Each event type is toggled
individually.

**Dashboard:** `/guilds/<id>/m/logging` (also the **Audit logging** tab on the
Moderator page).

## Needs

- **View Audit Log** for accurate "who did it" attribution on bans, kicks and
  role changes.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`) for join/leave/nick/role
  events; **Message Content** intent (`INTENT_MESSAGE_CONTENT`) for message
  delete/edit content.

## Settings

- **Log channel** — one channel for all enabled events.
- **Events** — member join, member leave, member ban, member unban, member
  timeout, nickname change, role change (per member), message delete, message
  edit, bulk message delete, role create/delete, channel create/delete.

## Notes

- Deleted-message logging can only show content Discord still had cached; very
  old messages log as "content unavailable".
- This is separate from the **mod-log** (moderation actions Sylo itself takes),
  which is set under *General*.
