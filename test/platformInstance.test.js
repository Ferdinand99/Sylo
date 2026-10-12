import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';

const { inviteUrl, setFluxerInstance, fluxerEndpoints } = await import('../src/platform/instance.js');

const fluxer = {};
const discordGuild = { client: {} };
const fluxerGuild = { client: fluxer };

test.beforeEach(() => {
  runtime.clients.fluxer = fluxer;
  setFluxerInstance(null);
});
test.afterEach(() => {
  runtime.clients.fluxer = null;
});

test('a Discord guild gets a discord.gg link', () => {
  assert.equal(inviteUrl(discordGuild, 'abc'), 'https://discord.gg/abc');
});

test('a Fluxer guild gets the invite host of its instance', () => {
  setFluxerInstance({
    endpoints: { invite: 'https://fluxer.opland.net/invite', webapp: 'https://fluxer.opland.net' },
  });
  assert.equal(inviteUrl(fluxerGuild, 'abc'), 'https://fluxer.opland.net/invite/abc');
});

test('hosted Fluxer (no instance document) uses fluxer.gg', () => {
  assert.equal(inviteUrl(fluxerGuild, 'abc'), 'https://fluxer.gg/abc');
  assert.equal(fluxerEndpoints().webapp, 'https://web.fluxer.app');
});

test('a fallback document with only the two origins still yields the web app origin', () => {
  setFluxerInstance({ api_public: 'https://f.test/api', webapp: 'https://f.test' });
  assert.equal(fluxerEndpoints().webapp, 'https://f.test');
  assert.equal(inviteUrl(fluxerGuild, 'x'), 'https://fluxer.gg/x');
});
