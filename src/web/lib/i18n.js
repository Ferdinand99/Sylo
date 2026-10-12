// Dashboard translations only. Discord messages and administrator-written
// content remain in their original language.
import { readFileSync } from 'node:fs';
import ejs from 'ejs';

export const polish = JSON.parse(readFileSync(new URL('../locales/pl.json', import.meta.url), 'utf8'));
export const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();
export function translate(text, language = 'en') {
  if (text == null) return '';
  const value = String(text);
  if (language !== 'pl') return value;
  const key = normalize(value);
  if (Object.hasOwn(polish, key)) return value.match(/^\s*/)[0] + polish[key] + value.match(/\s*$/)[0];
  for (const [pattern, replacement] of translatedPatterns) {
    if (pattern.test(key)) return key.replace(pattern, replacement);
  }
  return value;
}

export const translatedPatterns = [
  [/^Close ticket #(\d+)\?$/, 'Zamknąć zgłoszenie nr $1?'],
  [/^Upload "(.+)" as a backup snapshot\?$/, 'Przesłać „$1” jako kopię zapasową?'],
  [
    /^Restore the database from "(.+)"\? This replaces all current data and restarts the bot\.$/,
    'Przywrócić bazę z „$1”? To zastąpi wszystkie bieżące dane i zrestartuje bota.',
  ],
  [
    /^Permanently delete all stored data for (.+) in this server\? Sylo will DM them a confirmation\.$/,
    'Trwale usunąć wszystkie dane osoby $1 na tym serwerze? Sylo wyśle potwierdzenie przez DM.',
  ],
  [
    /^Request failed \((\d+)\) — reload the page and try again\.$/,
    'Żądanie nie powiodło się ($1) — odśwież i spróbuj ponownie.',
  ],
  [/^Test sent to #(.*)$/, 'Test wysłany na #$1'],
  [/^(\/\S+) updated$/, '$1 zaktualizowano'],
  [
    /^(.+) (enabled|disabled)$/,
    (_all, name, state) => `${translate(name, 'pl')} ${state === 'enabled' ? 'włączono' : 'wyłączono'}`,
  ],
  [/^Saved(.*)$/, (_all, note) => `Zapisano${note ? ` ${translate(note, 'pl')}` : ''}`],
  [/^(\d+) of (\d+)$/, '$1 z $2'],
  [/^(\d+) rules?$/, '$1 reguł'],
  [/^(\d+) active$/, '$1 aktywnych'],
  [/^(\d+) max$/, 'maks. $1'],
  [/^(\d+) selected$/, 'Wybrano: $1'],
  [/^of (\d+)$/, 'z $1'],
  [/^of (\d+), first (\d+)$/, 'z $1, pierwsze $2'],
  [/^Joins versus leaves per day$/, 'Dołączenia i wyjścia dziennie'],
  [/^Joins versus leaves per hour$/, 'Dołączenia i wyjścia na godzinę'],
  [
    /^Every (\d+) minutes$/,
    (_all, n) =>
      `Co ${n} ${Number(n) === 1 ? 'minutę' : /[2-4]$/.test(n) && !/1[2-4]$/.test(n) ? 'minuty' : 'minut'}`,
  ],
  [
    /^Every (\d+) hours$/,
    (_all, n) =>
      `Co ${n} ${Number(n) === 1 ? 'godzinę' : /[2-4]$/.test(n) && !/1[2-4]$/.test(n) ? 'godziny' : 'godzin'}`,
  ],
  [/^Every (\d+) days$/, 'Co $1 dni'],
  [/^keep (\d+)m$/, 'zachowaj $1 min'],
  [/^(\d+) unconfigured$/, '$1 nieskonfigurowanych'],
  [
    /^(\d+)([smhd]) ago$/,
    (_all, number, unit) => `${number} ${{ s: 's', m: 'min', h: 'godz.', d: 'dni' }[unit]} temu`,
  ],
  [
    /^last (\d+) (hours?|days?)$/,
    (_all, number, unit) => `ostatnie ${number} ${unit.startsWith('hour') ? 'godz.' : 'dni'}`,
  ],
  [
    /^(\d+) (seconds?|minutes?|hours?|days?) ago$/,
    (_all, number, unit) =>
      `${number} ${unit.startsWith('second') ? 's' : unit.startsWith('minute') ? 'min' : unit.startsWith('hour') ? 'godz.' : 'dni'} temu`,
  ],
];
const entities = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  ndash: '–',
  mdash: '—',
  nbsp: ' ',
  middot: '·',
  times: '×',
  copy: '©',
  larr: '←',
  rarr: '→',
};
function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (original, key) => {
    if (key.startsWith('#')) {
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : original;
    }
    return entities[key] ?? original;
  });
}
const skipped = new Set(['script', 'style', 'textarea', 'code', 'pre']);
const uiExpression =
  /^(?:i\.label|cat\.title|mod\.(?:name|description)|activeModule\.(?:name|description)|group\.title|card\.(?:name|description)|line\.label|it\.label|[ev]\.label|(?:cmd|opt|c)\.description|label|hint|pair\[1\]|m\[1\]|PRESET_LABEL\[p\] \|\| p|msg|message|error|title|pill\.label)$/;

// Mask EJS before tokenizing HTML: EJS expressions can contain >, quotes and
// HTML. Only literal UI text and known UI expressions are translated; editable
// values, names from Discord, code and message bodies are never inspected.
export function localizeTemplate(source) {
  const expressions = [];
  const masked = source.replace(
    /<%[\s\S]*?%>/g,
    (expression) => `\uE000${expressions.push(expression) - 1}\uE000`
  );
  const tokens = /\uE000\d+\uE000|<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<\uE000]+|</g;
  const stack = [];
  function localized(text) {
    const key = normalize(decode(text));
    if (!Object.hasOwn(polish, key)) return text.replace(/\bSylo\b/g, 'Krip-bot');
    const left = text.match(/^\s*/)[0];
    const right = text.match(/\s*$/)[0];
    return `${left}<%= uiText(${JSON.stringify(key)}) %>${right}`;
  }
  let result = masked.replace(tokens, (token) => {
    if (token.startsWith('\uE000')) {
      const index = Number(token.slice(1, -1));
      const expression = expressions[index];
      if (!stack.length && expression.startsWith('<%=')) {
        const body = expression.slice(3, -2).trim();
        if (
          uiExpression.test(body) ||
          /^(?:messages|m)\[msg\]/.test(body) ||
          /^\w+\[1\]$/.test(body) ||
          /^(?:modeLabels|matchLabels|roleActionLabels|ACTION_LABELS)\[/.test(body) ||
          (body === 't' && source.includes('issues.forEach')) ||
          (body === 't' && source.includes('presenceTypes.forEach')) ||
          (body === 'name' && source.includes('logEvents.forEach')) ||
          /^(?:\w+\.)?(?:ago|openedAgo|closedAgo|decidedAgo|windowLabel|perLabel)$/.test(body)
        ) {
          expressions[index] = `<%= uiText(${body}) %>`;
        } else {
          // Localize literal branches without translating the value of the
          // other branch (for example, a member's display name).
          const translatedBody = body.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (literal, value, offset) => {
            // Comparisons, property keys and function arguments are program
            // values, not copy. Translate only displayed literal results.
            const before = body.slice(0, offset);
            const displayed = body === literal || /(?:[?:]|\|\|)\s*$/.test(before);
            return displayed && Object.hasOwn(polish, value) && /[a-zA-Z]{2}/.test(value)
              ? `uiText(${literal})`
              : literal;
          });
          expressions[index] = `<%= ${translatedBody} %>`;
        }
      }
      return token;
    }
    if (token.startsWith('<!--')) return token;
    if (token.startsWith('<')) {
      const tag = token.match(/^<\/?([\w-]+)/);
      if (!tag) return token;
      const name = tag[1].toLowerCase();
      if (stack.length) {
        if (token.startsWith('</') && name === stack.at(-1)) stack.pop();
        return token;
      }
      const output = token.replace(
        /\b(placeholder|data-ph|aria-label|title|data-confirm|hx-confirm)="([^"]*)"/g,
        (original, attr, value) => (value.includes('\uE000') ? original : `${attr}="${localized(value)}"`)
      );
      if (skipped.has(name)) {
        if (!token.startsWith('</')) stack.push(name);
      }
      return output;
    }
    return stack.length ? token : localized(token);
  });
  result = result.replace(/\uE000(\d+)\uE000/g, (_, index) => expressions[Number(index)]);
  return result;
}

export function mountI18n(app) {
  app.use((req, res, next) => {
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)sylo_language=(en|pl)(?:;|$)/)?.[1];
    const language = ['en', 'pl'].includes(req.query.lang) ? req.query.lang : cookie || 'pl';
    if (req.method === 'GET' && ['en', 'pl'].includes(req.query.lang)) {
      res.cookie('sylo_language', language, {
        maxAge: 365 * 86400_000,
        sameSite: 'lax',
        path: '/',
        secure: req.secure,
      });
    }
    res.locals.language = language;
    res.locals.uiText = (text) => translate(text, language).replace(/\bSylo\b/g, 'Krip-bot');
    const href = (locale) => {
      const url = new URL(req.originalUrl, 'http://dashboard.local');
      url.searchParams.set('lang', locale);
      return url.pathname + url.search;
    };
    res.locals.languageHref = href;
    next();
  });
  app.get('/dashboard-translations.js', (_req, res) => {
    const patterns = translatedPatterns
      .map(
        ([pattern, replacement]) =>
          `[${pattern.toString()},${typeof replacement === 'function' ? replacement.toString() : JSON.stringify(replacement)}]`
      )
      .join(',');
    res
      .type('application/javascript')
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .send(
        `(()=>{const polish=${JSON.stringify(polish).replace(/</g, '\\u003c')};const normalize=${normalize.toString()};const translatedPatterns=[${patterns}];const translate=${translate.toString()};window.syloTranslate=translate;})();`
      );
  });
  app.engine('ejs', (filename, options, callback) => {
    try {
      const template = localizeTemplate(readFileSync(filename, 'utf8'));
      const output = ejs.render(template, options, {
        filename,
        includer: (_original, resolved) => ({
          filename: resolved,
          template: localizeTemplate(readFileSync(resolved, 'utf8')),
        }),
      });
      callback(null, output);
    } catch (error) {
      callback(error);
    }
  });
}
