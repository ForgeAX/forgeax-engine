import { createRequire } from 'node:module';

const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stateProjectionAliases } from './state-projection-aliases.mjs';

// Bundle both revisions with the same compiler. Vite's instrumented module
// getter cost is not representative of the production frame loop.
const root = resolve(process.argv[2] ?? '.');
const output = resolve(process.argv[3] ?? 'artifacts/state-projection');
const aliases = stateProjectionAliases(root);
mkdirSync(output, { recursive: true });
const executable = resolve(output, 'benchmark.mjs');
await build({
  stdin: {
    contents: readFileSync(
      resolve(import.meta.dirname, '../../packages/render/bench/state-projection.ts'),
      'utf8',
    ),
    resolveDir: resolve(root, 'packages/render/bench'),
    sourcefile: 'state-projection.ts',
    loader: 'ts',
  },
  alias: aliases,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: executable,
});
let aggregate;
for (const workload of [
  'small',
  'static',
  'sparse',
  'scattered',
  'dense',
  'fragmented',
  'history',
  'parent',
  'material',
]) {
  for (const mode of ['persistent', 'sequential']) {
    const resultPath = resolve(output, `${workload}-${mode}.json`);
    const result = spawnSync(process.execPath, [executable], {
      stdio: 'inherit',
      env: {
        ...process.env,
        FORGEAX_PROJECTION_WORKLOAD: workload,
        FORGEAX_PROJECTION_MODE: mode,
        FORGEAX_PROJECTION_BENCH_OUTPUT: resultPath,
      },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    const sample = JSON.parse(readFileSync(resultPath, 'utf8'));
    aggregate ??= { ...sample, reports: [] };
    aggregate.reports.push(...sample.reports);
    console.log(`[projection-bench] ${workload}/${mode} complete`);
  }
}
writeFileSync(resolve(output, 'result.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
