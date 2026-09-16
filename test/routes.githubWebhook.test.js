import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startWebApp } from './helpers/webApp.js';
import { CH, ROLE, GID } from './helpers/fakeGuild.js';
import { createGithubWatch, getGithubWatch } from '../src/db/githubWatches.js';
import { setGuildModule } from '../src/db/modules.js';

function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function postWebhook(base, token, { event, body, secret, signatureOverride }) {
  const raw = Buffer.from(JSON.stringify(body));
  return fetch(`${base}/webhooks/github/${token}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signatureOverride ?? sign(secret, raw),
    },
    body: raw,
  });
}

test('github webhook: valid signature posts a formatted embed to the configured channel', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: true, config: {} });
    const id = await createGithubWatch(GID, { repo: 'o/r', channelId: CH.general, events: ['release'] });
    const { token, secret } = await getGithubWatch(GID, id);

    const res = await postWebhook(app.base, token, {
      event: 'release',
      secret,
      body: {
        action: 'published',
        repository: { full_name: 'o/r' },
        release: { tag_name: 'v1.0.0', name: 'v1.0.0', html_url: 'https://x/rel' },
      },
    });

    assert.equal(res.status, 200);
    assert.equal(app.sink.messages.length, 1);
    assert.equal(app.sink.messages[0].channel, CH.general);
    assert.match(app.sink.messages[0].payload.embeds[0].title, /New release: o\/r v1\.0\.0/);
  } finally {
    app.close();
  }
});

test('github webhook: a configured role gets pinged in the posted message', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: true, config: {} });
    const id = await createGithubWatch(GID, {
      repo: 'o/r',
      channelId: CH.general,
      roleId: ROLE.member,
      events: ['release'],
    });
    const { token, secret } = await getGithubWatch(GID, id);

    await postWebhook(app.base, token, {
      event: 'release',
      secret,
      body: { action: 'published', repository: { full_name: 'o/r' }, release: { tag_name: 'v1' } },
    });

    const sent = app.sink.messages[0].payload;
    assert.equal(sent.content, `<@&${ROLE.member}>`);
    assert.deepEqual(sent.allowedMentions, { roles: [ROLE.member] });
  } finally {
    app.close();
  }
});

test('github webhook: wrong secret is rejected with 401 and nothing is posted', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: true, config: {} });
    const id = await createGithubWatch(GID, { repo: 'o/r', channelId: CH.general, events: ['release'] });
    const { token } = await getGithubWatch(GID, id);

    const res = await postWebhook(app.base, token, {
      event: 'release',
      secret: 'totally-the-wrong-secret',
      body: { action: 'published', repository: { full_name: 'o/r' }, release: {} },
    });

    assert.equal(res.status, 401);
    assert.equal(app.sink.messages.length, 0);
  } finally {
    app.close();
  }
});

test('github webhook: unknown token 404s', async () => {
  const app = await startWebApp();
  try {
    const res = await postWebhook(app.base, 'this-token-does-not-exist', {
      event: 'push',
      secret: 'irrelevant',
      body: {},
    });
    assert.equal(res.status, 404);
  } finally {
    app.close();
  }
});

test('github webhook: a correctly signed ping posts a connectivity confirmation regardless of the event filter', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: true, config: {} });
    const id = await createGithubWatch(GID, { repo: 'o/r', channelId: CH.general, events: ['release'] }); // no 'ping' in the list
    const { token, secret } = await getGithubWatch(GID, id);

    const res = await postWebhook(app.base, token, { event: 'ping', secret, body: { zen: 'hi' } });

    assert.equal(res.status, 200);
    assert.equal(app.sink.messages.length, 1);
    assert.match(app.sink.messages[0].payload.embeds[0].description, /connected/);
  } finally {
    app.close();
  }
});

test("github webhook: an event not in the watch's list is verified but silently ignored", async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: true, config: {} });
    const id = await createGithubWatch(GID, { repo: 'o/r', channelId: CH.general, events: ['release'] });
    const { token, secret } = await getGithubWatch(GID, id);

    const res = await postWebhook(app.base, token, {
      event: 'push',
      secret,
      body: { repository: { full_name: 'o/r' }, commits: [{ id: 'a', message: 'm', url: 'x', author: {} }] },
    });

    assert.equal(res.status, 200); // acknowledged
    assert.equal(app.sink.messages.length, 0); // but not posted — 'push' isn't checked for this watch
  } finally {
    app.close();
  }
});

// Only intercepts raw.githubusercontent.com — postWebhook() above also uses
// the global fetch to hit the local test server, which must go through untouched.
function withMockedChangelogFetch(rawFileResponse, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).startsWith('https://raw.githubusercontent.com/')) return rawFileResponse;
    return realFetch(url, ...rest);
  };
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

test('github webhook: a push touching the changelog path posts only its latest entry', async () => {
  const app = await startWebApp();
  try {
    await withMockedChangelogFetch(
      { ok: true, text: async () => '## v2\nnewest entry\n\n## v1\nold entry' },
      async () => {
        await setGuildModule(GID, 'github', { enabled: true, config: {} });
        const id = await createGithubWatch(GID, {
          repo: 'Ferdinand99/home-assistant-newt-addon',
          channelId: CH.general,
          changelogPath: 'newt-beta/CHANGELOG.md',
          events: [], // deliberately no 'push' checked — changelog watching is independent
        });
        const { token, secret } = await getGithubWatch(GID, id);

        const res = await postWebhook(app.base, token, {
          event: 'push',
          secret,
          body: {
            after: 'deadbeef',
            compare: 'https://github.com/x/compare',
            repository: { full_name: 'Ferdinand99/home-assistant-newt-addon', private: false },
            commits: [{ added: [], modified: ['newt-beta/CHANGELOG.md'], removed: [] }],
          },
        });

        assert.equal(res.status, 200);
        assert.equal(app.sink.messages.length, 1);
        const embed = app.sink.messages[0].payload.embeds[0];
        assert.match(embed.description, /newest entry/);
        assert.doesNotMatch(embed.description, /old entry/);
      }
    );
  } finally {
    app.close();
  }
});

test("github webhook: a push NOT touching the changelog path doesn't trigger a fetch or a post", async () => {
  const app = await startWebApp();
  try {
    let fetched = false;
    await withMockedChangelogFetch(
      {
        ok: true,
        text: async () => {
          fetched = true;
          return '## v1\nhi';
        },
      },
      async () => {
        await setGuildModule(GID, 'github', { enabled: true, config: {} });
        const id = await createGithubWatch(GID, {
          repo: 'o/r',
          channelId: CH.general,
          changelogPath: 'CHANGELOG.md',
          events: [],
        });
        const { token, secret } = await getGithubWatch(GID, id);

        await postWebhook(app.base, token, {
          event: 'push',
          secret,
          body: {
            after: 'deadbeef',
            repository: { full_name: 'o/r', private: false },
            commits: [{ added: [], modified: ['unrelated-file.txt'], removed: [] }],
          },
        });

        assert.equal(fetched, false);
        assert.equal(app.sink.messages.length, 0);
      }
    );
  } finally {
    app.close();
  }
});

test('github webhook: a private repo skips the changelog fetch entirely (no token support yet)', async () => {
  const app = await startWebApp();
  try {
    let fetched = false;
    await withMockedChangelogFetch(
      {
        ok: true,
        text: async () => {
          fetched = true;
          return '## v1\nhi';
        },
      },
      async () => {
        await setGuildModule(GID, 'github', { enabled: true, config: {} });
        const id = await createGithubWatch(GID, {
          repo: 'o/r',
          channelId: CH.general,
          changelogPath: 'CHANGELOG.md',
          events: [],
        });
        const { token, secret } = await getGithubWatch(GID, id);

        await postWebhook(app.base, token, {
          event: 'push',
          secret,
          body: {
            after: 'deadbeef',
            repository: { full_name: 'o/r', private: true },
            commits: [{ added: [], modified: ['CHANGELOG.md'], removed: [] }],
          },
        });

        assert.equal(fetched, false);
        assert.equal(app.sink.messages.length, 0);
      }
    );
  } finally {
    app.close();
  }
});

test('github webhook: changelog watching and the generic "push" checkbox can both fire for the same delivery', async () => {
  const app = await startWebApp();
  try {
    await withMockedChangelogFetch({ ok: true, text: async () => '## v2\nnewest' }, async () => {
      await setGuildModule(GID, 'github', { enabled: true, config: {} });
      const id = await createGithubWatch(GID, {
        repo: 'o/r',
        channelId: CH.general,
        changelogPath: 'CHANGELOG.md',
        events: ['push'], // both on this time
      });
      const { token, secret } = await getGithubWatch(GID, id);

      await postWebhook(app.base, token, {
        event: 'push',
        secret,
        body: {
          after: 'deadbeef',
          ref: 'refs/heads/main',
          repository: { full_name: 'o/r', private: false },
          commits: [
            {
              id: 'a',
              message: 'm',
              url: 'x',
              author: { name: 'ann' },
              added: [],
              modified: ['CHANGELOG.md'],
              removed: [],
            },
          ],
        },
      });

      assert.equal(app.sink.messages.length, 2);
      assert.match(app.sink.messages[0].payload.embeds[0].title, /Changelog update/);
      assert.match(app.sink.messages[1].payload.embeds[0].title, /new commit/);
    });
  } finally {
    app.close();
  }
});

test('github webhook: a disabled module is acknowledged but not acted on', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'github', { enabled: false, config: {} });
    const id = await createGithubWatch(GID, { repo: 'o/r', channelId: CH.general, events: ['release'] });
    const { token, secret } = await getGithubWatch(GID, id);

    const res = await postWebhook(app.base, token, {
      event: 'release',
      secret,
      body: { action: 'published', repository: { full_name: 'o/r' }, release: {} },
    });

    assert.equal(res.status, 200);
    assert.equal(app.sink.messages.length, 0);
  } finally {
    app.close();
  }
});
