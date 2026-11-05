// The dashboard writes dates in its own format, so the appeals and moderation lists carry real
// times (epoch milliseconds) next to the worded "ago", and the Welcome page tells how members are
// verified (button or captcha) for its verify row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { createAppeal } = await import('../src/db/appeals.js');
const { addWarning } = await import('../src/db/modCases.js');
const { setGuildModule } = await import('../src/db/modules.js');

async function admin() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  return b;
}

test('appeals carry the time they were sent', async () => {
  const b = await admin();
  const before = Date.now();
  const id = await createAppeal(D_GUILD, {
    userId: '800000000000000041',
    userTag: 'someone',
    banReason: 'spam',
    answers: [{ q: 'Why?', a: 'Sorry' }],
  });
  const body = await (await b.get(`/api/v2/guilds/${D_GUILD}/appeals`)).json();
  const row = body.appeals.find((a) => a.id === id);
  assert.ok(row, 'the appeal is listed');
  assert.equal(typeof row.at, 'number');
  assert.ok(row.at >= before);
  assert.equal(row.decidedAt, null);
  assert.equal(typeof row.ago, 'string');
});

test('moderation cases carry the time they were made', async () => {
  const b = await admin();
  const before = Date.now();
  await addWarning({
    guildId: D_GUILD,
    userId: '800000000000000042',
    moderatorId: 'web',
    reason: 'being loud',
  });
  const body = await (await b.get(`/api/v2/guilds/${D_GUILD}/moderation`)).json();
  const row = body.cases.find((c) => c.reason === 'being loud');
  assert.ok(row, 'the case is listed');
  assert.equal(typeof row.at, 'number');
  assert.ok(row.at >= before);
});

test('the Welcome page says how verification works', async () => {
  const b = await admin();
  await setGuildModule(D_GUILD, 'verification', { enabled: true, config: { mode: 'captcha' } });
  const body = await (await b.get(`/api/v2/guilds/${D_GUILD}/modules/welcome/config`)).json();
  assert.equal(body.verificationEnabled, true);
  // Captcha only counts when the captcha keys are set (they are not in the test setup).
  assert.ok(['button', 'captcha'].includes(body.verificationMode));
  await setGuildModule(D_GUILD, 'verification', { enabled: true, config: { mode: 'button' } });
  const plain = await (await b.get(`/api/v2/guilds/${D_GUILD}/modules/welcome/config`)).json();
  assert.equal(plain.verificationMode, 'button');
});
