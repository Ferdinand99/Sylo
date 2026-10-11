import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

/** Pull the `_rr` config back out of `x-data="rrRows({...})"` and HTML-decode it. */
function rrData(html) {
  const m = html.match(/x-data="rrRows\((\{.*?\})\)"/s);
  if (!m) throw new Error('rrRows(...) data-x not found in response HTML');
  const decoded = m[1].replace(/&#34;/g, '"').replace(/&amp;/g, '&');
  return JSON.parse(decoded);
}

test('POST /m/roles/rr — missing channel re-renders the form with the typed row preserved, not a redirect', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/roles/rr`, {
    // channelId deliberately omitted
    rr_style: 'reaction',
    rr_emoji: '👍',
    rr_role: ROLE.member,
  });

  assert.equal(res.status, 200); // re-rendered in place, not a 3xx redirect
  const html = await res.text();
  assert.match(html, /Select a channel\./);
  // The typed row survived into the re-render instead of being discarded.
  const data = rrData(html);
  assert.deepEqual(data.pairs, [{ display: '👍', label: '', roleId: ROLE.member, btnStyle: 'secondary' }]);
});

test('POST /m/roles/rr — a role picked with no emoji (reaction style) reports which row, keeps the role picked', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/roles/rr`, {
    channelId: CH.general,
    rr_style: 'reaction',
    rr_emoji: '',
    rr_role: ROLE.member,
  });

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Row 1: enter a valid emoji/);
  assert.equal(rrData(html).pairs[0].roleId, ROLE.member);
});

test('POST /m/roles/rr — a second row with only a role (no emoji) is flagged without dropping the valid first row', async () => {
  // URLSearchParams(object) collapses array values into one comma-joined
  // field instead of repeating the key, so build the repeated-key body by
  // hand here (the way a real <template x-for> form submits multiple rows).
  const body = new URLSearchParams();
  body.append('channelId', CH.general);
  body.append('rr_style', 'reaction');
  body.append('rr_emoji', '👍');
  body.append('rr_emoji', '');
  body.append('rr_role', ROLE.member);
  body.append('rr_role', ROLE.admin);
  const res = await post(app.base, `/guilds/${GID}/m/roles/rr`, body.toString());

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Row 2: enter a valid emoji/);
  // Row 1 (valid) is still present in the redisplay alongside the error.
  const pairs = rrData(html).pairs;
  assert.deepEqual(
    pairs.map((p) => p.roleId),
    [ROLE.member, ROLE.admin]
  );
});

test('POST /m/roles/rr — no rows at all is reported as "add at least one role"', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/roles/rr`, {
    channelId: CH.general,
    rr_style: 'reaction',
  });

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Add at least one role\./);
});

test('POST /m/roles/rr — a fully valid submission is not re-rendered with errors', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/roles/rr`, {
    channelId: CH.general,
    rr_style: 'reaction',
    rr_emoji: '👍',
    rr_role: ROLE.member,
  });

  assert.equal(res.status, 302); // redirected away, not re-rendered with an error banner
  assert.match(res.headers.get('location'), /\/m\/roles\?msg=/);
});
