# Sticky messages

Keeps a message glued to the bottom of a channel: when someone else posts, Sylo
deletes its old copy and re-posts the sticky.

**Dashboard:** `/guilds/<id>/m/sticky`.

## Needs

- **Send Messages**, **Manage Messages** (to delete the previous copy),
  **Embed Links**.
- No privileged intents.

## Settings

- **Stickies** — a list of `{ channel, content, embed }`. One sticky per
  channel; each needs text, an embed, or both. The embed editor is on the V2
  dashboard only — V1 can still edit a sticky's text/cooldown/channel without
  disturbing an embed set on V2.
- **Other apps / webhooks** — by default only human messages bump the sticky.
  Set this to *Bump the sticky too* so messages from other bots, apps or
  webhooks (e.g. a RuneLite plugin posting embeds) — and Sylo's own messages
  such as alerts, welcomes and composed embeds — also push the sticky back to
  the bottom. Sylo's own sticky re-post never counts.
- **Min seconds between reposts** — the smallest gap between two reposts in that
  channel (0 = the 4-second default). Raise it for a busy channel so the sticky
  isn't reposted after every message.

## Notes

- Re-posting is rate-limited so a burst of messages produces one re-post.
- Removing a sticky (clearing both its content and its embed) deletes the
  current copy.
