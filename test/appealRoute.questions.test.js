// The public appeal form posts its answers by position. Staff can reorder or edit the questions
// while a banned user is writing, so the form says which questions it was showing and the server
// must not file answers under the wrong question.
import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGlobalDispatcher, Agent } from 'undici';
import { runtime } from '../src/runtime.js';
import { createApp } from '../src/web/server.js';
import { setGuildModule } from '../src/db/modules.js';
import { matchAnswers, signAppealToken } from '../src/modules/appeals.js';
import { listAppeals } from '../src/db/appeals.js';

setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 100 }));

const RAW = '555555555555555555';
const KEY = `fluxer:${RAW}`;
const USER = '666666666666666666';
const OTHER_USER = '777777777777777777'; // the tests share one database

test('matchAnswers: same questions pass the answers straight through', () => {
  assert.deepEqual(matchAnswers(['A', 'B'], ['A', 'B'], ['1', '2']), { current: true, answers: ['1', '2'] });
  // A form from before the check existed does not say which questions it had.
  assert.deepEqual(matchAnswers(['A', 'B'], null, ['1']), { current: true, answers: ['1', ''] });
});

test('matchAnswers: a reorder keeps each answer with its question, new questions start empty', () => {
  assert.deepEqual(matchAnswers(['B', 'A', 'C'], ['A', 'B'], ['for A', 'for B']), {
    current: false,
    answers: ['for B', 'for A', ''],
  });
  // An edited question loses its answer; a repeated text is matched once per copy.
  assert.deepEqual(matchAnswers(['A2', 'B'], ['A', 'B'], ['x', 'y']), { current: false, answers: ['', 'y'] });
  assert.deepEqual(matchAnswers(['A', 'A'], ['A'], ['x']), { current: false, answers: ['x', ''] });
});

async function withServer(fn) {
  const client = {
    isReady: () => true,
    ws: { ping: 5 },
    user: { displayAvatarURL: () => null },
    commands: new Map(),
    users: { fetch: async () => ({ tag: 'Banned#0001' }) },
    guilds: { cache: new Map() },
  };
  const guild = {
    id: RAW,
    name: 'Fluxer Test',
    iconURL: () => null,
    members: { cache: new Map() },
    ownerId: 'x',
    client,
    bans: { fetch: async () => ({ reason: 'spam' }) },
    channels: { cache: new Map() },
  };
  client.guilds.cache.set(RAW, guild);
  runtime.clients.fluxer = client;
  await setGuildModule(KEY, 'appeals', { enabled: true, config: { questions: ['Q1', 'Q2'] } });
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  try {
    const post = (body) =>
      fetch(`http://127.0.0.1:${server.address().port}/appeal/${encodeURIComponent(KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'manual',
      });
    await fn(post);
  } finally {
    server.closeAllConnections?.();
    server.close();
    runtime.clients.fluxer = null;
  }
}

test('an appeal from a form with the current questions is stored under them', async () => {
  await withServer(async (post) => {
    const body = new URLSearchParams();
    body.append('t', signAppealToken(KEY, USER));
    for (const q of ['Q1', 'Q2']) body.append('q', q);
    body.append('a', 'first');
    body.append('a', 'second');
    const res = await post(body);
    assert.match(await res.text(), /Appeal submitted/);
    const [appeal] = await listAppeals(KEY);
    assert.deepEqual(appeal.answers, [
      { q: 'Q1', a: 'first' },
      { q: 'Q2', a: 'second' },
    ]);
  });
});

test('questions changed while writing: nothing is stored, the form comes back with the answers kept by question', async () => {
  await withServer(async (post) => {
    const body = new URLSearchParams();
    body.append('t', signAppealToken(KEY, OTHER_USER));
    // The form was rendered when staff still had the order Q2, Q1.
    for (const q of ['Q2', 'Q1']) body.append('q', q);
    body.append('a', 'about two');
    body.append('a', 'about one');
    const res = await post(body);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /The questions changed while you were writing/);
    assert.doesNotMatch(html, /Appeal submitted/);
    assert.equal((await listAppeals(KEY)).filter((a) => a.user_id === OTHER_USER).length, 0, 'not stored');
    // Q1 is the first live question and keeps "about one"; Q2 keeps "about two".
    assert.match(html, /id="appeal-a-0"[^>]*>about one<\/textarea>/);
    assert.match(html, /id="appeal-a-1"[^>]*>about two<\/textarea>/);
  });
});
