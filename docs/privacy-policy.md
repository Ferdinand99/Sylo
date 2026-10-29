# Privacy Policy — Sylo

**Effective date:** 2 September 2026
**Last updated:** 24 October 2026

This Privacy Policy explains what data the **Sylo** Discord application and its
test instance **Sylo - Test** (the "Bot"), the Sylo web dashboard (the
"Dashboard") and the websites **sylobot.com** and **docs.sylobot.com** (the
"Website") collect and how it is used. The instances covered by this policy
are operated by **Ferdinand99** (<https://github.com/Ferdinand99>) (the
"Operator"), who is the data controller for them. Sylo is open-source (MIT);
self-hosted instances are run by their own operators — see section 10.

The Operator does **not** sell your data, does **not** show advertising, and does
**not** use third-party analytics or tracking. The Website counts visits without
cookies on a statistics service the Operator runs (section 3a).

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

- **Infractions / case log** — for each moderation action (warn, note, timeout,
  kick, ban, unban): the affected member ID, moderator ID (or "dashboard"), the
  action, a reason, a timestamp and a per-server case number. `/case delete`
  marks a case inactive but keeps the row for audit.
- **Ban appeals** — the banned member's ID and tag, the ban reason, the member's
  free-text answers to the server's appeal questions, and the staff decision and
  reason.
- **Config audit log** — the display name of whoever changed a setting from the
  Dashboard, what changed, and when.

### Member activity

- **Leveling** — per-member XP, level, message count, voice minutes and
  last-active time, plus per-week and per-month XP rows for the periodic
  leaderboards.
- **Invite tracking** — per-member invite tallies and a record of who invited
  each joiner (an attribution graph), plus any personal invite code Sylo minted
  for a member.
- **Counting** — the ID of whoever counted last.
- **AFK** — a member's away status, away message and previous nickname.
- **Birthdays** — the day and month (and optionally year) a member registers.
- **Giveaways** — the host, the entrants, and the drawn winners.
- **Events** — the host and, for each event, who pressed Join or Maybe.
- **Suggestions** — the text of each suggestion, who wrote it (unless they erase it), the staff member who decided it, and each member's 👍 / 👎 vote.
- **Temporary roles** — which member holds which temporary role, when it ends, the reason, and the staff member who set it.
- **Quote board** — the text of each saved message (up to 2000 characters), its author's id and display name as they were when it was saved, the channel and message ids, the message date, how many attachments it had (the files are not kept), and who saved it. A server can switch on a public page that shows the text, display name and date of the quotes saved from channels everyone can read, without ids.
- **Polls** — the poll creator. Votes are Discord reactions and are not stored;
  the row is deleted when the poll ends.
- **Temporary voice channels** — the owner of a spawned channel and its
  per-channel ban list. The row is deleted when the channel empties.

### Conversation content

- **Modmail ticket transcripts** — the text and attachment URLs of ticket
  messages, from both the member and staff (see section 1).

### Notifier bookkeeping *(no personal data)*

"Have we already announced this" markers for free-game offers, Twitch / Kick
streams, YouTube videos/livestreams and RSS/social feed items, and the message
IDs of alert and starboard posts.

### Game-stat cache

The game title, player name and platform you look up with `/stats`, and the
statistics returned by the upstream provider, with a timestamp. Entries expire
automatically (default: 5 minutes).

## 3. Data the Dashboard processes

The Dashboard can run with or without login.

- **Open mode (no login):** the Dashboard collects no personal data of its own
  beyond ordinary server request logs (section 5). It sets no cookies.
- **Dashboard login enabled:** when you choose "Log in with Discord" or "Log in
  with Fluxer", the Operator receives, via that platform's OAuth2 (`identify` and
  `guilds` scopes), your user ID, username, avatar, and the list of servers you
  are in together with your permission level in each. This is used only to show
  your name in the Dashboard and to check that you administer a given server.
  The Dashboard keeps a **dashboard account** in its database: for each platform
  you signed in with, your user ID, username, avatar, the IDs of the servers you
  administer (not every server you are in), and when that list was last
  refreshed. Connecting a second platform adds it to the same account. Each
  login also creates a **session record** in the database (a random session ID,
  the account it belongs to, when it was created and when it expires). Your
  browser holds **one signed session cookie** (`httpOnly`, `SameSite=Lax`) with
  that session ID and short-lived sign-in state (a CSRF token, the login's
  `state` value, the page to return to, the server you last viewed, and an app
  sign-in in progress). No analytics or tracking cookies are used. The access
  token obtained during login is used once to read the above and is not stored.
- **Sylo app sign-in:** if you sign in to the Sylo app, you use the same login
  in a browser window, and the Dashboard then stores one record per signed-in
  device in its database: the account it belongs to, the device name the app
  sends (for example "iPhone"), when the sign-in was created and last used, and
  when it expires. The access token the app uses is stored **only as a hash**,
  never in readable form. During sign-in, a one-time code (also stored only as a
  hash) is valid for 60 seconds. Your account page lists your signed-in devices
  and lets you revoke them.
- **Sylo app notifications:** if you turn on notifications in the app, the
  device's record also holds its Apple push token (or, on a self-hosted
  instance, a relay token that stands for it), whether it is a development or
  production build, and the servers you muted. When a member writes in a
  ticket on a server whose tickets you may see, the notification (the server's
  name, the member's name and the first 180 characters of the message) is sent
  to Apple, which delivers it to your device.
- **Error reports and visit counts (the hosted Sylo):** the Dashboard's pages
  send errors that happen in your browser to Keen Kestrel, which the Operator
  runs (section 3a). A report holds the error and where in the Dashboard's code
  it happened, the page's address (which can contain a server or channel ID),
  the Dashboard addresses and page elements used just before it, your browser
  and operating system, and the Dashboard version. It holds no name, user ID,
  IP address or cookie. Page views are counted the same way as on the Website
  (section 3a). Self-hosted instances send none of this unless their operator
  sets it up.

## 3a. Visits to the Website

The Website counts visits with **Keen Kestrel**, an open-source statistics
service the Operator runs on its own server (`kestrel.hedgerow.tools`); no third
party receives this data. It sets no cookies and stores nothing on your device.
For each page view it keeps:

- the page (host and path; the query string is dropped except `utm_*` campaign
  tags);
- the referring site's domain, if any;
- the browser, operating system and device type (names only, read from the user
  agent, which itself is not kept) and a screen-size range;
- the time;
- a visitor ID: a hash of a random daily value, your IP address and your user
  agent. The daily value is kept only in memory and replaced every day, so the
  ID cannot be turned back into an address and the same browser gets an
  unrelated ID the next day.

IP addresses and user agents are not stored. If your browser sends
**Global Privacy Control**, nothing is recorded.

## 4. Legal basis for processing

Where the Operator processes personal data of people in the EEA or the UK, it
relies on **legitimate interests** (Article 6(1)(f) GDPR / UK GDPR) as the legal
basis, as set out below. In every case the processing is limited to Discord IDs
and feature-specific counters or records; message content is not stored except
for modmail transcripts (section 1).

| Purpose | Legitimate interest relied on |
| --- | --- |
| Running the modules a server enables (leveling, AFK, birthdays, counting, invite tracking, temporary voice channels, giveaways, polls, starboard, server statistics/insights) | Operating the features a server's administrators have turned on and its members choose to use |
| Moderation & safety records (infractions/case log, ban appeals, auto-moderation, config audit log) | The interest of the server and its members in keeping the community safe and keeping an auditable record of moderation decisions |
| Modmail ticket transcripts | Handling, and being able to review, the contact/support requests a member starts |
| Dashboard login (Discord or Fluxer OAuth2 identity, the servers you administer, session records) | Authenticating server administrators; taken only when you choose "Log in with Discord" or "Log in with Fluxer" |
| Sylo app sign-in (device name, sign-in times, hashed token) | Keeping you signed in on a device you chose to sign in on, and letting you see and revoke those devices |
| Sylo app notifications (push or relay token, muted servers, notification text) | Telling staff about new ticket messages, which they turned on in the app |
| Operational logs | Security, abuse prevention and debugging |
| Website visit statistics (section 3a) | Knowing how the Website is found and used, without cookies and without keeping IP addresses |
| Dashboard error reports and visit counts (section 3) | Finding and fixing faults in the Dashboard, and knowing which parts are used |
| Game-stat cache | Serving `/stats` responses quickly without repeatedly querying the upstream provider |

The Operator has weighed these interests against your rights: only identifiers
and minimal per-feature data are processed, nothing is sold or profiled, you can
get a copy of your data at any time with `/mydata` and erase it with `/forget`
(section 7). You can also **object** to processing based on legitimate interests,
and request **access**, **correction** or **erasure**, by contacting the Operator
(section 9). On an objection or erasure request the data is deleted, except the
minimum a server needs to keep to enforce an active ban or defend a moderation
decision.

Self-hosted instances must determine their own legal basis (section 10).

## 5. Logs

The service writes operational logs (startup messages, errors, and the fact that
a command or dashboard action occurred, which may include Discord IDs). These
are used for debugging and abuse prevention and are kept only as long as
operationally useful.

On the hosted Sylo, every error the service logs is also sent as an error
report to Keen Kestrel, which the Operator runs (section 3a): the error, where
in Sylo's code it happened, the log message (which may include a Discord ID)
and the Sylo version. Secrets such as tokens are removed first. Self-hosted
instances send none of this unless their operator sets it up.

## 6. Third parties

- **Discord** — the Bot and Dashboard operate on Discord's platform; your use is
  also governed by [Discord's Privacy Policy](https://discord.com/privacy).
- **Game-stats providers** — when you request player statistics, the player name
  and platform you supply are sent to the relevant public API
  (`api.gametools.network` for Battlefield, Jagex Hiscores for RuneScape) to
  retrieve the stats. Only data you explicitly put in a `/stats` command is sent.
- **Cloudflare Turnstile** — if a server enables captcha verification, the
  verification page loads Turnstile from Cloudflare and sends the challenge
  response to Cloudflare for validation. No account data is shared.
- **Off-site backup destination** — if the Operator has configured off-site
  backups (section 7), the encrypted-in-transit database snapshot is sent to that
  destination (a WebDAV server and/or a Discord webhook), which the Operator
  controls.
- **Apple Push Notification service** — if you turn on notifications in the Sylo
  app, each notification's text (server name, member name, message preview) and
  your device's push token are sent to Apple to deliver it, under
  [Apple's Privacy Policy](https://www.apple.com/legal/privacy/).
- **The hosted Sylo as a notification relay** — a self-hosted instance cannot
  talk to Apple for the Sylo app itself, so it sends each notification through
  the hosted Sylo (`app.sylobot.com`), which passes it on to Apple and keeps no
  copy of its text. The relay stores only the device's push token, a hashed
  relay token, which instance registered it and when it was last used. An
  Operator can turn this off (`PUSH_RELAY_URL` empty), which turns off
  notifications for that instance.

No other third parties receive your data.

## 7. Retention and deletion

- **`/mydata`** — any member can run `/mydata` in a server to receive, by direct
  message, a JSON file of everything Sylo has stored about their Discord account
  in that server (the same scope as `/forget`, below). Nothing is deleted. Rate
  limited to one export per member per server every few minutes.
- **`/forget`** — any member can run `/forget confirm:True` in a server to delete
  the data Sylo keys to their Discord account **in that server**: leveling XP
  (including period rows), ticket history (the whole conversation, staff replies
  included), ban appeals, invite records, AFK status, birthday, giveaway
  entries, event sign-ups, suggestion votes and temporary-role records (a suggestion you wrote stays on the server's board, without your name; a temporary role you hold stays on you, but Sylo no longer takes it back). It does **not** remove messages already posted to channels, a
  completed giveaway's winner list, or the display name recorded in that server's
  config audit log. **Safety records are kept**: moderation cases (warnings,
  notes, timeouts, kicks, bans), an active temporary ban, honeypot catches and a
  counting penalty. They protect the server and its members (section 4), so a
  member cannot erase their own record; the server's staff can remove a case, and
  you can ask the Operator (section 9). `/mydata` includes them.
- **Admin-assisted erasure** — a server's administrators can look up and delete a
  specific member's data from the Dashboard's **Member data** page (same scope as
  `/forget`). When they do, Sylo sends that member a direct message confirming
  what was removed.
- **Removing the Bot from a server** immediately stops processing and
  **automatically deletes every stored row for that server** (all of section 2).
- **Game-stat cache** entries expire automatically and hold only public game
  data.
- **Ephemeral rows** — ended polls and emptied temporary-voice-channel records —
  are deleted automatically.
- **Dashboard sessions** are deleted when you log out, and expire after 7 days;
  expired session records are removed automatically a few times a day.
- **Dashboard account:** a platform you connected is removed from your account
  when you disconnect it on the account page (the last one cannot be
  disconnected). **Delete account** on the account page (or in the Sylo app)
  deletes the whole account at once: its sign-ins, every web session and app
  device, dashboard preferences and roadmap votes; your roadmap suggestions stay,
  without your name. Data kept per server is removed with `/forget` there.
- **Sylo app sign-ins** are deleted when you sign out in the app, revoke the
  device under **Signed-in devices** on the Dashboard's account page, or
  disconnect a sign-in (Discord or Fluxer) from your account, which removes all
  of the account's app sign-ins. A sign-in not used for 90 days expires and is
  deleted automatically. One-time sign-in codes are deleted when used; an unused
  one stops working after 60 seconds and is deleted automatically.
- **Notification settings** (push or relay token, muted servers) are part of the
  app sign-in and go with it; turning notifications off in the app removes the
  token at once, and signing out or revoking the device removes it with the
  sign-in. Relay registrations at the hosted Sylo are removed when the app turns
  notifications off, when Apple reports the device gone, or after 90 days
  without use (after a sign-out the instance no longer has the relay token, so
  that registration can't be used and simply expires).

For any request the above does not cover, contact the Operator (section 9).

### Retention schedule

| Data | Retained for | Deleted when |
| --- | --- | --- |
| Server configuration & module settings | As long as the Bot is in the server | Bot removed from the server; or the setting is changed or cleared |
| Infractions / moderation case log | Indefinitely, as a moderation record | Staff remove the case; Bot removed. Not by `/forget` or admin-assisted erasure (a safety record). Inactive cases (`/case delete`, expired temp-bans) are kept for audit unless the server sets a "delete inactive cases after N days" limit |
| Ban appeals | Indefinitely | `/forget`; admin-assisted erasure; Bot removed |
| Config audit log | Indefinitely | Bot removed from the server (not covered by `/forget` — it records only a display name) |
| Leveling XP, level, message/voice counters | Until erased | `/forget`; admin-assisted erasure; Bot removed; leaderboard reset by an admin |
| Weekly / monthly leveling period rows | ~10 weeks / ~6 months | Automatic pruning, or any of the leveling triggers above |
| Invite tracking (tallies + attribution graph) | Until erased | `/forget`; admin-assisted erasure; Bot removed |
| AFK status | Until the member returns or is erased | Member sends a message; `/forget`; Bot removed |
| Birthdays | Until removed | Member or admin removes it; `/forget`; Bot removed |
| Giveaway entries | Until the giveaway ends, then until erased | `/forget` (entries only — a finished giveaway's winner list is kept); Bot removed |
| Event sign-ups (Join / Maybe) | Until the member leaves the event or is erased | The member presses Leave; `/forget`; Bot removed (`/forget` also removes you as the host of events you made; the title of a finished event is a server record and stays until the Bot is removed) |
| Suggestions and votes | The suggestion until staff delete it; a vote until the member takes it back | `/forget` (votes are deleted; your suggestions stay without your id; staff decisions lose the staff id); staff delete a suggestion on the dashboard; Bot removed |
| Temporary role records | Until the role's end time, or until staff remove it | The record is deleted when the role is taken back; `/forget` (the record is deleted, the role itself stays); Bot removed |
| Quote board quotes | Until a member or staff remove the quote, or the server removes the module's data | `/quote remove` (author, the member who saved it, or staff); `/forget` (quotes you wrote are deleted; quotes you only saved lose your id); staff remove a quote on the dashboard; Bot removed |
| Poll creator record | Until the poll ends | Poll ends (row deleted automatically) |
| Temporary voice channel owner + ban list | Until the channel empties | Channel empties (row deleted automatically); Bot removed |
| Modmail ticket transcripts | Until erased, or the server's "delete closed tickets after N days" limit (off by default) | `/forget`; admin-assisted erasure; Bot removed; a closed ticket ageing past the server's limit |
| Notifier bookkeeping *(no personal data)* | Rolling | Automatic pruning; Bot removed |
| Game-stat cache | 5 minutes (configurable) for answers; lookups are deleted after 30 days | TTL expiry; daily sweep |
| Dashboard account (per platform: user ID, username, avatar, servers you administer) | Until removed | Disconnecting that platform, or **Delete account**, on the account page or in the Sylo app; on request to the Operator |
| Dashboard session (session record + browser cookie) | 7 days | Logout or expiry (expired records are removed automatically) |
| Sylo app sign-in (device record, hashed token) | 90 days from the last use | Sign out in the app; revoke on the account page; a sign-in disconnected from the account; 90 days without use |
| One-time app sign-in code (hashed) | 60 seconds | Used, or expired and deleted automatically |
| Notification relay registration (push token, hashed relay token, instance) | 90 days from the last use | Notifications turned off in the app; Apple reports the device gone; 90 days without use |
| Website visit statistics (section 3a) | Page views 30 days; hourly and daily totals 400 days | Deleted automatically |
| Dashboard and bot error reports | 30 days; a grouped error's summary until 90 days after it last happened | Deleted automatically |
| Operational logs | As long as operationally useful | Rotated or discarded by the Operator |

**Backups.** The database is snapshotted automatically for recovery; the newest
few snapshots are kept (7 by default) and older ones are overwritten. If the
Operator has enabled off-site backup, a copy of each snapshot is also sent to a
WebDAV server and/or a Discord webhook the Operator controls. A snapshot taken
before an erasure still contains the removed rows until it rotates out.

## 8. Security

Data is stored on the Operator's self-hosted infrastructure. The database file is
not publicly exposed, and automatic snapshots are kept for recovery. The
Dashboard is run behind authentication or on a trusted network. No method of
storage or transmission is completely secure, and the Operator cannot guarantee
absolute security.

## 9. Contact

Privacy questions or requests to access, correct, erase or object to processing
of your data: open an issue at <https://github.com/Ferdinand99/Sylo/issues>, or
contact the Operator privately via their GitHub profile if the request contains
sensitive information. For suspected security vulnerabilities, please use
GitHub's private vulnerability reporting on the repository rather than a public
issue.

## 10. Self-hosted instances

Anyone may run their own copy of Sylo. If you operate a self-hosted instance,
**you** are the data controller for it, you must determine your own legal basis
for the data it stores, and this policy does not apply to your users — publish
your own. Sylo gives you the same tools: `/forget` for per-member erasure and
automatic full deletion of a server's data when the Bot is removed from it.
Consider your own legal obligations for the data your instance stores.

## 11. Changes

This policy may be updated; the "Last updated" date will change and the revised
version will be published at the same URL.

- **17 October 2026** — added Sylo app notifications: what is stored for them
  (section 3), Apple and the hosted relay as recipients (section 6), and when
  they are deleted (section 7).
- **17 October 2026** — added the Sylo app sign-in: what it stores about each
  signed-in device (section 3), its legal basis (section 4), and when it is
  deleted (section 7). Corrected the Dashboard login description: since Sylo 4.0
  it covers Fluxer as well as Discord, and the dashboard account and session
  records are stored in the database (the cookie holds only a session ID and
  short-lived sign-in state); added both to the retention schedule.
- **4 September 2026** — added a legal-basis section (section 4) and a retention
  schedule (section 7); documented off-site backup retention; refreshed the data
  inventory (case log, voice XP, birthdays, RSS/social notifier markers); added
  the `/mydata` self-service export (section 7); noted the optional per-server
  auto-deletion of old closed tickets and inactive cases.
- **2 September 2026** — corrected the message-content section and expanded the
  data inventory to match the current feature set.
