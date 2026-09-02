# Welcome channel

Build one rich, pinned message for a dedicated read-only `#welcome` channel — a
static "start here" board, separate from the per-join [Welcome & leave](welcome.md)
messages.

**Dashboard:** `/guilds/<id>/m/welcome-channel`.

## Needs

- **Send Messages**, **Embed Links**; **Manage Channels** to create the channel
  from the dashboard.
- No privileged intents.

## Settings

- **Channel** — pick an existing one, or **Create channel** makes a read-only
  `#welcome` (@everyone can view, not send).
- **Content** — a WYSIWYG builder: intro text plus up to 10 embeds and
  banner-style blocks, with preset elements (rules, links, …).
- **Publish** posts (or updates) the message and pins it; **Unpublish** deletes
  it.

## Notes

- Editing the content and saving re-publishes to the same message. The stored
  `messageId` tracks it; if the message is deleted in Discord, publish again.
