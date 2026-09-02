# Reminders

Post a text or embed message to a channel — once at a set time, or on a repeating
interval. (The dashboard calls this "Reminders"; the older id is
`scheduled-messages`.)

**Dashboard:** `/guilds/<id>/m/reminders`.

## Needs

- **Send Messages**, **Embed Links** in the target channel.
- No privileged intents.

## Settings (per reminder)

- **Channel** and the **message** (text or a built embed).
- **Mode** — `once` (a specific date/time) or `repeat` (every N minutes, 1 min –
  4 weeks).
- Enable/disable a reminder without deleting it.

## Notes

- A background tick fires due reminders; a `once` reminder disables itself after
  firing, a `repeat` one advances its next run.
- Times are handled in the host's timezone (`TZ` env var; the Docker image
  defaults to `Europe/Oslo`).
