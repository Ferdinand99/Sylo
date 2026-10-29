# Events (beta)

Schedule an event and let members sign up with **Join**, **Maybe** and **Leave**
buttons. Sylo keeps the lists and counts on the post up to date, can give a
participant role while someone is signed up, sends a reminder before the start,
and closes the event when it is over.

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
- The dashboard works exactly as on Discord.
