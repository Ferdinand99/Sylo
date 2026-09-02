# Privacy Policy — Sylo

**Effective date:** 2 September 2026
**Last updated:** 2 September 2026

This Privacy Policy explains what data the **Sylo** Discord application and its
test instance **Sylo - Test** (the "Bot"), and the Sylo web dashboard (the
"Dashboard"), collect and how it is used. The instances covered by this policy
are operated by **Ferdinand99** (<https://github.com/Ferdinand99>) (the
"Operator"). Sylo is open-source (MIT); self-hosted instances are run by their
own operators — see section 9.

The Operator does **not** sell your data, does **not** show advertising, and does
**not** use third-party analytics or tracking.

## 1. Message content

Sylo **does** use the Discord *Message Content* privileged intent (it is enabled
by default). Several optional modules need to read messages in real time to
function:

- **Auto-moderation** — scans new and edited messages against the filters a
  server enables (links, invites, spam, caps, banned words, …) and acts on a
  match. The message is not stored.
- **Counting** — reads the number posted in the counting channel.
- **Autoresponder** — matches messages against the server's trigger phrases.
- **Starboard** — copies a highly-reacted message into a highlights channel.
- **Server logging** — mirrors message edits/deletions to a log channel.
- **Leveling** — counts that a message was sent (not its text) to award XP.

Sylo does **not** keep a copy of message content, **with one exception:**
**modmail ticket transcripts**. When the Tickets module is enabled, the full
text and attachment links of the conversation between a member and staff are
stored so staff can read the thread from the Dashboard (see section 2).

## 2. Data the Bot stores

Everything is kept in a single local SQLite database. What exists depends on
which modules a server enables.

### Server configuration *(no personal data)*

Mod-log channel, default embed colour, dashboard-admin ("bot master") roles,
per-module settings and per-command permission overrides, saved embed messages
and scheduled/recurring posts you compose, autoresponder trigger/response pairs,
starboard settings, the Twitch logins and YouTube channels a server watches, and
the public-leaderboard vanity slug.

### Moderation & safety records

- **Warnings** — warned member ID, moderator ID (or "dashboard"), reason,
  timestamp.
- **Ban appeals** — the banned member's ID and tag, the ban reason, the member's
  free-text answers to the server's appeal questions, and the staff decision and
  reason.
- **Config audit log** — the display name of whoever changed a setting from the
  Dashboard, what changed, and when.

### Member activity

- **Leveling** — per-member XP, level, message count and last-active time.
- **Invite tracking** — per-member invite tallies and a record of who invited
  each joiner (an attribution graph), plus any personal invite code Sylo minted
  for a member.
- **Counting** — the ID of whoever counted last.
- **AFK** — a member's away status, away message and previous nickname.
- **Giveaways** — the host, the entrants, and the drawn winners.
- **Polls** — the poll creator. Votes are Discord reactions and are not stored;
  the row is deleted when the poll ends.
- **Temporary voice channels** — the owner of a spawned channel and its
  per-channel ban list. The row is deleted when the channel empties.

### Conversation content

- **Modmail ticket transcripts** — the text and attachment URLs of ticket
  messages, from both the member and staff (see section 1).

### Notifier bookkeeping *(no personal data)*

"Have we already announced this" markers for free-game offers, Twitch streams
and YouTube videos/livestreams, and the message IDs of starboard posts.

### Game-stat cache

The game title, player name and platform you look up with `/stats`, and the
statistics returned by `api.gametools.network`, with a timestamp. Entries expire
automatically (default: 5 minutes).

## 3. Data the Dashboard processes

The Dashboard can run with or without login.

- **Open mode (no login):** the Dashboard collects no personal data of its own
  beyond ordinary server request logs (section 4). It sets no cookies.
- **Discord login enabled:** when you choose "Log in with Discord", the Operator
  receives, via Discord OAuth2 (`identify` and `guilds` scopes), your Discord
  user ID, username, avatar, and the list of servers you are in together with
  your permission level in each. This is used only to show your name in the
  Dashboard and to check that you administer a given server. It is held in **one
  signed session cookie** in your browser (`httpOnly`, `SameSite=Lax`), is
  **not** written to the database, and is cleared when you log out or the
  session expires (7 days). No analytics or tracking cookies are used. The
  Discord access token obtained during login is used once to read the above and
  is not stored.

## 4. Logs

The service writes operational logs (startup messages, errors, and the fact that
a command or dashboard action occurred, which may include Discord IDs). These
are used for debugging and abuse prevention and are kept only as long as
operationally useful.

## 5. Third parties

- **Discord** — the Bot and Dashboard operate on Discord's platform; your use is
  also governed by [Discord's Privacy Policy](https://discord.com/privacy).
- **gametools.network** — when you request game statistics, the player name and
  platform you supply are sent to `api.gametools.network` to retrieve the stats.
  Only data you explicitly put in a `/stats` command is sent.
- **Cloudflare Turnstile** — if a server enables captcha verification, the
  verification page loads Turnstile from Cloudflare and sends the challenge
  response to Cloudflare for validation. No account data is shared.

No other third parties receive your data.

## 6. Retention and deletion

- **`/forget`** — any member can run `/forget confirm:True` in a server to delete
  the data Sylo keys to their Discord account **in that server**: warnings,
  leveling XP, ticket history (including their ticket messages), ban appeals,
  invite records, AFK status and giveaway entries. It does **not** remove
  messages already posted to channels, a completed giveaway's winner list, or the
  display name recorded in that server's config audit log.
- **Removing the Bot from a server** immediately stops processing and
  **automatically deletes every stored row for that server** (all of section 2).
- **Game-stat cache** entries expire automatically and hold only public game
  data.
- **Ephemeral rows** — ended polls and emptied temporary-voice-channel records —
  are deleted automatically.
- **Session data** lives only in your browser cookie.

For any request the above does not cover, contact the Operator (section 8).

## 7. Security

Data is stored on the Operator's self-hosted infrastructure. The database file is
not publicly exposed, and automatic snapshots are kept for recovery. The
Dashboard is run behind authentication or on a trusted network. No method of
storage or transmission is completely secure, and the Operator cannot guarantee
absolute security.

## 8. Contact

Privacy questions or deletion requests: open an issue at
<https://github.com/Ferdinand99/Sylo/issues>, or contact the Operator privately
via their GitHub profile if the request contains sensitive information. For
suspected security vulnerabilities, please use GitHub's private vulnerability
reporting on the repository rather than a public issue.

## 9. Self-hosted instances

Anyone may run their own copy of Sylo. If you operate a self-hosted instance,
**you** are the data controller for it and this policy does not apply to your
users — publish your own. Sylo gives you the same tools: `/forget` for
per-member erasure and automatic full deletion of a server's data when the Bot
is removed from it. Consider your own legal obligations for the data your
instance stores.

## 10. Changes

This policy may be updated; the "Last updated" date will change and the revised
version will be published at the same URL. The 2 September 2026 revision
corrected the message-content section and expanded the data inventory to match
the current feature set.
