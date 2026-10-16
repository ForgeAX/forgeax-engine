import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const gate = join(root, 'scripts/check-shader-no-compiler-import.mjs');

async function fixture(source) {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-material-compiler-free-'));
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'nested/entry.ts'), source);
  return directory;
}

test('compiler-free gate accepts a runtime-only shader source tree', async () => {
  const directory = await fixture("import { ok } from '@forgeax/engine-types';\nvoid ok;\n");
  const result = await run(process.execPath, [gate, directory]);
  assert.match(result.stdout, /AC-06 \(c\) OK/);
});

test('compiler-free gate rejects a compiler import reintroduced into runtime code', async () => {
  const directory = await fixture(
    "import { compileShader } from '@forgeax/engine-shader-compiler';\nvoid compileShader;\n",
  );
  await assert.rejects(run(process.execPath, [gate, directory]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /engine-shader-compiler/);
    return true;
  });
});
