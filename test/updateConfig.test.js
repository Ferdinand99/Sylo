// The environment switches of the update notice (src/config.js): UPDATE_CHECK=off turns the check off, and
// the Wise Wren settings are all-or-nothing. Config is read once per process, so each case runs in a child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const READ = `
  const { config } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
  console.log(JSON.stringify({ updateCheck: config.updateCheck, wiseWren: config.wiseWren }));
`;

async function configWith(extra) {
  const env = {
    PATH: process.env.PATH,
    DISCORD_TOKEN: 'ci-placeholder',
    DISCORD_CLIENT_ID: '000000000000000000',
    SESSION_SECRET: 'x',
    ...extra,
  };
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', READ],
    { env, timeout: 30_000 }
  );
  return { ...JSON.parse(stdout.trim().split('\n').pop()), stderr };
}

test('the update check is on unless UPDATE_CHECK says off', async () => {
  assert.equal((await configWith({})).updateCheck, true);
  assert.equal((await configWith({ UPDATE_CHECK: 'on' })).updateCheck, true);
  assert.equal((await configWith({ UPDATE_CHECK: '' })).updateCheck, true);
  for (const off of ['off', 'OFF', 'false', '0', 'no']) {
    assert.equal((await configWith({ UPDATE_CHECK: off })).updateCheck, false, off);
  }
});

test('Wise Wren is off without all three settings, and a bad one says which but never the token', async () => {
  assert.equal((await configWith({})).wiseWren, null);
  const on = await configWith({
    WISE_WREN_URL: 'http://wise-wren:3003/',
    WISE_WREN_TOKEN: 'ww_secret_env_token',
    WISE_WREN_TARGET_ID: '4',
  });
  assert.deepEqual(on.wiseWren, { url: 'http://wise-wren:3003', token: 'ww_secret_env_token', targetId: 4 });
  const partial = await configWith({
    WISE_WREN_URL: 'https://wren.example.com',
    WISE_WREN_TOKEN: 'ww_secret_env_token',
  });
  assert.equal(partial.wiseWren, null);
  assert.match(partial.stderr, /WISE_WREN_TARGET_ID/);
  assert.doesNotMatch(partial.stderr, /ww_secret_env_token/);
  const bad = await configWith({
    WISE_WREN_URL: 'http://wren.example.com',
    WISE_WREN_TOKEN: 'ww_secret_env_token',
    WISE_WREN_TARGET_ID: '4',
  });
  assert.equal(bad.wiseWren, null);
  assert.match(bad.stderr, /WISE_WREN_URL is not usable/);
  assert.doesNotMatch(bad.stderr, /ww_secret_env_token/);
});
