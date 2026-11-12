# Economy (beta)

A currency for your server. Members earn it by chatting and in voice, claim a daily reward, work
for it, keep it in cash or in a bank, pay each other, and compete on a leaderboard. Staff can add,
remove, set and reset money. Robbing other members is available, and **off by default**.

Each server has its own balances. Amounts are whole numbers; nobody can hold more than
**1,000,000,000** in cash and bank together. The module is free, like all of Sylo.

**Dashboard:** `/v2/guilds/<id>/m/economy`, with two tabs: **Settings** and **Members**.

## Needs

- The **Message Content** intent (`INTENT_MESSAGE_CONTENT`, see
  [privileged intents](../self-hosting.md#privileged-intents)). Sylo reads only the length of a
  message, to apply the minimum length, and never stores or logs the text.
- For the optional staff log channel: **View Channel**, **Send Messages** and **Embed Links** there.
- Members must allow DMs from server members to get the DM that tells them they were robbed.

## Commands

| Command                                   |                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/balance [user]`                         | Cash, bank, total and rank.                                                                   |
| `/daily`                                  | The daily reward, once every 24 hours, bigger for each day in a row.                          |
| `/work`                                   | A random pay with a short line, once per cooldown.                                            |
| `/deposit <amount or all>`                | Put cash in the bank.                                                                         |
| `/withdraw <amount or all>`               | Take money out of the bank.                                                                   |
| `/pay <user> <amount>`                    | Send cash to another member (not yourself, not a bot).                                        |
| `/rob <user>`                             | Try to steal another member's cash. Only when robbing is on.                                  |
| `/economy-leaderboard`                    | The richest members by cash + bank, ten to a page, with your own rank.                        |
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
  charged to the sender on top of the amount, rounded down, and removed from the economy: the
  recipient always gets exactly the amount. The sender needs the amount plus the tax in cash. A
  payment that would take the recipient over the cap is refused.

## Robbing

**Off by default.** With it on, a member can try to rob another member's **cash**:

- The chance to succeed is **40 percent**. A success takes **10 to 30 percent** of the victim's cash
  (at least 1) for the robber. A failure makes the robber pay the victim a **fine** of 10 percent of the
  robber's own cash, at least 25 (never more than they hold).
- The robber then waits **4 hours**, success or not.
- The victim must hold at least **100** in cash. Members who joined less than **24 hours** ago, and bots,
  cannot be robbed. After a successful robbery the victim is safe for **1 hour**.
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
visible for 180 days.

## The ledger

Every change of a balance writes one row: the kind (message, voice, daily, work, payments, tax,
robbery, fine, deposit, withdraw, staff add, remove or set, reset, and the starting balance), the amount,
the balances afterwards, the other member or the staff member, a reason and the time. Rows are kept for
**180 days** and pruned daily; balances are not affected by the pruning.

## Leaderboard

`/economy-leaderboard` shows the top 10 by cash + bank. With **Public leaderboard** on (the default, like
Leveling's), `/economy/<server id>` shows the same list on a page anyone can open: display name, avatar
and total only, never the cash. Turn it off in the settings and the page disappears.

## Your members' data

`/mydata` lists a member's economy account and ledger rows, and `/forget` deletes them. Where a member is
named on someone else's row, the name is removed and the row stays. Staff can also reset a member. See the
[privacy policy](../privacy-policy.md).
