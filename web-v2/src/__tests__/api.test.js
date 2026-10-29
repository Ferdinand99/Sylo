import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock;
let api;

beforeEach(async () => {
  // api.js keeps the CSRF token in module state, so every test gets a fresh copy.
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = await import('../api.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const csrfCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/v2/csrf');
const postCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('apiFetch CSRF handling', () => {
  it('sends the session token on a write and fetches it once', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/v2/csrf' ? json({ token: 'tok-1' }) : json({ ok: true })
    );
    await api.apiFetch('/api/v2/x', { method: 'POST' });
    await api.apiFetch('/api/v2/x', { method: 'POST' });
    expect(csrfCalls()).toHaveLength(1);
    expect(postCalls()).toHaveLength(2);
    for (const [, init] of postCalls()) expect(init.headers['x-csrf-token']).toBe('tok-1');
  });

  it('does not fetch a token for a read', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await api.apiFetch('/api/v2/x');
    expect(csrfCalls()).toHaveLength(0);
  });

  it('answers a 403 CSRF refusal by refetching the token and retrying the write once', async () => {
    const tokens = ['old-token', 'new-token'];
    let posts = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/v2/csrf') return json({ token: tokens.shift() });
      posts += 1;
      // The server refuses the first token (the session's token changed) and accepts the second.
      return init.headers['x-csrf-token'] === 'new-token'
        ? json({ saved: true })
        : json({ error: 'CSRF check failed — reload the page and try again.' }, 403);
    });

    await expect(api.apiFetch('/api/v2/x', { method: 'POST', body: '{}' })).resolves.toEqual({ saved: true });

    expect(posts).toBe(2);
    expect(csrfCalls()).toHaveLength(2);
    expect(postCalls().map(([, init]) => init.headers['x-csrf-token'])).toEqual(['old-token', 'new-token']);
  });

  it('surfaces the second CSRF refusal instead of retrying again', async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/v2/csrf') return json({ token: `tok-${++n}` });
      return json({ error: 'CSRF check failed — reload the page and try again.' }, 403);
    });

    const err = await api.apiFetch('/api/v2/x', { method: 'POST' }).catch((e) => e);

    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/CSRF/);
    expect(postCalls()).toHaveLength(2);
    expect(csrfCalls()).toHaveLength(2);
  });

  it('does not retry a 403 that is not a CSRF refusal', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/v2/csrf' ? json({ token: 't' }) : json({ error: 'Not allowed for this server.' }, 403)
    );
    const err = await api.apiFetch('/api/v2/x', { method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(403);
    expect(postCalls()).toHaveLength(1);
    expect(csrfCalls()).toHaveLength(1);
  });

  it('does not retry a GET', async () => {
    fetchMock.mockResolvedValue(json({ error: 'CSRF check failed' }, 403));
    await expect(api.apiFetch('/api/v2/x')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('gid() (server id in API paths)', () => {
  const discordId = '123456789012345678';
  const fluxerKey = `fluxer:${discordId}`;

  beforeEach(() => {
    fetchMock.mockResolvedValue(json({ ok: true }));
  });

  it('leaves a plain Discord id as it is', async () => {
    await api.getOverview(discordId);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v2/guilds/${discordId}/overview`);
  });

  it('percent-encodes the colon of a Fluxer key', async () => {
    await api.getOverview(fluxerKey);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v2/guilds/fluxer%3A${discordId}/overview`);
  });

  it('uses the encoded key in write paths too', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/v2/csrf' ? json({ token: 't' }) : json({ config: {} })
    );
    await api.saveModuleConfig(fluxerKey, 'sticky', { stickies: [] });
    const [url, init] = postCalls()[0];
    expect(url).toBe(`/api/v2/guilds/fluxer%3A${discordId}/modules/sticky/config`);
    expect(init.body).toBe(JSON.stringify({ stickies: [] }));
  });

  it.each([
    ['a path traversal', '../account'],
    ['an encoded traversal', '123456789012345678/../x'],
    ['a too short id', '12345'],
    ['a prefix other than fluxer', 'discord:123456789012345678'],
    ['an empty id', ''],
    ['no id', undefined],
  ])('refuses %s without sending a request', (_name, bad) => {
    // gid() runs while the path is built, so the ApiError is thrown synchronously, not as a rejection.
    let err;
    try {
      api.getOverview(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({ status: 400, message: 'Unknown server' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
