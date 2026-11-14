// The role-grant guards (src/web/middleware/roleGrants.js) refuse by returning a rejected promise.
// A call whose promise is neither awaited nor returned never refuses anything, and its rejection
// escapes as an unhandled rejection. ESLint here has no type information, so
// `@typescript-eslint/no-floating-promises` is not an option; this scan fails the build instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const GUARD_FILE = join(SRC, 'web', 'middleware', 'roleGrants.js');

// Async helpers that wrap a guard, or that report a refusal through their result.
const WRAPPERS = ['roleProblem', 'shouldSaveBotMasters'];

/** The exported guards of roleGrants.js: every exported function that is async or hands back checkNewGrants. */
function exportedGuards(text) {
  const source = text.replaceAll('\r\n', '\n');
  const names = [];
  const re = /export (async )?function (\w+)\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const body = source.slice(m.index, source.indexOf('\n}\n', m.index));
    if (m[1] || body.includes('checkNewGrants(')) names.push(m[2]);
  }
  return names;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'public' && entry !== 'vendor') yield* sourceFiles(path);
    } else if (path.endsWith('.js')) yield path;
  }
}

/** Calls of `names` whose promise is dropped: anything that is not directly awaited or returned. */
function floatingCalls(file, names) {
  const found = [];
  const call = new RegExp(`(?<![\\w.])(${names.join('|')})\\s*\\(`);
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const hit = call.exec(line);
      if (!hit) return;
      const before = line.slice(0, hit.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment
      if (
        /\b(async\s+)?function\s*\*?\s*$/.test(before) ||
        /\bexport\s+(async\s+)?function\s+$/.test(before)
      ) {
        return; // the declaration itself
      }
      if (/\b(await|return)\s+(\(\s*)?$/.test(before)) return;
      if (/=>\s*$/.test(before)) return; // `() => guard(...)`: the arrow hands the promise back
      found.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  return found;
}

test('the scan knows every guard exported by roleGrants.js', () => {
  const guards = exportedGuards(readFileSync(GUARD_FILE, 'utf8'));
  for (const name of ['checkRoleGrants', 'checkModuleGrants', 'checkLevelRewardGrants']) {
    assert.ok(guards.includes(name), `${name} is found as a guard`);
  }
  assert.ok(!guards.includes('grantRefusal'), 'a synchronous check is not a guard');
});

test('every call of a role-grant guard is awaited or returned', () => {
  const names = [...exportedGuards(readFileSync(GUARD_FILE, 'utf8')), ...WRAPPERS];
  const floating = [...sourceFiles(SRC)].flatMap((file) => floatingCalls(file, names));
  assert.deepEqual(floating, [], `floating guard calls (add await or return):\n${floating.join('\n')}`);
});

test('the scan flags a guard called without await', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rg-scan-'));
  const scan = (statement) => {
    const file = join(tmp, 'sample.js');
    writeFileSync(file, `async function f() {\n  ${statement}\n}\n`);
    return floatingCalls(file, ['checkRoleGrants', 'roleProblem']);
  };
  try {
    assert.equal(scan('checkRoleGrants([1]);').length, 1, 'a bare call');
    assert.equal(scan('if (roleProblem(a, b)) return;').length, 1, 'a condition');
    assert.equal(scan('const p = checkRoleGrants([1]);').length, 1, 'a variable');
    assert.deepEqual(scan('await checkRoleGrants([1]);'), []);
    assert.deepEqual(scan('return checkRoleGrants([2]);'), []);
    assert.deepEqual(scan('if (await roleProblem(a, b)) return;'), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
