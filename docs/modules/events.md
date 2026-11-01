# Events (beta)

Schedule an event and let members sign up with **Join**, **Maybe** and **Leave**
buttons. Sylo keeps the lists and counts on the post up to date, can give a
participant role while someone is signed up, sends a reminder before the start,
and closes the event when it is over. A server can also switch on a public page for
each event.

**Dashboard:** `/v2/guilds/<id>/m/events` — settings, the list of upcoming and
past events, and create, edit and cancel.

## Needs

- **View Channel**, **Send Messages**, **Embed Links** in the event channel.
- For a participant role: **Manage Roles**, and Sylo's own role must sit above
  that role.
- No privileged intents.

## Settings

- **Default channel** — where events are posted when none is named. Empty means
  the channel the command was used in.
- **Default reminder** — minutes before the start (5 to 1440), or off.
- **DM the reminder** — also DM everyone who pressed Join. A member with DMs
  closed is skipped without any message.
- **Time zone for commands** — the zone `/event create` reads its times in. Empty
  means UTC.
- **Staff roles** — may manage events without the Manage Events permission.
- **Public event pages** — off by default. Gives every event a public page and
  puts its link in the post; see [Public event pages](#public-event-pages).

## Commands

Staff only: the Manage Events permission (Manage Server and Administrator count
too) or one of the staff roles above. Sylo checks this itself, so the commands are
visible to everyone but refuse anyone else.

| Command | |
|---|---|
| `/event create` | Title, start (`YYYY-MM-DD HH:mm`), and optionally end, timezone, description, location, channel, capacity, role, reminder, image. |
| `/event list` | Upcoming events with their ids and sign-up counts. |
| `/event cancel` | Cancel an upcoming event by id. |

The start is read as a wall-clock time in the `timezone` option, else the server
setting above, else UTC. The post shows it with Discord timestamps, so every
member sees their own local time, and also spells it out in the creator's zone.

## How sign-ups work

- **Join** adds you to *Going*. If the event has a capacity and it is full, Join is
  refused with a private message; Maybe still works.
- **Maybe** moves you to *Maybe*; **Leave** removes you.
- At most 500 people can sign up to one event, and a server can have 50 upcoming
  events at a time.
- The **participant role** is given on Join and taken back on Maybe or Leave. When
  the event ends (its end time, or two hours after the start when there is none)
  or is cancelled, Sylo takes the role from everyone who was going. The person who
  creates the event must be allowed to hand out that role themselves (the same rule
  as for reaction roles).
- The **reminder** is posted in the channel (pinging the participant role when
  there is one) and, if enabled, sent as a DM to everyone who pressed Join. An
  event created inside its reminder window gets no reminder.

## Notes

- Everything lives in the database. After a restart, a slow background tick picks up
  reminders and endings that came due in the meantime; a reminder is never sent for
  an event that has already started.
- Editing an event on the dashboard updates the posted message. The channel and the
  participant role cannot be changed after creation; cancel and post a new event for
  that.
- `/forget` removes a member's sign-ups and takes them off as the **host** of the
  events they made (the event stays, without a host line). A finished event's title is
  a server record and is only cleared when Sylo leaves the server. Taking away the
  participant role is done when the event ends, from the sign-up list, so a member
  erased before then keeps the role until staff remove it.

## Public event pages

**Off by default.** Turn on *Public event pages* in the settings and every event gets
a page of its own that anyone with the link can open, with no sign-in. It is for
sharing an event outside the server, for example with friends who have not joined yet.

The page is at `/events/<code>` on your dashboard address, for example
`https://sylo.example.com/events/3f9c0d5e7a1b4c68a2e4d1b7c9f05a63`. The code is 32
random characters (128 bits) made when the event is created. It is **not** the event
number: event numbers run in sequence (#1, #2, ...) and anyone could count up to the
next one, so they are never used in an address. Events made before this feature got
a code when Sylo was updated. The code never changes, and the dashboard shows it only
as the link on the event.

Where the link is:

- **Discord:** the event post gets an **Event page** link button. The post keeps its
  link after the event is cancelled or over, because the page stays.
- **Fluxer:** Fluxer has no buttons, so the link is written into the post text
  (`🔗 [Event page](...)`), below the line that explains the reactions.
- **Dashboard:** every event in the list has a *Public page* link.
- The link in the post needs `DASHBOARD_URL` to be set (see
  [self-hosting](../self-hosting.md)), because the post has to carry a full address.
  Without it the dashboard still shows the link, and the posts have none.
- When you switch the setting on or off, Sylo edits the posts of the upcoming events
  to add or remove the link. Posts of finished events are updated the next time they
  are edited.

### What the page shows

- The **title**, whether the event is **upcoming**, **cancelled** or **ended**, the
  **description**, the **place** and the **image**.
- The **start time** (and the end time, if there is one) in the visitor's **own time
  zone and language**. A small script on the page does the conversion. Without
  scripts the page shows the time in UTC.
- The **capacity** and how many pressed **Going** and **Maybe**, as numbers only.
  "Upcoming" also covers an event that has started and is not over yet.

### What it never shows

- **No names.** Not who is going, not who is maybe, and no avatars.
- **No host** and no **participant role**. No channel, no message and no member ids.
  A mention, channel, custom emoji or message link written in the title, description
  or place is replaced by "@member", "@role", "#channel", ":name:" or "[message
  link]", and any long number in the text is replaced by "…".
- No outward links. Everything you write in an event is public, so do not put
  something private in the description of an event that has a page.

### Only public channels

An event has a page only if its channel is one **@everyone can see** (and is not
age-restricted). Sylo uses the same test as the [quote board](quote-board.md): the
@everyone role must be able to view the channel, a thread follows its parent channel,
and a private thread never counts. An event posted in a staff or other private channel
**never** has a page, even with the setting on, and has no link in its post.

The test is **not remembered**. It runs again **every time the page is requested**,
against the channel as it is at that moment:

- A channel made private after the event was posted: the page answers "not found" at
  once on the next request. The link in the post is removed the next time the post is
  edited (a Join or Maybe click, an edit on the dashboard, the end of the event, or
  switching the setting).
- A channel opened up later: the page works again, and the post gets its link back at
  the next edit.
- It **fails closed**. If Sylo cannot tell whether the channel is public, there is
  no page. That covers a channel that was deleted, a thread that is archived and no
  longer known to Sylo, a missing @everyone role and permissions that cannot be read.
  The check only reads what Sylo already has in memory, so a visitor cannot make
  Sylo call Discord.
- On **Fluxer** the test uses the same channel-permission lookup as the quote board.
  It has not been verified against a live Fluxer server, and wherever Sylo gets no
  answer from it, the event has no page.

### When there is no page

All of these give the **same** plain "not found" answer, identical down to the byte,
so a visitor learns nothing about which addresses or servers exist:

- an address that is not a real code, or a code that belongs to no event, including an
  event number;
- the server is not one Sylo is in, the Events module is off, or *Public event pages*
  is off;
- the event's channel is not public (above).

Switch the setting off and every page is gone at once. Pages are never cached
(`Cache-Control: no-store`), and they are marked `noindex`, so search engines are
asked to leave them alone. Like the other public pages they are limited to 40
requests a minute per visitor, and they work under the dashboard's strict security
policy: no inline script or style, and everything the page shows is escaped.

### The image

The page shows the event's image only if it is hosted by **Discord's own image
servers** (`cdn.discordapp.com` or `media.discordapp.net`), for example a picture you
uploaded to Discord and linked. An image from any other site is left out of the
page, though it still shows in the post. The reason is that a visitor's browser would
load it, and whoever owns that site would learn the address and browser of everyone
who opens the page. (The dashboard's security policy already lets pages load images
from any https site, so this check is made by the page itself.) Discord's links carry a
signature and expire after some time, so an old event's image may stop showing.

### Privacy and `/forget`

- The page shows only counts of sign-ups, never members. `/forget` removes a member's
  sign-ups, so the counts drop by one, and takes them off as host. The page never showed
  either, and the event, its page and its code stay as they were.
- The code is stored with the event. It is deleted with the event when Sylo leaves the
  server. It is not part of a member's data and is not in `/mydata`.
- The page address is a secret like a password reset link: anyone who has it can read
  the page. The request log hides it (`/events/:token`).

## On Fluxer

Fluxer has no buttons or slash commands yet:

- Members sign up by **reacting** to the event post: ✅ Join, ❔ Maybe, ❌ Leave.
  Replies to a click are sent as a short message that Sylo deletes after about 15
  seconds.
- Staff run the commands from chat with the prefix, naming the options:
  `!event create title:"Game night" start:"2026-11-05 19:00" timezone:Europe/Oslo`,
  `!event list`, `!event cancel id:3`. Quote values that contain spaces.
- The times sit in the post's description, where Fluxer renders Discord timestamps
  (see [What works differently](../fluxer.md#what-works-differently)); the post also
  states the start in the creator's time zone.
- With *Public event pages* on, the link to an event's page is written into the post
  text, since there are no buttons. Whether a Fluxer channel counts as public is
  decided as described under [Only public channels](#only-public-channels).
- The dashboard works exactly as on Discord.
