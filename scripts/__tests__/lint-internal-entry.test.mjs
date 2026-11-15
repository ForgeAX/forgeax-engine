import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../lint-internal.mjs', import.meta.url));

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
