// Voice-state tracking for Fluxer. The SDK passes raw VOICE_STATE_UPDATE payloads
// through and keeps no per-guild voice state, but temp-voice, leveling and
// insights need "who is in which voice channel" and a before/after pair on each
// change (discord.js's `voiceStateUpdate` contract). This keeps that map, seeded
// from each guild's initial voice_states (voiceStatesSync) and updated from
// voiceStateUpdate.
//
// Built per process by createVoiceTracker({ Collection }) so the SDK's Collection
// is injected and this module never imports the Fluxer SDK itself. Guilds here
// are keyed by their raw platform id (the SDK's own), never the guild key.
import { log } from '../lib/log.js';

export class VoiceState {
  /**
   * @param {any} client
   * @param {string} guildId  raw guild id
   * @param {object} data  raw API voice state (snake_case)
   */
  constructor(client, guildId, data) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
    this.guildId = guildId;
    this.id = data.user_id;
    this.channelId = data.channel_id ?? null;
    // Fluxer allows several voice connections per user; a move or disconnect
    // targets one connection, so keep its id.
    this.connectionId = data.connection_id ?? null;
    this.mute = Boolean(data.mute);
    this.deaf = Boolean(data.deaf);
    this.selfMute = Boolean(data.self_mute);
    this.selfDeaf = Boolean(data.self_deaf);
    this.selfVideo = Boolean(data.self_video);
    this.streaming = Boolean(data.self_stream);
    this.serverMute = this.mute;
    this.serverDeaf = this.deaf;
  }

  get guild() {
    return this.client.guilds.get(this.guildId) ?? null;
  }

  get member() {
    return this.guild?.members.get(this.id) ?? null;
  }

  get channel() {
    return this.channelId ? (this.guild?.channels.get(this.channelId) ?? null) : null;
  }
}

/** @param {{ Collection: new () => Map<string, any> }} deps */
export function createVoiceTracker({ Collection }) {
  /** raw guild id -> Collection<userId, VoiceState> (only members currently connected) */
  const byGuild = new Map();

  function statesFor(guildId) {
    let states = byGuild.get(guildId);
    if (!states) {
      states = new Collection();
      byGuild.set(guildId, states);
    }
    return states;
  }

  /** Cached members connected to `channelId`, keyed by user id. */
  function membersIn(guildId, channelId) {
    const out = new Collection();
    for (const state of statesFor(guildId).values()) {
      if (state.channelId !== channelId) continue;
      const member = state.member;
      if (member) out.set(state.id, member);
    }
    return out;
  }

  /** Apply one raw payload and return the { old, new } pair, or null when it names no guild/user. */
  function apply(client, data) {
    const guildId = data.guild_id;
    if (!guildId || !data.user_id) return null;
    const states = statesFor(guildId);
    const old =
      states.get(data.user_id) ??
      new VoiceState(client, guildId, { user_id: data.user_id, channel_id: null });
    const next = new VoiceState(client, guildId, data);
    if (next.channelId) states.set(next.id, next);
    else states.delete(next.id);
    return { old, new: next };
  }

  /**
   * Start tracking. `onUpdate(old, new)` fires for every change after the
   * initial sync.
   * @param {import('node:events').EventEmitter & { guilds: any }} client
   * @param {(oldState: VoiceState, newState: VoiceState) => void} onUpdate
   */
  function track(client, onUpdate) {
    client.on('voiceStatesSync', ({ guildId, voiceStates }) => {
      const states = statesFor(guildId);
      states.clear();
      for (const raw of voiceStates ?? []) {
        const state = new VoiceState(client, guildId, raw);
        if (state.channelId) states.set(state.id, state);
      }
    });
    client.on('voiceStateUpdate', (data) => {
      // Keep the member cache fresh when the payload carries a member we lack.
      const guild = data.guild_id ? client.guilds.get(data.guild_id) : null;
      if (guild && data.member && !guild.members.get(data.user_id)) {
        guild.members.fetch?.(data.user_id)?.catch?.(() => {});
      }
      const pair = apply(client, data);
      if (!pair) return;
      try {
        onUpdate(pair.old, pair.new);
      } catch (err) {
        log.error('fluxer', 'voiceStateUpdate listener failed:', err);
      }
    });
    client.on('guildDelete', (guild) => byGuild.delete(guild?.id ?? guild));
  }

  return { statesFor, membersIn, apply, track };
}
