// Who may import a configuration (routes/v2ConfigImport.js): server admins only, for their own server only,
// with the CSRF token every state-changing call needs. The preview is not a way to read another server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { getGuildModule } = await import('../src/db/modules.js');

const doc = {
  sylo: 'guild-config-export',
  version: 1,
  guildId: '1',
  settings: null,
  modules: [{ moduleId: 'afk', enabled: true, config: { setNickname: false } }],
  commandOverrides: [],
};

async function session() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body, { csrf = true } = {}) =>
    b.get(path, {
      method: 'POST',
      headers: { ...(csrf ? { 'x-csrf-token': token } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post };
}

test('a member without Manage Server cannot preview or apply an import on that server', async () => {
  const s = await session();
  for (const path of ['preview', 'apply']) {
    const res = await s.post(`/api/v2/guilds/${OTHER_D_GUILD}/import/${path}`, {
      export: doc,
      items: ['module:afk'],
      confirm: 'IMPORT',
    });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await getGuildModule(OTHER_D_GUILD, 'afk')).config.setNickname, undefined);
});

test('an admin needs the CSRF token, then can preview and apply on their own server', async () => {
  const s = await session();
  const body = { export: doc, items: ['module:afk'], confirm: 'IMPORT' };
  const noToken = await s.post(`/api/v2/guilds/${D_GUILD}/import/apply`, body, { csrf: false });
  assert.equal(noToken.status, 403);
  assert.equal((await getGuildModule(D_GUILD, 'afk')).config.setNickname, undefined);

  const preview = await s.post(`/api/v2/guilds/${D_GUILD}/import/preview`, body);
  assert.equal(preview.status, 200);
  const applied = await s.post(`/api/v2/guilds/${D_GUILD}/import/apply`, body);
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).results[0].ok, true);
  assert.equal((await getGuildModule(D_GUILD, 'afk')).config.setNickname, false);
  assert.equal((await getGuildModule(OTHER_D_GUILD, 'afk')).config.setNickname, undefined);
});
