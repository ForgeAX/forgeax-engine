// @perf-budget-skip: native host code-generation restriction and schema freshness subprocesses.
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('validates in a host that forbids runtime code generation', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--disallow-code-generation-from-strings',
      '--input-type=module',
      '-e',
      "for (const path of ['./src/schema-compiled.ts', './dist/schema.mjs']) { const module = await import(path); if (module.validateMeta({}) || module.validatePack({})) throw new Error('invalid input accepted'); }",
    ],
    { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
});

it('uses validators compiled from the current schema and generator', () => {
  const run = spawnSync(process.execPath, ['scripts/generate-validators.mjs', '--check'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
});
