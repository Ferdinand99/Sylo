# Events (beta)

Schedule an event and let members sign up with **Join**, **Maybe** and **Leave**
buttons. Sylo keeps the lists and counts on the post up to date, can give a
participant role while someone is signed up, sends a reminder before the start,
and closes the event when it is over. A server can also switch on a page for each
event: open to anyone with the link for an event in a public channel, and open only to
signed-in members who can see the channel for an event in a private one.

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
- **Event pages** — off by default. Gives every event a page and puts its link in the
  post; see [Event pages](#event-pages). (The setting is stored as `publicPages`, the
  name it had when only public channels had pages.)

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

## Event pages

**Off by default.** Turn on *Event pages* in the settings and every event gets a page
of its own. Who can open it depends on the channel the event was posted in:

- An event in a channel **everyone can see** has a **public** page that anyone with the
  link can open, with no sign-in. It is for sharing an event outside the server, for
  example with friends who have not joined yet.
- An event in a **private** channel has a page that only people who **sign in** and can
  see that channel can open. Everyone else sees a plain "not found" page. See
  [Events in private channels](#events-in-private-channels).
- An event in an **age-restricted** channel, or in a channel Sylo cannot see, has no
  page for anyone.

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
- **Dashboard:** every event in the list has a link: *Public page* for an event in a
  public channel, *Members-only page* for one in a private channel. An event with no
  page (age-restricted or unknown channel) says why instead.
- A post in a private channel carries the link and says no more about the page than a
  post in a public channel does. The link is no secret: the page checks every visitor.
- The link in the post needs `DASHBOARD_URL` to be set (see
  [self-hosting](../self-hosting.md)) to a **public https address**, because the post
  has to carry a full address that Discord accepts as a link. With no address, plain
  `http`, a local name (`localhost`, `.local`, `.lan`) or an IP address, the posts have
  no link at all. The dashboard still shows the page link either way. Signing in to a
  members-only page needs the dashboard's own login (Discord and/or Fluxer) to be set
  up; with no login (open mode) only public pages exist.
- A link button does not cost you an event. If Discord refuses a new post because of the
  button (a validation error, HTTP 400 with code 50035, whose error path points at the
  components), Sylo posts it again without the button and the event is kept. An edit
  that Discord refuses for the same reason is edited again without it. **Any other
  error is not repeated**: a timeout, a rate limit (429), a server error (5xx) or a
  refusal about something else (for example Sylo may not post in that channel) may
  have left a post behind or may pass at the next try, and a second post would be a
  duplicate. A new post that fails that way is reported as before and the event is not
  created; a failed edit leaves the post as it was, link included, until its next edit.
  If Discord ever words the button refusal differently from what Sylo expects, the
  result is that logged error and no link, never a second post.
- When you switch the setting on or off, or switch the Events module on or off while the
  setting is on, Sylo edits the posts of the server's events to add or remove the link:
  the upcoming ones and the finished and cancelled ones alike (their pages stay), up to
  the 200 newest events. This runs in the background, one edit after the other, and
  only one such pass runs per server at a time: if you switch again while it is
  running, it goes round once more at the end instead of a second pass starting. If Sylo
  restarts in the middle of a pass, the rest of it is lost, and the posts it had not
  reached keep their old link state until you switch the setting again or the post is
  next edited.

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
- No ids in the images either: the page holds no Discord address (see
  [The image](#the-image)).
- No outward links. Everything you write in an event is visible to whoever can open the
  page, so do not put something private in the description of an event that has a
  public page. A members-only page shows the same fields, and no names either.

### Public channels

An event has a **public** page if its channel is one **@everyone can see** (and is not
age-restricted, including through its category or the server on Fluxer). Sylo uses
the same test as the [quote board](quote-board.md): the
@everyone role must be able to view the channel, a thread follows its parent channel,
and a private thread never counts. A public page needs no sign-in.

The test is **not remembered**. It runs again **every time the page is requested**,
against the channel as it is at that moment:

- A channel made private after the event was posted: the page no longer opens without
  a sign-in on the very next request. It becomes a members-only page (see
  [Events in private channels](#events-in-private-channels)). The post keeps its link.
- A channel opened up later: the page opens for anyone again at once.
- It **fails closed**. If Sylo cannot tell whether the channel is public, there is
  no page. That covers a channel that was deleted, a thread that is archived and no
  longer known to Sylo, a missing @everyone role and permissions that cannot be read.
  The check only reads what Sylo already has in memory, so a visitor cannot make
  Sylo call Discord.
- On **Fluxer** the test works the same way. The SDK can only work out what a
  *member* may do in a channel, so Sylo works out what the @everyone role may do from
  the role's permissions and the channel's overwrites, the way discord.js does (the
  role's permissions, then the @everyone overwrite, then the role's own; Administrator
  is everything). Where it still cannot tell, there is no page. This is tested against
  the real Fluxer SDK classes, not yet against a live Fluxer server.
- On **Fluxer** a channel can be age-restricted by its own setting, by its **category**
  or by the **server**, in that order of say (a channel's own setting beats its
  category's, which beats the server's). Sylo applies the same rule, so an event in a
  channel that Fluxer treats as age-restricted never has a page, even when the
  channel itself is not marked. It fails closed: a category Sylo does not know, an
  age-restriction flag it cannot read, or a missing server flag all count as
  age-restricted. Discord is unchanged: Discord's own channel flag is already the
  effective one.

### Events in private channels

An event in a channel that only some members can see has a page too, for those members
and nobody else. It uses the **same address**, `/events/<code>`, and the same setting.

**Before sign-in.** A visitor who is not signed in gets one plain sign-in page (HTTP 401)
that shows nothing about the event: no title, no server name, no image and no
link-preview tags (no OpenGraph or Twitter card), so a link pasted into a chat shows
no preview. It offers the login for the platform the event was posted on, Discord or
Fluxer, through the dashboard's own login, and brings the visitor back to the same
address afterwards. The page is the same for **every address that has no page** for a
visitor who is not signed in: a private event, an address that is not an event, an
event in an age-restricted channel, a page that is switched off. Which login it offers
is the event's own platform, and for an address that is not an event a platform picked
from the address with a secret key, so the page does not show whether an event exists.
(Only a code that is not 32 characters of 0-9 and a-f is a plain "not found" page.)
With no login set up (open mode) there is nobody to ask, so only public pages exist.

**After sign-in.** On **every** request Sylo checks, with the bot's live data of that
moment, that the person:

- signed in with the **same platform** the event was posted on (a Discord account never
  opens a page of a Fluxer server, and the other way round, even if the two ids happen
  to be equal);
- is a **member of that server**; and
- can **view the channel**, by the platform's own rules: roles, the channel's and
  category's overwrites, Administrator and the owner. A public thread follows its parent
  channel. A **private thread has no page**, because Sylo cannot tell its members apart
  from the bot's cache with enough certainty.

Sylo remembers no answer: there is no cached "yes". A person who loses the role, leaves
the server, or whose channel is closed to them loses the page on the **next request**,
and gets it back as soon as they have access again. On Discord with the server-members
intent, and always on Fluxer, the bot's member cache is kept current by the gateway
and is used as it is (a member it does not hold is fetched); on Discord without that
intent the cache is not trusted and the member is fetched fresh from Discord every time.
A lookup that fails or takes longer than 4 seconds is a "no". The icon and the image of
the page use the same check, and Sylo's own copy of an image is read only after the check
passed, so a person without access never gets the bytes.

**Everything else is "not found".** A signed-in person who is not allowed gets the same
plain "not found" page, with the same status (404), the same headers and the same bytes
as for a wrong address: no access, a channel they cannot see, a server they are not in,
an event on the other platform than the one they signed in with, a page that is switched
off, a server Sylo has left, a check that cannot be made. They cannot tell a private
event from a wrong code.

**Age-restricted channels.** The rule for public pages is that an age-restricted channel
has no page. For members Sylo applies the same rule and shows **nothing to anyone**,
members included, because Sylo cannot tell whether a member has confirmed their age with
the platform. If Sylo cannot tell whether a channel is age-restricted (on Fluxer: a
category or flag it cannot read), the channel counts as age-restricted.

**Caching and search engines.** Every answer of a page that only some may open (the page,
its images, the sign-in page and the "not found" page) carries
`Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`,
`Vary: Cookie` and `Referrer-Policy: no-referrer`, and the pages are marked `noindex`.
The page of a public channel keeps the rules below.

**Logs and stats.** The request log shows `/events/:token` and never the code, the sign-in
link's code is in a query string that is never logged, and the pages load no visit-count
script. Like the public page they are limited to 40 requests a minute per visitor.

### When there is no page

For a visitor who is signed in (or when no login is set up), all of these give the
**same** plain "not found" answer, identical down to the byte, so a visitor learns
nothing about which addresses or servers exist:

- an address that is not a real code, or a code that belongs to no event, including an
  event number;
- the server is not one Sylo is in, the Events module is off, or *Event pages* is off;
- the event's channel is age-restricted, or one Sylo cannot see;
- for a private channel: the person is not allowed (above).

Switch the setting off and every page is gone at once. A public page is never cached
(`Cache-Control: no-store`), and every page is marked `noindex`, so search engines are
asked to leave them alone. Like the other public pages they are limited to 40
requests a minute per visitor, and they work under the dashboard's strict security
policy: no inline script or style, and everything the page shows is escaped.

### The image

A visitor's browser never contacts anyone but Sylo. The server's icon and the
event's image are fetched by **Sylo** and served from the page's own address
(`/events/<code>/icon` and `/events/<code>/image`), so the page holds only those two
paths: no Discord address, and none of the ids that Discord image links contain (a
server id in an icon, a channel id in an attachment, a user id in an avatar).

What Sylo fetches, and how:

- Only **https** links on Discord's image servers (`cdn.discordapp.com` and
  `media.discordapp.net`), with no port and no credentials. An image on any other site
  is left out of the page, though it still shows in the post. Sylo never fetches
  an address that a visitor sends; the links come from the event and the server.
- Through Sylo's safe fetch: a name that resolves to a private address is refused, **no
  redirect is followed**, at most **2 MB** is read, and it gives up after 5 seconds.
- Only PNG, JPEG, GIF and WebP, checked both by the content type and by the first bytes
  of the file. **SVG is refused**, and the type served is the one the bytes show, with
  `X-Content-Type-Options: nosniff`.
- The image addresses use the same rules as the page: the module and setting must be on,
  the channel must have a page, a members-only page's visitor must pass the same check
  (see [Events in private channels](#events-in-private-channels)), and every refusal is
  the same answer as for the page. They share the page's rate limit of 40 requests a
  minute.
- A browser may keep the image of a **public** page for up to a minute
  (`Cache-Control: private, max-age=60`); the page itself is never cached. The image of a
  **members-only** page is never kept (`Cache-Control: private, no-store`).
- If the fetch fails, for example because the Discord link has expired (Discord's links
  carry a signature and run out after a while), the page simply has no image.
- Fetched images are kept in memory for a short time (10 minutes, and a failure for 1
  minute) so a busy page does not make Sylo fetch the same file again. A sweep that runs
  every minute, and every use, removes an entry once its time is up, so nothing stays
  in memory more than about a minute past it, even if the page is switched off or the
  server removed in the meantime. The memory is bounded: at most 64 images and 16 MB.
  A copy is only handed out after the page's checks have passed for that request, so an
  image of a members-only page that is still in memory cannot be had by anyone who does
  not have access at that moment.
- The server's icon is taken from Discord. A Fluxer server's icon is not on Discord's
  servers, so a Fluxer page shows no icon.

### Privacy and `/forget`

- A visitor's browser calls only Sylo. Sylo itself fetches the server icon and the event
  image from Discord, which sees Sylo's request and not the visitor's.
- The page shows only counts of sign-ups, never members. `/forget` removes a member's
  sign-ups, so the counts drop by one, and takes them off as host. The page never showed
  either, and the event, its page and its code stay as they were. This holds for a
  members-only page too: no member name appears on it, for the visitor either.
- Signing in to a members-only page stores nothing new. The visitor is signed in by the
  dashboard's ordinary login (which keeps the account, the session and the servers the
  person manages, as described in the privacy policy), and Sylo reads the member's data
  in the server only to check the request, without keeping the answer. The sign-in link
  carries only the page's own address. Sylo's purge when it leaves a server, and `/forget`,
  need nothing added: they act on the event rows, which are the same for both kinds of page.
- The code is stored with the event. It is deleted with the event when Sylo leaves the
  server. It is not part of a member's data and is not in `/mydata`.
- The page address is a secret like a password reset link: for a public page, anyone who
  has it can read the page. The request log hides it (`/events/:token`). For a members-only
  page the address alone is not enough, the person must also pass the check above.

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
- With *Event pages* on, the link to an event's page is written into the post
  text, since there are no buttons. Whether a Fluxer channel counts as public is
  decided as described under [Public channels](#public-channels). A members-only page
  uses the Fluxer login and Fluxer's own member data. The member's permissions in the
  channel are worked out the way discord.js does: the roles' permissions, then the
  @everyone overwrite, then the roles' overwrites, then the member's own; Administrator
  and the owner are everything. (The Fluxer SDK alone ignores the @everyone overwrite
  for a member, so Sylo's compat layer does this calculation.) A thread has no page on
  Fluxer. The link needs a public https `DASHBOARD_URL`, as on Discord.
- The dashboard works exactly as on Discord.
