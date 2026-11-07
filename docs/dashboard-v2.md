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

- **Sidebar shows only what's turned on.** Instead of listing all 40 modules
  with an on/off dot, the sidebar lists just the modules enabled for whichever
  server you're looking at, grouped the same way the Dashboard/Overview page
  groups them. Turn a module on from Overview and it appears in the sidebar
  immediately — no reload needed.
- **Server switcher lives in the top bar**, not the sidebar — it's picking
  which server the whole app is scoped to, not a page within one.
- **A server selection follows you** onto bot-wide pages (Bot Personalizer,
  Health) that aren't scoped to any one server, instead of clearing when you
  navigate there.
- **Mobile gets a real off-canvas menu** (hamburger button, slide-in sidebar)
  below ~860px, rather than the sidebar just disappearing.

See [`docs/modules/`](modules/README.md) for the module reference itself: what
each module does and what its settings mean.

## Module coverage

Every module has its own V2 settings page, and so do the staff pages (tickets,
ban appeals, the moderation hub with commands, automod and logging), embed
messages, insights, the leaderboard, Health, Stats and the Bot Personalizer. The
server tools are there too, under **Settings → Server data**: the audit log,
config export (a JSON file) and member data (look up and forget a member;
moderation cases and other safety records are kept).

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
