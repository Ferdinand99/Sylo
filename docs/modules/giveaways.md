# Giveaways

Run prize giveaways with an **Enter** button. Winners are drawn automatically at
the end time.

**Dashboard:** `/v2/guilds/<id>/m/giveaways`.

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.

## Settings

- **Ping** — `none` / `@here` / `@everyone` when a giveaway is drawn.
- **DM winners** — also DM each winner.

## Commands

| Command | |
|---|---|
| `/giveaway start` | Prize, number of winners, duration, optional required role, and with the Economy module on an `entry_fee` and a currency `prize_amount`. |
| `/giveaway end` | Draw now. |
| `/giveaway cancel` | End without a draw; entry fees are given back. |
| `/giveaway reroll` | Pick new winner(s), excluding previous ones. |
| `/giveaway list` | Active giveaways in the server. |

## Notes

- A background tick ends due giveaways. Only entrants still in the server (and
  still holding the required role) are eligible.
- `end`, `cancel` and `reroll` are also available on the dashboard.
- **Entry fee** (Economy module on): entering takes the fee from the member's cash (ledger `giveaway_entry`);
  pressing Enter again before the draw leaves the giveaway and gives it back; cancelling the giveaway gives
  every entrant's fee back. A member cannot enter twice, cannot enter without the cash, and is never charged
  twice. If the Economy module is turned off, nobody can enter a giveaway that has a fee. An entry or a leave
  either lands before the draw (and is drawn, or refunded) or is refused after it: an entrant who was charged
  is in the draw or refunded, and a winner is never refunded.
- **Cancelling** refunds every entry once (each entry has a refunded marker). If a refund fails or Sylo stops
  half way, run `/giveaway cancel` again (it finishes the refunds that are left and says so) or wait: Sylo
  finishes them within a minute.
- **Currency prize**: at the draw every winner is paid the amount (ledger `giveaway_prize`), as well as the prize
  text. Each member is paid at most once per giveaway, however many times it is drawn, rerolled or retried. A
  reroll pays only newly drawn winners who have not been paid; nothing is taken back from earlier winners, so a
  staff reroll can pay extra prizes. A payout lost to a crash after the draw is completed by Sylo within a
  minute. The text prize is still required: write what it is, for example "500 coins" if the money is all
  there is.
- `/forget` removes a member's giveaway entries; a completed giveaway's winner
  list is a server record and is only cleared when Sylo leaves the server.
