// Music: plays audio from direct HTTP(S) links and internet-radio streams in a
// voice channel. There is deliberately no YouTube/Spotify extraction here (it
// breaks those services' terms); sources are plain audio URLs and a per-server
// list of radio stations configured in the dashboard.
//
// Pipeline: Node fetches the URL itself (public addresses only — checked again
// at connect time, so DNS rebinding cannot reach the LAN) and pipes the body
// into a sandboxed FFmpeg (stdin only, no protocols) that emits Ogg/Opus, which
// @discordjs/voice can send without any native Opus encoder.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import ffmpegStatic from 'ffmpeg-static';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { soundboardStatus } from './soundboard.js';
import { log } from '../lib/log.js';

export const MAX_STATIONS = 25;
export const MAX_SESSIONS = 5;
export const MAX_PER_USER = 10;
export const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 15_000;
const ALONE_LEAVE_MS = 60_000;

export class MusicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- config ----
const snowflake = (v) => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : '');
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Parse "Name | https://…" lines (or an array of {name,url}) into clean stations. */
export function parseStations(raw) {
  const rows = Array.isArray(raw)
    ? raw.map((s) => [s?.name, s?.url])
    : String(raw ?? '')
        .split(/\r?\n/)
        .map((line) => {
          const at = line.indexOf('|');
          return at === -1 ? ['', line] : [line.slice(0, at), line.slice(at + 1)];
        });
  const seen = new Set();
  const out = [];
  for (const [rawName, rawUrl] of rows) {
    let url;
    try {
      url = parseAudioUrl(rawUrl);
    } catch {
      continue;
    }
    const name = String(rawName ?? '')
      .replace(/[\r\n`*_~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, url: url.href });
    if (out.length >= MAX_STATIONS) break;
  }
  return out;
}

export function stationsToText(stations) {
  return (Array.isArray(stations) ? stations : []).map((s) => `${s.name} | ${s.url}`).join('\n');
}

export function normaliseMusic(raw = {}) {
  return {
    djRoleId: snowflake(raw.djRoleId),
    maxQueue: clampInt(raw.maxQueue, 1, 200, 50),
    maxTrackMinutes: clampInt(raw.maxTrackMinutes, 1, 720, 180),
    idleLeaveMinutes: clampInt(raw.idleLeaveMinutes, 1, 60, 5),
    allowUrls: raw.allowUrls !== false,
    stations: parseStations(raw.stations),
  };
}

// ------------------------------------------------------------ URL safety ----
const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['100::', 64],
]) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

function expandIPv6(ip) {
  let text = ip.split('%')[0].toLowerCase();
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    text = text.replace(v4[1], `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`);
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

/** True only for globally routable addresses (never loopback/LAN/link-local/etc.). */
export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 4) return !blocked.check(ip, 'ipv4');
  const g = expandIPv6(ip);
  if (g.length !== 8 || g.some(Number.isNaN)) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return !blocked.check(embedded(), 'ipv4');
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return !blocked.check(embedded(), 'ipv4');
  return !blocked.check(ip, 'ipv6');
}

/** Syntactic check of a user-supplied link. Throws MusicError; returns a URL. */
export function parseAudioUrl(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^<(.*)>$/, '$1');
  if (!text || text.length > 500) throw new MusicError('Podaj poprawny adres http(s) (do 500 znaków).');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new MusicError('To nie wygląda na poprawny adres URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new MusicError('Obsługiwane są tylko adresy http:// i https://.');
  if (url.username || url.password) throw new MusicError('Adres nie może zawierać loginu ani hasła.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new MusicError('Adres nie zawiera nazwy hosta.');
  if (net.isIP(host) && !isPublicIp(host)) throw new MusicError('Ten adres jest niedozwolony.');
  if (/\.(m3u8?|pls|xspf|asx)$/i.test(url.pathname))
    throw new MusicError('Podaj bezpośredni adres strumienia lub pliku, a nie playlistę (.m3u/.pls).');
  return url;
}

/** dns.lookup replacement that refuses non-public answers — used at connect time. */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') [options, callback] = [{}, options];
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses.filter((a) => isPublicIp(a.address));
    if (!list.length || list.length !== addresses.length)
      return callback(new MusicError('Ten adres wskazuje na sieć prywatną i jest niedozwolony.'));
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** Resolve early so a bad host is rejected at /music play, not minutes later. */
export async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true }).catch(() => null);
  if (!addresses?.length) throw new MusicError('Nie można znaleźć tego hosta.');
  if (addresses.some((a) => !isPublicIp(a.address)))
    throw new MusicError('Ten adres wskazuje na sieć prywatną i jest niedozwolony.');
}

const AUDIO_TYPE = /^(audio\/|application\/(ogg|octet-stream|x-ogg)|binary\/octet-stream|video\/ogg)/i;

function requestOnce(url, lookup) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup,
        timeout: CONNECT_TIMEOUT_MS,
        headers: {
          'User-Agent': 'Sylo-Music/1.0',
          Accept: 'audio/*, application/ogg;q=0.9, */*;q=0.1',
          'Icy-MetaData': '0',
        },
      },
      resolve
    );
    req.on('timeout', () => req.destroy(new MusicError('Serwer nie odpowiada.', 504)));
    req.on('error', (error) =>
      reject(error instanceof MusicError ? error : new MusicError('Nie udało się połączyć z serwerem.', 502))
    );
    req.end();
  });
}

/** Open an audio stream, following a few redirects with every hop re-validated. */
export async function openAudioStream(rawUrl, { lookup = safeLookup, request = requestOnce } = {}) {
  let url = parseAudioUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await request(url, lookup);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      try {
        url = parseAudioUrl(new URL(response.headers.location, url).href);
      } catch (error) {
        throw error instanceof MusicError ? error : new MusicError('Nieprawidłowe przekierowanie.');
      }
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new MusicError(`Serwer odpowiedział błędem ${status}.`, 502);
    }
    const type = String(response.headers['content-type'] ?? '')
      .split(';')[0]
      .trim();
    if (type && !AUDIO_TYPE.test(type)) {
      response.destroy();
      throw new MusicError('Ten adres nie prowadzi do pliku ani strumienia audio.');
    }
    return { stream: response, finalUrl: url, headers: response.headers };
  }
  throw new MusicError('Zbyt wiele przekierowań.');
}

export function titleFromUrl(url, headers = {}) {
  const icy = String(headers['icy-name'] ?? '').trim();
  if (icy) return cleanTitle(icy);
  const base = decodeURIComponentSafe(url.pathname.split('/').filter(Boolean).pop() ?? '').replace(
    /\.[a-z0-9]{2,5}$/i,
    ''
  );
  return cleanTitle(base || url.hostname);
}
function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
export function cleanTitle(text) {
  return (
    String(text ?? '')
      .replace(/[\r\n`*_~|<>@]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Bez tytułu'
  );
}

// -------------------------------------------------------------- playback ----
function ffmpegPath() {
  return process.env.FFMPEG_PATH || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg');
}

export const FFMPEG_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-nostdin',
  '-protocol_whitelist',
  'pipe',
  '-format_whitelist',
  'mp3,wav,ogg,mov,aac,flac,matroska,webm',
  '-i',
  'pipe:0',
  '-map',
  '0:a:0',
  '-vn',
  '-map_metadata',
  '-1',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-c:a',
  'libopus',
  '-b:a',
  '128k',
  '-f',
  'ogg',
  'pipe:1',
];

/** Fetch + decode one track. Resolves once FFmpeg is running; `stop()` frees everything. */
export async function openTrack(track, { maxMs = 3 * 3600_000, lookup = safeLookup } = {}) {
  const { stream, finalUrl, headers } = await openAudioStream(track.url, { lookup });
  const child = spawn(ffmpegPath(), FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch {
    stream.destroy();
    throw new MusicError('Brak działającego FFmpeg. Sprawdź instalację lub zmienną FFMPEG_PATH.', 503);
  }
  let stopped = false;
  let timer;
  let errorText = '';
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stream.destroy();
    child.stdin.destroy();
    child.kill('SIGKILL');
  };
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    errorText = (errorText + chunk.toString('utf8')).slice(-300);
  });
  stream.on('error', () => child.stdin.end());
  stream.pipe(child.stdin);
  child.once('close', () => {
    clearTimeout(timer);
    stream.destroy();
  });
  timer = setTimeout(stop, maxMs);
  timer.unref?.();
  const resource = createAudioResource(child.stdout, { inputType: StreamType.OggOpus });
  return {
    resource,
    stop,
    title: track.title || titleFromUrl(finalUrl, headers),
    error: () => (errorText ? errorText.trim() : ''),
  };
}

const defaultDeps = {
  voice: { joinVoiceChannel, createAudioPlayer, entersState, getVoiceConnection },
  openTrack,
};

/** @type {Map<string, MusicSession>} */
export const sessions = new Map();
const joining = new Map();

export class MusicSession {
  constructor({ guildId, channelId, connection, player, limits, deps = defaultDeps }) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.connection = connection;
    this.player = player;
    this.limits = limits;
    this.deps = deps;
    this.queue = [];
    this.current = null;
    this.source = null;
    this.token = 0;
    this.destroyed = false;
    this.textChannel = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.idleTimer = null;
    this.aloneTimer = null;
    this.onIdle = () => {
      if (this.destroyed) return;
      this.finishCurrent();
      void this.playNext();
    };
    this.player.on(AudioPlayerStatus.Idle, this.onIdle);
    this.player.on('error', (error) => log.warn(`module:music`, 'player error:', error?.message ?? error));
  }

  updateLimits(limits) {
    this.limits = limits;
  }

  notify(text) {
    Promise.resolve(this.textChannel?.send?.({ content: text, allowedMentions: { parse: [] } })).catch(
      () => {}
    );
  }

  finishCurrent() {
    const source = this.source;
    this.source = null;
    this.token += 1;
    if (source) {
      const reason = source.error?.();
      const track = this.current;
      source.stop();
      if (reason && Date.now() - this.startedAt < 3000 && track)
        this.notify(`⚠️ Nie udało się odtworzyć **${track.title}** — plik lub strumień jest nieczytelny.`);
    }
    this.current = null;
    this.pausedAt = 0;
    this.pausedTotal = 0;
  }

  enqueue(track) {
    if (this.destroyed) throw new MusicError('Sesja muzyczna została zakończona.', 409);
    if (this.queue.length >= this.limits.maxQueue)
      throw new MusicError(`Kolejka jest pełna (maksymalnie ${this.limits.maxQueue} utworów).`);
    const mine =
      this.queue.filter((t) => t.requestedBy === track.requestedBy).length +
      (this.current?.requestedBy === track.requestedBy ? 1 : 0);
    if (mine >= MAX_PER_USER)
      throw new MusicError(`Możesz mieć w kolejce maksymalnie ${MAX_PER_USER} utworów naraz.`);
    const wasIdle = !this.current;
    this.queue.push(track);
    this.clearIdleTimer();
    if (wasIdle) void this.playNext();
    return wasIdle ? 0 : this.queue.length;
  }

  async playNext() {
    if (this.destroyed) return;
    const track = this.queue.shift();
    if (!track) {
      this.current = null;
      this.startIdleTimer();
      return;
    }
    this.current = track;
    this.startedAt = Date.now();
    this.pausedAt = 0;
    this.pausedTotal = 0;
    const token = (this.token += 1);
    try {
      const opened = await this.deps.openTrack(track, {
        maxMs: this.limits.maxTrackMinutes * 60_000,
      });
      if (this.destroyed || token !== this.token) {
        opened.stop();
        return;
      }
      this.source = opened;
      if (!track.title) track.title = opened.title;
      this.startedAt = Date.now();
      this.player.play(opened.resource);
    } catch (error) {
      if (this.destroyed || token !== this.token) return;
      const message = error instanceof MusicError ? error.message : 'Nieoczekiwany błąd odtwarzania.';
      if (!(error instanceof MusicError)) log.warn('module:music', 'open failed:', error);
      this.notify(`⚠️ Pominięto **${track.title || 'utwór'}**: ${message}`);
      this.current = null;
      await this.playNext();
    }
  }

  skip() {
    if (!this.current) return null;
    const skipped = this.current;
    if (this.player.state?.status === AudioPlayerStatus.Idle) {
      // Still opening (nothing playing yet): drop it and move on ourselves.
      this.finishCurrent();
      void this.playNext();
    } else {
      this.player.stop(true); // emits Idle → onIdle advances the queue
    }
    return skipped;
  }

  pause() {
    if (!this.current || this.pausedAt) return false;
    if (!this.player.pause()) return false;
    this.pausedAt = Date.now();
    return true;
  }

  resume() {
    if (!this.pausedAt) return false;
    this.player.unpause();
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    return true;
  }

  clear() {
    const count = this.queue.length;
    this.queue = [];
    return count;
  }

  elapsedMs() {
    if (!this.current || !this.source) return 0;
    return Math.max(0, (this.pausedAt || Date.now()) - this.startedAt - this.pausedTotal);
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  startIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.current && !this.queue.length) this.destroy();
    }, this.limits.idleLeaveMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  setAlone(alone) {
    if (!alone) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = null;
    } else if (!this.aloneTimer) {
      this.aloneTimer = setTimeout(() => this.destroy(), ALONE_LEAVE_MS);
      this.aloneTimer.unref?.();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdleTimer();
    clearTimeout(this.aloneTimer);
    this.queue = [];
    this.token += 1;
    this.source?.stop();
    this.source = null;
    this.current = null;
    this.player.removeAllListeners();
    this.player.on('error', () => {});
    this.player.stop(true);
    if (this.connection?.state?.status !== VoiceConnectionStatus.Destroyed) this.connection?.destroy();
    if (sessions.get(this.guildId) === this) sessions.delete(this.guildId);
  }
}

async function checkVoiceChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (
    channel?.type !== ChannelType.GuildVoice ||
    !channel
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  )
    throw new MusicError('Bot nie może dołączyć i mówić na Twoim kanale głosowym (sprawdź uprawnienia).');
  if (!channel.joinable && guild.members.me?.voice?.channelId !== channelId)
    throw new MusicError('Kanał jest pełny lub niedostępny dla bota.');
}

/** Get this guild's session, joining `channelId` first if there isn't one. */
export function getOrCreateSession(guild, channelId, limits, deps = defaultDeps) {
  const existing = sessions.get(guild.id);
  if (existing) return Promise.resolve(existing);
  if (joining.has(guild.id)) return joining.get(guild.id);
  const job = (async () => {
    if (sessions.size >= MAX_SESSIONS)
      throw new MusicError('Bot gra już na zbyt wielu serwerach. Spróbuj za chwilę.', 409);
    const sb = soundboardStatus(guild.id);
    if (sb.playing || sb.connected || sb.joining)
      throw new MusicError(
        'Soundboard używa teraz kanału głosowego. Rozłącz go w panelu i spróbuj ponownie.',
        409
      );
    if (deps.voice.getVoiceConnection(guild.id))
      throw new MusicError('Bot ma już inne połączenie głosowe na tym serwerze.', 409);
    await checkVoiceChannel(guild, channelId);
    const connection = deps.voice.joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    try {
      await deps.voice.entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch {
      connection.destroy();
      throw new MusicError('Nie udało się dołączyć do kanału głosowego.', 503);
    }
    const player = deps.voice.createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(player);
    const session = new MusicSession({ guildId: guild.id, channelId, connection, player, limits, deps });
    sessions.set(guild.id, session);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          deps.voice.entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          deps.voice.entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        session.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => session.destroy());
    connection.on('error', (error) => log.warn('module:music', 'connection error:', error?.message));
    return session;
  })().finally(() => joining.delete(guild.id));
  joining.set(guild.id, job);
  return job;
}

export function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Leave when everyone left the channel, or when the bot was kicked/moved.
export function handleVoiceState({ old: before, new: after }, config, guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  const me = after.guild?.members?.me?.id ?? before.guild?.members?.me?.id;
  if ((after.id ?? before.id) === me && after.channelId !== session.channelId) {
    session.destroy();
    return;
  }
  const channel = after.guild?.channels?.cache?.get(session.channelId);
  if (!channel?.members) return;
  session.setAlone(channel.members.filter((m) => !m.user.bot).size === 0);
}
on('music', 'voiceStateUpdate', handleVoiceState);
