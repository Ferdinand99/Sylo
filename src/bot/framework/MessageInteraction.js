// Stands in for discord.js's ChatInputCommandInteraction when a command is run
// from a chat message (`!ban @user spam`) instead of a slash command, so the
// same command files run unchanged on a platform without slash commands. It
// implements only what the command files actually call.
//
//   - reply()/editReply() send, then edit, one message; followUp() sends another.
//     deferReply() just shows the typing indicator — the first editReply() sends.
//   - There are no ephemeral replies in a channel. An "ephemeral" reply that carries
//     data (an embed or a file: a member's moderation history, a private quote, the
//     /mydata export) goes to the invoking person's DMs in a server; the channel only
//     gets a short notice with none of it, deleted — along with the invoking message —
//     after a short delay. When the DM cannot be sent, the notice says so and the reply
//     is dropped: it is never posted in the channel. Any other "ephemeral" reply (a
//     short status or error line) is sent normally, then deleted after the same delay.
//   - Buttons and menus do not exist here; `components` become reactions
//     (platform/outgoing.js) and a reaction runs the same handler.
//   - `guildId` and `guild.id` are in platform form ("fluxer:<id>"), because
//     that is the id every DB lookup keys on; every other property of `guild`
//     (and every method, bound to the real guild) is the SDK's own.
import { makePlatformGuildId } from '../../lib/platformId.js';
import { prepareOutgoing, attachActions } from '../../platform/outgoing.js';

/** How long an "ephemeral" reply stays in the channel. */
export const PRIVATE_TTL_MS = 15_000;

/** How long the reactions of a command reply's buttons/menus stay live (a Discord interaction token lives 15 min). */
export const COMPONENT_TTL_MS = 15 * 60_000;

export function withPlatformId(guild, platform) {
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
    // A private reply in a server whose DM could not be sent: later data in it is dropped, not posted.
    this._privateUndeliverable = false;
    // The reply in `_sent` is a DM (not a message in the channel).
    this._sentIsDm = false;
    // Set when a reaction in a DM (on a private reply that was sent there) is run on behalf of a server.
    this._inDm = false;
  }

  /** Private replies need a DM only when this was run in a server's channel, not in a DM already. */
  get _inServerChannel() {
    return Boolean(this.guild) && !this._inDm;
  }

  inGuild() {
    return this.guild !== null;
  }

  isChatInputCommand() {
    return true;
  }

  // Subclasses may use a second `ephemeral` argument; a reply to the invoking
  // message needs no mention to reach its author.
  async _send(payload) {
    try {
      return await this.message.reply(payload);
    } catch {
      // The invoking message is gone (deleted) — post to the channel instead.
      return this.channel.send(payload);
    }
  }

  /** Is this a private reply with data in it, in a server channel? Then it must not sit in the channel. */
  _mustBePrivate(out, ephemeral) {
    return Boolean(
      ephemeral && this._inServerChannel && (out.payload.embeds?.length || out.payload.files?.length)
    );
  }

  /**
   * A private reply with data in a server channel: there are no private replies here, so it would sit
   * in the channel for everyone until the cleanup. Send it to the DMs of whoever ran the command (or
   * reacted) instead, and leave only a notice, with none of it, in the channel. When the DM fails the
   * notice says so and the reply is dropped; it is never posted in the channel.
   * Returns null when not applicable (see _mustBePrivate).
   * @returns {Promise<{ message: any } | null>} `message` is the DM, null when it could not be sent
   */
  async _sendPrivate(out, ephemeral) {
    if (!this._mustBePrivate(out, ephemeral)) return null;
    if (this._privateUndeliverable) return { message: null };
    let dm = null;
    try {
      dm = await this.user.send(out.payload);
    } catch {
      this._privateUndeliverable = true;
    }
    const notice = await this._send(
      {
        content: dm
          ? '📬 Sent to your DMs.'
          : "⚠️ I couldn't send you that by DM, and it is private. Allow DMs from this server's members, then try again.",
        allowedMentions: { parse: [] },
      },
      true
    );
    this._scheduleCleanup(notice);
    return { message: dm };
  }

  _scheduleCleanup(sent) {
    const timer = setTimeout(() => {
      sent?.delete?.().catch(() => {});
      this.message.delete?.().catch(() => {});
    }, this._privateTtlMs);
    timer.unref?.();
  }

  /** Put the reactions for a reply's buttons/menus on the sent message. */
  _attach(sent, out, edit = false) {
    return attachActions(sent, out, { guildId: this.guildId ?? '', ttlMs: COMPONENT_TTL_MS, edit });
  }

  async deferReply(opts = {}) {
    this.ephemeral = prepareOutgoing(opts).ephemeral;
    this.deferred = true;
    this.channel?.sendTyping?.().catch(() => {});
  }

  async reply(input) {
    const out = prepareOutgoing(input);
    this.ephemeral = out.ephemeral;
    const privately = await this._sendPrivate(out, out.ephemeral);
    if (privately) {
      this.replied = true;
      this._sent = privately.message;
      this._sentIsDm = Boolean(privately.message);
      if (privately.message) await this._attach(privately.message, out);
      return out.wantsResponse ? { resource: { message: privately.message } } : privately.message;
    }
    const sent = await this._send(out.payload, out.ephemeral);
    this._sent = sent;
    this.replied = true;
    await this._attach(sent, out);
    if (out.ephemeral) this._scheduleCleanup(sent);
    return out.wantsResponse ? { resource: { message: sent } } : sent;
  }

  async editReply(input) {
    // Private data in a server lives in the DM (or nowhere, when that failed): never in the channel.
    const first = prepareOutgoing(input);
    if (this._mustBePrivate(first, this.ephemeral)) {
      if (this._privateUndeliverable) return null;
      if (!this._sentIsDm) {
        const privately = await this._sendPrivate(first, true);
        this.replied = true;
        this._sent = privately.message;
        this._sentIsDm = Boolean(privately.message);
        if (privately.message) await this._attach(privately.message, first);
        return privately.message;
      }
    }
    if (this._sent) {
      const out = prepareOutgoing(input, { edit: true });
      const edited = await this._sent.edit(out.payload);
      await this._attach(this._sent, out, true);
      return edited;
    }
    const out = prepareOutgoing(input);
    const sent = await this._send(out.payload, this.ephemeral);
    this._sent = sent;
    this.replied = true;
    await this._attach(sent, out);
    if (this.ephemeral) this._scheduleCleanup(sent);
    return sent;
  }

  async followUp(input) {
    const out = prepareOutgoing(input);
    const privately = await this._sendPrivate(out, out.ephemeral);
    if (privately) {
      this.replied = true;
      if (privately.message) await this._attach(privately.message, out);
      return privately.message;
    }
    const sent = await this._send(out.payload, out.ephemeral);
    this.replied = true;
    await this._attach(sent, out);
    if (out.ephemeral) this._scheduleCleanup(sent);
    return sent;
  }

  async fetchReply() {
    return this._sent;
  }

  async deleteReply() {
    await this._sent?.delete?.();
  }
}
