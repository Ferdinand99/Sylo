# Custom commands

Build your own `/slash` commands from an ordered list of actions.

**Dashboard:** `/guilds/<id>/m/custom-commands`.

## Needs

- **Send Messages** / **Embed Links** for reply and post actions.
- **Manage Roles** (above the target roles) for add/remove-role actions.
- No privileged intents.

## Settings (per command)

- **Name** — `a-z0-9_-`, max 32; can't clash with a built-in command.
- **Description** — shown in Discord's command list.
- **Actions** — an ordered list, run in order:
  - **Reply** with text or an embed (ephemeral optional).
  - **Send** a message to a channel.
  - **Add role** / **Remove role** to the invoking member.
- **Allowed roles / channels** and a per-user **cooldown**.

## Notes

- Saving re-registers the guild's custom commands with Discord.
- Deleting a command removes it from Discord on the next sync.
