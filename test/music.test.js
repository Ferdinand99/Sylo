import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import {
  MusicError,
  MusicSession,
  FFMPEG_ARGS,
  isPublicIp,
  parseAudioUrl,
  parseStations,
  normaliseMusic,
  openAudioStream,
  openTrack,
  safeLookup,
  titleFromUrl,
  formatDuration,
  MAX_PER_USER,
} from '../src/modules/music.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';

function fakePlayer() {
  const player = new EventEmitter();
  player.state = { status: 'idle' };
  player.played = [];
  player.play = (resource) => {
    player.state.status = 'playing';
    player.played.push(resource);
  };
  player.stop = () => {
    const was = player.state.status;
    player.state.status = 'idle';
    if (was !== 'idle') player.emit('idle');
    return was !== 'idle';
  };
  player.pause = () => (player.state.status === 'playing' ? ((player.state.status = 'paused'), true) : false);
  player.unpause = () => ((player.state.status = 'playing'), true);
  return player;
}

function makeSession(openTrack, limits = {}) {
  const connection = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const player = fakePlayer();
  const session = new MusicSession({
    guildId: GUILD,
    channelId: '333333333333333333',
    connection,
    player,
    limits: { maxQueue: 3, maxTrackMinutes: 10, idleLeaveMinutes: 5, ...limits },
    deps: { openTrack },
  });
  const messages = [];
  session.textChannel = { send: async (m) => messages.push(m.content) };
  return { session, player, connection, messages };
}
const track = (n, by = USER) => ({ url: `https://example.com/${n}.mp3`, title: `t${n}`, requestedBy: by });
const opener = () => {
  const stops = [];
  const fn = async (t) => ({
    resource: { t },
    stop: () => stops.push(t.title),
    title: t.title,
    error: () => '',
  });
  fn.stops = stops;
  return fn;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('config is clamped, stations are parsed and deduplicated', () => {
  const cfg = normaliseMusic({
    djRoleId: 'bad',
    maxQueue: 9999,
    maxTrackMinutes: 0,
    idleLeaveMinutes: 'x',
    allowUrls: false,
    stations:
      'Radio A | https://a.example.com/s.mp3\nradio a | https://b.example.com/s.mp3\nBad | ftp://x/y\nNoName\n| https://c.example.com/x',
  });
  assert.equal(cfg.djRoleId, '');
  assert.equal(cfg.maxQueue, 200);
  assert.equal(cfg.maxTrackMinutes, 1);
  assert.equal(cfg.idleLeaveMinutes, 5);
  assert.equal(cfg.allowUrls, false);
  assert.deepEqual(cfg.stations, [{ name: 'Radio A', url: 'https://a.example.com/s.mp3' }]);
  assert.equal(normaliseMusic({}).allowUrls, true);
  assert.equal(
    parseStations(
      Array(40)
        .fill(0)
        .map((_, i) => ({ name: `s${i}`, url: `https://e.com/${i}` }))
    ).length,
    25
  );
});

test('only globally routable addresses are accepted', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])
    assert.equal(isPublicIp(ip), true, ip);
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002::1',
    'not-an-ip',
  ])
    assert.equal(isPublicIp(ip), false, ip);
});

test('URL parsing rejects unsafe or unsupported links', () => {
  assert.equal(parseAudioUrl('<https://example.com/a.mp3>').href, 'https://example.com/a.mp3');
  for (const bad of [
    '',
    'nonsense',
    'ftp://example.com/a.mp3',
    'file:///etc/passwd',
    'https://user:pw@example.com/a.mp3',
    'http://127.0.0.1/a.mp3',
    'http://[::1]/a.mp3',
    'http://169.254.169.254/latest',
    'http://10.0.0.5:8000/x',
    'https://example.com/list.m3u',
    'https://example.com/list.pls',
    `https://example.com/${'a'.repeat(600)}`,
  ])
    assert.throws(() => parseAudioUrl(bad), MusicError, bad);
});

test('safeLookup refuses names that resolve to private addresses', async () => {
  await assert.rejects(
    new Promise((resolve, reject) =>
      safeLookup('localhost', { all: true }, (e, a) => (e ? reject(e) : resolve(a)))
    ),
    MusicError
  );
});

function response(status, headers = {}, body = 'x') {
  const r = Readable.from([Buffer.from(body)]);
  r.statusCode = status;
  r.headers = headers;
  return r;
}

test('redirects are followed but every hop is re-validated', async () => {
  const seen = [];
  const request = async (url) => {
    seen.push(url.href);
    if (url.pathname === '/start') return response(302, { location: '/final.mp3' });
    return response(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Radio X' });
  };
  const ok = await openAudioStream('https://example.com/start', { request });
  assert.deepEqual(seen, ['https://example.com/start', 'https://example.com/final.mp3']);
  assert.equal(titleFromUrl(ok.finalUrl, ok.headers), 'Radio X');
  ok.stream.destroy();

  await assert.rejects(
    openAudioStream('https://example.com/start', {
      request: async () => response(302, { location: 'http://169.254.169.254/latest/meta-data' }),
    }),
    /niedozwolony/
  );
  await assert.rejects(
    openAudioStream('https://example.com/loop', {
      request: async () => response(302, { location: '/loop' }),
    }),
    /przekierowa/
  );
});

test('non-audio responses and HTTP errors are rejected', async () => {
  await assert.rejects(
    openAudioStream('https://example.com/page', {
      request: async () => response(200, { 'content-type': 'text/html' }),
    }),
    /nie prowadzi do pliku/
  );
  await assert.rejects(
    openAudioStream('https://example.com/gone', { request: async () => response(404, {}) }),
    /404/
  );
});

test('FFmpeg is restricted to stdin and a short list of demuxers', () => {
  const at = (flag) => FFMPEG_ARGS[FFMPEG_ARGS.indexOf(flag) + 1];
  assert.equal(at('-protocol_whitelist'), 'pipe');
  assert.equal(at('-i'), 'pipe:0');
  assert.ok(FFMPEG_ARGS.includes('-nostdin'));
});

test('first track plays immediately, the rest queue in order and advance on idle', async () => {
  const open = opener();
  const { session, player } = makeSession(open);
  assert.equal(session.enqueue(track(1)), 0);
  assert.equal(session.enqueue(track(2)), 1);
  assert.equal(session.enqueue(track(3)), 2);
  await tick();
  assert.equal(session.current.title, 't1');
  assert.equal(player.played.length, 1);
  player.stop(); // track ended
  await tick();
  assert.equal(session.current.title, 't2');
  assert.deepEqual(
    session.queue.map((t) => t.title),
    ['t3']
  );
  assert.deepEqual(open.stops, ['t1']);
});

test('queue length and per-user limits are enforced', async () => {
  const { session } = makeSession(opener(), { maxQueue: 2 });
  session.enqueue(track(1));
  session.enqueue(track(2));
  session.enqueue(track(3));
  assert.throws(() => session.enqueue(track(4)), /Kolejka jest pełna/);
  const { session: s2 } = makeSession(opener(), { maxQueue: 200 });
  for (let i = 0; i < MAX_PER_USER; i += 1) s2.enqueue(track(i));
  assert.throws(() => s2.enqueue(track(99)), /maksymalnie/);
  assert.doesNotThrow(() => s2.enqueue(track(100, '999999999999999999')));
});

test('skip while playing advances once; skip while still loading does not double-advance', async () => {
  const open = opener();
  const { session, player } = makeSession(open);
  session.enqueue(track(1));
  session.enqueue(track(2));
  session.enqueue(track(3));
  await tick();
  assert.equal(session.skip().title, 't1');
  await tick();
  assert.equal(session.current.title, 't2');
  assert.equal(session.queue.length, 1);

  // Slow opener: skip before the stream is ready.
  const releases = [];
  const slow = async (t) => {
    await new Promise((r) => releases.push(r));
    return { resource: { t }, stop: () => {}, title: t.title, error: () => '' };
  };
  const { session: s2, player: p2 } = makeSession(slow);
  s2.enqueue(track(1));
  s2.enqueue(track(2));
  assert.equal(s2.skip().title, 't1');
  assert.equal(releases.length, 2); // t1 is still loading, t2 started loading after the skip
  releases[0](); // the skipped, late-arriving t1 must be discarded
  await tick();
  assert.equal(p2.played.length, 0);
  assert.equal(s2.current.title, 't2');
  releases[1]();
  await tick();
  assert.equal(p2.played.length, 1);
  assert.equal(p2.played[0].t.title, 't2');
  void player;
});

test('a track that fails to open is skipped with a notice and the next one plays', async () => {
  let n = 0;
  const open = async (t) => {
    n += 1;
    if (t.title === 't1') throw new MusicError('Serwer odpowiedział błędem 404.');
    return { resource: { t }, stop: () => {}, title: t.title, error: () => '' };
  };
  const { session, messages } = makeSession(open);
  session.enqueue(track(1));
  session.enqueue(track(2));
  await tick();
  await tick();
  assert.equal(session.current.title, 't2');
  assert.equal(n, 2);
  assert.match(messages[0], /Pominięto \*\*t1\*\*.*404/);
});

test('an undecodable stream that ends instantly is reported', async () => {
  const open = async (t) => ({
    resource: { t },
    stop: () => {},
    title: t.title,
    error: () => 'Invalid data found',
  });
  const { session, player, messages } = makeSession(open);
  session.enqueue(track(1));
  await tick();
  player.stop();
  await tick();
  assert.match(messages[0], /nieczytelny/);
});

test('pause, resume, clear and destroy', async () => {
  const open = opener();
  const { session, player, connection } = makeSession(open);
  assert.equal(session.pause(), false);
  session.enqueue(track(1));
  session.enqueue(track(2));
  await tick();
  assert.equal(session.pause(), true);
  assert.equal(session.pause(), false);
  assert.equal(session.resume(), true);
  assert.equal(session.resume(), false);
  assert.equal(session.clear(), 1);
  session.destroy();
  session.destroy(); // idempotent
  assert.equal(connection.destroyed, true);
  assert.deepEqual(open.stops, ['t1']);
  assert.equal(player.listenerCount('idle'), 0);
  assert.throws(() => session.enqueue(track(5)), /zakończona/);
});

test('formatDuration', () => {
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
test(
  'real FFmpeg decodes mp3 / ogg / aac from stdin into Ogg Opus with our arguments',
  { skip: !hasFfmpeg },
  () => {
    for (const [ext, codec] of [
      ['mp3', 'libmp3lame'],
      ['ogg', 'libvorbis'],
      ['aac', 'aac'],
    ]) {
      const tone = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:a',
          codec,
          '-f',
          ext === 'aac' ? 'adts' : ext,
          'pipe:1',
        ],
        { maxBuffer: 1 << 24 }
      );
      assert.equal(tone.status, 0, `could not synthesise ${ext}`);
      const out = spawnSync('ffmpeg', FFMPEG_ARGS, { input: tone.stdout, maxBuffer: 1 << 24 });
      assert.equal(out.status, 0, `${ext}: ${out.stderr}`);
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', '-'],
        { input: out.stdout }
      );
      assert.equal(String(probe.stdout).trim(), 'opus,48000,2', ext);
    }
    const garbage = spawnSync('ffmpeg', FFMPEG_ARGS, { input: Buffer.from('<html>not audio</html>') });
    assert.notEqual(garbage.status, 0);
  }
);

test('openTrack streams a served file through FFmpeg and can be stopped', { skip: !hasFfmpeg }, async () => {
  const tone = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'libmp3lame',
      '-f',
      'mp3',
      'pipe:1',
    ],
    { maxBuffer: 1 << 24 }
  ).stdout;
  const server = http.createServer((req, res) => {
    if (req.url === '/page') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Test FM' }).end(tone);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // The hostname is fake; the injected resolver stands in for DNS so the loopback server is reachable.
  const lookup = (host, options, cb) =>
    options?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  try {
    const opened = await openTrack({ url: `http://radio.test:${port}/a.mp3` }, { lookup });
    assert.equal(opened.title, 'Test FM');
    const chunks = [];
    for await (const chunk of opened.resource.playStream) chunks.push(chunk);
    // The Ogg container is already demuxed by @discordjs/voice: these are raw Opus packets.
    assert.ok(chunks.length > 50, `expected ~100 20ms Opus packets for 2s of audio, got ${chunks.length}`);
    assert.ok(Buffer.concat(chunks).length > 1000, 'expected encoded audio');
    opened.stop();
    opened.stop(); // idempotent
    await assert.rejects(
      openTrack({ url: `http://radio.test:${port}/page` }, { lookup }),
      /nie prowadzi do pliku/
    );
  } finally {
    server.close();
  }
});
