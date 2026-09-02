# Starboard

Re-posts messages that get enough of a chosen reaction into a highlights channel.
Supports multiple independent boards.

**Dashboard:** `/guilds/<id>/m/starboard`.

## Needs

- **Message Content** intent (`INTENT_MESSAGE_CONTENT`) to copy message text.
- **Send Messages**, **Embed Links** in the board channel; **Add Reactions** for
  auto-react.

## Settings (per board)

- **Channel** and **emoji(s)** that count toward it.
- **Threshold** — reactions needed to post.
- **Multi per user** — count multiple reactions from one member, or one each.
- **Auto-react** — Sylo adds the emoji to new messages (optionally only the first
  one).
- **Remove on unstar / on delete**, **repost cooldown**, **min/max message age**,
  **ignore self-stars**, **ignore bot messages**, and an allow/deny **role list**
  for whose reactions count.

## Notes

- Enabling a board scans recent messages for anything already over the threshold.
- Up to 10 boards per server.
