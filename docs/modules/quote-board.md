# Quote board (beta)

Save the messages your server wants to remember and bring them back later. A member
right-clicks a message and chooses **Save quote**, or uses `/quote save` with the
message link. Each quote gets a number that is unique in the server (#1, #2, ...).
Anyone can then pull one out with `/quote random`, `/quote search`, `/quote user` or
`/quote show`. A server can also switch on a public page with the latest quotes.

**Dashboard:** `/v2/guilds/<id>/m/quote-board` - the settings, and a list of every
saved quote with a search and a Remove button on each row.

## Needs

- No special permission or privileged intent. Sylo has to be able to **read the
  channel** of a message to save it (View Channel and Read Message History).
- **Discord:** the "Save quote" entry appears under *Apps* in the right-click menu
  of a message once Sylo has registered its commands (a few minutes after an update;
  Discord can take up to an hour for new global commands).

## What is kept

A quote stores:

- the **text** of the message, cut to **2000 characters**;
- the **author's id and display name** as it was when the quote was saved (the
  name is a snapshot: it does not follow later renames);
- the channel and message ids (for the jump link), and the message's date;
- how many **attachments** the message had, shown as "📎 2 attachments";
- who saved it, and when.

**No file is copied or re-hosted.** Sylo only counts attachments. Embeds, stickers
and reactions are not kept. A message with **no text and no attachments** is skipped
("nothing to save"). Saving the **same message twice** returns the quote it already
has instead of making a second one.

## Saving

| How | |
|---|---|
| Message menu **Save quote** (Discord) | Right-click or long-press a message, *Apps*, *Save quote*. The reply shows the saved quote to the channel. |
| `/quote save [message]` | Paste a message link (*Copy Message Link*). The message must be in this server, and you must be able to see its channel. |

A new quote is announced in the channel with its number. An existing one is
answered privately ("already quote #12").

**Who may save** is a setting: **everyone** (the default) or **staff and chosen
roles**. Staff always may.

## Showing

| Command | |
|---|---|
| `/quote show <number>` | One quote: the text, the author and date, the attachment count and a link to the message. |
| `/quote random [member]` | A random quote of the server, or of one member. |
| `/quote search <text>` | The 5 newest quotes whose text or author name contains the text (up to 100 characters; case does not matter; `%` and `_` are ordinary characters). |
| `/quote user <member>` | The member's 10 newest quotes, with the total. |

Showing is open to everyone in the server. Quotes are shown with the name they were
saved under.

## Removing

- A member can remove a quote they **wrote** (they are the author) or **saved**,
  with `/quote remove <number>`.
- **Staff** can remove any quote: Manage Messages, Manage Server or Administrator,
  or one of the **staff roles** set on the module page.
- The dashboard lists every quote and removes any of them (it needs Manage Server
  like the rest of the dashboard).

A removed quote's number is **never used again**. The server keeps a counter that
only goes up, so "quote #12" always means the same quote, or none. (A server that
Sylo leaves and rejoins starts again at #1, because leaving erases its data.)

## The public page

**Off by default.** Turn on *Public quote page* in the settings and the page is at
`/quotes/<server id>` on your dashboard address. It needs no sign-in and shows the
**latest 50 quotes**, newest first, with paging.

What it shows and what it never shows:

- Shows: the quote text, the author's **display name** (as saved), the date and the
  quote number, and the attachment count.
- Never shows: user, channel, message or server ids in the text (a mention, channel,
  custom emoji or message link inside a quote is replaced by "@member", "#channel",
  ":name:" or "[message link]"), avatars, or **jump links**. A jump link only works
  for members of the server and would carry the ids, and the public leaderboard
  links nowhere either.
- Never lists a quote saved from a channel that **@everyone cannot read** (a staff
  or private channel) or an **age-restricted** channel. Sylo decides this when the
  quote is saved. Those quotes still work in the server and on the dashboard; the
  dashboard marks them "not on the public page".
- The page is marked `noindex`, so search engines are asked to leave it alone, and
  it works under the dashboard's strict security policy (no inline scripts or
  styles).

Switch the setting off and the address answers "not found" again at once. There is
no vanity address for this page.

## Limits

- Text of a quote: **2000** characters. Search: **100** characters.
- At most **10 000 quotes per server**. Past that, saving is refused ("remove some
  first"); showing an existing quote and saving a message that is already a quote
  still work.
- Role lists: 25 save roles and 25 staff roles.

## Privacy and `/forget`

- `/forget` **deletes the quotes whose author is the member** (their words), and
  removes their name as "saved by" from quotes of other people, which stay on the
  server. The deleted quotes' numbers stay used.
- `/mydata` lists both, with the text of the quotes they wrote.
- Quotes are also removed when Sylo leaves the server.
- A quote is a **copy** of a message. Deleting or editing the original message does
  not change the quote; staff remove it with `/quote remove` or the dashboard. Tell
  your members that a quote can outlive the message, and that `/forget` removes it.
- Anyone who may save quotes can save a message from any channel they can see, and `/quote` shows quotes in any channel. Sylo checks that the person saving can see the channel, but not who is reading the quote later; keep that in mind for private channels. (Quotes from channels hidden from @everyone are never put on the public page.)
- The public page publishes the display name and text of quotes to anyone with the
  link, so only turn it on if your members are fine with that.

## On Fluxer

Fluxer has **no message menu** and no slash commands, so there is no "Save quote"
menu. Use the chat commands with the prefix instead:

- `!quote save https://web.fluxer.app/channels/<server>/<channel>/<message>`, or
- **reply to the message** with `!quote save`.

The other commands work the same way: `!quote random`, `!quote search <text>`,
`!quote user @member`, `!quote show <number>`, `!quote remove <number>`. Replies that
should be private are deleted after about 15 seconds. Quotes show a link that opens
the Fluxer web app. The dashboard and the public page work exactly as on Discord.
Not verified against a live Fluxer server.

## Gaps

- No message menu on Fluxer (above).
- The author name is a snapshot; quotes are not updated when someone renames.
- Sylo can only save messages it can read; a link to a channel Sylo cannot see is
  refused.
- Search is a plain "contains" match, not a full-text search.
