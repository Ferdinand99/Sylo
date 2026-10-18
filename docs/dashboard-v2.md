# Dashboard V2 (Beta)

A rebuilt dashboard — a React single-page app instead of server-rendered EJS —
running side by side with the classic dashboard. Nothing about the classic
dashboard changes if you don't use it: V2 is opt-in, reuses the same login and
the same data, and every setting saved in one is visible in the other.

- [Trying it](#trying-it)
- [What's different from the classic dashboard](#whats-different-from-the-classic-dashboard)
- [Module coverage](#module-coverage)
- [Saving and unsaved changes](#saving-and-unsaved-changes)
- [Beta status](#beta-status)
- [Switching back](#switching-back)
- [For self-hosters](#for-self-hosters)

---

## Trying it

Click **Try the new dashboard** near the top of the classic dashboard's
sidebar, or go straight to `/v2` on your instance. It's gated behind the same
login as the rest of the dashboard — nothing extra to set up.

To make V2 your default, turn on **Open the new dashboard by default** under
**Dashboard** on V2's Account page. It's saved per account, so it follows you
to every browser: from then on, opening the dashboard's home page (`/`, which
is where signing in lands) takes you to `/v2`. It only applies when you're
signed in — a dashboard running without login always opens the classic one —
and only when the V2 build is present.

**Back to classic dashboard** in V2's top bar still works with the switch on:
it keeps you on the classic dashboard for the rest of that browser session.
Opening `/v2` again (for example via **Try the new dashboard**) ends that, so
the next visit to `/` goes back to V2.

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
messages, insights, the leaderboard, Health and the Bot Personalizer. The
server tools are there too, under **Settings → Server data**: the audit log,
config export (the same JSON file as the classic download) and member data
(look up and forget a member; moderation cases and other safety records are
kept, as in the classic dashboard). Everything you save in V2 is the same
setting the classic dashboard shows.

## Saving and unsaved changes

A settings page shows a bar at the bottom as soon as something differs from
what is saved: **Reset** puts the page back, **Save** (or Ctrl/Cmd+S) saves it.
Leaving the page, switching server or closing the tab with unsaved changes asks
first. Actions that can't be undone, like wiping all levels or restoring a
database backup, ask for confirmation and some ask you to type a word or name.

## Beta status

V2 is new — expect rough edges. The
"Beta" badge next to the Sylo logo in V2's top bar is a reminder, not a
warning to avoid it: everything that has shipped has the same real
functionality (and the same save behavior and side effects) as its classic
counterpart, just a different page to get there. Found a bug, or something
that works in the classic dashboard but not in V2? Report it same as any
other issue.

## Switching back

**Back to classic dashboard** sits in V2's top bar and returns you to the
classic dashboard at any time (for the rest of the session, even if V2 is your
default — see [Trying it](#trying-it)). Nothing about your settings depends on
which dashboard you use.

## For self-hosters

No extra configuration — `docker compose up -d --build` (or the published
image) includes V2's build automatically. If you're running Sylo directly
with `npm start` instead of Docker, run `npm run build:v2` once (it needs
dev dependencies installed — plain `npm install`, not `npm ci --omit=dev`)
before the dashboard serves `/v2`; without a build, `/v2` responds with a
plain-text explanation instead of a 500.
