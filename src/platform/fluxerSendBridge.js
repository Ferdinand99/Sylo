// Puts the component bridge (outgoing.js) on Fluxer's send path, so every
// module that calls channel.send() / message.reply() / message.edit() with
// discord.js-style payloads — embeds, files, buttons, menus — works unchanged.
//
// The SDK classes are passed in rather than imported, so mainline needs the
// Fluxer SDK only when a Fluxer client is actually started:
//
//   const { TextChannel, DMChannel, Message } = await import('@fluxerjs/core');
//   installSendBridge({ channelClasses: [TextChannel, DMChannel], Message });
import { makePlatformGuildId } from '../lib/platformId.js';
import { prepareOutgoing, attachActions } from './outgoing.js';

const PLATFORM = 'fluxer';

/** The prototype in the chain that actually owns `name` (the SDK defines send() on a shared base). */
function ownerOf(proto, name) {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, name)) return p;
  }
  return null;
}

function wrap(proto, name, make) {
  const owner = ownerOf(proto, name);
  if (!owner || owner[name].__sendBridge) return;
  const wrapped = make(owner[name]);
  wrapped.__sendBridge = true;
  owner[name] = wrapped;
}

const platformGuildId = (rawId) => (rawId ? makePlatformGuildId(PLATFORM, rawId) : '');

/**
 * @param {{ channelClasses: Function[], Message: Function }} sdk
 */
export function installSendBridge({ channelClasses, Message }) {
  // Methods that create a message: prepare the payload, send, then react.
  const creating = (rawGuildId) => (native) =>
    async function (input, ...rest) {
      const out = prepareOutgoing(input, { platform: PLATFORM });
      const sent = await native.call(this, out.payload, ...rest);
      if (sent) await attachActions(sent, out, { guildId: platformGuildId(rawGuildId(this)) });
      return sent;
    };

  for (const C of channelClasses)
    wrap(
      C.prototype,
      'send',
      creating((channel) => channel.guildId)
    );
  const ofMessage = (m) => m.guildId ?? m.channel?.guildId;
  for (const name of ['send', 'reply']) wrap(Message.prototype, name, creating(ofMessage));

  // Editing may replace or clear the components, so it re-syncs the reactions.
  wrap(
    Message.prototype,
    'edit',
    (native) =>
      async function (input, ...rest) {
        const out = prepareOutgoing(input, { platform: PLATFORM, edit: true });
        const edited = await native.call(this, out.payload, ...rest);
        await attachActions(this, out, { guildId: platformGuildId(ofMessage(this)), edit: true });
        return edited;
      }
  );
}
