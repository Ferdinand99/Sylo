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
  back. The channel's live page is treated the same way, and a live page that cannot be read
  never counts as "not live", so a running live post is left alone, until the page has
  answered 404 for 6 hours without a break (the channel is gone) and the post is ended. A
  stream that is restarted while the page could not be read ends the earlier post when the new
  one is announced. If the feed answers 404
  without a break for 24 hours (any other kind of failure in between starts the count again),
  the module shows a warning in the server's health check ("YouTube can't find the feed for
  ..."): check that the channel still exists, or update its id.
- A new alert with both new-video and live alerts on waits for its first successful feed read
  before it can post a live alert, so a feed that is down at the start does not make the
  first good poll announce old uploads.
