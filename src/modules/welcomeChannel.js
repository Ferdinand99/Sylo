// Welcome Channel — build one rich, pinned message for a dedicated read-only
// channel (welcome / rules / links). A thin, welcome-flavoured front-end over
// the Message Creator's embed payload builder.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { sendComposed, editComposed } from './messageCreator.js';

const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const url = (v) => (/^https?:\/\/\S+$/i.test(v ?? '') ? v : '');
const hex = (v) =>
  /^#?[0-9a-fA-F]{6}$/.test(v ?? '') ? (String(v).startsWith('#') ? String(v) : '#' + v) : '';
const BRAND = '#5865f2';

// "Add element" presets. `kind` is a UI hint; everything is stored as an embed
// spec (a "banner" is just an embed with a big image).
export const WC_PRESETS = [
  { id: 'advanced-embed', label: 'Advanced embed', kind: 'embed', make: () => ({ kind: 'embed', color: BRAND }) },
  {
    id: 'welcome-embed',
    label: 'Welcome embed',
    kind: 'embed',
    make: () => ({
      kind: 'embed',
      color: BRAND,
      title: 'Welcome to {server}!',
      description:
        "Hello and a warm welcome to all of our new members! 👋 We're thrilled to have you.\n\nTake a moment to introduce yourself and read the rules below. Enjoy your stay! 🎉",
    }),
  },
  {
    id: 'rules-embed',
    label: 'Rules embed',
    kind: 'embed',
    make: () => ({
      kind: 'embed',
      color: BRAND,
      title: '📋 Server rules',
      description:
        '**1.** Be respectful to everyone.\n**2.** No spam or unsolicited self-promotion.\n**3.** Keep content in the right channels.\n**4.** Follow the Discord Community Guidelines.',
    }),
  },
  {
    id: 'invite-embed',
    label: 'Invite embed',
    kind: 'embed',
    make: () => ({ kind: 'embed', color: BRAND, title: '🔗 Invite your friends', description: 'Enjoying it here? Bring a friend along and help the server grow.' }),
  },
  {
    id: 'mods-embed',
    label: 'Staff embed',
    kind: 'embed',
    make: () => ({ kind: 'embed', color: BRAND, title: '🛡️ Staff', description: 'Need help? Mention a staff member or open a ticket.' }),
  },
  {
    id: 'links-embed',
    label: 'Links embed',
    kind: 'embed',
    make: () => ({ kind: 'embed', color: BRAND, title: '🌐 Links', description: '• Website — https://\n• Twitter — https://\n• YouTube — https://' }),
  },
  { id: 'welcome-banner', label: 'Welcome banner', kind: 'banner', make: () => ({ kind: 'banner', image: '' }) },
  { id: 'rules-banner', label: 'Rules banner', kind: 'banner', make: () => ({ kind: 'banner', image: '' }) },
  { id: 'invite-banner', label: 'Invite banner', kind: 'banner', make: () => ({ kind: 'banner', image: '' }) },
  { id: 'links-banner', label: 'Links banner', kind: 'banner', make: () => ({ kind: 'banner', image: '' }) },
];

/** Sanitise one embed spec object (shared by Welcome Channel and Reaction roles). */
export function normaliseEmbedSpec(e = {}) {
  return {
    kind: e.kind === 'banner' ? 'banner' : 'embed',
    title: String(e.title ?? '').slice(0, 256),
    description: String(e.description ?? '').slice(0, 4096),
    color: hex(e.color),
    image: url(e.image),
    thumbnail: url(e.thumbnail),
    authorName: String(e.authorName ?? '').slice(0, 256),
    authorIcon: url(e.authorIcon),
    footerText: String(e.footerText ?? '').slice(0, 2048),
    footerIcon: url(e.footerIcon),
    timestamp: Boolean(e.timestamp),
    fields: (Array.isArray(e.fields) ? e.fields : [])
      .map((f) => ({
        name: String(f.name ?? '').slice(0, 256),
        value: String(f.value ?? '').slice(0, 1024),
        inline: Boolean(f.inline),
      }))
      .filter((f) => f.name && f.value)
      .slice(0, 25),
  };
}

export function normaliseWelcomeChannelConfig(raw = {}) {
  const spec = raw.spec && typeof raw.spec === 'object' ? raw.spec : {};
  const embeds = (Array.isArray(spec.embeds) ? spec.embeds : []).slice(0, 10).map(normaliseEmbedSpec);
  return {
    channelId: id(raw.channelId),
    messageId: id(raw.messageId),
    spec: { content: String(spec.content ?? '').slice(0, 2000), embeds },
  };
}

export function substitutePlaceholders(str, guild) {
  return String(str ?? '')
    .replaceAll('{server.name}', guild.name)
    .replaceAll('{server.id}', guild.id)
    .replaceAll('{server}', guild.name)
    .replaceAll('{memberCount}', String(guild.memberCount ?? 0));
}

/** Stored config -> a Message Creator spec with placeholders filled in. */
export function resolveWelcomeSpec(cfg, guild) {
  const s = (v) => substitutePlaceholders(v, guild);
  return {
    content: s(cfg.spec?.content),
    embeds: (cfg.spec?.embeds ?? []).map((e) => ({
      title: s(e.title),
      description: s(e.description),
      color: e.color || '',
      image: e.image || '',
      thumbnail: e.thumbnail || '',
      authorName: s(e.authorName),
      authorIcon: e.authorIcon || '',
      footerText: s(e.footerText),
      footerIcon: e.footerIcon || '',
      timestamp: Boolean(e.timestamp),
      fields: (Array.isArray(e.fields) ? e.fields : []).map((f) => ({
        name: s(f.name),
        value: s(f.value),
        inline: Boolean(f.inline),
      })),
    })),
  };
}

/** Send the message (or edit the existing one). Returns { ok, messageId?, error? }. */
export async function publishWelcome(guild, cfg) {
  if (!cfg.channelId) return { ok: false, error: 'Pick a channel first.' };
  const spec = resolveWelcomeSpec(cfg, guild);
  try {
    let message = null;
    if (cfg.messageId) {
      message = await editComposed(guild, cfg.channelId, cfg.messageId, spec).catch(() => null);
    }
    if (!message) message = await sendComposed(guild, cfg.channelId, spec);
    return { ok: true, messageId: message.id };
  } catch (err) {
    return { ok: false, error: err.message || 'Publish failed.' };
  }
}

/** Delete the published message (best-effort). */
export async function unpublishWelcome(guild, cfg) {
  if (!cfg.channelId || !cfg.messageId) return;
  const ch = guild.channels.cache.get(cfg.channelId);
  const msg = ch && (await ch.messages.fetch(cfg.messageId).catch(() => null));
  if (msg) await msg.delete().catch(() => {});
}

/** Create a read-only #welcome text channel. Returns { ok, channelId?, error? }. */
export async function createWelcomeChannel(guild) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, error: 'The bot needs Manage Channels.' };
  }
  try {
    const ch = await guild.channels.create({
      name: 'welcome',
      type: ChannelType.GuildText,
      reason: 'Welcome Channel module',
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionFlagsBits.ViewChannel],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
          ],
        },
        {
          id: me.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
        },
      ],
    });
    return { ok: true, channelId: ch.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
