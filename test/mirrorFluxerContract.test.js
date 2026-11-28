// The two order calls of the server mirror against Fluxer's real request shapes. The adapter (src/mirror/target.js)
// runs on the real SDK (a Guild of @fluxerjs/core and its REST client); only the network is swapped for a local HTTP
// server that records each request and answers as Fluxer does (fluxer_api GuildRoleController / GuildChannelController:
// 204 No Content on success, a 400 with `errors` when the form is refused).
//
// The route bodies, per Fluxer's schemas (packages/schema):
//   PATCH /guilds/{id}/roles     [{ id: snowflake, position?: int }]                       (at most 10000)
//   PATCH /guilds/{id}/channels  [{ id, position?: int >= 0, parent_id?: snowflake | null,
//                                   preceding_sibling_id?: snowflake | null, lock_permissions?: bool }]
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as sdk from '@fluxerjs/core';
import { createFluxerTarget } from '../src/mirror/target.js';
import { classifyError } from '../src/mirror/errors.js';

const GUILD = '800000000000000050';
const requests = [];
let answer = () => ({ status: 204 });
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        raw,
      });
      const { status, body } = answer();
      if (body === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** A Guild of the real SDK whose REST client talks to the recording server. */
function sdkGuild() {
  const client = new sdk.Client({});
  client.rest = new client.rest.constructor({ api: base, version: '1', retries: 0 });
  client.rest.setToken('test-token');
  return new sdk.Guild(client, { id: GUILD, name: 'Target' });
}

const last = () => requests.at(-1);

test('the role order is one PATCH of [{ id, position }] to /guilds/{id}/roles, and a 204 is success', async () => {
  answer = () => ({ status: 204 });
  const target = createFluxerTarget(sdkGuild());
  await target.setRolePositions([
    { id: '810000000000000002', position: 1 },
    { id: '810000000000000001', position: 2 },
  ]);
  const req = last();
  assert.equal(req.method, 'PATCH');
  assert.equal(req.path, `/api/v1/guilds/${GUILD}/roles`);
  assert.equal(req.auth, 'Bot test-token');
  assert.match(req.type, /application\/json/);
  assert.equal(
    req.raw,
    '[{"id":"810000000000000002","position":1},{"id":"810000000000000001","position":2}]',
    'a bare array, string ids, integer positions, nothing else'
  );
});

test("the SDK's own guild.setRolePositions() throws on Fluxer's 204 (why the adapter calls the route itself)", async () => {
  answer = () => ({ status: 204 });
  const guild = sdkGuild();
  const sentBefore = requests.length;
  await assert.rejects(guild.setRolePositions([{ id: '810000000000000001', position: 1 }]), (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /reading 'map'/);
    return true;
  });
  assert.equal(requests.length, sentBefore + 1, 'the order did reach Fluxer before the SDK threw');
});

test('the channel order is one PATCH of [{ id, position, parent_id, lock_permissions }] to /guilds/{id}/channels', async () => {
  answer = () => ({ status: 204 });
  const target = createFluxerTarget(sdkGuild());
  await target.setChannelPositions([
    { id: '820000000000000001', position: 0, parentId: null },
    { id: '820000000000000002', position: 0, parentId: '820000000000000001' },
    { id: '820000000000000003', position: 1, parentId: '820000000000000001' },
  ]);
  const req = last();
  assert.equal(req.method, 'PATCH');
  assert.equal(req.path, `/api/v1/guilds/${GUILD}/channels`);
  assert.equal(req.auth, 'Bot test-token');
  assert.deepEqual(JSON.parse(req.raw), [
    { id: '820000000000000001', position: 0, parent_id: null, lock_permissions: false },
    { id: '820000000000000002', position: 0, parent_id: '820000000000000001', lock_permissions: false },
    { id: '820000000000000003', position: 1, parent_id: '820000000000000001', lock_permissions: false },
  ]);
  for (const item of JSON.parse(req.raw)) {
    assert.ok(Number.isInteger(item.position) && item.position >= 0, 'position is a non-negative integer');
    assert.equal(typeof item.id, 'string');
  }
});

test('a refused order is an item error that says what Fluxer refused', async () => {
  answer = () => ({
    status: 400,
    body: {
      code: 'INVALID_FORM_BODY',
      message: 'Invalid form body.',
      errors: [
        {
          path: 'preceding_sibling_id',
          message: 'Voice channels cannot be above text channels.',
          code: 'VOICE_CHANNELS_CANNOT_BE_ABOVE_TEXT_CHANNELS',
        },
      ],
    },
  });
  const target = createFluxerTarget(sdkGuild());
  await assert.rejects(
    target.setChannelPositions([{ id: '820000000000000002', position: 0, parentId: null }]),
    (err) => {
      const c = classifyError(err);
      assert.equal(c.kind, 'item');
      assert.match(c.message, /^Invalid form body\./);
      assert.match(c.message, /preceding_sibling_id: Voice channels cannot be above text channels/);
      return true;
    }
  );
});
