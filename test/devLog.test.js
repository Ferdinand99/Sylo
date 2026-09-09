import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyDevLog, sendDevLogTest, _resetDevLogThrottle } from '../src/lib/devLog.js';
import { runtime } from '../src/runtime.js';

/** Run `fn` with a stand-in Discord client, restoring the real one after. */
async function withClient(client, fn) {
  const real = runtime.client;
  runtime.client = client;
  _resetDevLogThrottle();
  try {
    await fn();
  } finally {
    runtime.client = real;
    _resetDevLogThrottle();
  }
}

function fakeChannel({ guild = null } = {}) {
  const sent = [];
  return {
    sent,
    isTextBased: () => true,
    guild,
    send: async (payload) => {
      sent.push(payload);
    },
  };
}

test('notifyDevLog: no-op with no channel configured', async () => {
  // config.devLogChannelId is unset in the test env, and no override is given.
  await assert.doesNotReject(async () => notifyDevLog('error', 'db', 'boom'));
});

test('notifyDevLog: no-op when the client is not ready', async () => {
  await withClient({ isReady: () => false }, async () => {
    let fetched = false;
    runtime.client.channels = { fetch: async () => ((fetched = true), null) };
    notifyDevLog('error', 'db', 'boom', { channelId: '111111111111111111' });
    await Promise.resolve(); // let any stray microtask settle
    assert.equal(fetched, false);
  });
});

test('notifyDevLog: posts an embed to the configured channel when ready', async () => {
  const channel = fakeChannel();
  await withClient(
    {
      isReady: () => true,
      channels: { fetch: async () => channel },
    },
    async () => {
      notifyDevLog('error', 'youtube-alerts', 'resolve failed: HTTP 429', {
        channelId: '111111111111111111',
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(channel.sent.length, 1);
      const embed = channel.sent[0].embeds[0];
      assert.match(embed.title, /youtube-alerts/);
      assert.match(embed.description, /HTTP 429/);
      assert.equal(embed.color, 0xed4245);
    }
  );
});

test('notifyDevLog: an identical scope+message is throttled, not reposted', async () => {
  const channel = fakeChannel();
  await withClient(
    {
      isReady: () => true,
      channels: { fetch: async () => channel },
    },
    async () => {
      notifyDevLog('error', 'db', 'connection lost', { channelId: '111111111111111111' });
      notifyDevLog('error', 'db', 'connection lost', { channelId: '111111111111111111' });
      notifyDevLog('error', 'db', 'connection lost', { channelId: '111111111111111111' });
      await new Promise((r) => setImmediate(r));
      assert.equal(channel.sent.length, 1);
    }
  );
});

test('notifyDevLog: a different message from the same scope is not throttled', async () => {
  const channel = fakeChannel();
  await withClient(
    {
      isReady: () => true,
      channels: { fetch: async () => channel },
    },
    async () => {
      notifyDevLog('error', 'db', 'connection lost', { channelId: '111111111111111111' });
      notifyDevLog('error', 'db', 'query timed out', { channelId: '111111111111111111' });
      await new Promise((r) => setImmediate(r));
      assert.equal(channel.sent.length, 2);
    }
  );
});

test('notifyDevLog: skips a channel the bot lacks permission in', async () => {
  const channel = fakeChannel({
    guild: {
      members: { me: {} },
      // `channel.permissionsFor` in real discord.js — stub it directly on
      // the fake channel object below instead of trying to model the guild API.
    },
  });
  channel.permissionsFor = () => ({ has: () => false });
  await withClient(
    {
      isReady: () => true,
      channels: { fetch: async () => channel },
    },
    async () => {
      notifyDevLog('error', 'db', 'boom', { channelId: '111111111111111111' });
      await new Promise((r) => setImmediate(r));
      assert.equal(channel.sent.length, 0);
    }
  );
});

test('sendDevLogTest: reports the reason when no channel is configured', async () => {
  const result = await sendDevLogTest();
  assert.deepEqual(result, { ok: false, error: 'DEV_LOG_CHANNEL_ID is not set.' });
});

test('sendDevLogTest: reports the reason when the client is not connected yet', async () => {
  await withClient({ isReady: () => false }, async () => {
    const result = await sendDevLogTest({ channelId: '111111111111111111' });
    assert.equal(result.ok, false);
    assert.match(result.error, /not connected/);
  });
});

test('sendDevLogTest: succeeds and posts a message when everything is set up', async () => {
  const channel = fakeChannel();
  await withClient({ isReady: () => true, channels: { fetch: async () => channel } }, async () => {
    const result = await sendDevLogTest({ channelId: '111111111111111111' });
    assert.deepEqual(result, { ok: true });
    assert.equal(channel.sent.length, 1);
    assert.match(channel.sent[0].embeds[0].title, /Dev-log test/);
  });
});

test('sendDevLogTest: reports the reason when the channel lacks permission', async () => {
  const channel = fakeChannel({ guild: { members: { me: {} } } });
  channel.permissionsFor = () => ({ has: () => false });
  await withClient({ isReady: () => true, channels: { fetch: async () => channel } }, async () => {
    const result = await sendDevLogTest({ channelId: '111111111111111111' });
    assert.equal(result.ok, false);
    assert.match(result.error, /Send Messages|Embed Links|View Channel/);
    assert.equal(channel.sent.length, 0);
  });
});

test('notifyDevLog: never throws even if channels.fetch rejects', async () => {
  await withClient(
    {
      isReady: () => true,
      channels: {
        fetch: async () => {
          throw new Error('gateway down');
        },
      },
    },
    async () => {
      assert.doesNotThrow(() => notifyDevLog('error', 'db', 'boom', { channelId: '111111111111111111' }));
      await new Promise((r) => setImmediate(r)); // let the rejected promise settle, unhandled-safe
    }
  );
});
