# Welcome & leave

Greet new members in a channel and/or by DM, announce departures, and optionally
attach a generated **welcome image**.

**Dashboard:** `/guilds/<id>/m/welcome`.

## Needs

- **Send Messages**, **Embed Links** in the target channel; **Attach Files** for
  the welcome image.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`).

## Settings

- **Join message** — channel + text, optionally sent as an embed (uses the
  server's default embed colour, set under *General*).
- **Welcome image** — a 1000×340 banner with the member's avatar, name and member
  number. Optional background image URL (drawn behind a dark scrim). Needs
  **Attach Files**; skipped with a logged warning if missing.
- **DM message** — a private message to each new member.
- **Leave message** — channel + text when a member leaves.
- **Give roles to new members** — shared with the [Reaction roles &
  autoroles](roles.md) module.

Placeholders: `{user}` `{user.tag}` `{user.name}` `{user.id}` `{server}`
`{memberCount}`.

## Notes

- A live preview of the welcome image is shown on the config page.
- Rendering needs `@napi-rs/canvas` (bundled). If it can't load on your platform,
  the image is skipped and the text still sends.
