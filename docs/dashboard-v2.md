# Dashboard V2 (Beta)

A rebuilt dashboard — a React single-page app instead of server-rendered EJS —
running side by side with the classic dashboard. Nothing about the classic
dashboard changes if you don't use it: V2 is opt-in, reuses the same login and
the same data, and every setting saved in one is visible in the other.

- [Trying it](#trying-it)
- [What's different from the classic dashboard](#whats-different-from-the-classic-dashboard)
- [Module coverage](#module-coverage)
- [Beta status](#beta-status)
- [Switching back](#switching-back)
- [For self-hosters](#for-self-hosters)

---

## Trying it

Click **Try the new dashboard** near the top of the classic dashboard's
sidebar, or go straight to `/v2` on your instance. It's gated behind the same
login as the rest of the dashboard — nothing extra to set up.

There's currently no remembered "always open V2" preference — each session
starts on the classic dashboard, and V2 is one click away. (A per-account
preference is planned; the database side of it already exists but isn't wired
up to anything yet.)

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

Not every module has its own V2 page yet. One that doesn't is marked
**Classic** (with a tooltip explaining why) wherever it's linked from — on the
Dashboard/Overview grid and in the sidebar — and clicking it opens that
module's classic-dashboard config page instead. It's still fully
configurable, just not on a V2-native page yet.

Modules with a real V2 page today: AFK, Welcome & leave, Birthdays,
Verification, Free games, Counting, Auto-react. This list grows over time —
the **Classic** tag is the accurate, live answer for any module not listed
here.

## Beta status

V2 is new and still filling in module coverage — expect rough edges. The
"Beta" badge next to the Sylo logo in V2's top bar is a reminder, not a
warning to avoid it: everything that has shipped has the same real
functionality (and the same save behavior and side effects) as its classic
counterpart, just a different page to get there. Found a bug, or something
that works in the classic dashboard but not in V2? Report it same as any
other issue.

## Switching back

**Back to classic dashboard** sits in V2's top bar and returns you to `/` at
any time — nothing about your settings depends on which dashboard you use.

## For self-hosters

No extra configuration — `docker compose up -d --build` (or the published
image) includes V2's build automatically. If you're running Sylo directly
with `npm start` instead of Docker, run `npm run build:v2` once (it needs
dev dependencies installed — plain `npm install`, not `npm ci --omit=dev`)
before the dashboard serves `/v2`; without a build, `/v2` responds with a
plain-text explanation instead of a 500.
