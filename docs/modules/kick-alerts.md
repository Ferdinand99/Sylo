# Kick alerts

Announce in a channel when a [Kick.com](https://kick.com) streamer goes live.

**Dashboard:** `/guilds/<id>/m/kick-alerts`.

## Needs

- **Send Messages**, **Embed Links** in the alert channels.
- No privileged intents.
- `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` — a free app under
  [kick.com/settings/developer](https://kick.com/settings/developer). Sylo uses
  the OAuth2 client-credentials flow (an app access token, no user login). When
  either is unset the poll loop no-ops and the dashboard shows a note.

## Settings

- **Alerts** — a list of `{ Kick username, channel, optional ping role,
  message, post-as }`. Up to 50.
- Message placeholders: `{name}` `{title}` `{game}` `{url}` `{viewers}`.
- **Post as** — *Embed* (default) or *Plain text (no embed)*. Plain-text mode
  posts a normal message and always appends the stream link, for channels that
  are transcribed elsewhere (e.g. a RuneLite Discord→game-chat plugin that
  ignores embeds).
- **When the stream ends** — *Delete the message* (default), *Mark it as ended*,
  or *Leave it*.

## Notes

- Sylo polls the Kick API about once a minute and de-duplicates on the stream
  start time, so one "went live" event posts once per broadcast — a new stream by
  the same channel fires again.
- Dedupe state lives in the shared `posted_keys` table (scope `kick`).
