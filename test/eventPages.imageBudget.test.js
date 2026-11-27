// Anonymous views of public event pages must not turn into an endless stream of image downloads,
// even when a server's events hold more big images than its share of the cache.
import './helpers/trustLoopbackProxy.js';
import { startWebApp } from './helpers/webApp.js';
import { CH, GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { createEvent } from '../src/db/events.js';
import {
  MAX_IMAGE_BYTES,
  OWNER_FETCHES_PER_MINUTE,
  _clearImageCache,
  _setImageFetcher,
} from '../src/modules/lib/eventImage.js';

const SG = '900000000000000126';
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIG = Buffer.concat([PNG_HEAD, Buffer.alloc(MAX_IMAGE_BYTES - PNG_HEAD.length - 16)]);
const ICON_LINK = `https://cdn.discordapp.com/icons/${GID}/a1b2c3.png?size=128`;

let app;
const calls = [];
test.before(async () => {
  app = await startWebApp();
  app.guild.iconURL = () => ICON_LINK;
  app.client.guilds.cache.set(SG, app.guild);
  _setImageFetcher(async (link) => {
    calls.push(link);
    return { status: 200, ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: BIG };
  });
  _clearImageCache();
  await setGuildModule(SG, 'events', { enabled: true, config: { publicPages: true } });
});
test.after(async () => {
  _setImageFetcher(null);
  await app.close();
});

test('27 page views over 9 big-image events start a bounded number of downloads', async () => {
  const events = [];
  for (let n = 0; n < 9; n += 1) {
    const { id } = await createEvent({
      guildId: SG,
      channelId: CH.general,
      title: `Night ${n}`,
      description: 'Bring snacks',
      location: 'Voice 1',
      capacity: 10,
      roleId: '100000000000000700',
      hostId: '900000000000000555',
      startAt: Date.UTC(2030, 0, 5, 18, 0),
      endAt: Date.UTC(2030, 0, 5, 21, 0),
      timeZone: 'Europe/Oslo',
      imageUrl: `https://cdn.discordapp.com/attachments/${CH.general}/100000000000000042/p${n}.png`,
    });
    events.push(id);
  }
  const { getEvent } = await import('../src/db/events.js');
  let views = 0;
  for (let round = 0; round < 3; round += 1) {
    for (const id of events) {
      const ev = await getEvent(id);
      const res = await fetch(`${app.base}/events/${ev.public_token}`, {
        headers: { 'x-forwarded-for': `10.30.${views++}.1` },
      });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
  }
  assert.equal(views, 27);
  assert.ok(
    calls.length <= OWNER_FETCHES_PER_MINUTE,
    `${calls.length} downloads for 27 views (limit ${OWNER_FETCHES_PER_MINUTE})`
  );
});
