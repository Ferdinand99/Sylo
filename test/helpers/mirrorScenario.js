// A server worth copying, a Fluxer server, an engine and an agreed pair: the setup of the engine tests.
import * as db from '../../src/db/mirror.js';
import { requestMirror } from '../../src/mirror/consent.js';
import { BIT, dChannel, dRole, engineFor, fakeClock, fakeDiscord, fakeFluxer } from './mirrorFakes.js';

let n = 0;
export const ids = () => {
  n += 1;
  const tag = String(n).padStart(3, '0');
  return {
    src: `93000000000000${tag}`,
    dst: `83000000000000${tag}`,
    cat: `73100000000000${tag}`,
    rules: `73200000000000${tag}`,
    chat: `73300000000000${tag}`,
    cat2: `73400000000000${tag}`,
    voice: `73500000000000${tag}`,
    member: `73600000000000${tag}`,
    mod: `73700000000000${tag}`,
    bot: `73800000000000${tag}`,
    emoji1: `73900000000000${tag}`,
    emoji2: `74000000000000${tag}`,
    emoji3: `74100000000000${tag}`,
    sticker1: `74200000000000${tag}`,
    sticker2: `74300000000000${tag}`,
  };
};

/** A Discord server worth copying, a Fluxer server, an engine, and a pair that both sides agreed to. */
export async function scenario({
  fluxerOpts = {},
  discordOpts = {},
  options,
  engineOpts = {},
  withExpressions = true,
} = {}) {
  const k = ids();
  const discord = fakeDiscord({
    id: k.src,
    name: 'Source',
    roles: [
      dRole({
        id: k.member,
        name: 'Member',
        rawPosition: 1,
        permissions: BIT.ViewChannel | BIT.SendMessages | BIT.ManageEvents,
        color: 255,
        hoist: true,
      }),
      dRole({ id: k.mod, name: 'Mod', rawPosition: 2, permissions: BIT.ManageMessages, mentionable: true }),
      dRole({ id: k.bot, name: 'A bot', rawPosition: 3, managed: true }),
    ],
    channels: [
      dChannel({ id: k.cat, name: 'Info', type: 4, rawPosition: 0 }),
      dChannel({
        id: k.rules,
        name: 'rules',
        type: 0,
        parentId: k.cat,
        rawPosition: 1,
        topic: 'Read these',
        overwrites: [
          { id: k.src, type: 0, deny: BIT.SendMessages },
          { id: k.member, type: 0, allow: BIT.ViewChannel },
        ],
      }),
      dChannel({ id: k.chat, name: 'chat', type: 0, rawPosition: 2, rateLimitPerUser: 5 }),
      dChannel({ id: k.cat2, name: 'Voice', type: 4, rawPosition: 3 }),
      dChannel({ id: k.voice, name: 'Lounge', type: 2, parentId: k.cat2, rawPosition: 4, userLimit: 4 }),
    ],
    emojis: withExpressions
      ? [
          {
            id: k.emoji1,
            name: 'party',
            animated: false,
            managed: false,
            imageURL: () => 'https://cdn.test/e1.png',
          },
          {
            id: k.emoji2,
            name: 'wave',
            animated: true,
            managed: false,
            imageURL: () => 'https://cdn.test/e2.gif',
          },
        ]
      : [],
    stickers: withExpressions
      ? [
          {
            id: k.sticker1,
            name: 'hello',
            description: 'Hi',
            tags: 'hi,wave',
            format: 1,
            url: 'https://cdn.test/s1.png',
          },
          {
            id: k.sticker2,
            name: 'anim',
            description: '',
            tags: '',
            format: 3,
            url: 'https://cdn.test/s2.json',
          },
        ]
      : [],
    ...discordOpts,
  });
  discord._icon = 'https://cdn.test/icon.png';
  const clock = fakeClock();
  const fluxer = fakeFluxer({ id: k.dst, ...fluxerOpts, clock });
  const { engine, fetched } = engineFor({ discord, fluxer, clock, ...engineOpts });
  const { pair } = await requestMirror({
    sourceGuild: k.src,
    targetGuild: `fluxer:${k.dst}`,
    actor: 'Anna',
    sourceUser: 'discord-owner',
    targetUser: 'fluxer-owner',
    targetOwner: true,
    options,
    now: clock.now,
  });
  return { k, discord, fluxer, clock, engine, fetched, pair };
}

/** Work the queue until the copy is over (moving the clock past any wait). */
export async function drain(s, { rounds = 60 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    await s.engine.runPair(s.pair.id);
    const now = await db.getPair(s.pair.id);
    if (!['copying'].includes(now.status)) return now;
    s.clock.now += 5000;
  }
  throw new Error('the copy did not finish');
}

export const names = (calls) => calls.map((c) => c.spec?.name ?? c.name);
