import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildBotInvites } = await import('../src/web/lib/botInvites.js');

const parse = (url) => new URL(url);

test('a Discord-only install offers one Discord invite', () => {
  const invites = buildBotInvites({ discordClientId: '123456789012345678' });
  assert.deepEqual(
    invites.map((i) => i.platform),
    ['discord']
  );
  const u = parse(invites[0].url);
  assert.equal(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(u.searchParams.get('client_id'), '123456789012345678');
  assert.match(u.searchParams.get('scope'), /\bbot\b/);
});

test('a Fluxer-only install offers one Fluxer invite on the configured instance', () => {
  const invites = buildBotInvites({
    fluxerClientId: '223456789012345678',
    fluxerWeb: 'https://fluxer.example',
  });
  assert.deepEqual(
    invites.map((i) => i.platform),
    ['fluxer']
  );
  const u = parse(invites[0].url);
  assert.equal(u.origin + u.pathname, 'https://fluxer.example/oauth2/authorize');
  assert.equal(u.searchParams.get('client_id'), '223456789012345678');
  assert.equal(u.searchParams.get('scope'), 'bot');
  assert.ok(BigInt(u.searchParams.get('permissions')) > 0n);
});

test('both platforms give both invites, Discord first, each labelled', () => {
  const invites = buildBotInvites({
    discordClientId: '123456789012345678',
    fluxerClientId: '223456789012345678',
    fluxerWeb: 'https://web.fluxer.app',
  });
  assert.deepEqual(
    invites.map((i) => [i.platform, i.label]),
    [
      ['discord', 'Discord'],
      ['fluxer', 'Fluxer'],
    ]
  );
});

test('nothing configured, nothing offered', () => {
  assert.deepEqual(buildBotInvites({}), []);
});

// Invite tracking reads the server's invites and native AutoMod manages rules: both need
// Manage Server (bit 5), which the invite link used to leave out.
test('the Discord invite asks for Manage Server', () => {
  const [d] = buildBotInvites({ discordClientId: '123456789012345678' });
  const perms = BigInt(new URL(d.url).searchParams.get('permissions'));
  assert.equal(perms & (1n << 5n), 1n << 5n);
});
