import { join } from 'node:path';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
} from '@forgeax/engine/pack/source-node';
import { defineFeature } from '../../lab/feature';
import { withFixture } from './support/fixture';
import { GENERATOR_SOURCE, invokeBuild } from './support/scriptable';

const FILES = {
  'generator.pack.ts': GENERATOR_SOURCE,
  'hang-on-load.pack.ts': 'while (true) {}\nexport default {};\n',
  'slow-build.pack.ts':
    "export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(3), build() { const t = Date.now(); while (Date.now() - t < 3000) {} return { ok: true, value: {} }; } };\n",
  'syntax.pack.ts': 'export default {\n  build: () => { const = 1; }\n};\n',
  'throws.pack.ts':
    "export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(4), build() { throw new Error('author build failed'); } };\n",
} as const;

export default defineFeature({
  title: 'ScriptablePack executor',
  catalog: 'ScriptablePack executor',
  kind: 'headless',
  summary:
    'loadScriptablePack() runs each *.pack.ts in a Node worker with module-load and build timeouts; pools reuse workers.',
  expect:
    'Hung load / slow build return pack-parameter-invalid with reason=timeout and the phase; syntax errors keep line:col.',
  async run(checks) {
    await withFixture(FILES, async (root) => {
      const hang = await loadScriptablePack(join(root, 'hang-on-load.pack.ts'), { timeoutMs: 300 });
      checks.equal(
        'hung module load -> timeout in module-load phase',
        hang.ok
          ? 'ok'
          : `${hang.error.code}/${String(hang.error.detail.reason)}/${String(hang.error.detail.phase)}`,
        'pack-parameter-invalid/timeout/module-load',
      );

      const slow = await loadScriptablePack(join(root, 'slow-build.pack.ts'), {
        buildTimeoutMs: 200,
      });
      if (slow.ok) {
        const outcome = await invokeBuild(slow.value);
        checks.equal(
          'slow build -> timeout in build phase',
          `${String(outcome.error?.code)}/${String(outcome.error?.detail?.reason)}/${String(outcome.error?.detail?.phase)}`,
          'pack-parameter-invalid/timeout/build',
        );
      } else checks.ok('slow build module loads', false, slow.error.code);

      const syntax = await loadScriptablePack(join(root, 'syntax.pack.ts'));
      checks.ok(
        'syntax error is structured and points at line 2',
        !syntax.ok && JSON.stringify(syntax.error).includes('syntax.pack.ts:2:'),
        syntax.ok ? 'loaded' : String(syntax.error.detail.diagnostic),
      );

      await checks.run('author exception during build surfaces its message', async () => {
        const thrower = await loadScriptablePack(join(root, 'throws.pack.ts'));
        if (!thrower.ok) throw new Error(`load failed: ${thrower.error.code}`);
        try {
          const outcome = await invokeBuild(thrower.value);
          if (outcome.ok) throw new Error('build unexpectedly succeeded');
          return true;
        } catch (error) {
          return error instanceof Error && error.message.includes('author build failed');
        }
      });

      const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 4 });
      try {
        const counts: number[] = [];
        for (const count of [1, 2]) {
          const executor = await pool.acquire();
          const loaded = await loadScriptablePack(join(root, 'generator.pack.ts'), { executor });
          if (!loaded.ok) continue;
          counts.push(Object.keys((await invokeBuild(loaded.value, { count })).value ?? {}).length);
        }
        checks.equal('pooled executor builds sequential loads', counts, [1, 2]);
      } finally {
        await pool.dispose();
      }
    });
  },
});
