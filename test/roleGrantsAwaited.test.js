// The role-grant guards (src/web/middleware/roleGrants.js) refuse by returning a rejected promise.
// A call whose promise is neither awaited nor returned never refuses anything, and its rejection
// escapes as an unhandled rejection. ESLint here has no type information, so
// `@typescript-eslint/no-floating-promises` is not an option; this scan fails the build instead.
//
// What counts as a guard is worked out, not listed: every async function (or one that hands back
// checkNewGrants) in roleGrants.js, and then, repeatedly, every named async function in src/web that
// awaits or returns a guard or throws a RoleGrantError itself (roleProblem, shouldSaveBotMasters).
// A call passes when it is awaited, returned, or the body of an arrow function that hands the promise
// back. It is flagged when it is dropped: a bare call, a condition, a variable, an arrow given to
// forEach/map/setTimeout (unless the map sits in Promise.all), a second call on a line, a member call
// (`rg.checkRoleGrants()`) or an import under another name (`checkRoleGrants as crg`).
// Not covered: a guard passed around as a value (`roles.some(checkRoleGrants)`), and a call that
// starts in the middle of a statement spread over several lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const GUARD_FILE = join('web', 'middleware', 'roleGrants.js');

const lf = (text) => text.replaceAll('\r\n', '\n');

/** Named functions of a source text: { name, async, body }, the body found by matching braces. */
function functionsOf(source) {
  const found = [];
  const decl =
    /(?:^|[^\w$.])(?:export\s+)?(?:(async)\s+)?function\s*\*?\s*([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(async\s+)?(?:function\s*)?\(?[^=;]*?\)?\s*=>/g;
  for (let m = decl.exec(source); m; m = decl.exec(source)) {
    const name = m[2] ?? m[3];
    const isAsync = Boolean(m[1] ?? m[4]);
    let start = decl.lastIndex;
    if (m[2]) {
      let depth = 1; // skip the parameter list
      while (start < source.length && depth > 0) {
        const c = source[start++];
        if (c === '(') depth++;
        else if (c === ')') depth--;
      }
    }
    const rest = source.slice(start);
    const open = /^\s*\{/.exec(rest);
    let body;
    if (open) {
      const from = start + open[0].indexOf('{');
      let depth = 0;
      let i = from;
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) break;
      }
      body = source.slice(from, i + 1);
    } else {
      body = rest.split('\n')[0]; // an expression body: `=> guard(...)`
    }
    found.push({ name, async: isAsync, body });
  }
  return found;
}

/** Local names a file gives to imported guards: `import { checkRoleGrants as crg }`. */
function aliasesIn(source, names) {
  const out = [];
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (alias && names.has(orig)) out.push(alias);
    }
  }
  return out;
}

const ITERATES =
  /\.(?:forEach|map|filter|flatMap|some|every|find|reduce)\(\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*$|\b(?:setTimeout|setImmediate|queueMicrotask)\(\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)?\s*=>\s*$/;
const COLLECTS = /Promise\.(?:all|allSettled|any|race)\(/;

/** Every call of `names` in `source`: { line, text, ok } where ok means the promise is awaited or returned. */
function callsOf(source, names) {
  if (!names.length) return [];
  const calls = [];
  const lines = lf(source).split('\n');
  const re = new RegExp(`(?<![\\w$])(?:${names.join('|')})\\s*\\(`, 'g');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      let before = line.slice(0, m.index);
      if (!before.trim()) {
        const prev = lines.slice(0, i).findLast((l) => l.trim());
        before = `${prev ?? ''} ${before}`;
      }
      if (/\bfunction\s*\*?\s*$/.test(before)) continue; // the declaration itself
      let ok = /\b(?:await|return)\s*\(*\s*$/.test(before);
      if (!ok && /=>\s*$/.test(before)) ok = !ITERATES.test(before) || COLLECTS.test(before);
      calls.push({ line: i + 1, text: line.trim(), ok });
    }
  });
  return calls;
}

/**
 * Scan { path: source } and return the guards found and the calls that drop a promise.
 * @param {Record<string, string>} files
 * @param {string} guardFile  the path in `files` of roleGrants.js
 */
function scan(files, guardFile) {
  const names = new Set();
  for (const f of functionsOf(lf(files[guardFile] ?? ''))) {
    if (f.async || f.body.includes('checkNewGrants(')) names.add(f.name);
  }
  // A named async function in src/web that awaits or returns a guard, or throws a RoleGrantError
  // itself, hands the refusal on to its callers, so its callers are guards too.
  for (let grew = true; grew;) {
    grew = false;
    for (const [path, source] of Object.entries(files)) {
      if (!path.startsWith('web')) continue;
      for (const f of functionsOf(lf(source))) {
        if (!f.async || names.has(f.name)) continue;
        const refuses = f.body.includes('new RoleGrantError(');
        const hands = callsOf(f.body, [...names]).some((c) => c.ok);
        if (refuses || hands) {
          names.add(f.name);
          grew = true;
        }
      }
    }
  }
  const floating = [];
  for (const [path, source] of Object.entries(files)) {
    const here = [...names, ...aliasesIn(source, names)];
    for (const c of callsOf(source, here)) if (!c.ok) floating.push(`${path}:${c.line}: ${c.text}`);
  }
  return { names, floating };
}

function readTree(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'public' && entry !== 'vendor') readTree(path, base, out);
    } else if (path.endsWith('.js')) out[relative(base, path)] = readFileSync(path, 'utf8');
  }
  return out;
}

test('the scan finds the guards of roleGrants.js and the helpers built on them', () => {
  const { names } = scan(readTree(SRC), GUARD_FILE);
  for (const name of [
    'checkRoleGrants',
    'checkModuleGrants',
    'checkLevelRewardGrants',
    'checkNewGrants',
    'roleProblem',
    'shouldSaveBotMasters',
  ]) {
    assert.ok(names.has(name), `${name} is found as a guard`);
  }
  assert.ok(!names.has('grantRefusal'), 'a synchronous check is not a guard');
});

test('every call of a role-grant guard is awaited or returned', () => {
  const { floating } = scan(readTree(SRC), GUARD_FILE);
  assert.deepEqual(floating, [], `floating guard calls (add await or return):\n${floating.join('\n')}`);
});

const GUARDS = `export async function checkRoleGrants(ids) { return checkNewGrants([], ids); }
async function checkNewGrants() {}
`;
const floatingIn = (code, extra = {}) =>
  scan({ [GUARD_FILE]: GUARDS, 'web/routes/sample.js': code, ...extra }, GUARD_FILE).floating;
const handler = (statement) => `async function f() {\n  ${statement}\n}\n`;

test('the scan flags a guard called without await or return', () => {
  const flagged = (statement, why) => assert.equal(floatingIn(handler(statement)).length, 1, why);
  flagged('checkRoleGrants([1]);', 'a bare call');
  flagged('if (checkRoleGrants([1])) return;', 'a condition');
  flagged('const p = checkRoleGrants([1]);', 'a variable');
  flagged('await checkRoleGrants([1]); checkRoleGrants([2]);', 'the second call on a line');
  flagged('rg.checkRoleGrants([1]);', 'a member call');
  flagged('ids.forEach((id) => checkRoleGrants([id]));', 'forEach');
  flagged('ids.map((id) => checkRoleGrants([id]));', 'map without Promise.all');
  flagged('setTimeout(() => checkRoleGrants([1]), 5);', 'setTimeout');
  const aliased = `import { checkRoleGrants as crg } from '../middleware/roleGrants.js';\n${handler('crg([1]);')}`;
  assert.equal(floatingIn(aliased).length, 1, 'an import under another name');
});

test('the scan passes a guard that is awaited, returned or handed on', () => {
  assert.deepEqual(floatingIn(handler('await checkRoleGrants([1]);')), []);
  assert.deepEqual(floatingIn(handler('return checkRoleGrants([2]);')), []);
  assert.deepEqual(floatingIn(handler('await Promise.all(ids.map((id) => checkRoleGrants([id])));')), []);
  assert.deepEqual(floatingIn('setGuard((write) => checkRoleGrants(write.ids));\n'), []);
});

test('a helper that awaits a guard becomes a guard, and so do its callers', () => {
  const helper = `export async function roleProblem(x) {\n  await checkRoleGrants([x]);\n  return false;\n}\n`;
  const direct = `export async function refuse() {\n  throw new RoleGrantError('no');\n}\n`;
  const files = { 'web/lib/helper.js': `${helper}${direct}` };
  assert.equal(floatingIn(handler('if (roleProblem(1)) return;'), files).length, 1, 'the helper');
  assert.equal(floatingIn(handler('refuse();'), files).length, 1, 'a helper that throws RoleGrantError');
  assert.deepEqual(floatingIn(handler('if (await roleProblem(1)) return;'), files), []);
  const second = {
    'web/lib/second.js': `async function again(x) {\n  return roleProblem(x);\n}\n`,
    ...files,
  };
  assert.equal(floatingIn(handler('again(1);'), second).length, 1, 'a helper of the helper');
});
