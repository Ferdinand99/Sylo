# Changelog

## [3.22.4](https://github.com/Ferdinand99/Sylo/compare/v3.22.3...v3.22.4) (2026-09-05)


### Bug Fixes

* reject open-redirect returnTo paths and rate-limit requireAuth ([#136](https://github.com/Ferdinand99/Sylo/issues/136)) ([7ca6b3b](https://github.com/Ferdinand99/Sylo/commit/7ca6b3b97c7e18977451784805d95a26b3b3127f))

## [3.22.3](https://github.com/Ferdinand99/Sylo/compare/v3.22.2...v3.22.3) (2026-09-04)


### Bug Fixes

* don't let htmx-boosted navigations hit Discord's OAuth redirect … ([88207a0](https://github.com/Ferdinand99/Sylo/commit/88207a0e90c48c7f02ed3dfb9a0241a749871fe8))
* don't let htmx-boosted navigations hit Discord's OAuth redirect directly ([1131078](https://github.com/Ferdinand99/Sylo/commit/1131078576b4cfd25b0579aa5a0b1ed13953f5c3))
* rate-limit the new session-refresh check + a missing backup-download limiter ([65b80e6](https://github.com/Ferdinand99/Sylo/commit/65b80e69780fc54681b185373d7d167a4bebcbbe))

## [3.22.2](https://github.com/Ferdinand99/Sylo/compare/v3.22.1...v3.22.2) (2026-09-04)


### Bug Fixes

* refresh a stale guild-list session automatically ([8599034](https://github.com/Ferdinand99/Sylo/commit/859903463443e813a7a8517d4ebf772bf4390b6e))

## [3.22.1](https://github.com/Ferdinand99/Sylo/compare/v3.22.0...v3.22.1) (2026-09-04)


### Bug Fixes

* gate /health to OWNER_IDS instead of any signed-in user ([#126](https://github.com/Ferdinand99/Sylo/issues/126)) ([22ef2f8](https://github.com/Ferdinand99/Sylo/commit/22ef2f84255d080f3ed39fea0c7f60dafe7c625c))

## [3.22.0](https://github.com/Ferdinand99/Sylo/compare/v3.21.0...v3.22.0) (2026-09-04)


### Features

* internal gateway sharding via DISCORD_SHARD_COUNT ([#124](https://github.com/Ferdinand99/Sylo/issues/124)) ([d30e802](https://github.com/Ferdinand99/Sylo/commit/d30e802fe9df19f5ea74667eda88ac9f3ceec605))

## [3.21.0](https://github.com/Ferdinand99/Sylo/compare/v3.20.0...v3.21.0) (2026-09-04)


### Features

* per-server auto-prune for old closed tickets and inactive cases ([951b952](https://github.com/Ferdinand99/Sylo/commit/951b952de9dff0e53f78b2acbb7ee3b053af231a))

## [3.20.0](https://github.com/Ferdinand99/Sylo/compare/v3.19.3...v3.20.0) (2026-09-03)


### Features

* add /mydata self-service data export ([5f7ec3d](https://github.com/Ferdinand99/Sylo/commit/5f7ec3d322b46039f10358481d24fae082a8edd8))

## [3.19.3](https://github.com/Ferdinand99/Sylo/compare/v3.19.2...v3.19.3) (2026-09-03)


### Bug Fixes

* show temp-voice channel names on the Insights top list ([c8885f8](https://github.com/Ferdinand99/Sylo/commit/c8885f8ebbfa2c584d1915c311222da7f3e5bd8a))

## [3.19.2](https://github.com/Ferdinand99/Sylo/compare/v3.19.1...v3.19.2) (2026-09-03)


### Bug Fixes

* build the YouTube resolver request from a literal youtube.com or… ([a4ec2c2](https://github.com/Ferdinand99/Sylo/commit/a4ec2c29ae3db712d86f937b557b71cff4713afe))

## [3.19.1](https://github.com/Ferdinand99/Sylo/compare/v3.19.0...v3.19.1) (2026-09-03)


### Bug Fixes

* harden the feed parser, YouTube resolver and alert URL parsing (CodeQL) ([6240733](https://github.com/Ferdinand99/Sylo/commit/6240733d7d8bd38e5d47c5e53dd915bbae1ca7ac))
* harden the feed parser, YouTube resolver and alert URL parsing (CodeQL) ([#113](https://github.com/Ferdinand99/Sylo/issues/113)) ([6240733](https://github.com/Ferdinand99/Sylo/commit/6240733d7d8bd38e5d47c5e53dd915bbae1ca7ac))

## [3.19.0](https://github.com/Ferdinand99/Sylo/compare/v3.18.0...v3.19.0) (2026-09-03)


### Features

* clean up the "went live" alert message when a stream ends ([#110](https://github.com/Ferdinand99/Sylo/issues/110)) ([#111](https://github.com/Ferdinand99/Sylo/issues/111)) ([94cafe2](https://github.com/Ferdinand99/Sylo/commit/94cafe2add6f047574033dded81f341f8d99152f))

## [3.18.0](https://github.com/Ferdinand99/Sylo/compare/v3.17.0...v3.18.0) (2026-09-03)


### Features

* numbered moderation case log with /history and /case ([#108](https://github.com/Ferdinand99/Sylo/issues/108)) ([cce1358](https://github.com/Ferdinand99/Sylo/commit/cce13587add241f2dda5e713581ab05655272afe))

## [3.17.0](https://github.com/Ferdinand99/Sylo/compare/v3.16.0...v3.17.0) (2026-09-03)


### Features

* off-site database backups, a Grafana dashboard, and a route-test fix ([#106](https://github.com/Ferdinand99/Sylo/issues/106)) ([1d578af](https://github.com/Ferdinand99/Sylo/commit/1d578afe2da015103c75b3b8f6b4dc54000957c6))

## [3.16.0](https://github.com/Ferdinand99/Sylo/compare/v3.15.0...v3.16.0) (2026-09-03)


### Features

* voice XP, XP multipliers, and weekly/monthly leaderboards for leveling ([#104](https://github.com/Ferdinand99/Sylo/issues/104)) ([1097b1d](https://github.com/Ferdinand99/Sylo/commit/1097b1d6bd9dbfc8eb0c16e3adc47539dc437ac7))

## [3.15.0](https://github.com/Ferdinand99/Sylo/compare/v3.14.0...v3.15.0) (2026-09-03)


### Features

* add a RuneScape (OSRS + RS3) stats adapter and flatten /stats ([#101](https://github.com/Ferdinand99/Sylo/issues/101)) ([ff72d39](https://github.com/Ferdinand99/Sylo/commit/ff72d39660621f9e6272babe7dea1ec4fa9a0a93))


### Miscellaneous Chores

* re-anchor release-please to 3.15.0 ([313b67a](https://github.com/Ferdinand99/Sylo/commit/313b67a88b1f952242c776f6958672365d4e1396))

## [3.14.0](https://github.com/Ferdinand99/Sylo/compare/v3.13.0...v3.14.0) (2026-09-03)


### Features

* resolve Reddit, Mastodon and Bluesky handles in the RSS module ([550bbbd](https://github.com/Ferdinand99/Sylo/commit/550bbbd2d7fbc5295c0cff2322e5249264f5ab39))

## [3.13.0](https://github.com/Ferdinand99/Sylo/compare/v3.12.0...v3.13.0) (2026-09-02)


### Features

* insights — voice-channel usage, an hourly view, and on-demand refresh ([9bb052e](https://github.com/Ferdinand99/Sylo/commit/9bb052e5b2505b7349bca8477133e4d90c76af5b))

## [3.12.0](https://github.com/Ferdinand99/Sylo/compare/v3.11.2...v3.12.0) (2026-09-02)


### Features

* use the bot's avatar as the dashboard favicon ([92ba0c9](https://github.com/Ferdinand99/Sylo/commit/92ba0c99e881551b7e1afc4144f4c8dcb868e2c3))
* use the bot's avatar as the dashboard favicon ([fa85eec](https://github.com/Ferdinand99/Sylo/commit/fa85eec81ab6eb01f5a504ddc949030572a66156))

## [3.11.2](https://github.com/Ferdinand99/Sylo/compare/v3.11.1...v3.11.2) (2026-09-02)


### Bug Fixes

* /health rendered JSON instead of the page on an hx-boost sidebar click ([3f18e70](https://github.com/Ferdinand99/Sylo/commit/3f18e707470231d60434833dcb8e90972b14b64f))
* /health rendered JSON instead of the page on an hx-boost sidebar… ([9e66533](https://github.com/Ferdinand99/Sylo/commit/9e6653371be8f75151f784e8de9e56762f4f6133))

## [3.11.1](https://github.com/Ferdinand99/Sylo/compare/v3.11.0...v3.11.1) (2026-09-02)


### Bug Fixes

* sticky messages can bump for other apps' messages, with a per-ch… ([568e937](https://github.com/Ferdinand99/Sylo/commit/568e937c992f56bc3a6cf326e11c075220f8a8f4))
* sticky messages can bump for other apps' messages, with a per-channel cooldown ([1fc1c11](https://github.com/Ferdinand99/Sylo/commit/1fc1c11bbda137529fa58d14d162c6f0b175340c))

## [3.11.0](https://github.com/Ferdinand99/Sylo/compare/v3.10.0...v3.11.0) (2026-09-02)


### Features

* server insights — daily activity charts ([0458032](https://github.com/Ferdinand99/Sylo/commit/04580324c5ba0ebcdcf68726098f37ed9262b5eb))
* server insights — daily activity charts ([e32d387](https://github.com/Ferdinand99/Sylo/commit/e32d38716b5fbe9ad677c536c6456b5a418a1c6e))

## [3.10.0](https://github.com/Ferdinand99/Sylo/compare/v3.9.0...v3.10.0) (2026-09-02)


### Features

* RSS / Atom feed alerts ([834128e](https://github.com/Ferdinand99/Sylo/commit/834128e11be6fc05eb1f466cc78de385af9e6560))
* RSS / Atom feed alerts ([58432c8](https://github.com/Ferdinand99/Sylo/commit/58432c8a7ff25913b095cf43cc1b16e34ac3c3f8))

## [3.9.0](https://github.com/Ferdinand99/Sylo/compare/v3.8.0...v3.9.0) (2026-09-02)


### Features

* Kick.com live alerts ([6557685](https://github.com/Ferdinand99/Sylo/commit/65576854b92cbbdc2637a984a79f027e70f30b1e))
* Kick.com live alerts ([7b13cc7](https://github.com/Ferdinand99/Sylo/commit/7b13cc70caec58886a38e3d79b984feafcac3afb))
* plain-text (no embed) option for Twitch and Kick alerts ([c694b8d](https://github.com/Ferdinand99/Sylo/commit/c694b8d95506500e37ee535b8429900f7f17a494))

## [3.8.0](https://github.com/Ferdinand99/Sylo/compare/v3.7.0...v3.8.0) (2026-09-02)


### Features

* push mappable automod checks to native Discord AutoMod ([ec9b1bb](https://github.com/Ferdinand99/Sylo/commit/ec9b1bb433f5db8d5fb0b91185bc17d023976526))
* push mappable automod checks to native Discord AutoMod ([7674ede](https://github.com/Ferdinand99/Sylo/commit/7674edeca73e9dce3385250e1748feb03d9fcc96))

## [3.7.0](https://github.com/Ferdinand99/Sylo/compare/v3.6.1...v3.7.0) (2026-09-02)


### Features

* Prometheus /metrics endpoint, request logging, and richer /health ([9e418f7](https://github.com/Ferdinand99/Sylo/commit/9e418f77135e45e34d5ae9dee53efefbde17f717))
* Prometheus /metrics endpoint, request logging, and richer /health ([a12ef80](https://github.com/Ferdinand99/Sylo/commit/a12ef80a11c433c1f41bbdc1e42cf393feeda7c4))

## [3.6.1](https://github.com/Ferdinand99/Sylo/compare/v3.6.0...v3.6.1) (2026-09-02)


### Bug Fixes

* temp-voice hub 404 on edit/delete and server-mute in spawned cha… ([38e0c75](https://github.com/Ferdinand99/Sylo/commit/38e0c758a40303bb9b6294ab11d17ef8c8269ea8))
* temp-voice hub 404 on edit/delete and server-mute in spawned channels ([c3af795](https://github.com/Ferdinand99/Sylo/commit/c3af795a26d2e62f6ba38d2bca898b69feca67a5))

## [3.6.0](https://github.com/Ferdinand99/Sylo/compare/v3.5.0...v3.6.0) (2026-09-02)


### Features

* dashboard module filter, light theme, per-module test, bulk toggle ([3b9fbc3](https://github.com/Ferdinand99/Sylo/commit/3b9fbc3feea50d627b6cd17aa182e9cad35506f8))
* dashboard module filter, light theme, per-module test, bulk toggle ([de4d23c](https://github.com/Ferdinand99/Sylo/commit/de4d23cc05e1f6f2c1f28fa2a6654f503166ce63))

## [3.5.0](https://github.com/Ferdinand99/Sylo/compare/v3.4.1...v3.5.0) (2026-09-02)


### Features

* welcome images and a Birthdays module ([c2fb9f8](https://github.com/Ferdinand99/Sylo/commit/c2fb9f8fdf38bf04108941335593d864abb7cfa1))
* welcome images and a Birthdays module ([774d731](https://github.com/Ferdinand99/Sylo/commit/774d731e312a3ef7e4f30974b925e8f536374bba))

## [3.4.1](https://github.com/Ferdinand99/Sylo/compare/v3.4.0...v3.4.1) (2026-09-02)


### Bug Fixes

* hx-boost dashboard nav and show every save as a toast ([79efafc](https://github.com/Ferdinand99/Sylo/commit/79efafcb3745a99c71b3e124daedce36796ca0d8))
* hx-boost dashboard nav and show every save as a toast ([09f0e7c](https://github.com/Ferdinand99/Sylo/commit/09f0e7cfcdc7748365b804a0a58794a61c7a7c54))
* toast reliably after hx-boost nav, no result-banner flash ([26db4d8](https://github.com/Ferdinand99/Sylo/commit/26db4d8a3226967b7ccf0475dad5ffa0a94638d6))

## [3.4.0](https://github.com/Ferdinand99/Sylo/compare/v3.3.0...v3.4.0) (2026-09-02)


### Features

* channel lock/lockdown and temporary bans ([e76a031](https://github.com/Ferdinand99/Sylo/commit/e76a0314b3c486c2e0a8e30cb5b915ce068bc94c))
* channel lock/lockdown and temporary bans ([c77b150](https://github.com/Ferdinand99/Sylo/commit/c77b1504cb31ed5585861064f90405befc674d3f))
* remove and clear warnings from the dashboard ([1e4bed9](https://github.com/Ferdinand99/Sylo/commit/1e4bed989d8728756f0d241e4eeecfc69e9e9af8))
* surface channel locks and temp-bans on the moderation page ([9ff5284](https://github.com/Ferdinand99/Sylo/commit/9ff52840a4f00d6d13718bd995d0575051f3cd2a))


### Bug Fixes

* keep the Infractions tab selected after a moderation action ([ace737f](https://github.com/Ferdinand99/Sylo/commit/ace737f7d0fe2d57874f5f116791e31478163f4f))

## [3.3.0](https://github.com/Ferdinand99/Sylo/compare/v3.2.0...v3.3.0) (2026-09-02)


### Features

* publish multi-arch (amd64 + arm64) Docker images ([b115906](https://github.com/Ferdinand99/Sylo/commit/b115906165c3e40b4961921e158e8dc924924e97))


### Bug Fixes

* harden the dashboard — open-mode CSRF, rate limits, clean shutdown ([603ac91](https://github.com/Ferdinand99/Sylo/commit/603ac9129630c8111cd000b5539d0a53db8e3675))

## [3.2.0](https://github.com/Ferdinand99/Sylo/compare/v3.1.0...v3.2.0) (2026-09-02)


### Features

* Member data page — inspect and erase a member's data with a DM receipt ([2273def](https://github.com/Ferdinand99/Sylo/commit/2273def275de6d8db1337fcb46699aded5bd3553))


### Bug Fixes

* /forget also clears AFK status and giveaway entries ([1aaf451](https://github.com/Ferdinand99/Sylo/commit/1aaf4514471d7b3d6fa03f0b1e5786a5b1ab31f8))

## [3.1.0](https://github.com/Ferdinand99/Sylo/compare/v3.0.0...v3.1.0) (2026-09-01)


### Features

* icon hero on all guild sub-pages; match sidebar icons ([b88403f](https://github.com/Ferdinand99/Sylo/commit/b88403ff21a455c2441e6b1f9feeeb87379a6736))
* module-page hero header and empty-state component ([d177530](https://github.com/Ferdinand99/Sylo/commit/d1775307e27b009e9aec7b40bf319fcb9436a6cc))

## [3.0.0](https://github.com/Ferdinand99/Sylo/compare/v2.14.0...v3.0.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* requires Node 22; DISCORD_GUILD_ID renamed to DISCORD_DEV_GUILD_IDS; /stats now requires the new Game stats module to be enabled; the reminders module id changed from scheduled-messages to reminders.

### Features

* leaderboard vanity URLs; move cached-stats list to the Game stats page ([21b3f07](https://github.com/Ferdinand99/Sylo/commit/21b3f07a8804421e8b829922b2770160ecf8de82))
* Node 22, Game stats module, reminders module id, DISCORD_DEV_GUILD_IDS ([d309908](https://github.com/Ferdinand99/Sylo/commit/d309908e6501452c26fa97d0482d503a8771c4ff))

## [2.14.0](https://github.com/Ferdinand99/Sylo/compare/v2.13.0...v2.14.0) (2026-09-01)


### Features

* add a Giveaways module ([8a6869b](https://github.com/Ferdinand99/Sylo/commit/8a6869ba75481be863a884feb9e6546486b17a6c))


### Bug Fixes

* debounce giveaway entry edits, stop reroll re-pinging, batch leaderboard fetch ([ca0eb2d](https://github.com/Ferdinand99/Sylo/commit/ca0eb2d44cb60f8ed379c492021324878303eade))

## [2.13.0](https://github.com/Ferdinand99/Sylo/compare/v2.12.0...v2.13.0) (2026-09-01)


### Features

* button and dropdown styles for self-assign roles ([af6c642](https://github.com/Ferdinand99/Sylo/commit/af6c6428e7a23ed3842c565b189ee0a996bd923d))
* render /rank and /leaderboard as image cards ([12a687c](https://github.com/Ferdinand99/Sylo/commit/12a687ce259d1f4839cb3937f4a1d65d9d20a786))

## [2.12.0](https://github.com/Ferdinand99/Sylo/compare/v2.11.0...v2.12.0) (2026-09-01)


### Features

* automatic database backups, restore and WAL checkpointing ([d3394c3](https://github.com/Ferdinand99/Sylo/commit/d3394c3297443f8135e2bee155c7d1afafb1f1ac))
* structured logging, /health error history, and CSRF protection ([ee51021](https://github.com/Ferdinand99/Sylo/commit/ee51021f0ae932ad7438ddff13f6f18d8144c9d5))

## [2.11.0](https://github.com/Ferdinand99/Sylo/compare/v2.10.0...v2.11.0) (2026-08-31)


### Features

* add Twitch and YouTube alert modules ([af67f5b](https://github.com/Ferdinand99/Sylo/commit/af67f5be6b18c82fc3b3788da2f532ab2596625a))
* add Twitch and YouTube alert modules ([f8b4035](https://github.com/Ferdinand99/Sylo/commit/f8b4035aa0b8fb04f522b08c4e9680f308c97368))
* add Twitch and YouTube alert modules ([8591faf](https://github.com/Ferdinand99/Sylo/commit/8591faf4c14ef062fdaa21323db0a0614596c8c8))
* rebuild Temporary voice channels as MEE6-style hubs with /voice-* commands ([5d64607](https://github.com/Ferdinand99/Sylo/commit/5d64607b15f59bb880b7108be322d52cccf41791))
* rework Scheduled messages into MEE6-style Reminders ([a93ff51](https://github.com/Ferdinand99/Sylo/commit/a93ff51430c45ff226a019231b2bc1f0cf9b35c9))

## [2.10.0](https://github.com/Ferdinand99/Sylo/compare/v2.9.2...v2.10.0) (2026-08-31)


### Features

* add a Polls module ([aca2672](https://github.com/Ferdinand99/Sylo/commit/aca2672ec784ec03714a9c1c92527e91123f39ed))
* rebuild the Message Creator as MEE6-style Embed Messages ([92d4801](https://github.com/Ferdinand99/Sylo/commit/92d48010cabf04648142c583c102f301ad3c6840))

## [2.9.2](https://github.com/Ferdinand99/Sylo/compare/v2.9.1...v2.9.2) (2026-08-31)


### Bug Fixes

* distinguish missing-permission from untrackable in the invite tracker ([a49413a](https://github.com/Ferdinand99/Sylo/commit/a49413a2705f3443e9a2ae1d34e880cd0b8839cf))

## [2.9.1](https://github.com/Ferdinand99/Sylo/compare/v2.9.0...v2.9.1) (2026-08-31)


### Bug Fixes

* clearer permission feedback in /invites ([5e5e248](https://github.com/Ferdinand99/Sylo/commit/5e5e2482a220ff58bd3f7678946a60c2beeaa9c6))

## [2.9.0](https://github.com/Ferdinand99/Sylo/compare/v2.8.1...v2.9.0) (2026-08-31)


### Features

* rebuild custom commands and add an invite tracker ([e892630](https://github.com/Ferdinand99/Sylo/commit/e892630c8e563d544b38f09d4e51fd83b38ecd4f))

## [2.8.1](https://github.com/Ferdinand99/Sylo/compare/v2.8.0...v2.8.1) (2026-08-30)


### Bug Fixes

* accept multiple DISCORD_GUILD_ID values and handle a missing bot member ([2b461a4](https://github.com/Ferdinand99/Sylo/commit/2b461a4237a2dbefa44ddc103bbe14430990874d))

## [2.8.0](https://github.com/Ferdinand99/Sylo/compare/v2.7.1...v2.8.0) (2026-08-30)


### Features

* add a Starboard module ([abea2b7](https://github.com/Ferdinand99/Sylo/commit/abea2b7164de4f3da0fa9849c0a8566db88ae467))

## [2.7.1](https://github.com/Ferdinand99/Sylo/compare/v2.7.0...v2.7.1) (2026-08-30)


### Bug Fixes

* use a valid CDN size for the sidebar guild icon ([f1c0012](https://github.com/Ferdinand99/Sylo/commit/f1c0012931e6aa6c2722528dfcad8013d67680a9))

## [2.7.0](https://github.com/Ferdinand99/Sylo/compare/v2.6.0...v2.7.0) (2026-08-30)


### Features

* MEE6-style dashboard redesign + temp voice & welcome channel modules ([a832d5f](https://github.com/Ferdinand99/Sylo/commit/a832d5fdc670c963fc4da64ec3469b956a29ba13))

## [2.6.0](https://github.com/Ferdinand99/Sylo/compare/v2.5.1...v2.6.0) (2026-08-30)


### Features

* add temporary voice channels module ([61f0b7d](https://github.com/Ferdinand99/Sylo/commit/61f0b7da32fa04d5cb67fa129a8da7766688639b))

## [2.5.1](https://github.com/Ferdinand99/Sylo/compare/v2.5.0...v2.5.1) (2026-08-30)


### Bug Fixes

* make server statistics refresh interval configurable ([74ce4f9](https://github.com/Ferdinand99/Sylo/commit/74ce4f986df79748beb870a70192140c83972358))

## [2.5.0](https://github.com/Ferdinand99/Sylo/compare/v2.4.0...v2.5.0) (2026-08-30)


### Features

* add ban appeal system ([80ce8a3](https://github.com/Ferdinand99/Sylo/commit/80ce8a37c4ed9202e4052edb836b3ca1dff2704f))

## [2.4.0](https://github.com/Ferdinand99/Sylo/compare/v2.3.0...v2.4.0) (2026-08-30)


### Features

* add IsThereAnyDeal as a Free games source ([c765277](https://github.com/Ferdinand99/Sylo/commit/c7652774be0739fbe3836361151c1ecf85ce9544))

## [2.3.0](https://github.com/Ferdinand99/Sylo/compare/v2.2.1...v2.3.0) (2026-08-30)


### Features

* add AFK and Server statistics modules ([0264182](https://github.com/Ferdinand99/Sylo/commit/0264182cda5ccc7b45efc2b19c9f3869714054d7))

## [2.2.1](https://github.com/Ferdinand99/Sylo/compare/v2.2.0...v2.2.1) (2026-08-30)


### Bug Fixes

* **ci:** push Docker media types so Unraid's update check works ([85f5a62](https://github.com/Ferdinand99/Sylo/commit/85f5a628984a776adeee53c3cae47f53366668af))

## [2.2.0](https://github.com/Ferdinand99/Sylo/compare/v2.1.0...v2.2.0) (2026-08-30)


### Features

* add the Verification module (Verify button + Turnstile captcha) ([3ab4ff2](https://github.com/Ferdinand99/Sylo/commit/3ab4ff2abe84f25acc6732e14c5a98493fb8ee77))

## [2.1.0](https://github.com/Ferdinand99/Sylo/compare/v2.0.1...v2.1.0) (2026-08-30)


### Features

* add Autoresponder, /help, and dashboard-configurable bot presence ([5eb3d7d](https://github.com/Ferdinand99/Sylo/commit/5eb3d7d7dca386ff877d819590aa99139bf5fbcb))

## [2.0.1](https://github.com/Ferdinand99/Sylo/compare/v2.0.0...v2.0.1) (2026-08-30)


### Bug Fixes

* **ci:** give the test job placeholder Discord env vars ([ae3a308](https://github.com/Ferdinand99/Sylo/commit/ae3a3081780237e394f30fcf6ea91bc02861cb85))

## [2.0.0](https://github.com/Ferdinand99/Sylo/compare/v1.15.0...v2.0.0) (2026-08-30)


### Features

* 2.0 hardening — CI test gate, data controls, audit log, rate limiting ([9eaeab1](https://github.com/Ferdinand99/Sylo/commit/9eaeab13bdbecf0b6f2fd33695bb93adc4eb98c0))

## [1.15.0](https://github.com/Ferdinand99/Sylo/compare/v1.14.0...v1.15.0) (2026-08-30)


### Features

* make the Leveling module functional with a public leaderboard ([babde97](https://github.com/Ferdinand99/Sylo/commit/babde9707afd371e173254ad992e781c49aca53d))

## [1.14.0](https://github.com/Ferdinand99/Sylo/compare/v1.13.0...v1.14.0) (2026-08-30)


### Features

* make Custom commands and Scheduled messages functional ([876b4e9](https://github.com/Ferdinand99/Sylo/commit/876b4e928a52fa26ef41edf31bb7aa7c21de84dc))

## [1.13.0](https://github.com/Ferdinand99/Sylo/compare/v1.12.0...v1.13.0) (2026-08-30)


### Features

* add Counting mini-game and make Auto-moderation functional ([ce2c345](https://github.com/Ferdinand99/Sylo/commit/ce2c345c416a3f9cb769aad434cce60d6be4acec))

## [1.12.0](https://github.com/Ferdinand99/Sylo/compare/v1.11.0...v1.12.0) (2026-08-29)


### Features

* **bot:** add /version and /about commands ([be7e177](https://github.com/Ferdinand99/Sylo/commit/be7e17753d1866a563be57b898cd06249700fb6b))

## [1.11.0](https://github.com/Ferdinand99/Sylo/compare/v1.10.0...v1.11.0) (2026-08-29)


### Features

* **web:** add topbar server switcher and rework the dashboard ([1b4f254](https://github.com/Ferdinand99/Sylo/commit/1b4f254e621bda6ad34976c186c8cf20ea10acd4))

## [1.10.0](https://github.com/Ferdinand99/Sylo/compare/v1.9.0...v1.10.0) (2026-08-29)


### Features

* Message Creator — compose and send messages/embeds as the bot ([c0009a2](https://github.com/Ferdinand99/Sylo/commit/c0009a28226d512bb07c1f0ba078454e5bce8e63))

## [1.9.0](https://github.com/Ferdinand99/Sylo/compare/v1.8.0...v1.9.0) (2026-08-29)


### Features

* downloadable ticket transcripts with local-time timestamps ([fe43de2](https://github.com/Ferdinand99/Sylo/commit/fe43de2109eaf03ef9f331082a9f4315217fea3e))
* ticket / modmail system (DM the bot, staff reply from the dashboard) ([2e8f98f](https://github.com/Ferdinand99/Sylo/commit/2e8f98f8afd1ced41f9c604abb1c7fc26ea794ba))

## [1.8.0](https://github.com/Ferdinand99/Sylo/compare/v1.7.0...v1.8.0) (2026-08-29)


### Features

* functional Moderation, Reaction roles/Autoroles, and Sticky messages ([1134f55](https://github.com/Ferdinand99/Sylo/commit/1134f55829c20fd9fa4e8381aff0f8ca62f2d5a8))

## [1.7.0](https://github.com/Ferdinand99/Sylo/compare/v1.6.0...v1.7.0) (2026-08-29)


### Features

* functional Server logging and Welcome & leave modules ([f532494](https://github.com/Ferdinand99/Sylo/commit/f532494aabc153d42b3ed5bbd678b8e187e5969b))

## [1.6.0](https://github.com/Ferdinand99/Sylo/compare/v1.5.0...v1.6.0) (2026-08-29)


### Features

* per-guild control panel with module toggles and command management ([7e465a3](https://github.com/Ferdinand99/Sylo/commit/7e465a38bf578de8f24ed494aa623d82ec68256d))

## [1.5.0](https://github.com/Ferdinand99/Sylo/compare/v1.4.1...v1.5.0) (2026-08-29)


### Features

* optional Discord OAuth2 login for the dashboard ([2cac5fe](https://github.com/Ferdinand99/Sylo/commit/2cac5fe090aa5f7192d546c91952ab91a55713d8))

## [1.4.1](https://github.com/Ferdinand99/Sylo/compare/v1.4.0...v1.4.1) (2026-08-29)


### Bug Fixes

* create the SQLite data dir writable on root-owned volume mounts ([1fbd909](https://github.com/Ferdinand99/Sylo/commit/1fbd909ce1094abd0d1a4f135adf2fdc7db09a62))

## [1.4.0](https://github.com/Ferdinand99/Sylo/compare/v1.3.0...v1.4.0) (2026-08-29)


### Features

* tell the dashboard when a warning wasn't logged, fix banner colour ([9571c2d](https://github.com/Ferdinand99/Sylo/commit/9571c2dc0e9c83dd633ae581ba6f397dc2dd0bc3))

## [1.3.0](https://github.com/Ferdinand99/Sylo/compare/v1.2.0...v1.3.0) (2026-08-29)


### Features

* moderation dashboard — mod-log channel, warnings (view + add), bans ([740ea65](https://github.com/Ferdinand99/Sylo/commit/740ea65f24dc75bbf5b0ac9e82747ebd687135be))

## [1.2.0](https://github.com/Ferdinand99/Sylo/compare/v1.1.0...v1.2.0) (2026-08-28)


### Features

* add moderator commands (kick, ban, timeout, purge, warn, modlog) ([25eabff](https://github.com/Ferdinand99/Sylo/commit/25eabffa1904ff2fc411269075446c77c3365f89))

## [1.1.0](https://github.com/Ferdinand99/Sylo/compare/v1.0.0...v1.1.0) (2026-08-28)


### Features

* scaffold Sylo bot, stats adapter, web dashboard, and Docker setup ([109e1f7](https://github.com/Ferdinand99/Sylo/commit/109e1f799c42bf7b92dddfde24a6819662d9b894))
