# The new dashboard (V2)

A rebuilt dashboard — a React single-page app instead of server-rendered EJS.
It is the default dashboard now: the home page, and the old dashboard addresses
(for example the ticket links Sylo posts in Discord), open it. It reuses the
same login and the same data as the classic dashboard, and every setting saved
in one is visible in the other. The classic dashboard stays one more release
and is removed in Sylo 5.0.

- [Trying it](#trying-it)
- [What's different from the classic dashboard](#whats-different-from-the-classic-dashboard)
- [Module coverage](#module-coverage)
- [Saving and unsaved changes](#saving-and-unsaved-changes)
- [Status](#status)
- [Switching back](#switching-back)
- [For self-hosters](#for-self-hosters)

---

## Trying it

Open your instance as usual: `/` takes you to `/v2`, also when the dashboard
runs without login. The old dashboard addresses (`/account`, `/health`,
`/guilds/<server>/tickets/5`, `/guilds/<server>/m/<module>` and so on) open the
matching page in V2. It's gated behind the same login as the rest of the
dashboard — nothing extra to set up. Without a V2 build (see
[For self-hosters](#for-self-hosters)) the classic dashboard answers instead.

**Back to classic dashboard** in V2's top bar opens `/?classic=1`, which keeps
you on the classic dashboard until you open `/v2` again (the banner on the
classic dashboard's pages links to it). Only the home page honours
`?classic=1`; the choice lives in the session cookie when the dashboard has a
login, and in a small cookie of its own when it runs without one. The old "Open the new
dashboard by default" switch on the Account page is gone; a saved choice from
it is ignored.

## What's different from the classic dashboard

- **Sidebar shows only what's turned on.** Instead of listing all ~33 modules
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

Everything else — what each module does, what its settings mean — works the
same as the classic dashboard; see [`docs/modules/`](modules/README.md) for
the module reference itself.

## Module coverage

Every module has its own V2 settings page, and so do the staff pages (tickets,
ban appeals, the moderation hub with commands, automod and logging), embed
messages, insights, the leaderboard, Health, Stats and the Bot Personalizer. The
server tools are there too, under **Settings → Server data**: the audit log,
config export (the same JSON file as the classic download) and member data
(look up and forget a member; moderation cases and other safety records are
kept, as in the classic dashboard). Everything you save in V2 is the same
setting the classic dashboard shows.

Two pages are public, with no login: the command list (`/v2/commands`) and the
roadmap (`/v2/roadmap`). They show what the classic public pages show; voting
and suggesting a feature still need a login, and the log-in link on them brings
you back to the page.

## Saving and unsaved changes

A settings page shows a bar at the bottom as soon as something differs from
what is saved: **Reset** puts the page back, **Save** (or Ctrl/Cmd+S) saves it.
Leaving the page, switching server or closing the tab with unsaved changes asks
first. Actions that can't be undone, like wiping all levels or restoring a
database backup, ask for confirmation and some ask you to type a word or name.

## Status

Everything that has shipped has the same real functionality (and the same save
behavior and side effects) as its classic counterpart, just a different page
to get there. Found a bug, or something that works in the classic dashboard but
not in V2? Report it same as any other issue.

## Switching back

**Back to classic dashboard** sits in V2's top bar and returns you to the
classic dashboard (`/?classic=1`) until you open `/v2` again. It goes away
with the classic dashboard in Sylo 5.0. Nothing about your settings depends on
which dashboard you use.

## For self-hosters

No extra configuration — `docker compose up -d --build` (or the published
image) includes V2's build automatically. If you're running Sylo directly
with `npm start` instead of Docker, run `npm run build:v2` once (it needs
dev dependencies installed — plain `npm install`, not `npm ci --omit=dev`)
before the dashboard serves `/v2`; without a build, `/v2` responds with a
plain-text explanation instead of a 500.
