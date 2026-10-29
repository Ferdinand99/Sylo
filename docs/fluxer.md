# Running Sylo on Fluxer

Sylo can run on **Discord**, on **[Fluxer](https://fluxer.app)**, or on **both at
once** from one process, with one dashboard. This page covers setting up the Fluxer
side, how people use the bot there, and what is different from Discord.

> **Experimental.** Fluxer support is new. It has been tested module by module on
> a self-hosted Fluxer instance, but expect rough edges, and please report what
> you find. A Discord-only install is unaffected: leave the Fluxer variables
> blank and nothing here applies.

- [How it fits together](#how-it-fits-together)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Create the Fluxer application](#create-the-fluxer-application)
- [Add the bot to a server](#add-the-bot-to-a-server)
- [Dashboard login](#dashboard-login)
- [Using commands](#using-commands)
- [What works differently](#what-works-differently)
- [Server ids](#server-ids)
- [Upgrading an existing install](#upgrading-an-existing-install)
- [Coming from Sylo-Fluxer](#coming-from-sylo-fluxer)
- [Troubleshooting](#troubleshooting)

---

## How it fits together

- One Sylo process can hold a Discord bot and a Fluxer bot at the same time. Each
  platform is optional; set the credentials of the ones you use. At least one is
  required.
- There is **one dashboard**. Servers from both platforms appear in the same
  server switcher, tagged with a small platform badge once your account has both.
- Every module works per server, on either platform. A module that is on in your
  Discord server is not on in your Fluxer server until you turn it on there.
- Discord and Fluxer servers never see each other's data: XP, cases, settings and
  appeals are stored per server.

---

## Quick start

Fluxer only:

```env
FLUXER_TOKEN=...        # bot token from your Fluxer application
FLUXER_CLIENT_ID=...    # application id
```

Both platforms: keep your existing `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` and add
the two lines above. With a self-hosted Fluxer instance also set `FLUXER_WEB_URL`
(see below).

Then start Sylo as usual (`npm start` or Docker). The log shows one line per
platform:

```
INFO  fluxer  Logged in as <bot name> - serving 1 guild(s)
INFO  bot     Logged in as <bot name> - serving 2 guild(s)
```

**One process per bot token.** A bot token can only be connected from one place at
a time. If you run Sylo on a server and also on your laptop with the same Fluxer
token, they will fight over the connection. Use a separate application (and token)
for local testing.

---

## Environment variables

| Variable                | Default                  | Description                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLUXER_TOKEN`          | n/a                      | Bot token from your Fluxer application. Setting it turns the Fluxer side on.                                                                                                                                                                        |
| `FLUXER_CLIENT_ID`      | n/a                      | Application id. **Required** when `FLUXER_TOKEN` is set.                                                                                                                                                                                            |
| `FLUXER_WEB_URL`        | hosted Fluxer            | The web app origin of the Fluxer instance, for example `https://chat.example.com`. Leave unset for hosted Fluxer. For a self-hosted instance Sylo reads the API, gateway and CDN addresses from `<FLUXER_WEB_URL>/.well-known/fluxer`.                |
| `FLUXER_API_URL`        | from `.well-known`       | Overrides only the API origin. You rarely need this.                                                                                                                                                                                                |
| `COMMAND_PREFIX`        | `!`                      | The chat prefix for commands on Fluxer (see [Using commands](#using-commands)). 1 to 5 characters, no spaces.                                                                                                                                       |
| `FLUXER_CLIENT_SECRET`  | n/a                      | The application's client secret. Setting it adds **Log in with Fluxer** to the dashboard.                                                                                                                                                           |
| `FLUXER_OWNER_IDS`      | n/a                      | Your Fluxer user id(s), comma or space separated. The Fluxer counterpart of `OWNER_IDS`: these accounts can open `/health` and the other bot-wide pages. `OWNER_IDS` holds Discord ids only, so an id on one platform never grants access on the other. |

Everything else in [self-hosting.md](self-hosting.md#environment-variables) (ports,
database, backups, `DASHBOARD_URL`, `SESSION_SECRET` and so on) is shared by both
platforms.

---

## Create the Fluxer application

On your Fluxer instance, create an application (the developer area of your user
settings) and open its **bot** page:

1. Create the bot and copy its **token** into `FLUXER_TOKEN`.
2. Copy the **application id** into `FLUXER_CLIENT_ID`.
3. For dashboard login, copy the **client secret** into `FLUXER_CLIENT_SECRET` and
   add the redirect URL described under [Dashboard login](#dashboard-login).

Treat the token and client secret like passwords. If either one ends up somewhere
public, reset it on the application page and update your `.env`.

---

## Add the bot to a server

Open this address, with your own values filled in, and choose the server:

```
<FLUXER_WEB_URL>/oauth2/authorize?client_id=<FLUXER_CLIENT_ID>&scope=bot&permissions=1100469103831
```

For hosted Fluxer the origin is `https://web.fluxer.app`. The
dashboard also builds this link for you: the server switcher has an **Add a
server** entry for each platform you have configured.

The permission value `1100469103831` is the set Sylo's modules use. It is made up of:

- **General:** View Channels, Manage Channels, Manage Webhooks, View Audit Log, Create Invite, Manage Nicknames, Manage Roles
- **Moderation:** Kick Members, Ban Members, Moderate Members (timeouts)
- **Text:** Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, Manage Messages
- **Voice:** Connect, Move Members

If you generate your own link, keep these. Two things to check afterwards:

- Drag Sylo's role **above the roles it should manage**, exactly as on Discord. The
  bot cannot kick, ban, time out or edit anyone whose highest role is above its own.
- The invite tracker reads the server's invite list. If it cannot, give the bot
  **Manage Server** as well.

---

## Dashboard login

By default the dashboard runs open, which is only safe on localhost or a trusted
network (see [Dashboard authentication](self-hosting.md#dashboard-authentication)).
To require a login on Fluxer:

1. Set `FLUXER_CLIENT_SECRET` (and `FLUXER_CLIENT_ID`).
2. In your Fluxer application, add the redirect URL
   `<DASHBOARD_URL>/auth/fluxer/callback`, for example
   `https://sylo.example.com/auth/fluxer/callback`, or
   `http://localhost:3000/auth/fluxer/callback` locally. It has to match
   `DASHBOARD_URL` exactly, including `https` behind a reverse proxy.
3. `SESSION_SECRET` is optional: Sylo keeps its own in `<data>/session-secret` unless you set one.
4. Put your own Fluxer user id in `FLUXER_OWNER_IDS`. Without it nobody can open
   `/health`.

You can enable Discord login, Fluxer login or both. With both configured, the
login page offers a choice.

**Who can manage a server.** On both platforms it is people who own the server or
have Administrator or Manage Server there, plus anyone with a "bot-master" role set
on the server's Settings page. A Fluxer server list does not always include
permissions; in that case Sylo asks the bot itself, from its own member cache, so
the bot has to be in the server.

### One account, two platforms

A dashboard account can hold one Discord identity and one Fluxer identity.

- Sign in with either platform. The first time, an account is created.
- To use both, sign in with one, open **Account** in the sidebar, and choose
  **Connect** for the other. From then on, signing in with either lands in the same
  account and shows the servers from both.
- **Disconnect** removes one identity (and its servers from the list) but never the
  last one. An identity already attached to a different account cannot be
  connected; the page tells you so.
- Sessions are stored on the server. The cookie only holds a session id, so the
  number of servers you manage no longer affects its size.

---

## Using commands

Fluxer has no slash commands yet, so Sylo's commands run from chat, using the same
command code as Discord:

```
!ping
@Sylo ping
```

Both forms work: the prefix (`!` by default, set with `COMMAND_PREFIX`) or a
mention of the bot. `!help` lists the commands, and a wrong argument answers with
the correct usage.

### Arguments

Arguments are read from the command's own definition, so each command takes what
its `/` version takes.

- **By position, in order:** `!timeout @user 10m being rude`
- **By name, in any order:** `!ban @user duration:7d reason:"repeat offender"`
- **Spaces need quotes:** `!poll "What should we play?" Chess|Go|Poker`
- **Free text.** The **last** text option takes the rest of the line, so a multi-word
  reason needs no quotes. An earlier text option takes one word. That is why
  `!ban @user 1m spam` reads `1m` as the reason; write `duration:1m` for a
  temporary ban: `!ban @user spam duration:1m`.
- **People, channels and roles** can be a mention or an id.

### Permissions

A command that needs a permission on Discord (for example Ban Members) needs the
same on Fluxer. Per-server command overrides from the dashboard apply as well.

### Custom commands

A custom command called `hello` is run with `!hello`. Anything after it fills
`{args}`:

```
!hello world        ->  "Hi ferdi! world"
```

Role limits, channel limits, cooldowns and all actions work as on Discord. Sylo
does not register anything with Fluxer for these.

---

## What works differently

| On Discord                          | On Fluxer                                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash commands                      | Chat commands with a prefix or a mention (above).                                                                                                                                                                                            |
| Buttons and select menus            | Shown as **reactions**, with a short legend in the message such as "React with ✅ to verify". Panels posted by modules (verification, giveaways, reaction roles) stay active; the reactions on a command's own reply expire after 15 minutes. |
| Private (ephemeral) replies         | Sent as a normal message that Sylo deletes after about 15 seconds, together with the command message.                                                                                                                                        |
| Native AutoMod rules                | Not available. Sylo's own automod scanner does the enforcement on Fluxer (word lists, invites, mentions, spam and so on). It also recognises Fluxer invite links.                                                                            |
| Threads and auto-threads            | Not available yet. Lock and lockdown skip the thread permissions.                                                                                                                                                                            |
| Moving members between voice        | Not usable from a bot. **Temporary voice channels** are still created, but the member gets a DM with a link to join, and a channel nobody joins within two minutes is removed.                                                              |
| Timestamps such as `<t:...:R>`      | Rendered in message text, but not in embed footers, titles or field names. Sylo shows a fixed UTC time (for example "Ends 12 Oct 2026, 19:55 UTC") there instead.                                                                            |
| `discord.gg` invite links           | The instance's own invite links (for hosted Fluxer `fluxer.gg/<code>`), in `!invites`, ban appeal rejoin links and the invite tracker.                                                                                                      |

Everything else is shared: moderation and cases, ban appeals and their dashboard
page, DM tickets (modmail), leveling, counting, sticky messages, giveaways, polls,
reminders, birthdays, server stats, RSS, Twitch, YouTube and Kick alerts, starboard,
welcome messages, reaction roles, custom commands and the rest.

Two things to know about modules that reach outside Fluxer:

- **Feeds and alerts** (RSS, Twitch, YouTube, Kick, GitHub) work the same way and
  post into a Fluxer channel. They use the same API keys as on Discord.
- Some feed hosts rate limit shared server addresses. Reddit in particular answers
  with `HTTP 429` now and then. That shows up in the error log, not as a bot fault.

---

## Server ids

Discord servers keep their plain numeric id everywhere (database rows, dashboard
URLs, API). Fluxer servers are written `fluxer:<id>`, for example
`/v2/guilds/fluxer:1554951170231894016`. You only meet this in dashboard
addresses, the API and the database. It is what keeps a Discord and a Fluxer server
with the same number apart.

---

## Upgrading an existing install

- **Nothing changes for Discord-only installs.** No new variables are needed, and
  existing data keeps its ids.
- **Everyone signs in once more.** Dashboard sessions moved from a cookie that held
  the whole login to a server-side session table, so existing logins end after the
  upgrade. After signing in again the account page appears in the sidebar.
- The database gets three new tables for accounts, linked identities and sessions.
  They are created on start-up, and the usual pre-migration backup runs first.
- `FLUXER_CLIENT_SECRET` is only needed for dashboard login; the bot itself needs
  just the token and the application id.

---

## Coming from Sylo-Fluxer

[Sylo-Fluxer](https://github.com/Ferdinand99/Sylo-Fluxer) was a separate fork of Sylo for
Fluxer. It is **archived**: Sylo 4.0 runs on Fluxer natively, so there is no second
codebase to keep up with and no separate releases.

- **Switch by running Sylo.** Set `FLUXER_TOKEN` and `FLUXER_CLIENT_ID` (and, for
  dashboard login, `FLUXER_CLIENT_SECRET`) as described above, and stop the old container.
  Only one process can use a bot token at a time, so do not run both.
- **Your data does not carry over automatically.** Sylo-Fluxer stored a server under its
  plain id; Sylo 4 stores a Fluxer server as `fluxer:<id>` (see [Server ids](#server-ids)),
  so the two databases are not interchangeable. Plan on setting the modules up again on
  the new install.
- **Commands and behaviour are the same shape.** Chat commands with a prefix, buttons as
  reactions and so on; the difference is that the same bot can also run on Discord.

---

## Troubleshooting

| Symptom                                               | Check                                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `fluxer  Logged in` line at start-up               | `FLUXER_TOKEN` and `FLUXER_CLIENT_ID` both set? Self-hosted instance: is `FLUXER_WEB_URL` reachable from the Sylo container, and does `<origin>/.well-known/fluxer` answer?                                      |
| The bot connects, commands do nothing                 | Use the prefix (`!ping`) or a mention (`@Sylo ping`), not `/`. If you changed `COMMAND_PREFIX`, use the new one. The bot needs permission to read and send messages in that channel.                            |
| "You don't have permission to use this command"       | The command needs the same permission as on Discord, or a per-server override blocks it. Check the dashboard's Commands page.                                                                                   |
| Login with Fluxer fails or loops                      | The redirect URL on the application must be exactly `<DASHBOARD_URL>/auth/fluxer/callback`. Behind a proxy set `DASHBOARD_URL` to the public https address.                                                     |
| Logged in, but my Fluxer server is missing            | You need to own the server, or have Administrator or Manage Server there, and the bot has to be in it. Sign out and in again to refresh the list (it is refreshed automatically about every 10 minutes).             |
| `Log in with Fluxer` button missing                   | `FLUXER_CLIENT_SECRET` (and `FLUXER_CLIENT_ID`) must both be set.                                                                                                                                               |
| `/health` says forbidden                              | Your id has to be in `FLUXER_OWNER_IDS` (Fluxer) or `OWNER_IDS` (Discord). The lists are separate on purpose.                                                                                                   |
| A temporary voice channel is created but I am not moved | Expected on Fluxer. Open the link in the DM from the bot.                                                                                                                                                       |
| `ERROR rss ... fetch failed` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The feed's own HTTPS certificate chain is incomplete. Browsers repair that, Node does not. Use another feed or ask the feed owner to fix it.                                                          |
| `ERROR rss ... HTTP 429`                              | The feed host is rate limiting your server's address. Try again later or use a different feed.                                                                                                                  |
| Two bots answer, or the connection keeps dropping     | Another process is using the same Fluxer token. Use a separate application for development.                                                                                                                     |
