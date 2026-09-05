import { startWebApp, post } from './helpers/webApp.js';
import { GID, MEMBER_ID, ADMIN_ROLE, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (p, headers) => fetch(app.base + p, { headers, redirect: 'manual' });

test('GET /guilds/:id redirects to /overview', async () => {
  const res = await get(`/guilds/${GID}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/overview$/);
});

test('GET /overview renders the plugin grid shell', async () => {
  const res = await get(`/guilds/${GID}/overview`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /class="plugin-grid"/);
  assert.match(html, /of 31 plugins/); // overview health line
  assert.match(html, /data-bulk-url=/); // 3.6 bulk-select wiring present
});

test('GET /settings renders the bot-masters form', async () => {
  const res = await get(`/guilds/${GID}/settings`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Bot masters/);
  assert.match(html, /Admins/); // the admin-perm role is listed as automatic
});

test('POST /settings saves and redirects', async () => {
  const res = await post(app.base, `/guilds/${GID}/settings`, { botMasterRoles: ADMIN_ROLE });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=saved/);
});

test('GET /moderation renders the tabbed moderator page', async () => {
  const res = await get(`/guilds/${GID}/moderation`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Infractions/);
  assert.match(html, /Channel locks/); // 3.4 addition
});

test('GET /insights renders the activity charts panel', async () => {
  const { db } = await import('../src/db/index.js');
  const { utcDay, utcHour } = await import('../src/db/insights.js');
  db.prepare(
    'INSERT OR REPLACE INTO guild_daily (guild_id, day, messages, active_members, voice_minutes, voice_peak, channels, voice_channels) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    GID,
    utcDay(),
    42,
    5,
    180,
    4,
    JSON.stringify({ [CH.general]: 30, [CH.bots]: 12 }),
    JSON.stringify({ [CH.voice]: 180 })
  );
  db.prepare(
    'INSERT OR REPLACE INTO guild_hourly (guild_id, hour, messages, voice_minutes) VALUES (?,?,?,?)'
  ).run(GID, utcHour(), 7, 25);

  const daily = await (await get(`/guilds/${GID}/insights?range=7`)).text();
  assert.match(daily, /Server insights/);
  assert.match(daily, /Messages per day/);
  assert.match(daily, /Voice minutes per day/);
  assert.match(daily, /Top channels/);
  assert.match(daily, /Top voice channels/);
  assert.match(daily, /#general/);
  assert.match(daily, /Voice/); // the "Voice" voice channel name in top-voice

  const hourly = await get(`/guilds/${GID}/insights?range=24`);
  assert.equal(hourly.status, 200);
  assert.match(await hourly.text(), /Messages per hour/);
});

test('POST /insights/refresh flushes the buffer and redirects back', async () => {
  const { _internals } = await import('../src/modules/insights.js');
  const { db } = await import('../src/db/index.js');
  const { utcDay } = await import('../src/db/insights.js');
  _internals.buf.clear();
  const s = _internals.slot(GID);
  s.messages = 11;

  const res = await post(app.base, `/guilds/${GID}/insights/refresh`, { range: '7' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/insights\?range=7$/);
  const row = db
    .prepare('SELECT messages FROM guild_daily WHERE guild_id = ? AND day = ?')
    .get(GID, utcDay());
  assert.ok(row.messages >= 11);
});

test('GET /m/:id — full page, bare fragment, and hx-boost', async () => {
  const full = await (await get(`/guilds/${GID}/m/welcome`)).text();
  assert.match(full, /^<!doctype html>/i);
  assert.match(full, /class="sidebar"/);

  const frag = (await (await get(`/guilds/${GID}/m/welcome`, { 'HX-Request': 'true' })).text()).trim();
  assert.match(frag, /^<div id="module-config">/);
  assert.doesNotMatch(frag, /class="sidebar"/);

  const boosted = await (
    await get(`/guilds/${GID}/m/welcome`, { 'HX-Request': 'true', 'HX-Boosted': 'true' })
  ).text();
  assert.match(boosted, /^<!doctype html>/i);
  assert.match(boosted, /class="sidebar"/);
});

test('GET /m/:id for an unknown module redirects to overview', async () => {
  const res = await get(`/guilds/${GID}/m/nope`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/overview$/);
});

test('POST /m/:id/config — no-JS redirect and htmx fragment + toast', async () => {
  const plain = await post(app.base, `/guilds/${GID}/m/counting/config`, {
    channel: CH.general,
    allowSameUser: 'on',
  });
  assert.equal(plain.status, 302);
  assert.match(plain.headers.get('location'), /\/m\/counting/);

  const hx = await post(
    app.base,
    `/guilds/${GID}/m/counting/config`,
    { channel: CH.general },
    { 'HX-Request': 'true' }
  );
  assert.equal(hx.status, 200);
  assert.match((await hx.text()).trim(), /^<div id="module-config">/);
  assert.match(hx.headers.get('hx-trigger') || '', /toast/);
});

test('POST /m/sticky/config keeps the per-channel app + cooldown options', async () => {
  await post(app.base, `/guilds/${GID}/m/sticky/config`, {
    s_channel: CH.general,
    s_content: 'read the rules',
    s_bots: 'on',
    s_cooldown: '90',
  });
  const { getGuildModule } = await import('../src/db/modules.js');
  const [row] = getGuildModule(GID, 'sticky').config.stickies;
  assert.equal(row.channelId, CH.general);
  assert.equal(row.repostOnBots, true);
  assert.equal(row.cooldownSeconds, 90);
});

test('POST /m/kick-alerts/config stores a cleaned alert list', async () => {
  const res = await post(
    app.base,
    `/guilds/${GID}/m/kick-alerts/config`,
    { kc_slug: 'xQc', kc_channel: CH.general, kc_role: '', kc_message: '' },
    { 'HX-Request': 'true' }
  );
  assert.equal(res.status, 200);
  const { getGuildModule } = await import('../src/db/modules.js');
  const stored = getGuildModule(GID, 'kick-alerts').config;
  assert.equal(stored.alerts.length, 1);
  assert.equal(stored.alerts[0].slug, 'xqc');
  assert.equal(stored.alerts[0].channelId, CH.general);
});

test('POST /m/rss/config resolves a friendly handle to a feed URL', async () => {
  const res = await post(
    app.base,
    `/guilds/${GID}/m/rss/config`,
    {
      rss_id: '',
      rss_type: 'reddit',
      rss_ref: 'r/programming',
      rss_channel: CH.general,
      rss_role: '',
      rss_template: '',
    },
    { 'HX-Request': 'true' }
  );
  assert.equal(res.status, 200);
  const { getGuildModule } = await import('../src/db/modules.js');
  const [feed] = getGuildModule(GID, 'rss').config.feeds;
  assert.equal(feed.type, 'reddit');
  assert.equal(feed.ref, 'r/programming');
  assert.equal(feed.url, 'https://www.reddit.com/r/programming/new/.rss');
  assert.equal(feed.channelId, CH.general);
});

test('POST /modules/:id single toggle (htmx grid path) returns the CTA fragment', async () => {
  const res = await post(
    app.base,
    `/guilds/${GID}/modules/afk`,
    { enabled: 'true', view: 'grid' },
    { 'HX-Request': 'true' }
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('hx-trigger') || '', /moduleToggled/);
});

test('POST /modules/bulk enables several and is not shadowed by :moduleId', async () => {
  const { db } = await import('../src/db/index.js');
  const res = await post(app.base, `/guilds/${GID}/modules/bulk`, 'ids=polls&ids=afk&enabled=1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.equal(
    db.prepare("SELECT enabled FROM guild_modules WHERE guild_id = ? AND module_id = 'polls'").get(GID)
      .enabled,
    1
  );
});

test('POST /modules/bulk with only junk ids is a no-op count 0', async () => {
  const res = await post(app.base, `/guilds/${GID}/modules/bulk`, 'ids=made-up&enabled=1');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).count, 0);
});

test('POST /m/:id/test — sends for a configured testable module', async () => {
  app.sink.messages.length = 0;
  // welcome needs a joinChannel to have something to test
  await post(app.base, `/guilds/${GID}/m/welcome/config`, {
    enable_join: 'on',
    joinChannel: CH.general,
    joinMessage: 'hi {user}',
  });
  const res = await post(app.base, `/guilds/${GID}/m/welcome/test`, {}, { 'HX-Request': 'true' });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('hx-trigger') || '', /Test sent to #general/);
  assert.equal(app.sink.messages.length, 1);
});

test('POST /m/:id/test — "set a channel first" when unconfigured', async () => {
  await post(app.base, `/guilds/${GID}/m/free-games/config`, {}); // clears channel
  const res = await post(app.base, `/guilds/${GID}/m/free-games/test`, {}, { 'HX-Request': 'true' });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('hx-trigger') || '', /Set a channel/);
});

test('GET /member-data lists a member’s stored data', async () => {
  const { db } = await import('../src/db/index.js');
  db.prepare(
    'INSERT INTO infractions (guild_id, case_number, user_id, moderator_id, action, reason, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(GID, 1, MEMBER_ID, 'mod', 'warn', 'x', Date.now());

  const res = await get(`/guilds/${GID}/member-data?user=${MEMBER_ID}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Member data/);
  assert.match(html, new RegExp(MEMBER_ID));
});

test('POST /warnings adds a case; POST /cases/:n/delete soft-deletes it', async () => {
  const { db } = await import('../src/db/index.js');
  const add = await post(app.base, `/guilds/${GID}/warnings`, {
    userId: MEMBER_ID,
    reason: 'noise',
  });
  assert.equal(add.status, 302);
  const row = db
    .prepare(
      "SELECT case_number AS n FROM infractions WHERE guild_id = ? AND user_id = ? AND action = 'warn' ORDER BY case_number DESC"
    )
    .get(GID, MEMBER_ID);
  assert.ok(row);

  const del = await post(app.base, `/guilds/${GID}/cases/${row.n}/delete`, {});
  assert.equal(del.status, 302);
  assert.match(del.headers.get('location'), /tab=infr/);
  assert.equal(
    db.prepare('SELECT active FROM infractions WHERE guild_id = ? AND case_number = ?').get(GID, row.n)
      .active,
    0
  );
});

test('POST /moderation/lock-all locks the text channels via the fake overwrites', async () => {
  app.sink.channelEdits.length = 0;
  const res = await post(app.base, `/guilds/${GID}/moderation/lock-all`, {});
  assert.equal(res.status, 302);
  assert.ok(app.sink.channelEdits.length >= 1, 'at least one channel overwrite edited');
});

test('POST /m/automod/config pushes and later removes native AutoMod rules', async () => {
  app.sink.automodRules.length = 0;

  // Turn the words check on and mirror it natively.
  const on = await post(
    app.base,
    `/guilds/${GID}/m/automod/config`,
    { r_words_mode: 'delete', r_words_list: 'badword, another', native_enabled: 'on', native_words: 'on' },
    { 'HX-Request': 'true' }
  );
  assert.equal(on.status, 200);
  assert.match(on.headers.get('hx-trigger') || '', /native rules \+1/);
  assert.equal(app.sink.automodRules.length, 1);
  assert.equal(app.sink.automodRules[0].name, 'Sylo: bad words');
  assert.deepEqual(app.sink.automodRules[0].triggerMetadata.keywordFilter, ['*badword*', '*another*']);

  // Saving again with no change is a no-op.
  await post(
    app.base,
    `/guilds/${GID}/m/automod/config`,
    { r_words_mode: 'delete', r_words_list: 'badword, another', native_enabled: 'on', native_words: 'on' },
    { 'HX-Request': 'true' }
  );
  assert.equal(app.sink.automodRules.length, 1);

  // Turning native enforcement off tears the rule down.
  await post(
    app.base,
    `/guilds/${GID}/m/automod/config`,
    { r_words_mode: 'delete', r_words_list: 'badword, another' },
    { 'HX-Request': 'true' }
  );
  assert.equal(app.sink.automodRules.length, 0);
});
