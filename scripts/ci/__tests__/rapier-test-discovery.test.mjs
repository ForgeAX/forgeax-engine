import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const owner = join(root, 'packages/physics-rapier3d');

test('Rapier Vitest discovery retains every tracked owner test after source hydration', () => {
  const tracked = spawnSync('git', ['ls-files', 'packages/physics-rapier3d'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const expected = tracked.stdout
    .split('\n')
    .filter((file) => file.endsWith('.test.ts'))
    .sort();
  assert.ok(expected.length > 0, 'the package must retain real owner tests');

  const buildRoot = join(owner, '.wasm-build');
  mkdirSync(buildRoot, { recursive: true });
  const fixture = mkdtempSync(join(buildRoot, 'discovery-regression-'));
  const vendorTest = join(fixture, 'rapier/typescript/rapier-compat/tests/World3d.test.ts');
  mkdirSync(dirname(vendorTest), { recursive: true });
  writeFileSync(vendorTest, "import '../builds/3d-deterministic/pkg';\n");
  try {
    for (const cwd of [root, owner]) {
      const discovery = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { createVitest } from 'vitest/node';
        import { relative, sep } from 'node:path';
        const ctx = await createVitest('test', {
          config: ${JSON.stringify(join(owner, 'vitest.config.ts'))},
          run: true, watch: false,
        });
        try {
          const files = (await Promise.all(ctx.projects.map(project => project.globTestFiles())))
            .flatMap(({ testFiles }) => testFiles)
            .map(file => relative(${JSON.stringify(root)}, file).split(sep).join('/')).sort();
          process.stdout.write(JSON.stringify(files));
        } finally { await ctx.close(); }
      `,
        ],
        { cwd, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(discovery.status, 0, discovery.stderr);
      assert.deepEqual(JSON.parse(discovery.stdout), expected, `all owner tests from ${cwd}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
