# Contributing to Sylo

Thanks for taking a look. Sylo is a single Node.js process (Discord bot + web
dashboard) with SQLite persistence, run as a Docker container.

## Getting set up

```bash
npm install
cp .env.example .env      # add DISCORD_TOKEN + DISCORD_CLIENT_ID (a test bot)
npm start                 # or: npm run dev  (node --watch)
```

Set `DISCORD_GUILD_ID` to a private test server so slash commands register
instantly.

## Before opening a PR

- `npm test` — the suite must pass. It runs in CI and gates every image build.
- Add or update tests for behaviour you change. Pure helpers get unit tests;
  DB-touching tests import `test/helpers/tmpDb.js` first so they use a throwaway
  database.
- Keep to the existing style: ESM, no build step, no new runtime dependencies
  without discussion, plain CSS + small vanilla JS in `src/web/public`.
- New per-guild storage goes in a migration in `src/db/index.js` (append only —
  migrations are forward-only and run automatically on boot).
- New guild-scoped tables must be added to `GUILD_TABLES` in `src/db/purge.js`
  so they are wiped when Sylo leaves a server.

## Commits & releases

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`,
`fix:`, `refactor:`, `docs:`, `chore:`, and `feat!:` / `BREAKING CHANGE:` for a
major bump. [release-please](https://github.com/googleapis/release-please)
maintains the release PR and `CHANGELOG.md` from commit subjects — one bullet
per subject line, so write them for a human reader.

## Adding a module

1. `src/modules/<id>.js` — register handlers with `on(moduleId, event, fn)` from
   `dispatch.js`, or start a timer for scheduled work.
2. Add it to `MODULES` in `src/modules/registry.js` and import it in
   `src/modules/index.js`.
3. If it stores per-guild config, add a settings partial at
   `src/web/views/guild/modules/<id>.ejs`, list the id in `CONFIG_VIEWS` in
   `src/web/routes/guilds.js`, and handle its config POST there.
4. Give it an overview card line in `src/web/lib/overviewSummary.js`.
