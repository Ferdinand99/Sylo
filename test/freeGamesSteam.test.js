import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamPayload, getFreeGames, gameEmbed, parseItadPayload } from '../src/modules/freeGames.js';
import { translate } from '../src/web/lib/i18n.js';

const now = Date.parse('2026-10-11T12:00:00Z');
const offer = (extra = {}) => ({
  id: 3810,
  title: 'Fireside Feelings (Steam) Giveaway',
  type: 'Game',
  platforms: 'PC, Steam',
  status: 'Active',
  description: 'Fireside Feelings is free on Steam until October 12!',
  instructions: 'Download this game directly via Steam before the offer expires.',
  open_giveaway_url: 'https://www.gamerpower.com/open/fireside-feelings-steam-giveaway',
  gamerpower_url: 'https://www.gamerpower.com/fireside-feelings-steam-giveaway',
  image: 'https://www.gamerpower.com/offers/game.jpg',
  worth: '$7.99',
  end_date: '2026-10-12 23:59:00',
  ...extra,
});

test('Steam: maps a direct permanent giveaway and credits the source', () => {
  const [game] = parseSteamPayload([offer()], now);
  assert.equal(game.title, 'Fireside Feelings');
  assert.equal(game.key, 'steam:firesidefeelings');
  assert.equal(game.store, 'Steam');
  assert.equal(game.endsOn, '2026-10-12');
  assert.ok(Number.isNaN(game.endsAt));
  const embed = gameEmbed(game).toJSON();
  assert.ok(embed.fields.some((f) => f.name === 'Źródło' && f.value.includes(game.sourceUrl)));
});

test('Steam: excludes keys, task giveaways, weekends, demos, beta, loot and inactive offers', () => {
  for (const extra of [
    { title: 'Dwarven Realms (Steam) Key Giveaway' },
    { instructions: 'Requires 10 ARP on Alienware. Activate a Product on Steam.' },
    { description: 'Free weekend on Steam' },
    { description: 'A free-to-play game on Steam' },
    { title: 'Demo (Steam) Giveaway' },
    { type: 'Beta' },
    { type: 'Loot' },
    { status: 'Expired' },
    { platforms: 'PC, Epic Games Store' },
    { end_date: '2026-10-10 23:59:00' },
    { description: 'Win this game.', instructions: 'Enter our contest.' },
  ])
    assert.deepEqual(parseSteamPayload([offer(extra)], now), [], JSON.stringify(extra));
});

test('Steam: rejects untrusted links and tolerates malformed or unknown expiry data', () => {
  for (const value of [null, {}, { status: 0 }, [null], [{}]])
    assert.deepEqual(parseSteamPayload(value, now), []);
  assert.deepEqual(parseSteamPayload([offer({ open_giveaway_url: 'https://evil.example/game' })], now), []);
  assert.deepEqual(parseSteamPayload([offer({ gamerpower_url: 'javascript:alert(1)' })], now), []);
  const [game] = parseSteamPayload([offer({ end_date: 'N/A' })], now);
  assert.equal(game.endsOn, null);
});

test('Steam: ITAD Steam results use the same dedup key', () => {
  const [steam] = parseSteamPayload([offer()], now);
  const [itad] = parseItadPayload([
    {
      title: 'Fireside Feelings',
      deal: {
        shop: { name: 'Steam' },
        price: { amount: 0 },
        regular: { amount: 7.99 },
        cut: 100,
      },
    },
  ]);
  assert.equal(steam.key, itad.key);
});

test('combined: Steam is fetched without API keys and survives Epic failure', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).includes('epicgames.com')) throw new Error('offline');
    assert.equal(url, 'https://www.gamerpower.com/api/giveaways?platform=steam&type=game');
    return { ok: true, status: 200, json: async () => [offer({ end_date: 'N/A' })] };
  });
  const games = await getFreeGames();
  assert.equal(games.length, 1);
  assert.equal(games[0].store, 'Steam');
  assert.equal(calls.length, 2);
});

test('combined: a Steam failure does not discard Epic games or merge the two stores', async (t) => {
  const epic = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              title: 'Fireside Feelings',
              price: { totalPrice: { discountPrice: 0 } },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: new Date(Date.now() - 60_000).toISOString(),
                        endDate: new Date(Date.now() + 60_000).toISOString(),
                        discountSetting: { discountPercentage: 0 },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
  let steamFails = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('epicgames.com')) return { ok: true, json: async () => epic };
    if (steamFails) throw new Error('offline');
    return { ok: true, status: 200, json: async () => [offer({ end_date: 'N/A' })] };
  });
  assert.equal((await getFreeGames()).length, 1);
  steamFails = false;
  assert.deepEqual(
    (await getFreeGames()).map((g) => g.store),
    ['Epic Games Store', 'Steam']
  );
});

test('Steam: no-giveaways response and DLC query are handled without false announcements', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 201, json: async () => ({}) }));
  assert.deepEqual(await getFreeGames(), []);
  assert.deepEqual(await getFreeGames({ kind: 'dlc' }), []);
});

test('dashboard: the new Steam explanation has a Polish translation', () => {
  const text =
    'Epic Games Store and Steam giveaways (via GamerPower) are checked hourly without API keys. Steam announcements include permanent claims; free weekends, demos and third-party key tasks are skipped. Other stores require an';
  assert.match(translate(text, 'pl'), /bez kluczy API/);
  assert.match(translate(text, 'pl'), /na stałe/);
});
