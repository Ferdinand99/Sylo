# Auto-moderation

Scans new and edited messages and acts on the first rule that matches.
Administrators, the server owner, bot-master roles, and members with an
**immunity role** are always skipped. Sylo never acts on other bots.

**Dashboard:** `/guilds/<id>/moderation` → **Automod** tab.

## Needs

- **Manage Messages** to delete offending messages; **Moderate Members** for the
  timeout action.
- **Message Content** intent (`INTENT_MESSAGE_CONTENT`, default on).
- **Manage Server** — only for the native AutoMod push (below). Without it the
  in-process scanner still works; the native toggles just no-op with a notice.

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

## Native Discord AutoMod

Four checks have a built-in Discord equivalent and can be **pushed to native
AutoMod**, where Discord enforces them before a message is ever posted — and
keeps enforcing while Sylo is offline:

| Sylo check | Native rule |
| --- | --- |
| Bad words | Keyword rule (each term matched as a `*substring*`) |
| Excessive mentions | Mention Spam rule (`mention_total_limit`) |
| Anti-spam | Spam rule (Discord's own classifier) |
| *(new)* Keyword presets | KeywordPreset rule — Discord's Profanity / Sexual content / Slurs lists |

Turn on **Enforce natively** in the Automod tab, then tick the checks (and/or
presets) to mirror. On save Sylo reconciles the rules named `Sylo: …`:

- It **creates, updates and deletes only its own** `Sylo:`-named rules — rules
  you made by hand are never touched.
- A hand edit to a `Sylo:` rule in *Server Settings → AutoMod* is overwritten on
  the next dashboard save. Edit those from the dashboard.
- The block action carries a short notice; if a mod-log channel is set, blocks
  are also posted there.
- A native-blocked message never reaches Sylo's scanner, so the `warn` action
  does not escalate for natively-enforced checks — use it for the checks that
  stay in-process.

The other checks (repeated text, zalgo, caps, emojis, spoilers, invites, links)
have no native form and always run in Sylo's own scanner.

## Notes

- Immunity roles are configured on the Moderator page's **Admin** tab and are
  shared with the warning auto-actions. They are passed through as the native
  rules' exempt roles too.
