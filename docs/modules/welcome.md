# Welcome & leave

Greet new members in a channel and/or by DM, announce departures, and optionally
attach a generated **welcome image**. The welcome goes out when a member joins, or
later, when they get a role.

**Dashboard:** `/v2/guilds/<id>/m/welcome`.

## Needs

- **Send Messages**, **Embed Links** in the target channel; **Attach Files** for
  the welcome image.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`).

## Settings

- **When to welcome** — **When a member joins** (the default) or **When a member
  gets a role**. See [Welcome on a role](#welcome-on-a-role).
- **Join message** — channel + text, optionally sent as an embed (uses the
  server's default embed colour, set under *General*).
- **Welcome image** — a 1000×340 banner with the member's avatar, name and member
  number. Optional background image URL (drawn behind a dark scrim). Needs
  **Attach Files**; skipped with a logged warning if missing.
- **DM message** — a private message to each new member.
- **Leave message** — channel + text when a member leaves.
- **Give roles to new members** — shared with the [Reaction roles &
  autoroles](roles.md) module.

Placeholders: `{user}` `{user.tag}` `{user.name}` `{user.id}` `{server}`
`{memberCount}` `{intro}` `{role}`.

`{intro}` is a mention of the introductions channel when the
[Introductions](introductions.md) module is on and has a channel, for example
"Say hello in {intro}!". When Introductions is off, or has no channel yet, it is
empty text.

`{role}` is the name of the role that started the welcome (see below). When
members are welcomed on joining, it is empty text.

## Welcome on a role

Some servers only count a member after a step: passing [Verification](verification.md),
or being accepted in [Applications](applications.md), which can both give a role. With
**When a member gets a role**, the welcome waits for that role instead of going out when
the member joins.

- **Roles** — pick 1 to 10. The welcome is sent the first time the member gets **any**
  of them. A role must exist, cannot be @everyone and cannot be a managed role (a bot's
  or an integration's).
- **What is sent** — everything the join welcome does: the join message (plain or embed),
  the welcome image and the DM, if they are turned on. All placeholders work, and `{role}`
  is the role that started it.
- **Once per member** — a member is welcomed once per server, however many of the roles
  they get. A member who leaves and comes back can be welcomed again. Sylo keeps a short
  record of who was welcomed (also when welcoming on joining); a record left over from an
  earlier time on the server, because the leave was missed, does not block a member who has
  rejoined since.
- **Joining** — sends nothing, unless the member already has one of the roles when they
  join (for example from an autorole). Then they are welcomed right away.
- **The leave message** works the same in both modes.
- **Members who were already welcomed** — a member welcomed on joining (before you
  switched to roles) is not welcomed again by a role, and neither is a long-time member who
  loses a trigger role and gets it back: once welcomed, never again. This holds for
  welcomes sent since Sylo 5.2, which is when Sylo started keeping the record; a member
  welcomed on joining before that has none, so a role they get later can welcome them once.
- **Switching on** — members who already have one of the roles are **not** welcomed when
  you switch to **When a member gets a role**. Only roles given afterwards count. A role you
  add to the list later starts counting from that moment, in the same way, and so do all the
  roles when you switch the Welcome module itself back on after it was off: a role a member
  got while it was off does not welcome them.
- **No usable role** — the settings save with a warning, and nothing is sent until you
  pick one.

Sylo notices a role change from the member update events, so it needs the **Server
Members** intent. Normally the update says which roles the member had before, and a new
trigger role is a gain. For a member Sylo has not seen since it started, the update says
nothing about the earlier roles. Then Sylo welcomes the member only if they **joined after
the role started counting** (when you switched to roles, or added the role to the list) and
have not been welcomed yet. That covers a role given by hand after a restart, or while Sylo
was offline (the welcome comes with the member's next update of any kind). A member who
joined before the role started counting is not welcomed this way; this is what keeps a
switch from welcoming everyone who already has the role.

If a welcome cannot be sent (no permission in the channel, or DMs closed), it is not tried
again: a missed welcome is better than a double one. The log notes it, without the message.

## Notes

- A live preview of the welcome image is shown on the config page.
- Rendering needs `@napi-rs/canvas` (bundled). If it can't load on your platform,
  the image is skipped and the text still sends.
