# Fluxer Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the composite `"discord:123…"` / `"fluxer:456…"` guild-id
convention end-to-end — a new helper module, a multi-client `runtime.js`, the
two chokepoints that translate it (`send.js`, `moduleEvents.js`), the two
confirmed snowflake-validation leaks, and a one-time data migration — with
**zero behavior change** for the existing Discord-only deployment.

**Architecture:** Every guild id in application code becomes an opaque
`"<platform>:<raw id>"` string instead of a bare snowflake. `runtime.js`
grows a `clients: { discord, fluxer }` map behind a backward-compatible
`client` getter/setter alias. `send.js` and `moduleEvents.js` are the only
two places that actually split/compose the string — everything else
(`dispatch.js`, all 25 feature modules, the DB layer) already treats guild
ids as opaque strings and needs no change, per this session's own DB-layer
audit.

**Tech Stack:** Node.js (ESM), better-sqlite3 (SQLite) + `postgres` (optional
Postgres path via `src/db/driver.js`), `node:test` + `node:assert/strict`,
discord.js.

**Spec:** `C:\Users\ferdi\.claude\plans\majestic-enchanting-ritchie.md`
(decisions 1–3; this plan implements the roadmap's "Phase 1 — Foundation").

## Global Constraints

- No behavior change for an existing Discord-only deployment — every
  existing test must keep passing unmodified except where a task explicitly
  touches it.
- `runtime.client` (read **and** write, including direct assignment —
  `runtime.client = x`, used throughout the existing test suite, not just
  through `setClient()`) must keep working exactly as today.
- Every new/changed file: run `npx eslint <file>` and `npx prettier --check
  <file>` before marking a task done (project convention — see repo's
  existing commits this session).
- SQLite is the only driver most deployments use; any schema/data change
  needs a matching Postgres path via `registerPostgresMigration()`
  (`src/db/driver.js`) — see Task 6.
- Follow TDD: write the failing test first, watch it fail for the stated
  reason, then implement.

## Review Focus

- **Direct `runtime.client = x` assignment** (not via `setClient()`) is used
  pervasively by the existing test suite (`test/auth.test.js`,
  `test/devLog.test.js`, `test/moderation.tempBan.test.js`,
  `test/youtubeAlerts.runAlert.test.js`, `test/helpers/webApp.js`) — if
  `client` becomes a getter-only property this throws under ESM's strict
  mode and the whole suite breaks. Task 2 covers this with an explicit
  read-and-write round-trip test.
- **A malformed/non-composite guildId reaching `send.js`** (legacy bare
  snowflake, typo, empty string) must fail closed — return `null`/`false`,
  never throw, never silently resolve against the wrong platform's client.
  Task 3 covers this.
- **`dispatch()` called with a falsy guildId** (`member.guild?.id` when the
  member object is partial/guildless) must not throw when wrapped — the
  wrapper must pass `null`/`undefined` straight through so `dispatch()`'s own
  `if (!guildId) return;` guard still fires. Task 4 covers this.
- **The migration running twice** (re-applied by hand, or any future bug
  that re-triggers it) must not double-prefix a row into
  `"discord:discord:123…"`. Task 6 covers this with an idempotency test.
- **`verifyAppealToken`/`verifyVerifyToken` accepting a composite guildId
  without becoming more permissive than intended** — a malformed value
  (`"fluxer:"` with an empty id, plain garbage, a bare snowflake that used to
  pass) must still be rejected. Task 5 covers both directions.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/platformId.js` (new) | The composite-id convention itself: `makePlatformGuildId`, `splitPlatformGuildId`, `isPlatformGuildId`. Pure, dependency-free. |
| `src/runtime.js` (modify) | `runtime.clients` map + back-compat `client` getter/setter; new `clientFor`/`setClientFor`. |
| `src/modules/lib/send.js` (modify) | `usableChannel()` resolves the right platform's client from a composite guildId. |
| `src/bot/events/moduleEvents.js` (modify) | Wraps every raw `guild.id`/`guildId` into composite form once, at the Discord gateway→dispatch boundary. |
| `src/modules/appeals.js` (modify) | `verifyAppealToken()` accepts a composite guildId. |
| `src/modules/verification.js` (modify) | `verifyVerifyToken()` accepts a composite guildId. |
| `src/db/index.js` (modify) | New migration #46: backfill every `GUILD_TABLES` row's `guild_id` with the `discord:` prefix (SQLite). |
| `src/db/purge.js` (modify) | Postgres twin of the same backfill, via `registerPostgresMigration(46, …)`. |

---

## Task 1: `src/lib/platformId.js` — composite guild-id helpers

**Files:**
- Create: `src/lib/platformId.js`
- Test: `test/platformId.test.js`

**Interfaces:**
- Produces: `PLATFORMS: string[]` (`['discord', 'fluxer']`),
  `makePlatformGuildId(platform: string, rawId: string): string` (throws on
  an unknown platform), `splitPlatformGuildId(value: unknown): {platform:
  string, rawId: string} | null`, `isPlatformGuildId(value: unknown):
  boolean`.

- [ ] **Step 1: Write the failing test**

```js
// test/platformId.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, makePlatformGuildId, splitPlatformGuildId, isPlatformGuildId } from '../src/lib/platformId.js';

test('PLATFORMS lists exactly discord and fluxer', () => {
  assert.deepEqual(PLATFORMS, ['discord', 'fluxer']);
});

test('makePlatformGuildId builds the composite string', () => {
  assert.equal(makePlatformGuildId('discord', '123456789012345678'), 'discord:123456789012345678');
  assert.equal(makePlatformGuildId('fluxer', '987654321098765432'), 'fluxer:987654321098765432');
});

test('makePlatformGuildId throws on an unknown platform', () => {
  assert.throws(() => makePlatformGuildId('telegram', '123'), /Unknown platform/);
});

test('splitPlatformGuildId round-trips a value makePlatformGuildId produced', () => {
  const id = makePlatformGuildId('discord', '123456789012345678');
  assert.deepEqual(splitPlatformGuildId(id), { platform: 'discord', rawId: '123456789012345678' });
});

test('splitPlatformGuildId rejects malformed input', () => {
  assert.equal(splitPlatformGuildId('123456789012345678'), null); // bare snowflake, no prefix
  assert.equal(splitPlatformGuildId('telegram:123'), null); // unknown platform
  assert.equal(splitPlatformGuildId('discord:'), null); // empty raw id
  assert.equal(splitPlatformGuildId(''), null);
  assert.equal(splitPlatformGuildId(null), null);
  assert.equal(splitPlatformGuildId(undefined), null);
  assert.equal(splitPlatformGuildId(12345), null);
});

test('isPlatformGuildId mirrors splitPlatformGuildId', () => {
  assert.equal(isPlatformGuildId('discord:123'), true);
  assert.equal(isPlatformGuildId('fluxer:456'), true);
  assert.equal(isPlatformGuildId('123'), false);
  assert.equal(isPlatformGuildId('discord:'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/platformId.test.js`
Expected: FAIL — `Cannot find module '../src/lib/platformId.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/platformId.js
// Composite guild-id convention: every guild id in application code is
// "<platform>:<raw id>" (e.g. "discord:123456789012345678"), not a bare
// snowflake — so a single opaque guildId string can be routed to the right
// platform's client (src/runtime.js) without any DB schema change. See the
// architecture plan (docs/superpowers/plans — Fluxer dual-platform support)
// for the full rationale.
export const PLATFORMS = ['discord', 'fluxer'];

/**
 * @param {'discord'|'fluxer'} platform
 * @param {string} rawId
 * @returns {string}
 */
export function makePlatformGuildId(platform, rawId) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  return `${platform}:${rawId}`;
}

/**
 * @param {unknown} value
 * @returns {{ platform: 'discord'|'fluxer', rawId: string } | null}
 */
export function splitPlatformGuildId(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(':');
  if (i === -1) return null;
  const platform = value.slice(0, i);
  const rawId = value.slice(i + 1);
  if (!PLATFORMS.includes(platform) || !rawId) return null;
  return { platform, rawId };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlatformGuildId(value) {
  return splitPlatformGuildId(value) !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/platformId.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Lint and format**

Run: `npx eslint src/lib/platformId.js test/platformId.test.js && npx prettier --check src/lib/platformId.js test/platformId.test.js`
Expected: both clean. If prettier reports differences, run `npx prettier --write` on the same two files only, then re-run both checks.

- [ ] **Step 6: Commit**

```bash
git add src/lib/platformId.js test/platformId.test.js
git commit -m "feat(platform): add the composite discord:/fluxer: guild-id helpers"
```

---

## Task 2: `src/runtime.js` — multi-client, backward-compatible

**Files:**
- Modify: `src/runtime.js`
- Test: `test/runtime.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `runtime.clients: { discord: Client|null, fluxer: object|null }`,
  `runtime.client` (getter **and** setter, aliases `runtime.clients.discord`),
  `clientFor(platform: string): Client|object|null`,
  `setClientFor(platform: string, client: unknown): void`. `setClient`,
  `isDiscordReady`, `guildCount`, `recordError`, `recordGatewayPing`,
  `uptimeSeconds` keep their exact existing signatures and behavior.

- [ ] **Step 1: Write the failing test**

```js
// test/runtime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, setClient, clientFor, setClientFor, isDiscordReady, guildCount } from '../src/runtime.js';

test('runtime.client read/write alias runtime.clients.discord (back-compat)', () => {
  const fake = { isReady: () => true, guilds: { cache: new Map([['a', 1]]) } };
  runtime.client = fake; // direct assignment, as the existing test suite does throughout
  assert.equal(runtime.clients.discord, fake);
  assert.equal(runtime.client, fake);
  runtime.client = null;
  assert.equal(runtime.clients.discord, null);
});

test('setClient() sets the Discord client via the new clients map', () => {
  const fake = { isReady: () => true, guilds: { cache: new Map() } };
  setClient(fake);
  assert.equal(clientFor('discord'), fake);
  assert.equal(runtime.client, fake);
  setClient(null);
});

test('setClientFor()/clientFor() work for an arbitrary platform', () => {
  const fakeFluxer = { isReady: () => true };
  setClientFor('fluxer', fakeFluxer);
  assert.equal(clientFor('fluxer'), fakeFluxer);
  assert.equal(runtime.clients.fluxer, fakeFluxer);
  setClientFor('fluxer', null);
});

test('clientFor() returns null for a platform with no client set', () => {
  assert.equal(clientFor('fluxer'), null);
});

test('isDiscordReady()/guildCount() keep reading the Discord client unchanged', () => {
  assert.equal(isDiscordReady(), false);
  assert.equal(guildCount(), 0);
  setClient({ isReady: () => true, guilds: { cache: new Map([['a', 1], ['b', 2]]) } });
  assert.equal(isDiscordReady(), true);
  assert.equal(guildCount(), 2);
  setClient(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime.test.js`
Expected: FAIL — `clientFor`/`setClientFor` are not exported yet (and
`runtime.clients` is `undefined`, so `runtime.clients.discord` throws).

- [ ] **Step 3: Modify `src/runtime.js`**

Replace the `RuntimeState` typedef's `client` line and the `runtime` object
literal:

```js
/**
 * @typedef {Object} RuntimeState
 * @property {number} startedAt          Epoch ms when the process booted.
 * @property {{ message: string, at: number } | null} lastError  Most recent unexpected error.
 * @property {ErrorEntry[]} errors       Recent errors, most-recent-first, capped.
 * @property {{ discord: import('discord.js').Client | null, fluxer: object | null }} clients
 *   One logged-in client per platform, keyed by platform name. Either side is
 *   null until that platform is configured and connected.
 */
```

```js
/** @type {RuntimeState} */
export const runtime = {
  startedAt: Date.now(),
  lastError: null,
  errors: [],
  /** @type {number[]} Gateway ping in ms, oldest first, capped. */
  pingHistory: [],
  clients: { discord: null, fluxer: null },
  // Back-compat alias for the (still overwhelmingly common) Discord-only call
  // sites, and for the test suite's existing `runtime.client = fake` direct
  // assignments — both reads and writes transparently go through to
  // `clients.discord` instead of a second, separate source of truth.
  get client() {
    return this.clients.discord;
  },
  set client(value) {
    this.clients.discord = value;
  },
};
```

Replace `setClient`:

```js
/**
 * Attach a logged-in client for a platform.
 * @param {'discord'|'fluxer'} platform
 * @param {unknown} client
 */
export function setClientFor(platform, client) {
  runtime.clients[platform] = client;
}

/**
 * @param {'discord'|'fluxer'} platform
 * @returns {unknown}
 */
export function clientFor(platform) {
  return runtime.clients[platform] ?? null;
}

/**
 * Back-compat alias — attaches the Discord client specifically.
 * @param {import('discord.js').Client} client
 */
export function setClient(client) {
  setClientFor('discord', client);
}
```

`recordError`, `errorScopeCounts`, `recordGatewayPing`, `uptimeSeconds`,
`isDiscordReady`, `guildCount` are unchanged — they already read
`runtime.client`, which now transparently aliases `runtime.clients.discord`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `npm test`
Expected: same pass count as before this task (the whole point of the
getter/setter approach) — pay particular attention to `test/auth.test.js`,
`test/devLog.test.js` passing unchanged.

- [ ] **Step 6: Lint and format**

Run: `npx eslint src/runtime.js test/runtime.test.js && npx prettier --check src/runtime.js test/runtime.test.js` (then `--write` + re-check if needed, same as Task 1).

- [ ] **Step 7: Commit**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "feat(runtime): multi-client clients map, client getter/setter stays back-compat"
```

---

## Task 3: `src/modules/lib/send.js` — platform-aware channel resolution

**Files:**
- Modify: `src/modules/lib/send.js`
- Test: `test/send.test.js` (new)

**Interfaces:**
- Consumes: `splitPlatformGuildId` from `src/lib/platformId.js` (Task 1),
  `clientFor` from `src/runtime.js` (Task 2).
- Produces: `postToChannel`, `sendToChannel`, `deleteChannelMessage`,
  `editChannelMessage` — same exported signatures as today, now taking a
  composite guildId.

- [ ] **Step 1: Write the failing test**

```js
// test/send.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { setClientFor } from '../src/runtime.js';
import { postToChannel, sendToChannel, deleteChannelMessage, editChannelMessage } from '../src/modules/lib/send.js';

const CHANNEL_ID = '200000000000000001';

function mockGuild({ sendOk = true, deleteOk = true, editOk = true } = {}) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      if (!sendOk) throw new Error('send failed');
      return { id: 'msg1' };
    },
    messages: {
      delete: async () => {
        if (!deleteOk) throw new Error('delete failed');
      },
      edit: async () => {
        if (!editOk) throw new Error('edit failed');
      },
    },
  };
  return {
    channels: { cache: new Map([[CHANNEL_ID, channel]]), fetch: async () => channel },
    members: { me: {} },
  };
}

test.afterEach(() => {
  setClientFor('discord', null);
  setClientFor('fluxer', null);
});

test('sendToChannel resolves the Discord client for a "discord:" guildId', async () => {
  setClientFor('discord', { guilds: { cache: new Map([['900000000000000050', mockGuild()]]) } });
  const ok = await sendToChannel('discord:900000000000000050', CHANNEL_ID, { content: 'hi' });
  assert.equal(ok, true);
});

test('postToChannel returns null when the guildId has no recognised platform prefix', async () => {
  setClientFor('discord', { guilds: { cache: new Map([['900000000000000050', mockGuild()]]) } });
  // Legacy bare snowflake — must fail closed, not throw, not accidentally match.
  const result = await postToChannel('900000000000000050', CHANNEL_ID, { content: 'hi' });
  assert.equal(result, null);
});

test('postToChannel returns null when that platform has no client connected', async () => {
  // No setClientFor('fluxer', ...) call — clientFor('fluxer') is null.
  const result = await postToChannel('fluxer:900000000000000050', CHANNEL_ID, { content: 'hi' });
  assert.equal(result, null);
});

test('postToChannel resolves a second platform independently of the first', async () => {
  setClientFor('discord', { guilds: { cache: new Map([['900000000000000050', mockGuild()]]) } });
  setClientFor('fluxer', { guilds: { cache: new Map([['900000000000000060', mockGuild()]]) } });
  const discordResult = await postToChannel('discord:900000000000000050', CHANNEL_ID, { content: 'a' });
  const fluxerResult = await postToChannel('fluxer:900000000000000060', CHANNEL_ID, { content: 'b' });
  assert.notEqual(discordResult, null);
  assert.notEqual(fluxerResult, null);
});

test('deleteChannelMessage and editChannelMessage also route through the composite guildId', async () => {
  setClientFor('discord', { guilds: { cache: new Map([['900000000000000050', mockGuild()]]) } });
  assert.equal(await deleteChannelMessage('discord:900000000000000050', CHANNEL_ID, 'msg1'), true);
  assert.equal(await editChannelMessage('discord:900000000000000050', CHANNEL_ID, 'msg1', { content: 'x' }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/send.test.js`
Expected: FAIL — the "legacy bare snowflake" and "no recognised platform
prefix" cases currently *succeed* (today's code does
`runtime.client?.guilds.cache.get(guildId)`, which still finds the guild
under its bare id, since nothing strips/validates the prefix yet) — so
`postToChannel returns null when the guildId has no recognised platform
prefix` fails by getting a non-null result instead of `null`. The other
tests fail too since `setClientFor`/multi-client resolution doesn't exist
until Task 2's runtime.js change is in (confirm Task 2 is committed first).

- [ ] **Step 3: Modify `src/modules/lib/send.js`**

```js
// Helper for modules that post to a configured channel.
import { clientFor } from '../../runtime.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';

/** Resolve a text-based channel the bot can post in, or null. Never throws. */
async function usableChannel(guildId, channelId) {
  if (!channelId) return null;
  const parsed = splitPlatformGuildId(guildId);
  if (!parsed) return null;
  const guild = clientFor(parsed.platform)?.guilds.cache.get(parsed.rawId);
  if (!guild) return null;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel?.isTextBased()) return null;
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return null;
    return channel;
  } catch {
    return null;
  }
}
```

(The four exported functions — `postToChannel`, `sendToChannel`,
`deleteChannelMessage`, `editChannelMessage` — are unchanged; they already
delegate to `usableChannel`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/send.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Lint and format**

Run: `npx eslint src/modules/lib/send.js test/send.test.js && npx prettier --check src/modules/lib/send.js test/send.test.js` (write + re-check if needed).

- [ ] **Step 6: Commit**

```bash
git add src/modules/lib/send.js test/send.test.js
git commit -m "feat(send): resolve the posting channel from a composite platform:guildId"
```

---

## Task 4: `src/bot/events/moduleEvents.js` — wrap dispatch at the edge

**Files:**
- Modify: `src/bot/events/moduleEvents.js`
- Test: `test/moduleEvents.test.js` (new)

**Interfaces:**
- Consumes: `makePlatformGuildId` from `src/lib/platformId.js` (Task 1),
  `dispatch` from `src/modules/dispatch.js` (unchanged).
- Produces: `register(client)` — same signature as today; every event it
  wires now hands `dispatch()` a composite guildId instead of a bare one.

- [ ] **Step 1: Write the failing test**

```js
// test/moduleEvents.test.js
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { on } from '../src/modules/dispatch.js';
import { register } from '../src/bot/events/moduleEvents.js';
import { setGuildModule } from '../src/db/modules.js';

const RAW_GUILD_ID = '900000000000000040';

function fakeClient() {
  const handlers = new Map();
  return {
    on(event, fn) {
      handlers.set(event, fn);
    },
    // Returns whatever the handler returns — moduleEvents.js's
    // GuildMemberAdd listener is a single-expression arrow
    // `(member) => dispatch(...)`, so its implicit return IS the dispatch()
    // promise, letting the test await the full dispatch chain deterministically
    // instead of guessing at a timeout.
    emit(event, ...args) {
      return handlers.get(event)?.(...args);
    },
  };
}

test('moduleEvents: wraps the raw Discord guild id into composite form before dispatching', async () => {
  await setGuildModule(RAW_GUILD_ID, 'test-probe-moduleEvents', { enabled: true, config: {} });

  let seenGuildId = null;
  on('test-probe-moduleEvents', 'guildMemberAdd', (payload, config, guildId) => {
    seenGuildId = guildId;
  });

  const client = fakeClient();
  register(client);
  await client.emit(Events.GuildMemberAdd, { guild: { id: RAW_GUILD_ID } });

  assert.equal(seenGuildId, `discord:${RAW_GUILD_ID}`);
});

test('moduleEvents: a guildless payload (no guild.id) does not throw', async () => {
  const client = fakeClient();
  register(client);
  // member.guild is undefined — member.guild?.id is undefined. Must not throw.
  await assert.doesNotReject(client.emit(Events.GuildMemberAdd, {}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/moduleEvents.test.js`
Expected: FAIL on the first test — `seenGuildId` is the bare
`RAW_GUILD_ID`, not the `discord:`-prefixed form (the second test already
passes today, since `dispatch()`'s own `if (!guildId) return;` guard already
handles `undefined` safely — keep it anyway as a regression guard for the
wrapper you're about to add).

- [ ] **Step 3: Modify `src/bot/events/moduleEvents.js`**

Add the import and a local wrapper, then replace every `dispatch(` call with
`dispatchDiscord(`:

```js
// Bridges Discord gateway events to the module dispatch layer. Each listener
// forwards (eventName, guildId, payload) to dispatch(), which calls every
// enabled module's handler for that guild.
import { Events } from 'discord.js';
import { dispatch } from '../../modules/dispatch.js';
import { makePlatformGuildId } from '../../lib/platformId.js';
import '../../modules/index.js'; // side-effect: registers module handlers

// Every gateway event on this (Discord) client carries a bare snowflake —
// wrap it into the "discord:<id>" composite form exactly once, here, so
// every module downstream of dispatch() only ever sees composite guild ids.
// Falsy guildId (a partial/guildless payload) passes straight through so
// dispatch()'s own `if (!guildId) return;` guard still fires.
function dispatchDiscord(eventName, guildId, payload) {
  return dispatch(eventName, guildId ? makePlatformGuildId('discord', guildId) : guildId, payload);
}

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.GuildMemberAdd, (member) => dispatchDiscord('guildMemberAdd', member.guild?.id, member));
  client.on(Events.GuildMemberRemove, (member) => dispatchDiscord('guildMemberRemove', member.guild?.id, member));
  client.on(Events.GuildMemberUpdate, (oldM, newM) =>
    dispatchDiscord('guildMemberUpdate', newM.guild?.id, { old: oldM, new: newM })
  );

  client.on(Events.GuildBanAdd, (ban) => dispatchDiscord('guildBanAdd', ban.guild?.id, ban));
  client.on(Events.GuildBanRemove, (ban) => dispatchDiscord('guildBanRemove', ban.guild?.id, ban));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    dispatchDiscord('voiceStateUpdate', guildId, { old: oldState, new: newState });
  });

  client.on(Events.MessageDelete, (message) => {
    if (message.guildId) dispatchDiscord('messageDelete', message.guildId, message);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (channel?.guildId) dispatchDiscord('messageDeleteBulk', channel.guildId, { messages, channel });
  });
  client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    if (newMsg.guildId) dispatchDiscord('messageUpdate', newMsg.guildId, { old: oldMsg, new: newMsg });
  });
  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId) return;
    // `messageCreateAny` also carries bot / app / webhook messages — only the
    // sticky module opts into those. `messageCreate` stays human-only.
    dispatchDiscord('messageCreateAny', message.guildId, message);
    if (!message.author?.bot) dispatchDiscord('messageCreate', message.guildId, message);
  });

  client.on(Events.GuildRoleCreate, (role) => dispatchDiscord('roleCreate', role.guild?.id, role));
  client.on(Events.GuildRoleDelete, (role) => dispatchDiscord('roleDelete', role.guild?.id, role));

  client.on(Events.InviteCreate, (invite) => dispatchDiscord('inviteCreate', invite.guild?.id, invite));
  client.on(Events.InviteDelete, (invite) => dispatchDiscord('inviteDelete', invite.guild?.id, invite));
  client.on(Events.GuildCreate, (guild) => dispatchDiscord('guildCreate', guild.id, guild));

  client.on(Events.ChannelCreate, (channel) => {
    if (channel.guildId) dispatchDiscord('channelCreate', channel.guildId, channel);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guildId) dispatchDiscord('channelDelete', channel.guildId, channel);
  });

  const forwardReaction = (event) => async (reaction, user) => {
    // A reaction on an uncached message arrives partial; guildId is null until
    // the message is fetched.
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch {
      return;
    }
    const guildId = reaction.message.guildId ?? reaction.message.guild?.id;
    if (guildId) dispatchDiscord(event, guildId, { reaction, user });
  };
  client.on(Events.MessageReactionAdd, forwardReaction('reactionAdd'));
  client.on(Events.MessageReactionRemove, forwardReaction('reactionRemove'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/moduleEvents.test.js`
Expected: PASS, 2 tests

- [ ] **Step 5: Lint and format**

Run: `npx eslint src/bot/events/moduleEvents.js test/moduleEvents.test.js && npx prettier --check src/bot/events/moduleEvents.js test/moduleEvents.test.js` (write + re-check if needed).

- [ ] **Step 6: Commit**

```bash
git add src/bot/events/moduleEvents.js test/moduleEvents.test.js
git commit -m "feat(events): wrap Discord guild ids into composite form before dispatch"
```

---

## Task 5: Fix the two snowflake-validation leaks

**Files:**
- Modify: `src/modules/appeals.js:85`
- Modify: `src/modules/verification.js:87`
- Test: `test/appeals.test.js`, `test/verification.test.js` (extend if they
  exist, else create — check first with `ls test/appeals.test.js
  test/verification.test.js`)

**Interfaces:**
- Consumes: `isPlatformGuildId` from `src/lib/platformId.js` (Task 1).
- Produces: `verifyAppealToken(token)` / `verifyVerifyToken(token)` — same
  signatures, now accept a composite guildId and still reject a malformed one.

- [ ] **Step 1: Check for existing test files**

Run: `ls test/appeals.test.js test/verification.test.js`

If either exists, read it fully before writing new tests, and add the new
cases into the existing file following its established style (helper
functions, imports already in scope) rather than duplicating setup. If
neither exists, create both fresh with just the tests below.

- [ ] **Step 2: Write the failing tests**

```js
// test/appeals.test.js (add if the file exists; these are the new cases either way)
import test from 'node:test';
import assert from 'node:assert/strict';
import { signAppealToken, verifyAppealToken } from '../src/modules/appeals.js';

test('verifyAppealToken accepts a composite "discord:" guildId', () => {
  const token = signAppealToken('discord:123456789012345678', '900000000000000001');
  const result = verifyAppealToken(token);
  assert.deepEqual(result, { guildId: 'discord:123456789012345678', userId: '900000000000000001' });
});

test('verifyAppealToken accepts a composite "fluxer:" guildId', () => {
  const token = signAppealToken('fluxer:987654321098765432', '900000000000000001');
  const result = verifyAppealToken(token);
  assert.deepEqual(result, { guildId: 'fluxer:987654321098765432', userId: '900000000000000001' });
});

test('verifyAppealToken still rejects a malformed guildId', () => {
  // signAppealToken signs whatever string it's given — simulate a forged/corrupt
  // token by re-signing with an unsupported platform prefix directly.
  const token = signAppealToken('telegram:123', '900000000000000001');
  assert.equal(verifyAppealToken(token), null);
});
```

```js
// test/verification.test.js (add if the file exists; these are the new cases either way)
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyVerifyToken } from '../src/modules/verification.js';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';

function signVerifyToken(guildId, userId, exp) {
  const body = `${guildId}.${userId}.${exp}`;
  const bodyB64 = Buffer.from(body).toString('base64url');
  const sig = createHmac('sha256', config.sessionSecret).update(body).digest();
  return `${bodyB64}.${sig.toString('base64url')}`;
}

test('verifyVerifyToken accepts a composite "discord:" guildId', () => {
  const token = signVerifyToken('discord:123456789012345678', '900000000000000001', Date.now() + 60_000);
  assert.deepEqual(verifyVerifyToken(token), {
    guildId: 'discord:123456789012345678',
    userId: '900000000000000001',
  });
});

test('verifyVerifyToken still rejects a malformed guildId', () => {
  const token = signVerifyToken('telegram:123', '900000000000000001', Date.now() + 60_000);
  assert.equal(verifyVerifyToken(token), null);
});
```

(If `test/verification.test.js` already exists and already has its own
token-signing helper, reuse that one instead of adding a second — check its
contents in Step 1 before writing this.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/appeals.test.js test/verification.test.js`
Expected: FAIL — both "accepts a composite" cases currently fail because
`/^\d{17,20}$/.test(guildId)` rejects any string containing a `:`.

- [ ] **Step 4: Fix `src/modules/appeals.js`**

```js
import { isPlatformGuildId } from '../lib/platformId.js';
```

(add near the top with the other imports)

```js
/** @returns {{ guildId: string, userId: string } | null} */
export function verifyAppealToken(token) {
  const parts = verifyToken(token, 2);
  if (!parts) return null;
  const [guildId, userId] = parts;
  if (!isPlatformGuildId(guildId) || !/^\d{17,20}$/.test(userId)) return null;
  return { guildId, userId };
}
```

- [ ] **Step 5: Fix `src/modules/verification.js`**

```js
import { isPlatformGuildId } from '../lib/platformId.js';
```

(add near the top with the other imports)

```js
const [guildId, userId, exp] = body.split('.');
if (!isPlatformGuildId(guildId) || !/^\d{17,20}$/.test(userId)) return null;
```

(replaces the existing `if (!/^\d{17,20}$/.test(guildId) || ...)` line —
`userId` keeps the bare-snowflake check, only `guildId` changes.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/appeals.test.js test/verification.test.js`
Expected: PASS — new cases pass, every pre-existing case in both files still
passes unchanged.

- [ ] **Step 7: Lint and format**

Run: `npx eslint src/modules/appeals.js src/modules/verification.js test/appeals.test.js test/verification.test.js && npx prettier --check` (same set; write + re-check if needed).

- [ ] **Step 8: Commit**

```bash
git add src/modules/appeals.js src/modules/verification.js test/appeals.test.js test/verification.test.js
git commit -m "fix(appeals,verification): accept a composite platform guildId in signed tokens"
```

---

## Task 6: Backfill migration — prefix every stored `guild_id` with `discord:`

**Files:**
- Modify: `src/db/index.js` (new `MIGRATIONS` entry, becomes #46)
- Modify: `src/db/purge.js` (Postgres twin via `registerPostgresMigration`)
- Test: `test/platformIdMigration.test.js` (new)

**Interfaces:**
- Consumes: nothing new (plain SQL against tables that already exist).
- Produces: after this migration, every row in every `GUILD_TABLES` table
  (`src/db/purge.js`) has a `guild_id` value of the form `"discord:<old
  value>"` instead of a bare snowflake.

- [ ] **Step 1: Write the failing test**

This test exercises the actual migration function in isolation — on a
throwaway `better-sqlite3` database the test builds itself (not the shared
test-DB singleton from `test/helpers/tmpDb.js`, which runs every migration
against an already-empty database and so has no pre-existing data to
backfill).

```js
// test/platformIdMigration.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/index.js';
import { GUILD_TABLES } from '../src/db/purge.js';

// The migration this task adds is appended last — asserted explicitly so
// this test fails loudly (not silently against the wrong function) if a
// later migration is ever inserted after it instead of appended.
const backfillMigration = MIGRATIONS[MIGRATIONS.length - 1];

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE temp_bans (
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      mod_id     TEXT NOT NULL,
      reason     TEXT NOT NULL,
      unban_at   INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  return db;
}

test('the backfill migration prefixes an existing bare guild_id with "discord:"', () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO temp_bans (guild_id, user_id, mod_id, reason, unban_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('123456789012345678', '900000000000000001', '900000000000000002', 'test', Date.now(), Date.now());

  backfillMigration(db);

  const row = db.prepare('SELECT guild_id FROM temp_bans').get();
  assert.equal(row.guild_id, 'discord:123456789012345678');
});

test('the backfill migration is idempotent — running it twice does not double-prefix', () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO temp_bans (guild_id, user_id, mod_id, reason, unban_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('123456789012345678', '900000000000000001', '900000000000000002', 'test', Date.now(), Date.now());

  backfillMigration(db);
  backfillMigration(db);

  const row = db.prepare('SELECT guild_id FROM temp_bans').get();
  assert.equal(row.guild_id, 'discord:123456789012345678');
});

test('every GUILD_TABLES entry is covered by the migration (exhaustive, not just temp_bans)', () => {
  const db = new Database(':memory:');
  // Minimal one-column-plus-guild_id shape per table — enough to prove the
  // migration's own table list has no gap against the real GUILD_TABLES
  // registry, without needing each table's full production schema.
  for (const t of GUILD_TABLES) {
    db.exec(`CREATE TABLE ${t} (guild_id TEXT NOT NULL, _row INTEGER PRIMARY KEY);`);
    db.prepare(`INSERT INTO ${t} (guild_id) VALUES (?)`).run('123456789012345678');
  }

  backfillMigration(db);

  for (const t of GUILD_TABLES) {
    const row = db.prepare(`SELECT guild_id FROM ${t}`).get();
    assert.equal(row.guild_id, 'discord:123456789012345678', `table ${t} was not backfilled`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/platformIdMigration.test.js`
Expected: FAIL — `MIGRATIONS[MIGRATIONS.length - 1]` is today's `bot_audit`
migration (a `CREATE TABLE`, not an `UPDATE`), so running it against a table
that already exists does nothing useful and `temp_bans.guild_id` stays
`'123456789012345678'` un-prefixed.

- [ ] **Step 3: Add the SQLite migration to `src/db/index.js`**

Append to the end of the `MIGRATIONS` array (immediately before the closing
`];`, after the existing `bot_audit` entry):

```js

  // Prefix every stored guild_id with "discord:" — the first step of the
  // composite <platform>:<id> guild-id convention (src/lib/platformId.js)
  // that lets Sylo run on more than one chat platform at once without a
  // schema change. Every value is bare today (Discord-only, always has
  // been). The WHERE guard makes this safe to re-run (defence in depth, not
  // required for a single correct run). This table list must stay in sync
  // with GUILD_TABLES in src/db/purge.js — that file can't be imported here
  // (index.js is upstream of purge.js in the import graph; see purge.js's
  // own header comment) — test/platformIdMigration.test.js cross-checks the
  // two lists directly.
  (database) => {
    const tables = [
      'guild_settings',
      'guild_modules',
      'command_overrides',
      'infractions',
      'case_counters',
      'tickets',
      'composed_messages',
      'counting',
      'counting_penalties',
      'scheduled_messages',
      'leveling',
      'leveling_periods',
      'config_audit',
      'afk',
      'posted_keys',
      'appeals',
      'temp_voice_channels',
      'starboard_posts',
      'invite_counts',
      'invite_joins',
      'invite_personal',
      'polls',
      'giveaways',
      'leaderboard_vanity',
      'temp_bans',
      'channel_locks',
      'birthdays',
      'guild_daily',
      'guild_hourly',
      'channel_cleanup_schedules',
      'github_watches',
      'honeypot_catches',
    ];
    for (const t of tables) {
      database.exec(`UPDATE ${t} SET guild_id = 'discord:' || guild_id WHERE guild_id NOT LIKE '%:%';`);
    }
  },
```

- [ ] **Step 4: Run test to verify the first two cases pass**

Run: `node --test test/platformIdMigration.test.js`
Expected: the first two tests (`prefixes an existing bare guild_id`,
`idempotent`) PASS. The third (`every GUILD_TABLES entry is covered`) still
FAILs — the inline `tables` list above only has entries for tables that
exist; the test creates a fresh in-memory DB with exactly the `GUILD_TABLES`
set, so this will actually pass too as soon as the hardcoded list matches —
cross-check your typed list character-by-character against the `GUILD_TABLES`
array printed in `src/db/purge.js` (32 entries) if it doesn't.

- [ ] **Step 5: Add the Postgres twin to `src/db/purge.js`**

```js
import { prepare, registerPostgresMigration } from './driver.js';
```

(replaces the existing `import { prepare } from './driver.js';` line)

Add after the `GUILD_TABLES` array (after its closing `];`, before
`const simpleStmts = ...`):

```js

// Postgres twin of the "discord:" backfill migration in src/db/index.js
// (SQLite migration #46) — GUILD_TABLES is already in scope here, so this
// builds the statement list from the same source of truth instead of a
// second hand-copied list.
registerPostgresMigration(
  46,
  GUILD_TABLES.map((t) => `UPDATE ${t} SET guild_id = 'discord:' || guild_id WHERE guild_id NOT LIKE '%:%';`).join(
    '\n'
  )
);
```

- [ ] **Step 6: Run the full test file to verify everything passes**

Run: `node --test test/platformIdMigration.test.js`
Expected: PASS, 3 tests

- [ ] **Step 7: Run the full suite, SQLite and Postgres**

Run: `npm test`
Expected: same pass count as before this task, plus the 3 new tests. Then,
only if a local Postgres is available for this repo's Postgres test leg
(check `DATABASE_URL` / the project's own Postgres-testing docs — skip this
step with a note if none is set up locally, it still runs in CI):
Run: `DATABASE_URL=<local postgres url> npm test`
Expected: same pass count — confirms `registerPostgresMigration(46, …)`
doesn't throw against a real Postgres connection.

- [ ] **Step 8: Lint and format**

Run: `npx eslint src/db/index.js src/db/purge.js test/platformIdMigration.test.js && npx prettier --check src/db/index.js src/db/purge.js test/platformIdMigration.test.js` (write + re-check if needed).

- [ ] **Step 9: Commit**

```bash
git add src/db/index.js src/db/purge.js test/platformIdMigration.test.js
git commit -m "feat(db): backfill every guild_id with the discord: platform prefix"
```

---

## Task 7: Full-suite verification and manual regression check

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test passes, including all new tests from Tasks 1–6. Compare
the total pass count against the count from before this plan started (note
it down before Task 1 if you haven't already) — it should be exactly the old
count plus the new tests added across Tasks 1–6 (7 + 5 + 5 + 2 + 5 + 3 = 27
new tests if Task 5 added the two test files fresh; a few more or fewer if it
extended existing `test/appeals.test.js`/`test/verification.test.js` files
that already had their own cases).

- [ ] **Step 2: Lint and build the whole touched surface**

Run: `npx eslint src/lib/platformId.js src/runtime.js src/modules/lib/send.js src/bot/events/moduleEvents.js src/modules/appeals.js src/modules/verification.js src/db/index.js src/db/purge.js`
Expected: clean.

- [ ] **Step 3: Manual check — existing Discord-only deployment is unaffected**

Run the bot locally against a real (or sylo-test) Discord guild exactly as
before — no `FLUXER_TOKEN`/`FLUXER_CLIENT_ID` configured, same `.env` as
today. Confirm:
- The bot logs in and `/health` (or the V2 Health page) shows it connected,
  same as before this plan.
- A module that posts messages (e.g. trigger a moderation action, or a
  welcome message) still posts correctly — this exercises `send.js`'s new
  composite-guildId path end-to-end against a real Discord guild.
- A ban-appeal or verification link (whichever the test server has
  configured) still works — exercises Task 5's fix against a real signed
  token round-trip.
- Deploy to `sylo-test` (`docker --context sylo-test compose -f
  docker-compose.test.yml --env-file .env.test up -d --build`, per this
  project's established workflow) against an **existing** (pre-migration)
  database if one is available, and confirm the bot starts cleanly and the
  migration log line appears once (`Applied migration 46`) — this is the
  only way to prove the backfill runs correctly against real legacy data.

- [ ] **Step 4: Confirm the branch state**

Run: `git log --oneline main..HEAD` — expect exactly the 6 commits from
Tasks 1–6, in order, each with a clean message. `git status` should be
clean (nothing uncommitted).

No commit for this task — it's verification only. If Step 3's manual check
surfaces a problem, fix it as a new, appropriately-scoped commit before
considering Phase 1 done.
