import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommands } from '../src/bot/loadCommands.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';

test('every real command schema parses without an unexpected error', async () => {
  const commands = await loadCommands();
  assert.ok(commands.size >= 40, 'the real command set was loaded');

  for (const [name, command] of commands) {
    const schema = command.data.toJSON();
    for (const input of ['', 'x', 'add', 'a b c d e f']) {
      try {
        parseArgs(schema, input);
      } catch (err) {
        assert.ok(
          err instanceof ParseError,
          `/${name} ${JSON.stringify(input)} threw a non-ParseError: ${err}`
        );
      }
    }
  }
});

test('no real command needs an option type the prefix parser cannot supply', async () => {
  const commands = await loadCommands();
  const unsupported = [];
  for (const [name, command] of commands) {
    const walk = (opts) => {
      for (const o of opts ?? []) {
        if (o.type === 11 && o.required) unsupported.push(`${name}.${o.name}`);
        walk(o.options);
      }
    };
    walk(command.data.toJSON().options);
  }
  assert.deepEqual(unsupported, []);
});
