# Twitch alerts

Announce in a channel when a Twitch streamer goes live.

**Dashboard:** `/guilds/<id>/m/twitch-alerts`.

## Needs

- **Send Messages**, **Embed Links** in the alert channels.
- No privileged intents. No API key — Sylo uses a public endpoint.

## Settings

- **Alerts** — a list of `{ streamer login, channel, optional ping role,
  message, post-as }`. Up to 50.
- Message placeholders: `{name}` `{title}` `{game}` `{url}` `{viewers}`.
- **Post as** — *Embed* (default) or *Plain text (no embed)*. Plain-text mode
  posts a normal message and always appends the stream link, for channels that
  are transcribed elsewhere (e.g. a RuneLite Discord→game-chat plugin that
  ignores embeds).

## Notes

- Sylo polls periodically and de-duplicates so one "went live" event posts once
  per stream.
