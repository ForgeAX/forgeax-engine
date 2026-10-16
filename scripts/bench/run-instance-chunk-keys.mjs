import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateProjectionAliases } from './state-projection-aliases.mjs';

const args = process.argv.slice(2);
let ref,
  output = resolve('artifacts/instance-chunk-keys');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline-ref') ref = args[++i];
  else if (args[i] === '--output') output = resolve(args[++i]);
  else
    throw Error(
      'usage: node --expose-gc scripts/bench/run-instance-chunk-keys.mjs --baseline-ref REF [--output DIRECTORY]',
    );
}
if (!ref) throw Error('--baseline-ref is required');
ref = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
  encoding: 'utf8',
}).trim();
mkdirSync(output, { recursive: true });
const paths = [
  'packages/render/src/instance-buffer-cache.ts',
  'packages/render/src/record/frame-snapshot.ts',
  'packages/render/src/record/main-pass-geometry.ts',
  'packages/render/src/record/fold-buckets.ts',
];
const baseline = Object.fromEntries(
  paths.map((path) => [
    resolve(path),
    execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' }),
  ]),
);
const candidate = Object.fromEntries(
  paths.map((path) => [resolve(path), readFileSync(path, 'utf8')]),
);
const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');
const modules = {};
const ownerLoads = {};
for (const version of ['baseline', 'candidate']) {
  ownerLoads[version] = 0;
  await build({
    entryPoints: ['packages/render/bench/instance-chunk-keys.ts'],
    alias: stateProjectionAliases(process.cwd()),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(output, `${version}.mjs`),
    plugins: [
      {
        name: 'owner-baseline',
        setup(b) {
          b.onLoad(
            {
              filter:
                /\/(?:instance-buffer-cache|frame-snapshot|main-pass-geometry|fold-buckets)\.ts$/,
            },
            (args) => {
              ownerLoads[version] += 1;
              return {
                contents: (version === 'baseline' ? baseline : candidate)[args.path],
                loader: 'ts',
                resolveDir: resolve(args.path, '..'),
              };
            },
          );
        },
      },
    ],
  });
  deepStrictEqual(ownerLoads[version], paths.length);
  modules[version] = await import(pathToFileURL(resolve(output, `${version}.mjs`)));
}
const samples = [];
for (const mode of modules.candidate.modes) {
  const cases = Object.fromEntries(
    Object.entries(modules).map(([v, m]) => [v, m.createCase(mode)]),
  );
  deepStrictEqual(cases.baseline.run(2), cases.candidate.run(2));
  for (const c of Object.values(cases)) c.run(10);
  for (let round = 0; round < 12; round++)
    for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const item = cases[version],
        iterations = mode === 'small-stable' ? 5000 : 20,
        before = item.inspect(),
        cpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null,
        wall = performance.now();
      const checksum = item.run(iterations),
        elapsed = cpu === null ? null : process.threadCpuUsage(cpu),
        after = item.inspect();
      samples.push({
        mode,
        round,
        version,
        iterations,
        cpuMs: elapsed === null ? null : (elapsed.user + elapsed.system) / 1000 / iterations,
        wallMs: (performance.now() - wall) / iterations,
        checksum,
        work: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
      });
    }
  const baselineWork = samples.filter((x) => x.mode === mode && x.version === 'baseline');
  const candidateWork = samples.filter((x) => x.mode === mode && x.version === 'candidate');
  deepStrictEqual(
    baselineWork.map((x) => [x.checksum, x.work]),
    candidateWork.map((x) => [x.checksum, x.work]),
  );
  for (const c of Object.values(cases)) c.dispose();
}
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = modules.candidate.modes.map((mode) => {
  const row = { mode };
  for (const v of ['baseline', 'candidate']) {
    const s = samples.filter((x) => x.mode === mode && x.version === v);
    row[v] = {
      cpuMs: s[0].cpuMs === null ? null : median(s.map((x) => x.cpuMs)),
      wallMs: median(s.map((x) => x.wallMs)),
      drawsPerIteration: s[0].work.draws / s[0].iterations,
    };
  }
  row.improvementPercent =
    row.baseline.cpuMs === null || row.candidate.cpuMs === null
      ? null
      : (100 * (row.baseline.cpuMs - row.candidate.cpuMs)) / row.baseline.cpuMs;
  return row;
});
const hash = (s) => createHash('sha256').update(s).digest('hex');
const result = {
  baselineRef: ref,
  baselineSHA: Object.fromEntries(
    Object.entries(baseline).map(([path, code]) => [path, hash(code)]),
  ),
  candidateSHA: Object.fromEntries(
    Object.entries(candidate).map(([path, code]) => [path, hash(code)]),
  ),
  ownerLoads,
  fixtureSHA: hash(readFileSync('packages/render/bench/instance-chunk-keys.ts')),
  lockfileSHA: hash(readFileSync('pnpm-lock.yaml')),
  runtime: process.version,
  scope:
    'Production chunk storage resolution and cleanup CPU A/B with synthetic RHI operations; 1 or 256 collections x 32 instances, 8 instances per chunk; no GPU/frame claim',
  samples,
  summary,
};
writeFileSync(resolve(output, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
