# Suggestions (beta)

Members post ideas, everyone votes with **👍** and **👎**, and staff approve, deny,
or mark them as implemented or "considering" with an optional reason. Every
suggestion gets the server's own number (#1, #2, ...) and its own discussion
thread (Discord only).

**Dashboard:** `/v2/guilds/<id>/m/suggestions` - settings, a list you can filter by
status and sort by newest or most votes, and the staff actions.

## Needs

- **View Channel**, **Send Messages**, **Embed Links** in the suggestions channel
  (and in the log channel, if you set one).
- For threads on Discord: **Create Public Threads**. Without it the suggestion is
  posted without a thread.
- For "turn messages into suggestions": **Manage Messages** (to delete the
  original) and the **Message Content** intent.
- No other privileged intents.

## Settings

- **Suggestions channel** - where suggestions are posted. Empty means the channel
  `/suggest` was used in. Also the channel watched by the message option below.
- **Log channel** - optional. When a suggestion is approved, denied or marked
  implemented, Sylo reposts it here and deletes the original. The discussion thread
  stays where it was.
- **Anonymous suggestions** - new posts do not show who wrote them. The setting is
  fixed when a suggestion is posted, so changing it later does not change old posts.
  Staff still see the author on the dashboard page.
- **DM the author** - on by default. The author gets a direct message when staff
  decide. A member with DMs closed is skipped without any message.
- **Turn messages in the channel into suggestions** - off by default. When on, a
  plain message in the suggestions channel is deleted and posted as a suggestion
  instead. Messages from bots and messages with attachments are left alone (the
  attachment would be lost). If the message is too long, or the member is on
  cooldown, Sylo replies with a short note that disappears after ten seconds and
  leaves the message in place.
- **Cooldown** - seconds a member must wait between suggestions, 0 to 3600. Default 60.
  0 turns it off.
- **Staff roles** - may decide on suggestions without the Manage Server permission.

## Commands

| Command | |
|---|---|
| `/suggest` | Anyone. `text` (up to 1000 characters) and an optional `title` (up to 100). |
| `/suggestion approve` | Staff. `id` and an optional `reason` (up to 500 characters). |
| `/suggestion deny` | Staff. Same options. |
| `/suggestion implement` | Staff. Same options. |
| `/suggestion consider` | Staff. Same options. |

Staff means **Manage Server**, **Administrator**, or one of the staff roles above.
Sylo checks this itself, so the staff commands are visible to everyone but refuse
anyone else. (Manage Events does not count here.)

## How voting works

- One vote per member. Press the other button to change your vote, or the same
  button again to take it back. Only you see the confirmation.
- The counts on the buttons update a few seconds after a click, so a burst of
  votes causes a single edit.
- The author may vote on their own suggestion.
- **Approved**, **denied** and **implemented** close voting: the buttons go away
  and the final counts stay on the post. **Open** and **considering** accept votes.
- Votes are stored in Sylo's database, not as Discord reactions.

## Decisions

A decision changes the embed's colour and status line and shows the reason. Staff
may decide again later (for example approved, then implemented); the latest
decision and reason win. The author's DM says which suggestion it was, its new
status and the reason.

If a suggestion is posted in the log channel and the post cannot be created there
(missing permissions), the suggestion stays where it was and the decision still
counts.

## Limits

- 1000 characters of text, 100 of title, 500 of reason.
- At most **5000** stored suggestions per server. Past that, new suggestions are
  refused until staff delete old ones on the dashboard (Delete removes the
  suggestion, its votes and its post).
- At most **10** open suggestions (open or considering) per member at a time.
- A per-member cooldown, 60 seconds by default.

## Privacy and `/forget`

- A member's **votes** are deleted by `/forget`.
- Their **suggestions** stay on the server's board, but `/forget` removes the
  author id, so the suggestion no longer points to the person. Staff decisions the
  member made lose their staff id as well. The text of a suggestion is kept
  because it belongs to the server's history; staff can delete it on the dashboard.
- The already posted message in Discord still shows the author if the suggestion
  was not anonymous. `/forget` works on Sylo's database and does not edit old
  messages; the next time the post is updated (a vote, a decision) the author is
  left out.
- `/mydata` lists the votes, the suggestions the member wrote and the decisions
  they made, with counts.
- The posted suggestions, their votes and the log channel posts are removed when
  Sylo leaves the server.

## On Fluxer

Fluxer has no buttons, threads or slash commands yet:

- Members vote by **reacting** to the suggestion: 👍 or 👎. Sylo takes the reaction
  back at once; reacting with the same emoji again takes the vote back. Replies
  are sent as a short message that Sylo deletes after about 15 seconds.
- **No discussion thread** is opened (see [What works differently](../fluxer.md#what-works-differently)).
- Commands run from chat with the prefix: `!suggest text:"Add a movie night"`,
  `!suggestion approve id:12 reason:"Starting next week"`. Quote values that
  contain spaces.
- Plain messages in the suggestions channel work the same way as on Discord.
- The dashboard works exactly as on Discord.
