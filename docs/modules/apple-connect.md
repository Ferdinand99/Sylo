# App Store Connect alerts

**Beta · owner only.** Post a message in a channel when something happens to your
apps on Apple's side: a version moving through App Review, a TestFlight build
finishing (or failing) processing, TestFlight review results, a new customer
review, tester feedback or a crash, and a certificate or provisioning profile that
is about to expire.

It reads your Apple Developer account through the
[App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi).
Because the API key belongs to one account, **only the Sylo owner** (the accounts in
`OWNER_IDS` / `FLUXER_OWNER_IDS`) can see, enable or configure the module. It is
hidden from everyone else and refused on the server for server admins, moderators
and members alike.

**Dashboard:** `/v2/guilds/<id>/m/apple-connect` (owner only).

## Needs

- **Send Messages**, **Embed Links** in the target channel.
- An **App Store Connect API key**, set on the bot as environment variables (never in
  the database). Create it in App Store Connect under **Users and Access →
  Integrations**:

  | Variable | Value |
  |---|---|
  | `APPLE_KEY_ID` | The key's Key ID |
  | `APPLE_ISSUER_ID` | The Issuer ID shown on the Integrations page (team keys only; leave out for an individual key) |
  | `APPLE_PRIVATE_KEY` | The `.p8` file: its PEM text, the PEM on one line with literal `\n`, or base64 of the file |
  | `APPLE_VENDOR_NUMBER` | Optional, for a planned daily downloads digest |

- The key's **role** decides what Apple lets it read. **App Manager** covers apps,
  versions, builds, TestFlight and customer reviews. Certificate and profile expiry
  needs a **team key**: an individual key is refused. Prefer a dedicated key with the
  lowest role that works, so it can be revoked without touching anything else.

## Settings

- **Main channel** — where alerts go by default, plus an optional **ping role**.
  Each kind of alert below can also have **its own channel** (reviews in one place,
  App Review results in another); leave it on *main channel* to use the default. An
  alert with no channel at all (no main channel and none of its own) stays off.
- **Apps** — App Store Connect app ids (one per line); empty means all your apps.
- **What to announce**, each on its own switch:
  - **App version state changes** — waiting for review, in review, rejected,
    ready for sale and the other states, with the previous state.
  - **Builds** — a TestFlight build that finished processing (valid), or came out
    invalid or failed.
  - **TestFlight review** — a build entering beta review, then approved or rejected.
  - **TestFlight feedback and crashes** — the tester's comment, device and OS (the
    tester's email is not posted).
  - **Customer reviews** — stars, title and text, with a *only up to N stars* filter.
  - **Certificates and profiles expiring** — at the number of days you choose
    (default 30), again at 7 and 1 days, and once when expired.

## Notes

- Checked about every 5 minutes (certificates and profiles at most once an hour). One
  request set per check serves every server that has the module on.
- The **first** check after the module is switched on only records what exists, so you
  never get a replay of old versions, builds or reviews. A new draft version
  (`PREPARE_FOR_SUBMISSION`) is recorded silently until it moves on. Certificates that
  are already inside the warning window are announced right away.
- The last state of each item lives in the shared `posted_keys` table (scopes
  `apple:<kind>`). Switching a kind off forgets its state, so switching it on again
  starts with a silent look.
- Apple limits requests per key and per hour; the module stays far below that for a
  handful of apps. If Apple refuses a call (wrong key, missing role) the error is
  logged on the Health page and the other alerts keep working.
- Apple's webhooks (instant notifications for builds, version state and TestFlight
  feedback) are not used yet.
