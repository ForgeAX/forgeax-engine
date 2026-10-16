import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateProjectionAliases } from './state-projection-aliases.mjs';

const args = process.argv.slice(2);
let ref;
let output = resolve('artifacts/feature-rollback-references');
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--baseline-ref') ref = args[++index];
  else if (args[index] === '--output') output = resolve(args[++index]);
  else throw Error('usage: run-feature-rollback-references.mjs --baseline-ref REF [--output DIR]');
}
if (!ref) throw Error('--baseline-ref is required');
ref = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
  encoding: 'utf8',
}).trim();
mkdirSync(output, { recursive: true });
const path = 'packages/render/src/features/prepared-gpu-work.ts';
const source = {
  baseline: execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' }),
  candidate: readFileSync(path, 'utf8'),
};
const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');
const modules = {};
const coverage = {};
for (const version of ['baseline', 'candidate']) {
  coverage[version] = 0;
  await build({
    entryPoints: ['packages/render/bench/feature-rollback-references.bench.ts'],
    alias: stateProjectionAliases(process.cwd()),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(output, `${version}.mjs`),
    plugins: [
      {
        name: 'frozen-feature-owner',
        setup(builder) {
          builder.onLoad({ filter: /\/features\/prepared-gpu-work\.ts$/ }, (input) => {
            if (input.path !== resolve(path)) throw Error('Unexpected owner');
            coverage[version]++;
            return { contents: source[version], loader: 'ts' };
          });
        },
      },
    ],
  });
  if (coverage[version] !== 1) throw Error('Owner load coverage is incomplete');
  modules[version] = await import(pathToFileURL(resolve(output, `${version}.mjs`)));
}
const samples = [];
for (const mode of modules.candidate.modes) {
  const cases = {
    baseline: await modules.baseline.createCase(mode),
    candidate: await modules.candidate.createCase(mode),
  };
  for (const item of Object.values(cases)) item.run(200);
  for (let round = 0; round < 12; round++) {
    for (const version of round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const item = cases[version];
      const iterations = mode === 'replace' ? 50 : 500;
      const before = item.inspect();
      const cpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
      const wall = performance.now();
      const checksum = item.run(iterations);
      const elapsed = cpu === null ? null : process.threadCpuUsage(cpu);
      const after = item.inspect();
      samples.push({
        mode,
        round,
        version,
        iterations,
        checksum,
        cpuMs: elapsed === null ? null : (elapsed.user + elapsed.system) / 1000 / iterations,
        wallMs: (performance.now() - wall) / iterations,
        work: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
      });
    }
  }
  deepStrictEqual(
    samples
      .filter((x) => x.mode === mode && x.version === 'baseline')
      .map((x) => [x.checksum, x.work]),
    samples
      .filter((x) => x.mode === mode && x.version === 'candidate')
      .map((x) => [x.checksum, x.work]),
  );
  for (const item of Object.values(cases)) item.dispose();
}
const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
const summary = modules.candidate.modes.map((mode) => {
  const row = { mode };
  for (const version of ['baseline', 'candidate']) {
    const rows = samples.filter((x) => x.mode === mode && x.version === version);
    row[version] = {
      cpuMs: rows[0].cpuMs === null ? null : median(rows.map((x) => x.cpuMs)),
      wallMs: median(rows.map((x) => x.wallMs)),
    };
  }
  row.improvementPercent =
    row.baseline.cpuMs === null || row.candidate.cpuMs === null
      ? null
      : (100 * (row.baseline.cpuMs - row.candidate.cpuMs)) / row.baseline.cpuMs;
  return row;
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const result = {
  baselineRef: ref,
  candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ownerSHA256: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, hash(value)])),
  fixtureSHA256: hash(readFileSync('packages/render/bench/feature-rollback-references.bench.ts')),
  lockfileSHA256: hash(readFileSync('pnpm-lock.yaml')),
  runtime: process.version,
  coverage,
  scope:
    'Actual feature GPU prepare/commit/abort owner with Null RHI resources and completion release; owner-file A/B, not GPU or whole-Game FPS.',
  samples,
  summary,
};
writeFileSync(resolve(output, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary));
