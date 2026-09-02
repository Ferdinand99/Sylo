# Counting

A channel where members count upward one number at a time. Sylo tracks the
current number and the record.

**Dashboard:** `/guilds/<id>/m/counting`.

## Needs

- **Message Content** intent (`INTENT_MESSAGE_CONTENT`).
- **Manage Messages** if you want wrong entries deleted.
- **Add Reactions** for the confirmation tick.

## Settings

- **Counting channel** — where the game runs.
- **Allow the same user twice in a row** — on/off (default off).
- **Reset on a mistake** — start over at 0, or just ignore the bad message.
- **React** — add a ✅ to each correct count.

## Notes

- The running number, record and last counter live in the database; correct it or
  reset to 0 from the dashboard.
- `/forget` clears a member from the "last counter" slot.
