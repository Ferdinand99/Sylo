import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommands } from '../src/bot/loadCommands.js';
import { GROUPS, otherCommands, execute } from '../src/bot/commands/help.js';
import { runtime } from '../src/runtime.js';
import { setCommandPrefix } from '../src/db/guildSettings.js';

// Regression test for a real bug: /help crashed ("Received one or more
// errors") once the commands left ungrouped under "Other" pushed that
// field's value past Discord's 1024-char-per-field limit. /help was then
// rebuilt as a select-menu-paginated command (one category per page) partly
// to fix this and partly so it reads better — this test's job is making
// sure nothing added later can silently cross the same limit again without
// a test failure pointing at it, and that every category actually has a
// real command in it (a typo'd name would otherwise render as an empty
// page instead of erroring).
const FIELD_LIMIT = 1024;

test("help: every category's page stays under Discord's 1024-char description limit", async () => {
  const all = await loadCommands();

  for (const group of GROUPS) {
    const lines = group.commands.map((n) => all.get(n)).filter(Boolean);
    assert.equal(
      lines.length,
      group.commands.length,
      `"${group.name}" references a command name that doesn't exist: ` +
        group.commands.filter((n) => !all.has(n)).join(', ')
    );
    const value = lines.map((c) => `/${c.data.name} — ${c.data.description}`).join('\n');
    assert.ok(
      value.length <= FIELD_LIMIT,
      `"${group.name}" page is ${value.length} chars — over the ${FIELD_LIMIT} limit`
    );
  }

  const other = otherCommands(all);
  const otherValue = other.map((c) => `/${c.data.name} — ${c.data.description}`).join('\n');
  assert.ok(
    otherValue.length <= FIELD_LIMIT,
    `"Other" page is ${otherValue.length} chars (commands: ${other.map((c) => c.data.name).join(', ')}) — ` +
      `over the ${FIELD_LIMIT} limit; add the new command(s) to a group in help.js`
  );
});

test('help: every real command is covered by exactly one GROUPS entry (or falls through to Other)', async () => {
  const all = await loadCommands();
  const counts = new Map();
  for (const group of GROUPS) {
    for (const name of group.commands) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(duplicates, [], `command(s) listed in more than one group: ${duplicates.join(', ')}`);

  // Not asserting `other` is empty — a brand new command legitimately lands
  // there until someone groups it — just that GROUPS hasn't drifted to
  // reference a command that no longer exists (covered above) and that the
  // "Other" catch-all still works as a safety net either way.
  assert.ok(Array.isArray(otherCommands(all)));
});

test("help: GROUPS names are unique and stay within Discord's 25-option select-menu limit", () => {
  const names = GROUPS.map((g) => g.name);
  assert.equal(new Set(names).size, names.length);
  // +1 for "Overview" and +1 for a possible "Other" option.
  assert.ok(GROUPS.length + 2 <= 25);
});

// --- the prefix in the help texts --------------------------------------------------------------

const RAW = '900000000000000070';
const KEY = `fluxer:${RAW}`;

/** Runs /help (or !help) and returns the overview embed, the first page and the select-menu handler. */
async function runHelp({ client, guild }) {
  const commands = await loadCommands();
  client.commands = commands;
  const sent = { replies: [] };
  let onCollect;
  const message = {
    createMessageComponentCollector: () => ({
      on: (event, fn) => {
        if (event === 'collect') onCollect = fn;
      },
    }),
  };
  const interaction = {
    client,
    guild,
    user: { id: 'u1' },
    reply: async (payload) => sent.replies.push(payload),
    fetchReply: async () => message,
    editReply: async () => {},
  };
  await execute(interaction);
  const page = async (value, userId = 'u1') => {
    const updates = [];
    await onCollect({
      user: { id: userId },
      values: [value],
      update: async (p) => updates.push(p),
      reply: async (p) => updates.push(p),
    });
    return updates[0];
  };
  return { overview: sent.replies[0].embeds[0].data, page };
}

test("help on Discord lists slash commands; on Fluxer it lists the server's prefix", async () => {
  const discord = await runHelp({ client: {}, guild: { id: '900000000000000071' } });
  assert.match(discord.overview.description, /^Slash commands are grouped/);
  assert.match((await discord.page('0')).embeds[0].data.description, /`\/help` —/);

  const fluxerClient = {};
  runtime.clients.fluxer = fluxerClient;
  const guild = { id: RAW, client: fluxerClient };
  try {
    const byDefault = await runHelp({ client: fluxerClient, guild });
    assert.match(byDefault.overview.description, /^Commands are grouped/);
    assert.match((await byDefault.page('0')).embeds[0].data.description, /`!help` —/);

    await setCommandPrefix(KEY, '?');
    const own = await runHelp({ client: fluxerClient, guild });
    const text = (await own.page('0')).embeds[0].data.description;
    assert.match(text, /`\?help` —/);
    assert.doesNotMatch(text, /`[!/]help`/);
    assert.match((await own.page('0', 'someone-else')).content, /run `\?help` yourself/);

    // A direct message has no server: the instance default.
    const dm = await runHelp({ client: fluxerClient, guild: null });
    assert.match((await dm.page('0')).embeds[0].data.description, /`!help` —/);
  } finally {
    await setCommandPrefix(KEY, null);
    runtime.clients.fluxer = null;
  }
});
