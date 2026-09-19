# Auto-react

Automatically react — and optionally add or remove a role — when a message
comes from a chosen user or role.

**Dashboard:** `/guilds/<id>/m/auto-react`.

## Needs

- No privileged intents — only the message author and their roles are read,
  never the message content.
- **Add Reactions** and **View Channel** in any channel it should react in.
- **Manage Roles** (with Sylo's own role above the one being granted/removed)
  if a rule uses the "also change a role" option.

## Settings

- **Rules** — as many as you like; the first one that matches a message wins.
  Each rule has:
  - **Target users** and/or **target role** — at least one of the two.
  - **Channel** — optional; leave as "all channels" or lock the rule to one.
  - **Emoji** — one or more, unicode or a server custom emoji.
  - **When to react** — every matching message, or a random % chance.
  - **Also change a role** — optionally give or take away a role on the same
    trigger (e.g. to track a status like "infected").
- **Per-user cooldown** — seconds before the same person can trigger a rule
  again, regardless of channel.
- **Log channel** — optional; posts one line per trigger (who, where, and any
  role change).

## Notes

- A rule with neither target users nor a target role, or with no emoji, is
  dropped automatically — there's nothing for it to do.
- Reacting and changing a role both happen on the same trigger; if the role
  change fails (missing permission, role above Sylo's), the reaction still
  happens.
