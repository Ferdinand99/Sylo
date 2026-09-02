# Sticky messages

Keeps a message glued to the bottom of a channel: when someone else posts, Sylo
deletes its old copy and re-posts the sticky.

**Dashboard:** `/guilds/<id>/m/sticky`.

## Needs

- **Send Messages**, **Manage Messages** (to delete the previous copy),
  **Embed Links**.
- No privileged intents.

## Settings

- **Stickies** — a list of `{ channel, content }`. One sticky per channel.

## Notes

- Re-posting is debounced so a burst of messages produces one re-post.
- Removing a sticky (clearing its content) deletes the current copy.
