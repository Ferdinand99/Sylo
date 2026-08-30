import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicPayload, parseItadPayload, gameKey } from '../src/modules/freeGames.js';

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function element(overrides = {}) {
  return {
    id: 'offer-1',
    title: 'Some Game',
    description: 'A game.',
    keyImages: [{ type: 'OfferImageWide', url: 'https://img/wide.jpg' }],
    price: { totalPrice: { discountPrice: 0, fmtPrice: { originalPrice: '$19.99' } } },
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            { startDate: iso(now - 3600e3), endDate: iso(now + 3600e3), discountSetting: { discountPercentage: 0 } },
          ],
        },
      ],
    },
    catalogNs: { mappings: [{ pageSlug: 'some-game' }] },
    ...overrides,
  };
}

const payload = (els) => ({ data: { Catalog: { searchStore: { elements: els } } } });

test('parseEpicPayload: returns a currently-free game with a store URL', () => {
  const [g] = parseEpicPayload(payload([element()]));
  assert.equal(g.key, 'somegame');
  assert.equal(g.title, 'Some Game');
  assert.equal(g.kind, 'game');
  assert.equal(g.url, 'https://store.epicgames.com/en-US/p/some-game');
  assert.equal(g.priceText, '$19.99');
  assert.ok(g.endsAt > now);
});

test('parseEpicPayload: skips games that are not free', () => {
  const el = element({ price: { totalPrice: { discountPrice: 1999 } } });
  assert.equal(parseEpicPayload(payload([el])).length, 0);
});

test('parseEpicPayload: skips games whose promo window is not active', () => {
  const el = element({
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            { startDate: iso(now + 86400e3), endDate: iso(now + 2 * 86400e3), discountSetting: { discountPercentage: 0 } },
          ],
        },
      ],
    },
  });
  assert.equal(parseEpicPayload(payload([el])).length, 0);
});

test('parseEpicPayload: tolerates an empty / malformed payload', () => {
  assert.deepEqual(parseEpicPayload({}), []);
  assert.deepEqual(parseEpicPayload(null), []);
});

test('gameKey: normalises titles so Epic and ITAD entries collapse', () => {
  assert.equal(gameKey('Tomb Raider: Anniversary'), gameKey('tomb raider anniversary'));
  assert.equal(gameKey('  Hades  '), 'hades');
});

const itad = (rows) => ({ list: rows });
const itadRow = (over = {}) => ({
  title: 'Deal Game',
  slug: 'deal-game',
  type: 'game',
  deal: {
    shop: { name: 'GOG' },
    price: { amount: 0, currency: 'USD' },
    regular: { amount: 14.99, currency: 'USD' },
    cut: 100,
    url: 'https://gog.com/game/deal-game',
    expiry: new Date(now + 3600e3).toISOString(),
  },
  ...over,
});

test('parseItadPayload: keeps 100%-off games, maps store/price/expiry', () => {
  const [g] = parseItadPayload(itad([itadRow()]));
  assert.equal(g.key, 'dealgame');
  assert.equal(g.store, 'GOG');
  assert.equal(g.kind, 'game');
  assert.equal(g.priceText, '14.99 USD');
  assert.ok(g.endsAt > now);
});

test('parseItadPayload: filters DLC vs game by "kind"', () => {
  const rows = [itadRow(), itadRow({ title: 'Some DLC', type: 'dlc' })];
  assert.deepEqual(parseItadPayload(itad(rows), 'game').map((g) => g.title), ['Deal Game']);
  assert.deepEqual(parseItadPayload(itad(rows), 'dlc').map((g) => g.title), ['Some DLC']);
});

test('parseItadPayload: skips deals that are not free', () => {
  const notFree = itadRow({ deal: { ...itadRow().deal, cut: 80, price: { amount: 300, currency: 'USD' } } });
  assert.equal(parseItadPayload(itad([notFree])).length, 0);
});
