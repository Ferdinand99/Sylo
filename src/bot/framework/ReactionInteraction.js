// The interaction a handler receives when someone reacts to a message whose
// buttons / select menu were rendered as reactions (platform/components.js). It
// is a MessageInteraction with the parts of a Discord component interaction
// that handlers use: customId, values, update(), deferUpdate().
//
// There is no invoking message to reply to, so reply() posts in the channel; an
// "ephemeral" reply opens with a mention of the reactor and is deleted after a
// short delay, and — unlike a command reply — never deletes the panel itself.
import { MessageInteraction, COMPONENT_TTL_MS } from './MessageInteraction.js';
import { prepareOutgoing, attachActions } from '../../platform/outgoing.js';

const NO_ARGS = { subcommand: null, values: {} };
const ComponentType = { Button: 2, StringSelect: 3 };

export class ReactionInteraction extends MessageInteraction {
  /**
   * @param {object} init
   * @param {any} init.message  the message that carries the reactions
   * @param {any} init.user  who reacted
   * @param {any} init.member  their guild member, when in a guild
   * @param {{ kind: 'button'|'select', customId: string, value?: string | null }} init.action
   * @param {'discord'|'fluxer'} [init.platform]
   * @param {number} [init.privateTtlMs]
   */
  constructor({ message, user, member, action, platform, privateTtlMs }) {
    super({ message, commandName: action.customId, parsed: NO_ARGS, resolved: {}, platform, privateTtlMs });
    this.user = user;
    this.member = member ?? null;
    this.memberPermissions = member?.permissions ?? null;
    this.customId = action.customId;
    this.componentType = action.kind === 'select' ? ComponentType.StringSelect : ComponentType.Button;
    this.values = action.kind === 'select' ? [action.value] : undefined;
  }

  isChatInputCommand() {
    return false;
  }

  isMessageComponent() {
    return true;
  }

  isButton() {
    return this.componentType === ComponentType.Button;
  }

  isStringSelectMenu() {
    return this.componentType === ComponentType.StringSelect;
  }

  isRepliable() {
    return true;
  }

  async _send(payload, ephemeral = false) {
    const body = ephemeral
      ? { ...payload, content: `<@${this.user.id}> ${payload.content ?? ''}`.trimEnd() }
      : payload;
    return this.channel.send(body);
  }

  _scheduleCleanup(sent) {
    const timer = setTimeout(() => sent?.delete?.().catch(() => {}), this._privateTtlMs);
    timer.unref?.();
  }

  async deferUpdate() {
    this.deferred = true;
  }

  /** Replace the panel's content and components, as a Discord component update does. */
  async update(input) {
    const out = prepareOutgoing(input, { edit: true });
    await this.message.edit(out.payload);
    await attachActions(this.message, out, {
      guildId: this.guildId ?? '',
      ttlMs: COMPONENT_TTL_MS,
      edit: true,
    });
    this.replied = true;
    return this.message;
  }
}
