# YouTube alerts

Announce a YouTube channel's new uploads, and when it goes live.

**Dashboard:** `/v2/guilds/<id>/m/youtube-alerts`.

## Needs

- **Send Messages**, **Embed Links** in the alert channels.
- No privileged intents. No API key — Sylo reads the channel's public feed.

## Settings

- **Alerts** — a list of `{ YouTube channel id (UC…), name, Discord channel,
  optional ping role, on-video / on-live toggles, video message, live message }`.
  Up to 50.
- Message placeholders: `{name}` `{title}` `{url}`.
- **When a livestream ends** — *Delete the message* (default), *Mark it as
  ended*, or *Leave it*. Applies only to the "went live" post; new-video
  announcements are never touched.

## Notes

- Find the `UC…` id via the channel's *About → Share → Copy channel ID*.
- Uploads and live states are de-duplicated so each posts once.
- YouTube's feed now and then answers 404 or a server error for a channel that exists. Sylo
  treats that as temporary: it keeps count, polls that channel less often (up to every 30
  minutes) until the feed answers again, and then announces any upload it missed. The
  operator's log gets one warning after 6 failed polls in a row and one line when the feed is
  back. If the feed answers 404 without a break for 24 hours, the module shows a warning in the
  server's health check ("YouTube can't find the feed for ..."): check that the channel still
  exists, or update its id.
