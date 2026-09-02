# Auto-moderation

Scans new and edited messages and acts on the first rule that matches.
Administrators, the server owner, bot-master roles, and members with an
**immunity role** are always skipped. Sylo never acts on other bots.

**Dashboard:** `/guilds/<id>/moderation` → **Automod** tab.

## Needs

- **Manage Messages** to delete offending messages; **Moderate Members** for the
  timeout action.
- **Message Content** intent (`INTENT_MESSAGE_CONTENT`, default on).

## Rules

Each rule is toggled independently:

- **Bad words** — blocks any listed word or phrase.
- **Server invites** — blocks `discord.gg` / invite links.
- **External links** — blocks URLs; list allowed domains to permit only those.
- **Repeated text** — mostly one repeated word or character.
- **Excessive caps** — mostly uppercase.
- **Excessive emojis / spoilers / mentions** — more than N in one message.
- **Zalgo** — combining-mark spam.

## Actions

- **Delete the message** — on/off.
- **Timeout** the author for N minutes.
- Every action is posted to the mod-log channel (set under *General*).

## Notes

- Immunity roles are configured on the Moderator page's **Admin** tab and are
  shared with the warning auto-actions.
- This is Sylo's own scanner. Mapping rules onto Discord's native AutoMod is on
  the backlog.
