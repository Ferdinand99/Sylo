# The dashboard (V2)

Sylo's dashboard is a React single-page app. Since Sylo 5.0 it is the only
dashboard: the home page opens it, and the old dashboard addresses (for example
the ticket links Sylo posted in Discord before 5.0) redirect to the matching
page in it. It uses the same login and the same data as always, so nothing you
saved earlier is lost.

- [Opening it](#opening-it)
- [What the dashboard shows](#what-the-dashboard-shows)
- [Module coverage](#module-coverage)
- [Saving and unsaved changes](#saving-and-unsaved-changes)
- [For self-hosters](#for-self-hosters)

---

## Opening it

Open your instance as usual: `/` takes you to `/v2`, also when the dashboard
runs without login. The old dashboard addresses (`/account`, `/health`,
`/guilds/<server>/tickets/5`, `/guilds/<server>/m/<module>` and so on) open the
matching page in V2, so bookmarks and old Discord links keep working. It's gated
behind the login of the instance. Without a V2 build (see
[For self-hosters](#for-self-hosters)) `/v2` answers with a short plain-text
note.

## What the dashboard shows

- **Sidebar shows only what's turned on.** Instead of listing all 43 modules
  with an on/off dot, the sidebar lists just the modules enabled for whichever
  server you're looking at, grouped the same way the Dashboard/Overview page
  groups them. Turn a module on from Overview and it appears in the sidebar
  immediately — no reload needed.
- **Server switcher lives in the top bar**, not the sidebar — it's picking
  which server the whole app is scoped to, not a page within one.
- **A server selection follows you** onto bot-wide pages (Bot Personalizer,
  Health) that aren't scoped to any one server, instead of clearing when you
  navigate there.
- **A setup wizard for new servers.** A server with fewer than three modules
  set up gets a "Set up Sylo" card on its Overview; the wizard can also be run
  again any time from **Settings → Server data → Setup wizard**. Sylo looks at
  the server's channels and roles, you pick goals (welcome, verification,
  moderation and logging, tickets, community), and Sylo proposes the channels
  and roles by name (`welcome`, `rules`, `mod-log`, `logs`, `tickets`,
  `support` …). You review it, then apply. A channel or role is only created
  when you tick **Create** for it, and only if Sylo has Manage Channels or
  Manage Roles. Channels for logs and ticket alerts are made private (visible to
  admins, Sylo and the staff role you pick); the others are read-only for
  members and keep the server's own rules for who can see them. A channel with
  the wanted name that already exists is used only if it is what the wizard
  promises, and its permissions change only when you tick it. A module that is
  already set up is left alone unless you tick it. Each module is saved like its
  own settings page saves it and gets its own audit entry, and so does every
  channel or role the wizard makes. It works the same way on Fluxer.
- **Mobile gets a real off-canvas menu** (hamburger button, slide-in sidebar)
  below ~860px, rather than the sidebar just disappearing.

See [`docs/modules/`](modules/README.md) for the module reference itself: what
each module does and what its settings mean.

## Module coverage

Every module has its own V2 settings page, and so do the staff pages (tickets,
ban appeals, the moderation hub with commands, automod and logging), embed
messages, insights, the leaderboard, Health, Stats and the Bot Personalizer. The
server tools are there too, under **Settings → Server data**: the audit log,
config export and import (a JSON file) and member data (look up and forget a
member; moderation cases and other safety records are kept).

**Import configuration** reads a file made by the export, from this or another
server. It shows what each module would change, you tick what to import, and
you type `IMPORT` to confirm. Every module goes through the same checks as
saving its own page, so a role you may not hand out is refused. Channels, roles
and custom emoji that this server does not have are cleared (with a warning),
and the ids of messages the other server posted are never carried over.
Reminders, reaction-role sets and custom commands are in the file but are not
imported yet; embed messages, the shop and member data are not in the file at
all. A step that posts a message (verification, honeypot) or updates AutoMod is
named in the preview before you confirm. Each import is written to the audit
log.

## Public pages

Server settings → **Public pages** (Edit access only) gives the pages your members open without the dashboard their
own look: the application form (and the web shop), the ban appeal, the quote page and the two leaderboards. Two
things change and nothing else: the **accent colour** (buttons, links and highlights) and a **background**. The
background is none, a picture you upload (PNG, JPEG or WebP, at most 2 MB; Sylo stores a re-encoded copy without
metadata, at most 1920 pixels wide, and serves it itself), or the server's **invite background** on Discord or
Fluxer: Sylo downloads it once, keeps its own copy, checks it once a day and serves it itself, so a visitor's
browser never talks to Discord or Fluxer. The settings show a live preview of the application form page. The section
is saved with the Settings page's own Save bar, so leaving the page with unsaved changes here asks first, like any other
form. On a phone the page keeps a margin around its panel so the picture shows on every side.

What stays Sylo's: the layout, the type, the components, the light and dark themes, the readability and the small
"Powered by Sylo" link (to sylobot.com) at the bottom of every public page, which cannot be turned off. The page always
sits on a semi-opaque card over a dim overlay (a light veil in the light theme, and an all but opaque panel, so Sylo's
own text stays readable on any picture; fully opaque for visitors who ask for reduced transparency). The accent is held
to 3:1 against the card for fills, borders and focus rings: below that it is not used in that theme (the light or the
dark one), Sylo's own colour stays there, and the settings say so. Where the accent is used as text (links, the active
pill, top ranks) the pages use a text colour made from it: the accent itself when it reaches 4.5:1 on the card and the
page, otherwise the same hue lightened (dark theme) or darkened (light theme) until it does. The text on a button
fill is black or white, whichever reads better, also when hovered. The dashboard and the Sylo app are never restyled.
The event pages take no server look, because they carry no server address on purpose. The file addresses are
`/look/<server>.<hash>.css` and `.webp`; the style sheet is kept by caches for a year (its address is its content),
a picture for a day. The content security policy is unchanged (styles and images from Sylo only).

## Duplicate and templates

The "⋯" menu of a reminder, an embed message, a reaction-role set, a custom
command and a shop item has **Duplicate**. The copy never starts on its own: a
reminder and a shop item are paused, an embed message and a reaction-role set
are drafts (nothing is posted), and a custom command gets a free name ending in
`-copy`. A copy counts against the same limits as creating one.

**Start from a template** (the message builder, Welcome, the Welcome channel and
the alert messages) offers a small gallery: Rules, Welcome card, Announcement,
Stream live, Giveaway and Event. A template only fills in the form; nothing is
saved until you save. The message builder and the Welcome channel also have
**Message JSON**: the message as Discord message JSON (the shape Discohook uses)
to copy or download, and a box to paste or load JSON back in. JSON that is over
the limits is refused with the reason; what cannot be carried over (buttons that
need a bot, timestamps) is listed.

### Change history and undo

Every save of a module's settings or of the server settings made from the
dashboard keeps what it changed in its audit log entry: the settings that
differ, with the value before and after. This includes the leaderboard switch
and any page that saves settings through the same write. Lists that live in
tables of their own (reminders, shop items) are not module settings and keep no
copy. Open an entry in the audit log with **Show changes** to see the changed
fields only, with a readable name where one is known. API keys, tokens,
passwords, webhook links and links that carry a key are masked and never stored
in clear. The log keeps the newest 500 entries per server, saved changes
included; one copy is at most about 32 KB, all the copies of a server together
about 5 MB (the oldest copies go first, the entries stay), and they go with the
server when Sylo is removed from it.

**Undo this change** puts the earlier values of that module back. It goes
through the module's normal save (the same limits and checks as its form,
including the rule that you cannot hand out a role above your own) and writes an
entry of its own, so an undo can be undone too. If the settings were changed
again since the entry, the page says which ones and asks before they are lost
(the yes is for what the page showed: if the settings change again meanwhile,
you are asked again). A masked secret is never restored: the value that is saved
now stays, and a secret with nothing to be taken from is left out and reported.
Settings that Sylo manages itself (the id of a message it posted) and the
auto-role switch of Welcome, which goes together with the Roles page, are left
as they are, and an entry with only such settings has no undo. Server settings
are checked as the settings form checks them, all before the first is written.
Undo covers a module's settings and the server settings; lists kept on their own
(reminders, shop items, custom commands, saved messages) are not restored, and a
few modules whose save does more than store settings show the difference
without an undo.

Two pages are public, with no login: the command list (`/v2/commands`) and the
roadmap (`/v2/roadmap`). They show the same lists as before; voting
and suggesting a feature still need a login, and the log-in link on them brings
you back to the page.

## Saving and unsaved changes

A settings page shows a bar at the bottom as soon as something differs from
what is saved: **Reset** puts the page back, **Save** (or Ctrl/Cmd+S) saves it.
Leaving the page, switching server or closing the tab with unsaved changes asks
first. Actions that can't be undone, like wiping all levels or restoring a
database backup, ask for confirmation and some ask you to type a word or name.

## For self-hosters

No extra configuration — `docker compose up -d --build` (or the published
image) includes the dashboard build automatically. If you're running Sylo directly
with `npm start` instead of Docker, run `npm run build:v2` once (it needs
dev dependencies installed — plain `npm install`, not `npm ci --omit=dev`)
before the dashboard serves `/v2`; without a build, `/v2` responds with a
plain-text explanation instead of a 500.
