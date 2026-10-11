import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnnouncement, setAnnouncement, clearAnnouncement } from '../src/db/appSettings.js';

test('announcement: none before anything is saved', async () => {
  assert.equal(await getAnnouncement(), null);
});

test('announcement: round-trips and sanitises', async () => {
  const saved = await setAnnouncement({
    title: 'Heads up',
    body: 'Something happened.',
    severity: 'warning',
  });
  assert.equal(saved.title, 'Heads up');
  assert.equal(saved.body, 'Something happened.');
  assert.equal(saved.severity, 'warning');
  assert.ok(Number.isFinite(saved.createdAt));

  const a = await getAnnouncement();
  assert.deepEqual(a, saved);

  const bad = await setAnnouncement({ title: 'x'.repeat(300), body: 'y'.repeat(3000), severity: 'nonsense' });
  assert.equal(bad.title.length, 200);
  assert.equal(bad.body.length, 2000);
  assert.equal(bad.severity, 'info');
});

test('announcement: critical severity is accepted as-is', async () => {
  const saved = await setAnnouncement({ title: 'Down', body: 'Investigating.', severity: 'critical' });
  assert.equal(saved.severity, 'critical');
});

test('announcement: saving a blank title clears it', async () => {
  await setAnnouncement({ title: 'Will be cleared', body: '', severity: 'info' });
  assert.notEqual(await getAnnouncement(), null);

  const result = await setAnnouncement({ title: '   ', body: '', severity: 'info' });
  assert.equal(result, null);
  assert.equal(await getAnnouncement(), null);
});

test('announcement: clearAnnouncement removes it', async () => {
  await setAnnouncement({ title: 'Temporary', body: '', severity: 'info' });
  assert.notEqual(await getAnnouncement(), null);

  await clearAnnouncement();
  assert.equal(await getAnnouncement(), null);
});
