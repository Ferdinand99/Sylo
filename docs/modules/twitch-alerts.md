# Twitch alerts

Announce in a channel when a Twitch streamer goes live.

**Dashboard:** `/guilds/<id>/m/twitch-alerts`.

## Needs

- **Send Messages**, **Embed Links** in the alert channels.
- No privileged intents. No API key — Sylo uses a public endpoint.

## Settings

- **Alerts** — a list of `{ streamer login, channel, optional ping role,
  message }`. Up to 50.
- Message placeholders: `{name}` `{title}` `{game}` `{url}` `{viewers}`.

## Notes

- Sylo polls periodically and de-duplicates so one "went live" event posts once
  per stream.
