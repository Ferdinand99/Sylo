import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionSecret, SESSION_SECRET_FILE } from '../src/lib/sessionSecret.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sylo-secret-'));

test('SESSION_SECRET from the environment wins over a file and writes nothing', () => {
  const dir = tmp();
  writeFileSync(join(dir, SESSION_SECRET_FILE), 'a'.repeat(64));
  const r = resolveSessionSecret({ envValue: '  from-env  ', dataDir: dir });
  assert.deepEqual(r, { secret: 'from-env', source: 'env' });
  assert.equal(readFileSync(join(dir, SESSION_SECRET_FILE), 'utf8'), 'a'.repeat(64));

  const empty = tmp();
  resolveSessionSecret({ envValue: 'x', dataDir: empty });
  assert.throws(() => statSync(join(empty, SESSION_SECRET_FILE)), { code: 'ENOENT' });
});

test('a generated secret is stored and reused on the next call', () => {
  const dir = tmp();
  const first = resolveSessionSecret({ envValue: undefined, dataDir: dir });
  assert.equal(first.source, 'file');
  assert.match(first.secret, /^[0-9a-f]{64}$/);
  const second = resolveSessionSecret({ envValue: null, dataDir: dir });
  assert.deepEqual(second, first);
  assert.equal(readFileSync(join(dir, SESSION_SECRET_FILE), 'utf8').trim(), first.secret);
});

test('the data folder is created when it does not exist yet', () => {
  const dir = join(tmp(), 'nested', 'data');
  const r = resolveSessionSecret({ dataDir: dir });
  assert.equal(r.source, 'file');
  assert.equal(readFileSync(join(dir, SESSION_SECRET_FILE), 'utf8').trim(), r.secret);
});

test('the new file is mode 0600', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  resolveSessionSecret({ dataDir: dir });
  assert.equal(statSync(join(dir, SESSION_SECRET_FILE)).mode & 0o777, 0o600);
});

test('an empty or short file is replaced, with a warning that never holds the secret', () => {
  for (const content of ['', '  \n', 'abc123']) {
    const dir = tmp();
    writeFileSync(join(dir, SESSION_SECRET_FILE), content);
    const warnings = [];
    const r = resolveSessionSecret({ dataDir: dir, warn: (m) => warnings.push(m) });
    assert.equal(r.source, 'file');
    assert.match(r.secret, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(dir, SESSION_SECRET_FILE), 'utf8').trim(), r.secret);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(r.secret));
    if (content.trim()) assert.ok(!warnings[0].includes(content.trim()));
  }
});

test('a folder that cannot be written gives generated-ephemeral', () => {
  const parent = tmp();
  // A plain file where the data folder should be: mkdir and write both fail on every platform.
  const blocker = join(parent, 'data');
  writeFileSync(blocker, 'not a folder');
  const warnings = [];
  const r = resolveSessionSecret({ dataDir: blocker, warn: (m) => warnings.push(m) });
  assert.equal(r.source, 'generated-ephemeral');
  assert.match(r.secret, /^[0-9a-f]{64}$/);
  // Linux also warns about the failed read (ENOTDIR); Windows only about the write.
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((m) => !m.includes(r.secret)));
});

test(
  'a read-only folder gives generated-ephemeral',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const dir = tmp();
    chmodSync(dir, 0o500);
    try {
      assert.equal(resolveSessionSecret({ dataDir: dir }).source, 'generated-ephemeral');
    } finally {
      chmodSync(dir, 0o700);
    }
  }
);

test('without a data folder the secret is ephemeral and differs per call', () => {
  const a = resolveSessionSecret({});
  const b = resolveSessionSecret({ dataDir: null });
  assert.equal(a.source, 'generated-ephemeral');
  assert.notEqual(a.secret, b.secret);
});
