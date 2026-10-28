import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_PATHS, isPublicPath } from '../web-v2/src/publicRoutes.js';
import { PUBLIC_PAGES } from '../src/web/routes/v2Client.js';

test('the app and the server agree on which pages are public', () => {
  assert.deepEqual([...PUBLIC_PATHS].sort(), [...PUBLIC_PAGES].sort());
});

test('isPublicPath: the two public pages, with or without a trailing slash or capitals', () => {
  assert.equal(isPublicPath('/commands'), true);
  assert.equal(isPublicPath('/roadmap/'), true);
  assert.equal(isPublicPath('/Roadmap'), true);
});

test('isPublicPath: nothing else is public', () => {
  for (const p of ['/', '/roadmap/admin', '/account', '/guilds/900000000000000201/commands', '/commandsx']) {
    assert.equal(isPublicPath(p), false, p);
  }
});
