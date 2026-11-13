# Economy (beta)

A currency for your server. Members earn it by chatting and in voice, claim a daily reward, work
for it, keep it in cash or in a bank, pay each other, and compete on a leaderboard. Staff can add,
remove, set and reset money. Robbing other members is available, and **off by default**.

Each server has its own balances. Amounts are whole numbers; nobody can hold more than
**1,000,000,000** in cash and bank together. The module is free, like all of Sylo.

**Dashboard:** `/v2/guilds/<id>/m/economy`, with four tabs: **Settings**, **Members**, **Shop** and **Activity**.

## Needs

- Optional: the **Message Content** intent (`INTENT_MESSAGE_CONTENT`, see
  [privileged intents](../self-hosting.md#privileged-intents)). Sylo reads only the length of a
  message, to apply the minimum length, and never stores or logs the text. Without the intent the
  module still works, but every message counts whatever its length; the settings page says so.
- For the optional staff log channel: **View Channel**, **Send Messages** and **Embed Links** there.
- Members must allow DMs from server members to get the DM that tells them they were robbed.

## Commands

| Command                                   |                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/balance [user]`                         | Your cash, bank, total and rank (only you see it on Discord); for another member, their total and rank. |
| `/daily`                                  | The daily reward, once every 24 hours, bigger for each day in a row.                          |
| `/work`                                   | A random pay with a short line, once per cooldown.                                            |
| `/deposit <amount or all>`                | Put cash in the bank.                                                                         |
| `/withdraw <amount or all>`               | Take money out of the bank.                                                                   |
| `/pay <user> <amount>`                    | Send cash to another member of the server (not yourself, not a bot).                          |
| `/rob <user>`                             | Try to steal another member's cash. Only when robbing is on.                                  |
| `/economy-leaderboard`                    | The richest members by cash + bank, ten to a page, with your own rank.                        |
| `/shop` | The shop: ten items a page, with buttons to turn the pages, a menu to buy (with a confirmation) and a link to the web shop. |
| `/buy <item>` | Find an item by name or by its number in `/shop` (Discord suggests names as you type) and ask to confirm it, with its price. |
| `/inventory [user]` | What you own (only you see it on Discord); for another member, only the names of what they hold. |
| `/eco add`, `remove`, `set`, `reset-user` | Staff with **Manage Server**: change a member's money, or start them over.                    |

`/leaderboard` is the Leveling module's, so the economy leaderboard is `/economy-leaderboard`. On
Fluxer the commands are chat commands (`!balance`, `!pay @member 100`, ...) and the leaderboard pages turn
with the ⬅️ and ➡️ reactions; see [Fluxer](../fluxer.md).

Amounts can be written with separators (`1,000`), and `/deposit` and `/withdraw` take the word `all`.
Amounts are shown with thousands separators, the currency emoji and name: "🪙 1,234 coins".

## How money is earned

- **Chat** — a random amount between a minimum and a maximum (default 5 to 15), once per
  cooldown (default 60 seconds). A message shorter than the minimum length (default 3 characters)
  pays nothing. Ignored channels and ignored roles pay nothing.
- **Voice** (off by default) — an amount (default 10) for every 5 minutes in voice. Time alone in the
  channel, deafened (self or server) or in the AFK channel does not count. Bots are not company.
- **Daily** — the base amount (default 100) plus a bonus (default 10) for each day in a row after the
  first, counted for up to **7 days**. Claim again within **48 hours** to keep the streak; after that
  it starts again at day 1. A claim needs **24 hours** since the last.
- **Work** — a random amount between a minimum and a maximum (default 50 to 150), once per cooldown
  (default 1 hour), with one of a few built-in lines.
- A new member starts with the **starting balance** (default 0).

## Bank, payments and tax

- **Bank** (on by default) — cash can be stolen, the bank cannot. `/deposit` and `/withdraw` move money.
- **Payments** (on by default) — `/pay` sends cash. An optional **tax** (0 to 50 percent, default 0) is
  charged to the sender on top of the amount, rounded up (a taxed payment pays at least 1), and removed from the economy: the
  recipient always gets exactly the amount. The sender needs the amount plus the tax in cash. A
  payment that would take the recipient over the cap is refused.

## Robbing

**Off by default.** With it on, a member can try to rob another member's **cash**:

- The chance to succeed is **40 percent**. A success takes **10 to 30 percent** of the victim's cash
  (at least 1) for the robber. A failure makes the robber pay the victim a **fine** of 10 percent of the
  robber's own cash, at least 25. To attempt a rob the robber must hold at least that smallest fine in
  cash, so the fine can always be paid from cash (the bank is never touched).
- The robber then waits **4 hours**, success or not.
- The victim must hold at least **100** in cash. Members who joined less than **24 hours** ago, and bots,
  cannot be robbed; if Sylo cannot tell when a member joined, the rob is refused. After a successful
  robbery the victim is safe for **1 hour**.
- The result is posted in the channel, and the victim of a success gets a DM.

Every value above can be changed in the settings, inside sane limits.

## Staff

On the **Members** tab, staff see every member with an account, paged and sortable by total, cash or
bank, and can search for any member by name or ID. Opening a member shows their cash, bank, streak and
their latest 50 ledger rows, and offers every action `/eco` has:

- **Add** to cash, **Remove** (cash first, then bank; refused when the member has less), **Set** cash to an
  exact amount, and **Reset** the member (cash back to the starting balance, empty bank, no streak or
  cooldowns). Each can carry a reason (up to 200 characters).
- Each change goes through the same money rules as the commands, is written to the ledger with the
  staff member who made it and the reason, and is posted to the **staff log channel** when one is set.

**Reset the whole economy** (Settings tab, _Danger zone_) needs the word `RESET` typed. Every account goes
back to a new start, and the ledger gets one **reset** row per member, so what each member had stays
visible for 180 days. While a reset runs, the economy commands, `/shop` and the buy buttons answer "Economy
reset in progress, try again shortly." at once.

## The shop

Staff build the shop on the **Shop** tab; nothing needs a Discord command. An item has a name (up to 60
characters), a description (up to 300), an optional emoji, a **price** (1 or more), a **stock** (unlimited, or a
number), optional **required roles** (a member needs any one of them), an optional **limit per member**, a
paused/for-sale switch and a place in the list (move it up or down). There are four kinds:

- **Temporary role** — a role for a time from 1 hour to 365 days. The time is kept like any other
  temporary role (see [Temporary roles](temp-roles.md)): Sylo takes the role back when it is up and writes the
  mod-log entries. **Buying it again while it runs adds the new time to what is left** (never more than 365
  days from now).
- **Permanent role** — the role is handed out when it is bought. A member who already has the role cannot buy it.
- **Custom item** — goes into the member's inventory, and Sylo posts "X bought Y" in the shop channel (a setting)
  so staff can do what was promised, then mark it **fulfilled** on the member's Inventory panel.
- **Collectible** — a picture (and an optional rarity) that members buy, own and show. It gives no role and needs
  nobody to fulfil it. See [Collectibles](#collectibles).

Before any money moves Sylo checks that the item is for sale, in stock, that the member has a required role, and
that Sylo itself can hand out the role (Manage Roles, and the role is below Sylo's highest role). If not, the
member is told and nothing is charged.

**A member is only ever charged the item they saw, at the price they saw.** `/buy`, the shop menu and the web
shop all show the price and ask to confirm, and the confirmation carries that price and the item's version. If
staff changed the price meanwhile, nothing is charged and the member is told the new price ("The price changed
to X. Check and try again."); any other edit (the role, the time, the kind, the name, the stock) gives "This item
changed, check it and try again." A sale does not count as a change.

**Buying is one transaction:** the price is debited (ledger kind `purchase`), the stock goes down by one, the
member's limit is checked and the inventory row is added. 20 buyers of the last 5 items get exactly 5, and
a permanent role cannot be bought twice (two buys at once charge once). Only then is a role put on the member.
**If Sylo cannot give the role, the purchase is refunded** (a `refund` row, the stock and the earlier role time
are put back) and the member is told. If Sylo stops in between, a sweep settles the purchase once its
five-minute lease has run out: the member has the role, so it is confirmed; the member lacks it or is gone, so it
is refunded. A role that is still being given is never touched by the sweep, and a revoke or refund waits for
it, so nobody keeps a role after a revoke. A member the sweep cannot look up right now is tried again later.

A temporary role that **runs out** (or is taken off by hand or by staff, or the member leaves) turns its purchase
into **expired**: it stops counting against the limit per member, is not listed as owned, and cannot be revoked or
refunded (there is nothing to end). The member can buy it again.

Deleting an item keeps what members already own: their inventory shows it as "item removed", and a role they
hold stays until it is revoked or runs out.

### Inventory (Members tab)

Open a member and pick **Inventory**: see what they own, **give an item for free** (ledger kind `grant`, amount
0, no stock used), **revoke** an item (a temporary role ends, a permanent role comes off, ledger kind `revoke`, no
money back), **refund** a purchase (the price goes back through the money API, ledger kind `refund`, the stock
returns and the item is revoked) and mark a custom item **fulfilled**. A revoke or refund always looks at the
member and takes the role off when they still have it. Each purchase of a temporary role remembers **how much
time it added**: refunding or revoking one takes off only that time (never more than is left), so if the member
bought it twice the role stays for the other purchase, and time staff added by hand with `/temprole` stays. When
nothing is left the role comes off. A purchase from before this was recorded (its added time is unknown) ends
the whole temporary-role record (a purchase that added nothing because the role was already at the 365-day limit leaves it alone). A refund takes off the full time the purchase added, even if part of it was
already used: if a member bought a role twice and the first period is mostly over, refunding the first also
removes that much of the second period. Staff can give time back with `/temprole`.

### Activity tab

Recent purchases, newest first, filtered by member (paste an ID) and by item, with the status of each (active,
revoked, refunded, expired) and whether a custom item is waiting for staff.

### The web shop

Switch **Web shop page** on in the settings (it is off by default) and signed-in members of the server can open
`/shop/<server id>` on the dashboard address: their balance, the items (with price, stock and whether they meet
the requirements), what they own and a **Buy** button with a confirmation. It uses the same purchase code as
`/buy`, so every rule above holds, and the server checks the requirements again. Nothing about it is public:
anyone who is not signed in is sent to the login, and anyone else who may not use it (not a member of that
server, the module or the web shop is off, no such server) gets the same "Nothing here" page. Fluxer servers work
the same way for people who sign in with the Fluxer login, and on Fluxer a Discord login is never looked up.

### Collectibles

A **collectible** is a shop item with a **picture** and an optional **rarity**: Common (grey), Uncommon (green),
Rare (blue), Epic (purple) or Legendary (gold). The tiers are fixed; staff pick one or none. A collectible gives no
role and is the member's the moment it is bought. Everything else is the shop you already know: name, description,
emoji, price, required roles, a **stock** (which makes it a **limited edition**: the last copy sells out) and a
**limit per member**. The purchase is the same one as for every item: the member pays the price and sees the
version they confirmed (a changed price, rarity or picture means "This item changed, check it and try again" and
nothing is charged), it writes one ledger row, and staff can refund it, revoke it, or give it for free from the
member's Inventory panel. A collectible that has no picture yet cannot be bought ("not ready yet").

**The picture.** Staff upload it on the **Shop** tab, in the item editor (the item is saved first, then the
picture goes up). The file can be a PNG, JPEG or WebP of at most **2 MB**. Sylo decides what a file is from its first
bytes, never from its name or the type the browser sent, and refuses everything else, SVG included. The picture is
then decoded and **saved again as a new PNG of at most 512 by 512 pixels**, with its proportions kept and never
enlarged. That removes metadata and anything that was not a real picture; an animated WebP becomes its first
frame (animated pictures are not supported). The upload needs a dashboard login with the rights to manage the
server, the usual CSRF check, and has its own rate limit.

The picture is stored in the data folder (the folder of `DATABASE_PATH`) as `collectibles/<server>/<id>.png`, where
the id is 128 random bits. It is served at `<dashboard address>/c/<id>.png` **without a login**, because Discord and
Fluxer fetch it themselves to show an embed. The id cannot be guessed, but anyone who has the address can open that
one picture. The address needs a public `DASHBOARD_URL`; without one, messages go out without the picture. Any other
address under `/c/` answers a plain "Not found".

Replacing a picture deletes the old file. **Deleting an item keeps the picture while members still own it**: their
copies show as "item removed" with the picture kept, and the file goes when the last copy ends (revoked, refunded or
erased with `/forget`). When a server removes Sylo (or its data is purged), all its pictures are deleted.

**Backups do not cover the pictures.** The backups Sylo makes (the Health page, the scheduled ones and the off-site
copy) hold the **database only**. Copy the `collectibles` folder in the data folder together with your database
backups, also when you use Postgres (the pictures are files on the disk next to `DATABASE_PATH`). If the folder is
lost, items and what members own are intact, but the pictures are gone and staff upload them again.

**Announce purchases.** An item has a switch **Announce purchases**, and the settings have a **channel for
collectible announcements**. With both set, a purchase posts "🎉 @buyer bought 🎖️ **Founder badge** (Epic)!" in
that channel, with the picture as an embed. Only the buyer is mentioned, and the text of an item cannot ping or
format anything. A free gift is not announced, and neither is an item without the switch.

**Showing a collection.** `/collection [user]` lists the collectibles a member owns, one embed each with the picture as a
thumbnail, ten to a page (buttons on Discord, the ⬅️ and ➡️ reactions on Fluxer). A member who owns several copies
sees "× 2". The setting **Members can show their collection** is **off by default**. Off: `/collection` shows only
your own collection, and only you see it (on Fluxer, which has no private replies, it is a short-lived public
message), and asking for someone else's is refused. On: `/collection` is public and `/collection @member` shows that
member's collection. The page buttons are checked on every press, so a collection that was shown while the setting
was on cannot be paged by others once it is off. `/inventory` works as before and lists collectibles too, and
the web shop has a **Collection** section with the signed-in member's own collectibles.

**Not in this version** (later): gifting or trading collectibles between members, showing them on the
introduction card, animated pictures, and sets or achievements.

## Giveaways

With the Economy module on, `/giveaway start` takes two more options (see [Giveaways](giveaways.md)): an
**entry fee** (taken when a member enters, given back if they leave before the draw or the giveaway is cancelled)
and a **currency prize** (paid to every winner at the draw, and to the new winners of a reroll). `/giveaway
cancel` ends a giveaway without a draw and gives every entry fee back.

## The ledger

Every change of a balance writes one row: the kind (`start`, `message`, `voice`, `daily`, `work`, `pay_out`,
`pay_in`, `tax`, `rob_win`, `rob_loss`, `rob_fine_out`, `rob_fine_in`, `deposit`, `withdraw`, `staff_add`,
`staff_remove`, `staff_set`, `reset`, and from the shop and giveaways `purchase`, `refund`, `grant`, `revoke`,
`giveaway_entry`, `giveaway_prize`), the amount (a `grant` and a `revoke` are events with an amount of 0),
the balances afterwards, the other member or the staff member, a reason and the time. Rows are kept for
**180 days** and pruned daily; balances are not affected by the pruning.

## Leaderboard

`/economy-leaderboard` shows the top 10 by cash + bank. With **Public leaderboard** on (the default, like
Leveling's), `/economy/<server id>` shows the same list on a page anyone can open: display name, avatar
and total only, never the cash. Turn it off in the settings and the page disappears.

## Your members' data

`/mydata` lists a member's economy account, ledger rows and shop inventory (collectibles are inventory rows, so they are
included), and `/forget` deletes them
(first it takes off the roles the shop gave the member, temporary and permanent, because the records that
explain them are deleted; a role Sylo cannot take off is reported, and for a temporary one its record stays so
the expiry still removes it)
(the shop's items are the server's, not the member's). Where a member is
named on someone else's row, the name is removed and the row stays. Staff can also reset a member. See the
[privacy policy](../privacy-policy.md).

`/forget` keeps one small record for **7 days**: the server, the member id, the times of the member's last
`/daily`, `/work` and `/rob` (that the record exists also shows the starting balance was already given). It exists only so that
`/forget` cannot be used to reset cooldowns and collect the starting balance again. A new account made in
that time gets no starting balance and keeps those cooldowns. A clean-up that runs every hour deletes the record when
the 7 days are over.
