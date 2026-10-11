// Stands in for discord.js's ChatInputCommandInteraction when a command is run
// from a chat message (`!ban @user spam`) instead of a slash command, so the
// same command files run unchanged on a platform without slash commands. It
// implements only what the command files actually call.
//
//   - reply()/editReply() send, then edit, one message; followUp() sends another.
//     deferReply() just shows the typing indicator — the first editReply() sends.
//   - There are no ephemeral replies in a channel. An "ephemeral" reply is sent
//     normally, then deleted — along with the invoking message — after a short
//     delay, so a private result does not linger.
//   - Buttons and menus do not exist here; `components` is dropped.
//   - `guildId` and `guild.id` are in platform form ("fluxer:<id>"), because
//     that is the id every DB lookup keys on; every other property of `guild`
//     (and every method, bound to the real guild) is the SDK's own.
import { MessageFlags } from 'discord.js';
import { makePlatformGuildId } from '../../lib/platformId.js';

/** How long an "ephemeral" reply stays in the channel. */
export const PRIVATE_TTL_MS = 15_000;

function normalise(input) {
  const p = typeof input === 'string' ? { content: input } : { ...input };
  const flags = typeof p.flags === 'number' ? p.flags : 0;
  const ephemeral = Boolean(p.ephemeral) || (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
  const wantsResponse = Boolean(p.withResponse);
  for (const key of ['ephemeral', 'flags', 'withResponse', 'fetchReply', 'components']) delete p[key];
  if (p.content === '') delete p.content;
  return { payload: p, ephemeral, wantsResponse };
}

function withPlatformId(guild, platform) {
  if (!guild) return null;
  return new Proxy(guild, {
    get(target, prop) {
      if (prop === 'id') return makePlatformGuildId(platform, target.id);
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class Options {
  constructor(parsed, resolved) {
    this._subcommand = parsed.subcommand;
    this._values = parsed.values;
    this._resolved = resolved;
  }

  _need(found, name, required) {
    if (found == null && required) throw new TypeError(`Required option "${name}" was not provided`);
    return found ?? null;
  }

  _value(name, required) {
    return this._need(this._values[name]?.value, name, required);
  }

  getSubcommand(required = true) {
    return this._need(this._subcommand, 'subcommand', required);
  }

  getString(name, required = false) {
    return this._value(name, required);
  }

  getInteger(name, required = false) {
    return this._value(name, required);
  }

  getNumber(name, required = false) {
    return this._value(name, required);
  }

  getBoolean(name, required = false) {
    return this._value(name, required);
  }

  getUser(name, required = false) {
    return this._need(this._resolved[name]?.user, name, required);
  }

  getMember(name) {
    return this._resolved[name]?.member ?? null;
  }

  getChannel(name, required = false) {
    return this._need(this._resolved[name], name, required);
  }

  getRole(name, required = false) {
    return this._need(this._resolved[name], name, required);
  }

  getAttachment() {
    return null;
  }
}

export class MessageInteraction {
  /**
   * @param {object} init
   * @param {any} init.message  the invoking message
   * @param {string} init.commandName
   * @param {{ subcommand: string | null, values: Record<string, { type: number, value: any }> }} init.parsed
   * @param {Record<string, any>} init.resolved  from resolveOptions()
   * @param {'discord'|'fluxer'} [init.platform]
   * @param {number} [init.privateTtlMs]
   */
  constructor({
    message,
    commandName,
    parsed,
    resolved,
    platform = 'fluxer',
    privateTtlMs = PRIVATE_TTL_MS,
  }) {
    this.message = message;
    this.commandName = commandName;
    this.client = message.client;
    this.user = message.author;
    this.member = message.member ?? null;
    this.memberPermissions = message.member?.permissions ?? null;
    this.channel = message.channel;
    this.channelId = message.channelId ?? message.channel?.id;
    this.createdTimestamp = message.createdTimestamp;
    this.guild = withPlatformId(message.guild ?? null, platform);
    this.guildId = message.guild ? makePlatformGuildId(platform, message.guild.id) : null;
    this.options = new Options(parsed, resolved);
    this.deferred = false;
    this.replied = false;
    this.ephemeral = false;
    this._privateTtlMs = privateTtlMs;
    this._sent = null;
  }

  inGuild() {
    return this.guild !== null;
  }

  isChatInputCommand() {
    return true;
  }

  async _send(payload) {
    try {
      return await this.message.reply(payload);
    } catch {
      // The invoking message is gone (deleted) — post to the channel instead.
      return this.channel.send(payload);
    }
  }

  _scheduleCleanup(sent) {
    const timer = setTimeout(() => {
      sent?.delete?.().catch(() => {});
      this.message.delete?.().catch(() => {});
    }, this._privateTtlMs);
    timer.unref?.();
  }

  async deferReply(opts = {}) {
    this.ephemeral = normalise(opts).ephemeral;
    this.deferred = true;
    this.channel?.sendTyping?.().catch(() => {});
  }

  async reply(input) {
    const { payload, ephemeral, wantsResponse } = normalise(input);
    this.ephemeral = ephemeral;
    const sent = await this._send(payload);
    this._sent = sent;
    this.replied = true;
    if (ephemeral) this._scheduleCleanup(sent);
    return wantsResponse ? { resource: { message: sent } } : sent;
  }

  async editReply(input) {
    const { payload } = normalise(input);
    if (this._sent) return this._sent.edit(payload);
    const sent = await this._send(payload);
    this._sent = sent;
    this.replied = true;
    if (this.ephemeral) this._scheduleCleanup(sent);
    return sent;
  }

  async followUp(input) {
    const { payload, ephemeral } = normalise(input);
    const sent = await this._send(payload);
    this.replied = true;
    if (ephemeral) this._scheduleCleanup(sent);
    return sent;
  }

  async fetchReply() {
    return this._sent;
  }

  async deleteReply() {
    await this._sent?.delete?.();
  }
}
