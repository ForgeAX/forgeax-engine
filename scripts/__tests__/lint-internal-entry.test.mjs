import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../lint-internal.mjs', import.meta.url));

test('lint-internal scans real sources beneath TypeScript-named screenshot directories', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-internal-screenshot-')));
  try {
    mkdirSync(join(root, 'scripts'));
    const sources = join(root, 'packages/example/src');
    const snapshots = join(sources, '__screenshots__/scene.browser.test.ts');
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(root, 'scripts/lint-internal.mjs'), readFileSync(gate));
    writeFileSync(join(root, 'tsconfig.base.json'), '{"compilerOptions":{"target":"ESNext"}}');
    symlinkSync(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    writeFileSync(join(sources, 'subject.ts'), 'class Subject { private _bad = 1; }');
    writeFileSync(join(snapshots, 'nested.ts'), 'class Nested { private _nested = 2; }');
    writeFileSync(join(snapshots, 'image.png'), 'captured pixels');
    const child = spawnSync(process.execPath, [join(root, 'scripts/lint-internal.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /subject\.ts:1 _bad:.*R-internal-B/);
    assert.match(child.stderr, /nested\.ts:1 _nested:.*R-internal-B/);
    assert.match(child.stderr, /2 errors/);
    assert.doesNotMatch(child.stderr, /EISDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lint-internal recognizes a native CLI path without running on import', () => {
  const source = readFileSync(gate, 'utf8');
  const guard = source.slice(source.lastIndexOf('\nif ('));
  assert.ok(guard.startsWith('\nif ('), 'the script retains its direct-entry guard');
  const fixture = `
    import { resolve } from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    let invoked = 0;
    const main = () => { invoked += 1; };
    process.argv[1] = ${JSON.stringify(resolve(gate))};
    const direct = new Function('process', 'resolve', 'fileURLToPath', 'main',
      ${JSON.stringify(guard.replaceAll('import.meta.url', 'process.__moduleUrl'))});
    process.__moduleUrl = pathToFileURL(process.argv[1]).href;
    direct(process, resolve, fileURLToPath, main);
    if (invoked !== 1) throw new Error('native direct invocation skipped main');
    process.argv[1] = resolve('different-entry.mjs');
    direct(process, resolve, fileURLToPath, main);
    if (invoked !== 1) throw new Error('import unexpectedly invoked main');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
});
