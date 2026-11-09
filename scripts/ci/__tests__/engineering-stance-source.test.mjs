import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { walkSourceFiles } from '../engineering-stance-source.mjs';

test('stance source inventory admits every regular source without per-file stats', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'forgeax-stance-source-'));
  const original = fs.statSync;
  let calls = 0;
  try {
    for (let index = 0; index < 64; index++) fs.writeFileSync(join(root, `${index}.ts`), 'source');
    fs.mkdirSync(join(root, 'nested'));
    fs.writeFileSync(join(root, 'nested/module.mjs'), 'source');
    fs.writeFileSync(join(root, 'ignored.bin'), 'source');
    const excluded = join(root, 'gate.mjs');
    fs.writeFileSync(excluded, 'source');
    for (const directory of ['dist', 'node_modules', '.git']) {
      fs.mkdirSync(join(root, directory));
      fs.writeFileSync(join(root, directory, 'excluded.ts'), 'source');
    }
    fs.statSync = (...args) => {
      calls++;
      return original(...args);
    };
    syncBuiltinESMExports();
    const actual = [...walkSourceFiles(root, ['.ts', '.mjs'], excluded)]
      .map((path) => relative(root, path))
      .sort();
    assert.deepEqual(
      actual,
      [...Array.from({ length: 64 }, (_, index) => `${index}.ts`), 'nested/module.mjs'].sort(),
    );
    assert.equal(calls, 0, 'regular source inventory must not issue a stat for every entry');
  } finally {
    fs.statSync = original;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stance source inventory preserves file and directory symlinks and ignores broken links', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'forgeax-stance-links-'));
  try {
    fs.mkdirSync(join(root, 'actual'));
    fs.writeFileSync(join(root, 'actual/source.ts'), 'source');
    fs.symlinkSync(join(root, 'actual/source.ts'), join(root, 'alias.ts'));
    fs.symlinkSync(join(root, 'actual'), join(root, 'mirror'), 'dir');
    fs.symlinkSync(join(root, 'missing'), join(root, 'broken.ts'));
    fs.symlinkSync(join(root, 'actual'), join(root, 'node_modules'), 'dir');
    assert.deepEqual(
      [...walkSourceFiles(root, ['.ts'])].map((path) => relative(root, path)).sort(),
      ['actual/source.ts', 'alias.ts', 'mirror/source.ts'],
    );
    assert.deepEqual([...walkSourceFiles(join(root, 'missing'), ['.ts'])], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
