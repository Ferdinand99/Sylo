# Autoresponder

Automatically reply when a message matches a trigger phrase.

**Dashboard:** `/guilds/<id>/m/autoresponder`.

## Needs

- **Message Content** intent (`INTENT_MESSAGE_CONTENT`).
- **Send Messages** (and **Embed Links** for embed replies).

## Settings

- **Rules** — each has a trigger (exact / contains / starts / regex), a reply
  (text or embed), and optionally: reply as a real reply, delete the trigger
  message, restrict to certain channels or roles.
- **Cooldown** — per-channel seconds between triggered replies (anti-spam).
- **Ignore channels** — never respond in these.

## Notes

- Sylo never responds to other bots.
- For user-invocable commands rather than passive triggers, use [Custom
  commands](custom-commands.md).
