# Privacy Policy — Sylo

**Effective date:** 29 August 2026
**Last updated:** 29 August 2026

This Privacy Policy explains what data the **Sylo** Discord application and its
test instance **Sylo - Test** (the "Bot"), and the Sylo web dashboard (the
"Dashboard"), collect and how it is used. The instances covered by this policy
are operated by **Ferdinand99** (<https://github.com/Ferdinand99>) (the
"Operator"). Sylo is open-source (MIT); self-hosted instances are run by their
own operators and are not covered here.

The Operator does **not** sell your data, does **not** show advertising, and does
**not** use third-party analytics or tracking.

## 1. Data the Bot stores

The Bot keeps only what it needs to work, in a local SQLite database:

| Data | Purpose |
|---|---|
| **Warnings** — server ID, warned user ID, moderator ID (or "dashboard"), reason text, timestamp | Let server staff issue and review member warnings |
| **Per-server settings** — server ID, moderation-log channel ID, default game title | Remember how each server has configured the Bot |
| **Statistics cache** — the game title, player name and platform you looked up, and the statistics returned by `api.gametools.network`, with a timestamp | Serve repeat lookups quickly and stay within the third-party API's rate limits. Entries expire automatically (default: 5 minutes) |

The Bot requires only the standard "Guilds" gateway access from Discord. It does
**not** request the Message Content intent and does **not** read, store, or log
the content of your messages. `/purge` deletes messages via Discord's API but
does not retain them.

## 2. Data the Dashboard processes

The Dashboard can run with or without login.

- **Open mode (no login):** no personal data is collected by the Dashboard
  itself beyond ordinary server request logs.
- **Discord login enabled:** when you choose "Log in with Discord", the Operator
  receives, via Discord OAuth2 (`identify` and `guilds` scopes), your Discord
  user ID, username, avatar, and the list of servers you are in together with
  your permission level in each. This is used only to show your name in the
  Dashboard and to check that you administer a given server. It is stored in a
  signed session cookie in your browser and is **not** written to the database.
  Logging out or letting the session expire clears it. The Discord access token
  obtained during login is used once to read the above and is not stored.

## 3. Logs

The service writes operational logs (startup messages, errors, and the fact that
a command or dashboard action occurred, which may include Discord IDs). These
are used for debugging and abuse prevention and are kept only as long as
operationally useful.

## 4. Third parties

- **Discord** — the Bot and Dashboard operate on Discord's platform; your use is
  also governed by [Discord's Privacy Policy](https://discord.com/privacy).
- **gametools.network** — when you request Battlefield statistics, the player
  name and platform you supply are sent to `api.gametools.network` to retrieve
  the stats. Only data you explicitly put in a `/stats` command is sent.

No other third parties receive your data.

## 5. Data retention and deletion

- **Warnings** are kept until removed with `/warn remove`, `/warn clear`, or from
  the Dashboard.
- **Per-server settings** are kept until changed. Removing the Bot from a server
  stops further processing; residual settings and warnings for that server can be
  deleted on request.
- **Statistics cache** entries expire automatically and hold only public
  game data.
- **Session data** lives only in your browser cookie.

To request deletion of a server's warnings/settings, or any data associated with
your Discord account, contact the Operator (section 7). Removing the Bot from all
your servers and not using the Dashboard also ends processing.

## 6. Security

Data is stored on the Operator's self-hosted infrastructure. The database file is
not publicly exposed. The Dashboard should be run behind authentication or on a
trusted network. No method of storage or transmission is completely secure, and
the Operator cannot guarantee absolute security.

## 7. Contact

Privacy questions or deletion requests: open an issue at
<https://github.com/Ferdinand99/Sylo/issues> (or contact the Operator privately
via their GitHub profile if the request contains sensitive information).

## 8. Changes

This policy may be updated; the "Last updated" date will change and the revised
version will be published at the same URL.
