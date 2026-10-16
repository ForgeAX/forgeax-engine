import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('Dawn unit discovery excludes its native source cache and retains ordinary tests', () => {
  const repository = resolve(import.meta.dirname, '../../../..');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgeax-dawn-unit-discovery-')));
  const config = join(repository, 'packages/dawn-node/vitest.config.ts');
  const retained = ['src/carrier.unit.test.ts', 'src/.native-build/ordinary.unit.test.ts'];
  const excluded = [
    '.native-build/input/node-webgpu/third_party/cts/upstream.spec.ts',
    'node_modules/dependency/vendor.spec.ts',
    'dist/generated.spec.ts',
    'scripts/__tests__/bootstrap.test.mjs',
    'scripts/__tests__/native-output.test.mjs',
  ];
  try {
    for (const file of [...retained, ...excluded]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'export {};\n');
    }
    // Use Vitest's actual discovery without executing tests or acquiring a GPU.
    // Before the carrier owns a config, its package project uses Vitest defaults.
    const program = `import { createVitest } from 'vitest/node';
      let context;
      try {
        context = await createVitest('test', {
          root: ${JSON.stringify(root)},
          config: ${JSON.stringify(existsSync(config) ? config : false)},
          watch: false,
        });
        const files = (await context.globTestSpecifications()).map(item => item.moduleId);
        console.log('DISCOVERY=' + JSON.stringify(files));
      } finally { await context?.close(); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split('\n').find((line) => line.startsWith('DISCOVERY='));
    expect(line, result.stdout).toBeDefined();
    if (line === undefined) throw new Error('Vitest did not return discovery output');
    const discovered = JSON.parse(line.slice('DISCOVERY='.length)) as string[];
    expect(discovered.map((file) => realpathSync.native(file)).sort()).toEqual(
      retained.map((file) => realpathSync.native(join(root, file))).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
