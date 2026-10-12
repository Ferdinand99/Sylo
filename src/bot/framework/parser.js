// Turns the text after a command prefix ("<@id> being rude", "add <@id> spam",
// "reason:spam user:<@id>") into typed option values, using the command's own
// application-command schema (`data.toJSON()`) — the same single source of truth
// the Discord slash-command registration reads.
//
// Rules, kept deliberately small:
//   - A command with subcommands needs the subcommand name first.
//   - `name:value` (or `name:"two words"`) assigns an option explicitly, in any
//     order — the way to skip an optional option or to give one after a long
//     free-text reason.
//   - Anything else fills the remaining options positionally, in declared order.
//   - The last string option, when only optional options follow it, takes the rest
//     of the line (up to the next `name:value`), so a multi-word reason needs no
//     quotes. An earlier string option takes a single word.
//
// Users, channels and roles are returned as the raw reference text; resolving
// them against a guild is resolve.js's job.
import { ApplicationCommandOptionType as T } from 'discord.js';

/** An argument problem that should be shown to the user as-is. */
export class ParseError extends Error {}

const QUOTES = { '"': '"', '“': '”' };
const ENTITY_TYPES = new Set([T.User, T.Channel, T.Role, T.Mentionable]);

function readQuoted(text, i) {
  const end = text.indexOf(QUOTES[text[i]], i + 1);
  return end === -1 ? null : { value: text.slice(i + 1, end), next: end + 1 };
}

/**
 * @param {string} text
 * @param {Set<string>} names  option names that may be written as `name:value`
 * @returns {Array<{ name?: string, value: string, start: number, end: number }>}
 */
function tokenize(text, names) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const start = i;
    if (QUOTES[text[i]]) {
      const q = readQuoted(text, i);
      if (q) {
        out.push({ value: q.value, start, end: q.next });
        i = q.next;
        continue;
      }
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j])) j += 1;
    const word = text.slice(i, j);
    const m = /^([A-Za-z0-9_-]+):/.exec(word);
    if (m && names.has(m[1].toLowerCase())) {
      const name = m[1].toLowerCase();
      const valueStart = i + m[0].length;
      if (QUOTES[text[valueStart]]) {
        const q = readQuoted(text, valueStart);
        if (q) {
          out.push({ name, value: q.value, start, end: q.next });
          i = q.next;
          continue;
        }
      }
      out.push({ name, value: word.slice(m[0].length), start, end: j });
    } else {
      out.push({ value: word, start, end: j });
    }
    i = j;
  }
  return out;
}

const TRUE = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSE = new Set(['false', 'no', 'n', 'off', '0']);

function coerce(opt, raw) {
  const label = `"${opt.name}"`;
  if (opt.choices?.length) {
    const lower = raw.toLowerCase();
    const hit = opt.choices.find((c) => String(c.value) === raw || c.name.toLowerCase() === lower);
    if (!hit) throw new ParseError(`${label} must be one of: ${opt.choices.map((c) => c.name).join(', ')}.`);
    return hit.value;
  }
  switch (opt.type) {
    case T.Integer:
    case T.Number: {
      const whole = opt.type === T.Integer;
      const n = whole ? (/^-?\d+$/.test(raw) ? Number(raw) : NaN) : raw.trim() === '' ? NaN : Number(raw);
      if (!Number.isFinite(n))
        throw new ParseError(`${label} must be a ${whole ? 'whole number' : 'number'}.`);
      if (opt.min_value != null && n < opt.min_value)
        throw new ParseError(`${label} must be at least ${opt.min_value}.`);
      if (opt.max_value != null && n > opt.max_value)
        throw new ParseError(`${label} must be at most ${opt.max_value}.`);
      return n;
    }
    case T.Boolean: {
      const lower = raw.toLowerCase();
      if (TRUE.has(lower)) return true;
      if (FALSE.has(lower)) return false;
      throw new ParseError(`${label} must be true or false.`);
    }
    case T.String:
      if (opt.min_length != null && raw.length < opt.min_length) {
        throw new ParseError(`${label} must be at least ${opt.min_length} characters.`);
      }
      if (opt.max_length != null && raw.length > opt.max_length) {
        throw new ParseError(`${label} must be at most ${opt.max_length} characters.`);
      }
      return raw;
    case T.Attachment:
      throw new ParseError(`${label} needs an attachment, which prefix commands do not support.`);
    default:
      if (ENTITY_TYPES.has(opt.type) && raw !== '') return raw;
      throw new ParseError(`${label} needs a value.`);
  }
}

/**
 * @param {{ options?: any[] }} schema  a command's `data.toJSON()`
 * @param {string} text  everything after the command name
 * @returns {{ subcommand: string | null, values: Record<string, { type: number, value: string | number | boolean }> }}
 * @throws {ParseError}
 */
export function parseArgs(schema, text) {
  const top = schema.options ?? [];
  const subs = top.filter((o) => o.type === T.Subcommand);
  let scope = top;
  let subcommand = null;

  if (subs.length) {
    const names = subs.map((s) => s.name).join(', ');
    const m = /^\s*(\S+)/.exec(text);
    if (!m) throw new ParseError(`Choose a subcommand: ${names}.`);
    const sub = subs.find((s) => s.name === m[1].toLowerCase());
    if (!sub) throw new ParseError(`Unknown subcommand "${m[1]}". Choose: ${names}.`);
    subcommand = sub.name;
    scope = sub.options ?? [];
    text = text.slice(m[0].length);
  }

  const byName = new Map(scope.map((o) => [o.name, o]));
  const tokens = tokenize(text, new Set(byName.keys()));
  const values = {};
  const set = (opt, raw) => {
    if (opt.name in values) throw new ParseError(`"${opt.name}" was given twice.`);
    values[opt.name] = { type: opt.type, value: coerce(opt, raw) };
  };

  let cursor = 0;
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.name) {
      set(byName.get(tok.name), tok.value);
      continue;
    }
    while (cursor < scope.length && scope[cursor].name in values) cursor += 1;
    const opt = scope[cursor];
    if (!opt) throw new ParseError('Too many arguments.');
    cursor += 1;

    // Free text goes to the last string option only; an earlier string (a
    // duration, a name) takes one word so the options after it stay reachable.
    const later = scope.slice(cursor).filter((o) => !(o.name in values));
    const takesRest =
      opt.type === T.String && later.every((o) => !o.required) && !later.some((o) => o.type === T.String);
    if (!takesRest) {
      set(opt, tok.value);
      continue;
    }
    // Free text: everything up to the next explicit `name:value` (or the end).
    let stop = t + 1;
    while (stop < tokens.length && !tokens[stop].name) stop += 1;
    const raw = stop - t === 1 ? tok.value : text.slice(tok.start, tokens[stop - 1].end).trim();
    set(opt, raw);
    t = stop - 1;
  }

  for (const opt of scope) {
    if (opt.required && !(opt.name in values)) {
      if (opt.type === T.Attachment) coerce(opt, '');
      throw new ParseError(`Missing required option "${opt.name}".`);
    }
  }
  return { subcommand, values };
}
