// PIGEON_URL: which addresses are accepted, and that a bad or empty one switches Pigeon off
// instead of stopping the start.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkPigeonUrl } from '../src/lib/pigeonUrl.js';

test('https addresses are accepted and written without a trailing slash', () => {
  assert.equal(checkPigeonUrl('https://pigeon.hedgerow.tools'), 'https://pigeon.hedgerow.tools');
  assert.equal(checkPigeonUrl('  https://pigeon.hedgerow.tools/  '), 'https://pigeon.hedgerow.tools');
  assert.equal(
    checkPigeonUrl('HTTPS://Pigeon.Example.COM:8443/relay//'),
    'https://pigeon.example.com:8443/relay'
  );
});

test('http is for this machine and the local network only', () => {
  for (const ok of [
    'http://localhost:3010',
    'http://127.0.0.1:3010',
    'http://10.0.3.26:3016',
    'http://172.16.4.2',
    'http://192.168.1.10:3010',
    'http://[::1]:3010',
    'http://pigeon.lan:3010',
    'http://pigeon.home.arpa',
  ]) {
    assert.doesNotThrow(() => checkPigeonUrl(ok), ok);
  }
  for (const bad of [
    'http://pigeon.hedgerow.tools',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://169.255.1.1',
    'http://example.com',
    'http://localhost.example.com',
  ]) {
    assert.throws(() => checkPigeonUrl(bad), /https/, bad);
  }
});

test('credentials, a query, a fragment, another scheme or no URL at all are refused', () => {
  for (const bad of [
    'https://user:pass@pigeon.example',
    'https://user@pigeon.example',
    'https://pigeon.example?x=1',
    'https://pigeon.example#frag',
    'ftp://pigeon.example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'pigeon.example',
    '',
    'https://',
  ]) {
    assert.throws(() => checkPigeonUrl(bad), Error, bad);
  }
});

// The configuration is read once per process, so each case runs in a child process.
const SCRIPT = `
  await import(${JSON.stringify(new URL('./helpers/tmpDb.js', import.meta.url).href)});
  const { config } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
  console.log(JSON.stringify({ pigeonUrl: config.pigeonUrl, relay: config.pushRelayUrl }));
`;

async function configWith(PIGEON_URL) {
  const env = { ...process.env, DISCORD_TOKEN: 'dtoken.test', DISCORD_CLIENT_ID: '123456789012345678' };
  delete env.PIGEON_URL;
  if (PIGEON_URL !== undefined) env.PIGEON_URL = PIGEON_URL;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', SCRIPT],
    {
      env,
      timeout: 30_000,
    }
  );
  return { ...JSON.parse(stdout.trim().split('\n').pop()), stderr };
}

test('config.pigeonUrl: unset or empty is off, a good address is kept, a bad one is off with a message', async () => {
  assert.equal((await configWith(undefined)).pigeonUrl, null);
  assert.equal((await configWith('')).pigeonUrl, null);
  assert.equal((await configWith('   ')).pigeonUrl, null);

  const good = await configWith('https://pigeon.hedgerow.tools/');
  assert.equal(good.pigeonUrl, 'https://pigeon.hedgerow.tools');
  assert.doesNotMatch(good.stderr, /PIGEON_URL/);

  const bad = await configWith('http://pigeon.hedgerow.tools');
  assert.equal(bad.pigeonUrl, null);
  assert.match(bad.stderr, /PIGEON_URL is not usable/);
  assert.doesNotMatch(bad.stderr, /pigeon\.hedgerow\.tools/, 'the message does not repeat the address');
});

test('PIGEON_URL does not change the older settings', async () => {
  const withPigeon = await configWith('https://pigeon.hedgerow.tools');
  const without = await configWith(undefined);
  assert.equal(withPigeon.relay, without.relay);
});
