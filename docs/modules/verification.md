# Verification

Gate new members behind a **Verify** button (or a Cloudflare Turnstile captcha)
before they get a role.

**Dashboard:** `/guilds/<id>/m/verification`.

## Needs

- **Manage Roles**, with Sylo's role above the verified role.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`).
- For captcha mode: `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`, and a reachable
  `DASHBOARD_URL` (the captcha page is served by Sylo).

## Settings

- **Mode** — `button` or `captcha`. Captcha falls back to button when Turnstile
  isn't configured.
- **Verified role** — granted on success.
- **Verify channel / message** — where the button is posted.
- Optional: a pending role removed on success, a welcome DM, a log channel.

## How it works

A new member sees only the verify channel. Clicking **Verify** (button mode)
grants the role immediately; captcha mode opens `<DASHBOARD_URL>/verify/<token>`,
which grants the role after the challenge passes. Tokens are single-use and bound
to the member + guild.
