## What

<!-- One or two sentences on the change and why. -->

## Notes

<!-- Anything a reviewer should know: trade-offs, follow-ups, screenshots for UI. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run lint` and `npm run format:check` pass
- [ ] Commits follow Conventional Commits (`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `ci:` / `test:`)
- [ ] New guild-scoped table? `GUILD_TABLES` in `src/db/purge.js` updated (and `forgetUser` if user-scoped)
- [ ] New module? registry + `modules/index.js` + config view + `MODULE_ICONS` + `#i-<name>` SVG
- [ ] `docs/` updated if behaviour or config changed
