// GET /commands — lists the slash commands the bot currently has loaded.
// The list is derived from the live command collection, so it always matches
// what is actually registered.
import { Router } from 'express';
import { ApplicationCommandOptionType as OptType, PermissionsBitField } from 'discord.js';
import { runtime } from '../../runtime.js';

const router = Router();

/** Decode a default_member_permissions bitfield string into readable flag names. */
function describePermissions(bits) {
  if (bits == null) return null;
  try {
    const names = new PermissionsBitField(BigInt(bits)).toArray();
    return names.length ? names.map((n) => n.replace(/([a-z])([A-Z])/g, '$1 $2')) : null;
  } catch {
    return null;
  }
}

/** @param {any} opt */
function mapOption(opt) {
  return {
    name: opt.name,
    required: Boolean(opt.required),
    description: opt.description ?? '',
    choices: (opt.choices ?? []).map((c) => c.name),
  };
}

/** Build a `<name>`/`[name]` usage suffix from an option list. */
function usage(options) {
  return options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');
}

/**
 * Flatten the loaded command collection into rows for display. A command with
 * subcommands produces one row per subcommand.
 * @param {import('discord.js').Collection<string, { data: any }>} [collection]
 */
function describeCommands(collection) {
  if (!collection) return [];
  const rows = [];

  for (const { data } of collection.values()) {
    const json = data.toJSON();
    const permissions = describePermissions(json.default_member_permissions);
    const subs = (json.options ?? []).filter(
      (o) => o.type === OptType.Subcommand || o.type === OptType.SubcommandGroup
    );

    if (subs.length === 0) {
      const options = (json.options ?? []).map(mapOption);
      rows.push({
        signature: `/${json.name}${options.length ? ` ${usage(options)}` : ''}`,
        description: json.description,
        permissions,
        options,
      });
      continue;
    }

    for (const sub of subs) {
      const options = (sub.options ?? []).map(mapOption);
      rows.push({
        signature: `/${json.name} ${sub.name}${options.length ? ` ${usage(options)}` : ''}`,
        description: sub.description,
        permissions,
        options,
      });
    }
  }

  return rows.sort((a, b) => a.signature.localeCompare(b.signature));
}

router.get('/', (req, res) => {
  res.render('commands', { commands: describeCommands(runtime.client?.commands) });
});

export default router;
