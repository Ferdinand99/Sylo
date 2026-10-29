// The Quote board's pure helpers: the settings normaliser and LIMITS, text and query cutting, message
// link parsing, jump links, who may do what, the public text, and the embed and list line.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  LIMITS,
  buildQuoteEmbed,
  canView,
  canManageQuotes,
  canRemoveQuote,
  canSaveQuotes,
  isPublicSource,
  jumpUrl,
  normaliseQuoteBoardConfig,
  normaliseQuoteQuery,
  normaliseQuoteText,
  parseMessageLink,
  publicText,
  quoteLine,
} from '../src/modules/quoteBoard.js';
import { MODULE_LIMITS } from '../src/modules/limits.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import { MODULES } from '../src/modules/registry.js';
import { likePattern } from '../src/db/quotes.js';

const ID = (n) => String(100000000000000000n + BigInt(n));

test('the module is registered as a beta module, off by default, and its limits are served to the dashboard', () => {
  const m = MODULES.find((x) => x.id === 'quote-board');
  assert.equal(m.beta, true);
  assert.equal(m.defaultEnabled, false);
  assert.equal(m.configurable, true);
  assert.equal(MODULE_LIMITS['quote-board'], LIMITS);
});

test('LIMITS: text 2000, search query 100, role lists 25; the row ceiling is 10 000', () => {
  assert.deepEqual(LIMITS.text, { maxLength: 2000 });
  assert.deepEqual(LIMITS.query, { maxLength: 100 });
  assert.equal(LIMITS.saveRoles.maxItems, 25);
  assert.equal(LIMITS.staffRoles.maxItems, 25);
  assert.equal(CEILINGS.quotes, 10_000);
});

test('the settings default to: no public page, everyone may save, no extra roles', () => {
  assert.deepEqual(normaliseQuoteBoardConfig(), {
    publicPage: false,
    saveMode: 'everyone',
    saveRoles: [],
    staffRoles: [],
  });
  assert.deepEqual(normaliseQuoteBoardConfig(undefined), normaliseQuoteBoardConfig({}));
});

test('the public page needs an explicit true; anything else is off', () => {
  for (const v of [undefined, null, false, 0, 'true', 'yes', 1, [], {}]) {
    assert.equal(normaliseQuoteBoardConfig({ publicPage: v }).publicPage, false, JSON.stringify(v));
  }
  assert.equal(normaliseQuoteBoardConfig({ publicPage: true }).publicPage, true);
});

test('saveMode is everyone or roles; role lists keep valid ids only, once, up to 25', () => {
  assert.equal(normaliseQuoteBoardConfig({ saveMode: 'roles' }).saveMode, 'roles');
  for (const v of ['admins', '', null, 7]) {
    assert.equal(normaliseQuoteBoardConfig({ saveMode: v }).saveMode, 'everyone');
  }
  const out = normaliseQuoteBoardConfig({
    saveRoles: [ID(1), ID(1), 'junk', 5, [ID(2)], ID(3)],
    staffRoles: Array.from({ length: 40 }, (_, i) => ID(i)),
  });
  assert.deepEqual(out.saveRoles, [ID(1), ID(3)]);
  assert.equal(out.staffRoles.length, 25);
});

test('quote text is trimmed and cut at 2000 without splitting an emoji', () => {
  assert.equal(normaliseQuoteText('  hello  '), 'hello');
  assert.equal(normaliseQuoteText(undefined), '');
  assert.equal(normaliseQuoteText('a'.repeat(2000)).length, 2000);
  assert.equal(normaliseQuoteText('a'.repeat(2001)).length, 2000);
  const cutInTheMiddle = normaliseQuoteText(`${'a'.repeat(1999)}😀`);
  assert.equal(cutInTheMiddle, 'a'.repeat(1999), 'the half emoji is dropped');
});

test('a search query is collapsed to single spaces and cut at 100', () => {
  assert.equal(normaliseQuoteQuery('  big \n  cat\t'), 'big cat');
  assert.equal(normaliseQuoteQuery(undefined), '');
  assert.equal(normaliseQuoteQuery('b'.repeat(100)).length, 100);
  assert.equal(normaliseQuoteQuery('b'.repeat(101)).length, 100);
});

test('likePattern takes % _ and the escape character literally', () => {
  assert.equal(likePattern('Cat'), '%cat%');
  assert.equal(likePattern('100%'), '%100!%%');
  assert.equal(likePattern('a_b!c'), '%a!_b!!c%');
});

test('message links: Discord, canary, ptb, Fluxer and angle brackets parse; everything else does not', () => {
  const ids = { guildId: ID(1), channelId: ID(2), messageId: ID(3) };
  const path = `/channels/${ID(1)}/${ID(2)}/${ID(3)}`;
  for (const url of [
    `https://discord.com${path}`,
    `https://canary.discord.com${path}`,
    `https://ptb.discord.com${path}`,
    `https://discordapp.com${path}`,
    `https://web.fluxer.app${path}`,
    `<https://discord.com${path}>`,
    `  https://discord.com${path}?x=1  `,
    `http://discord.com${path}/`,
  ]) {
    assert.deepEqual(parseMessageLink(url), ids, url);
  }
  for (const bad of [
    '',
    undefined,
    'hello',
    `https://discord.com/channels/${ID(1)}/${ID(2)}`, // a channel link
    `https://discord.com/channels/@me/${ID(2)}/${ID(3)}`, // a DM
    `https://discord.com/channels/abc/${ID(2)}/${ID(3)}`,
    `see https://discord.com${path}`, // text around the link
    `javascript:alert(1)//channels/${ID(1)}/${ID(2)}/${ID(3)}`,
    `ftp://discord.com${path}`,
  ]) {
    assert.equal(parseMessageLink(bad), null, String(bad));
  }
});

test('jump links point at Discord, or at the Fluxer web app for a Fluxer server', () => {
  assert.equal(jumpUrl(ID(1), ID(2), ID(3)), `https://discord.com/channels/${ID(1)}/${ID(2)}/${ID(3)}`);
  assert.equal(
    jumpUrl(`fluxer:${ID(1)}`, ID(2), ID(3)),
    `https://web.fluxer.app/channels/${ID(1)}/${ID(2)}/${ID(3)}`
  );
});

// --- who may do what ---------------------------------------------------------------------------------------

const member = (roles = [], perms = []) => ({
  roles: { cache: new Map(roles.map((r) => [r, true])) },
  permissions: { has: (p) => perms.includes(p) },
});
const staffCheck = (m, cfg) => canManageQuotes(m, m.permissions, cfg);

test('staff are Manage Messages, Manage Server, Administrator or a staff role', () => {
  assert.equal(staffCheck(member([], ['ManageMessages']), {}), true);
  assert.equal(staffCheck(member([], ['ManageGuild']), {}), true);
  assert.equal(staffCheck(member([], ['Administrator']), {}), true);
  assert.equal(staffCheck(member([ID(7)]), { staffRoles: [ID(7)] }), true);
  assert.equal(staffCheck(member([ID(8)]), { staffRoles: [ID(7)] }), false);
  assert.equal(staffCheck(member([], ['ManageRoles', 'KickMembers', 'ManageChannels']), {}), false);
  assert.equal(staffCheck(member(), undefined), false);
  assert.equal(canManageQuotes(null, null, {}), false);
  assert.equal(
    canManageQuotes(
      member(),
      {
        has() {
          throw new Error('broken permissions');
        },
      },
      {}
    ),
    false,
    'a permissions object that throws is not staff'
  );
});

test('saving: everyone by default; in "roles" mode staff and the listed roles', () => {
  const plain = member();
  assert.equal(canSaveQuotes(plain, plain.permissions, { saveMode: 'everyone' }), true);
  assert.equal(canSaveQuotes(plain, plain.permissions, {}), true);
  const cfg = { saveMode: 'roles', saveRoles: [ID(1)], staffRoles: [ID(2)] };
  assert.equal(canSaveQuotes(plain, plain.permissions, cfg), false);
  const withRole = member([ID(1)]);
  assert.equal(canSaveQuotes(withRole, withRole.permissions, cfg), true);
  const staffRole = member([ID(2)]);
  assert.equal(canSaveQuotes(staffRole, staffRole.permissions, cfg), true);
  const mod = member([], ['ManageMessages']);
  assert.equal(canSaveQuotes(mod, mod.permissions, cfg), true);
  assert.equal(canSaveQuotes(plain, plain.permissions, { saveMode: 'roles', saveRoles: [] }), false);
});

test('removing: the author, whoever saved it, staff; nobody else', () => {
  const row = { author_id: 'author', saved_by: 'saver' };
  const none = member();
  const can = (userId, m = none, cfg = {}) => canRemoveQuote(row, userId, m, m.permissions, cfg);
  assert.equal(can('author'), true);
  assert.equal(can('saver'), true);
  assert.equal(can('other'), false);
  assert.equal(can(undefined), false);
  const mod = member([], ['ManageMessages']);
  assert.equal(can('other', mod), true);
  assert.equal(can('other', member([ID(5)]), { staffRoles: [ID(5)] }), true);
  // after the saver used /forget the name is gone: a null saved_by never matches anyone
  assert.equal(canRemoveQuote({ author_id: 'a', saved_by: null }, null, none, none.permissions, {}), false);
});

// --- showing --------------------------------------------------------------------------------------------------

const row = (over = {}) => ({
  number: 12,
  channel_id: ID(2),
  message_id: ID(3),
  author_name: 'Alice',
  body: 'first\nsecond',
  attachments: 0,
  message_at: Date.UTC(2030, 0, 2),
  ...over,
});

test('the embed shows the quote as a block, the author and date, the attachments and the jump link', () => {
  const e = buildQuoteEmbed(row({ attachments: 2 }), ID(1)).toJSON();
  assert.equal(e.footer.text, 'Quote #12');
  const parts = e.description.split('\n\n');
  assert.equal(parts[0], '> first\n> second');
  assert.equal(parts[1], `— **Alice**, <t:${Math.floor(Date.UTC(2030, 0, 2) / 1000)}:D>`);
  assert.equal(parts[2], '📎 2 attachments');
  assert.equal(parts[3], `[Jump to the message](https://discord.com/channels/${ID(1)}/${ID(2)}/${ID(3)})`);
});

test('the embed copes with no text, one attachment and no stored name', () => {
  const e = buildQuoteEmbed(row({ body: '', attachments: 1, author_name: '' }), ID(1)).toJSON();
  assert.match(e.description, /^\*\(no text\)\*/);
  assert.match(e.description, /\*\*Unknown\*\*/);
  assert.match(e.description, /📎 1 attachment\n/);
  assert.doesNotMatch(buildQuoteEmbed(row(), ID(1)).toJSON().description, /📎/);
});

test('the longest quote fits an embed description', () => {
  const body = Array.from({ length: 1000 }, () => 'x')
    .join('\n')
    .slice(0, 2000);
  const e = buildQuoteEmbed(row({ body, attachments: 10 }), `fluxer:${ID(1)}`).toJSON();
  assert.ok(e.description.length <= 4096, String(e.description.length));
  assert.match(e.description, /…\n\n— \*\*Alice\*\*/, 'the quote is shortened, the author and link stay');
  assert.match(e.description, /\/channels\/\d+\/\d+\/\d+\)$/);
});

test('list lines are one line each, cut at 110 characters, with the attachment count when there is no text', () => {
  assert.equal(quoteLine(row({ body: 'one\n\n two   three' })), '**#12** Alice: one two three');
  const long = quoteLine(row({ body: 'w'.repeat(300) }));
  assert.equal(long, `**#12** Alice: ${'w'.repeat(109)}…`);
  assert.equal(quoteLine(row({ body: '', attachments: 3 })), '**#12** Alice: 📎 3 attachments');
  assert.equal(quoteLine(row({ author_name: '' })), '**#12** Unknown: first second');
});

// --- the public page ---------------------------------------------------------------------------------------------

test('publicText turns anything with an id into words', () => {
  const text =
    `hi <@123456789012345678> and <@!223456789012345678>, role <@&323456789012345678> in <#423456789012345678> ` +
    `with <:blob:523456789012345678> <a:wave:623456789012345678> see ` +
    `https://discord.com/channels/723456789012345678/823456789012345678/923456789012345678 ` +
    `</cmd:123456789012345679> <t:1700000000:R> raw 12345678901234567890 end`;
  const out = publicText(text);
  assert.equal(
    out,
    'hi @member and @member, role @role in #channel with :blob: :wave: see [message link] /command  raw … end'
  );
  assert.doesNotMatch(out, /\d{17}/);
  assert.equal(publicText('plain words, 2030 and 42'), 'plain words, 2030 and 42');
  assert.equal(publicText(undefined), '');
});

test('a channel is a public source only when @everyone can view it and it is not age-restricted', () => {
  const everyone = { id: 'e' };
  const guild = { roles: { everyone } };
  const channel = (sees, extra = {}) => ({
    permissionsFor: (who) => ({ has: (p) => who === everyone && sees && p === 'ViewChannel' }),
    ...extra,
  });
  assert.equal(isPublicSource(guild, channel(true)), true);
  assert.equal(isPublicSource(guild, channel(false)), false);
  assert.equal(isPublicSource(guild, channel(true, { nsfw: true })), false);
  assert.equal(isPublicSource({}, channel(true)), false, 'no @everyone role known');
  assert.equal(isPublicSource(guild, {}), false, 'no way to check');
  assert.equal(isPublicSource(guild, null), false);
  assert.equal(
    isPublicSource(guild, {
      permissionsFor() {
        throw new Error('boom');
      },
    }),
    false
  );
});

// A thread has no permissions or age restriction of its own: discord.js answers permissionsFor
// with the parent channel's, and nsfw is not set on a thread.
function threadWorld() {
  const everyone = { id: 'e' };
  const guild = { roles: { everyone } };
  const parent = (sees, nsfw = false) => ({
    nsfw,
    permissionsFor: (who) => ({
      has: (p) =>
        who === everyone ? sees && p === 'ViewChannel' : Boolean(who.manager) && p === 'ManageThreads',
    }),
  });
  const thread = (type, par, memberIds = []) => ({
    type,
    isThread: () => true,
    parent: par,
    // discord.js: a thread answers with its parent's permissions and has no nsfw flag
    permissionsFor: (who) => par.permissionsFor(who),
    members: {
      cache: new Map(),
      fetch: async (id) => {
        if (!memberIds.includes(id)) throw new Error('Unknown Thread Member');
        return { id };
      },
    },
  });
  return { guild, everyone, parent, thread };
}

test('a thread follows its parent: public thread of a public channel is public, a private thread never is', () => {
  const { guild, parent, thread } = threadWorld();
  assert.equal(isPublicSource(guild, thread(ChannelType.PublicThread, parent(true))), true);
  assert.equal(isPublicSource(guild, thread(ChannelType.AnnouncementThread, parent(true))), true);
  assert.equal(isPublicSource(guild, thread(ChannelType.PrivateThread, parent(true))), false);
  assert.equal(isPublicSource(guild, thread(ChannelType.PublicThread, parent(false))), false);
  assert.equal(
    isPublicSource(guild, thread(ChannelType.PublicThread, parent(true, true))),
    false,
    'a thread under an age-restricted channel'
  );
  assert.equal(isPublicSource(guild, thread(ChannelType.PublicThread, null)), false, 'parent unknown');
});

test('canView: a private thread needs membership or Manage Threads, not only the parent channel', async () => {
  const { parent, thread } = threadWorld();
  const outsider = { id: '1' };
  const inside = { id: '2' };
  const moderator = { id: '3', manager: true };
  const parentOpen = { ...parent(false), permissionsFor: () => ({ has: (p) => p === 'ViewChannel' }) };
  const priv = thread(ChannelType.PrivateThread, parentOpen, ['2']);
  assert.equal(await canView(priv, outsider), false);
  assert.equal(await canView(priv, inside), true);
  assert.equal(await canView(priv, null), false);
  const modParent = {
    permissionsFor: (who) => ({ has: (p) => p === 'ViewChannel' || (who.manager && p === 'ManageThreads') }),
  };
  assert.equal(await canView(thread(ChannelType.PrivateThread, modParent, []), moderator), true);
  assert.equal(await canView(thread(ChannelType.PrivateThread, modParent, []), outsider), false);
  // a public thread is as visible as its parent
  assert.equal(await canView(thread(ChannelType.PublicThread, parentOpen, []), outsider), true);
  // a thread whose members cannot be fetched counts as no
  const broken = thread(ChannelType.PrivateThread, parentOpen);
  broken.members = undefined;
  assert.equal(await canView(broken, outsider), false);
});
