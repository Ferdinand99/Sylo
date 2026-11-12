# Introductions (beta)

A member answers a few questions in DM and Sylo posts a **server membership card** for them
in the introductions channel: their avatar, name, answers, the roles they have from groups
you define (Country, Age, DMs ...) and when they joined. One card per member per server. The
same flow works on Discord and Fluxer, and it uses no modals.

**Dashboard:** `/v2/guilds/<id>/m/introductions`.

## Needs

- **Send Messages**, **Embed Links** and **View Channel** in the introductions channel. To pin
  the optional prompt message, Sylo also needs **Manage Messages** (or Pin Messages) there;
  without it the prompt is posted unpinned.
- The **Server Members** intent (`INTENT_GUILD_MEMBERS`, on by default; see
  [privileged intents](../self-hosting.md#privileged-intents)). Without it Sylo does not see
  members leave or change roles, so cards are not removed or refreshed by themselves.
- Members must allow DMs from server members, because the questions are asked in DM.

## How a member makes a card

1. They use `/intro create` (on Fluxer `!intro create`), or press **Create my intro** on the
   prompt message. Sylo answers **Check your DMs**: a private reply on Discord, and a short
   message that Sylo deletes after about 15 seconds on Fluxer.
2. Sylo asks the questions in DM, one at a time. A member can type:
   - `skip` for an optional question,
   - `keep` to keep the answer shown as "Current:" (when they run it again),
   - `cancel` to stop.
3. Each answer is checked against the question's longest length; a too long answer is asked
   again. A session ends after **10 minutes** without an answer. Only one questionnaire runs per
   member at a time, across all servers.
4. Sylo shows a **preview** of the card with **Post** and **Start over**. On Fluxer these are
   reactions on the preview.
5. **Post** publishes the card (or edits the member's existing one).

While a questionnaire runs, the member's DMs to Sylo are answers. They do **not** open a
[modmail ticket](tickets.md). When the questionnaire ends (done, cancelled or timed out), DMs
work as before.

If Sylo cannot DM the member, the reply says: "Open your DMs from server members and try again."
`/intro create` and the button can be used once every **30 seconds** per member.

## Commands

| Command | |
|---|---|
| `/intro create` | Ask the questions in DM, then post or update your card. |
| `/intro view [user]` | Show a card (private on Discord). Default: your own. |
| `/intro remove [user]` | Delete your own card and answers. Staff with **Manage Messages** can name another member. |

## Settings

- **Introductions channel** — where cards are posted. Nothing works until it is set.
- **Questions** — up to **8**. Each has a label on the card (up to 45 characters), the question
  asked in DM, a *required* switch, the longest answer (1 to 1024 characters) and a *short field*
  switch (shown side by side with other short fields). The default set is About me, Likes,
  Dislikes, Pronouns and DMs. A server may remove all of them: the card then shows only the
  member's profile.
- **Role groups** — up to **10** groups, each with a name and up to 25 roles. A group is shown on
  the card as a field named after the group, with the member's roles from that group joined by
  ", ". When the member has none, the field shows "—", or is left out if *hide when empty* is on.
- **Card** — an optional description (up to 1000 characters) and footer (up to 200 characters),
  and the colour: the server's embed colour, a colour you pick, or the member's top role colour.
  *Show the member's other roles* adds a "Roles" field with the member's other roles (the 10
  highest, without @everyone, managed roles and roles already shown in a group).
- **When a member leaves** — delete their card and answers (on by default).
- **Prompt message** — publish (and update, and remove) a pinned "Introduce yourself" message
  with a **Create my intro** button in the introductions channel. On Fluxer the button is shown
  as a reaction.

Placeholders for the description and footer: `{user}` (mention, without a ping), `{user.name}`,
`{server}` and `{rolegroup:<name>}` (the member's roles of that group, for example
`{rolegroup:Country}`; the name is matched without regard to case).

The welcome message of the [Welcome & leave](welcome.md) module can use `{intro}`, a mention of
the introductions channel.

## Keeping cards current

- Running `/intro create` again offers the old answers ("Current: ... type `keep`") and **edits
  the card in place**. If the old message is gone, Sylo posts a new one.
- When a member's **roles change**, Sylo refreshes their card about 30 seconds later (several
  changes in a row cause one edit), so role groups stay right.
- If a card message is **deleted** (by staff or by the member), Sylo forgets the message but keeps
  the answers, so `/intro create` can post it again.
- When a member **leaves**, their card and answers are deleted (unless you turned that off).
- `/forget` deletes a member's answers **and** the card message.

## Safety

- `@everyone`, `@here` and role mentions are removed from answers, and cards are posted with
  mentions switched off, so a card never pings anyone.
- Markdown in an answer is escaped, so an answer shows as plain text and cannot turn into a
  link, a heading or a mention. Plain text, emoji and line breaks are fine.
- A card stays within Discord's embed limits: very long answers are shortened and end with "…".
- Answers are never written to the logs.

## What is stored

For each member: the **answers** (text), the **channel and message ids** of the card, and when
it was created and last changed. The card is a normal message in the channel, so it shows what
the member answered, to everyone who can read that channel. Answers are included in `/mydata`
and the dashboard's member data export, and removed by `/forget`, by `/intro remove` and when
Sylo leaves the server.

## On Fluxer

Fluxer has no slash commands, modals, private replies or buttons yet, so:

- use `!intro create`, `!intro view [@member]` and `!intro remove` (the prefix is set per server);
- "Check your DMs" is a normal message that Sylo deletes after about 15 seconds;
- **Post** and **Start over** under the preview, and the **Create my intro** button of the prompt
  message, are shown as reactions;
- everything else, including editing the card in place and refreshing it on role changes, works
  as on Discord.
