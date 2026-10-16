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
  output = resolve('artifacts/shadow-claim-lookup');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline-ref') ref = args[++i];
  else if (args[i] === '--output') output = resolve(args[++i]);
  else
    throw Error(
      'usage: node --expose-gc scripts/bench/run-shadow-claim-lookup.mjs --baseline-ref REF [--output DIRECTORY]',
    );
}
if (!ref) throw Error('--baseline-ref is required');
ref = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
  encoding: 'utf8',
}).trim();
mkdirSync(output, { recursive: true });
const path = 'packages/render/src/gpu-driven/shadow-claims.ts';
const baseline = execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
const candidate = readFileSync(path, 'utf8');
const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');
const modules = {};
const ownerLoads = {};
for (const version of ['baseline', 'candidate']) {
  ownerLoads[version] = 0;
  await build({
    entryPoints: ['packages/render/bench/shadow-claim-lookup.ts'],
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
          b.onLoad({ filter: /\/gpu-driven\/shadow-claims\.ts$/ }, () => {
            ownerLoads[version] += 1;
            return {
              contents: version === 'baseline' ? baseline : candidate,
              loader: 'ts',
              resolveDir: resolve('packages/render/src/gpu-driven'),
            };
          });
        },
      },
    ],
  });
  deepStrictEqual(ownerLoads[version], 1);
  modules[version] = await import(pathToFileURL(resolve(output, `${version}.mjs`)));
}
const samples = [];
for (const mode of modules.candidate.modes) {
  const cases = Object.fromEntries(
    Object.entries(modules).map(([v, m]) => [v, m.createCase(mode)]),
  );
  deepStrictEqual(cases.baseline.shape(), cases.candidate.shape());
  deepStrictEqual(cases.baseline.run(2), cases.candidate.run(2));
  for (const c of Object.values(cases)) c.run(200);
  for (let round = 0; round < 12; round++)
    for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const item = cases[version],
        iterations = mode === 'stable' ? 5000 : 100,
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
        calls: after.calls - before.calls,
        builds: after.builds - before.builds,
        refreshed: after.refreshed - before.refreshed,
      });
    }
}
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = modules.candidate.modes.map((mode) => {
  const row = { mode };
  for (const v of ['baseline', 'candidate']) {
    const s = samples.filter((x) => x.mode === mode && x.version === v);
    row[v] = {
      cpuMs: s[0].cpuMs === null ? null : median(s.map((x) => x.cpuMs)),
      wallMs: median(s.map((x) => x.wallMs)),
      callsPerIteration: s[0].calls / s[0].iterations,
    };
  }
  row.improvementPercent =
    row.baseline.cpuMs === null || row.candidate.cpuMs === null
      ? null
      : (100 * (row.baseline.cpuMs - row.candidate.cpuMs)) / row.baseline.cpuMs;
  return row;
});
const retention = [];
if (typeof globalThis.gc === 'function') {
  for (let round = 0; round < 4; round++)
    for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const fixture = modules[version].createCase('stable');
      globalThis.gc();
      const before = process.memoryUsage().heapUsed,
        count = 24;
      const tables = fixture.retainTables(count);
      globalThis.gc();
      const retainedBytes = process.memoryUsage().heapUsed - before;
      retention.push({
        round,
        version,
        count,
        retainedBytes,
        bytesPerTable: retainedBytes / count,
        keysPerTable: tables[0].casterKeys.size,
      });
      // Release before the next retained population, preserving the read above.
      tables.length = 0;
      globalThis.gc();
    }
}
const retentionSummary =
  retention.length === 0
    ? null
    : Object.fromEntries(
        ['baseline', 'candidate'].map((version) => [
          version,
          median(retention.filter((x) => x.version === version).map((x) => x.bytesPerTable)),
        ]),
      );
const hash = (s) => createHash('sha256').update(s).digest('hex');
const result = {
  baselineRef: ref,
  baselineSHA: hash(baseline),
  candidateSHA: hash(candidate),
  ownerLoads,
  fixtureSHA: hash(readFileSync('packages/render/bench/shadow-claim-lookup.ts')),
  lockfileSHA: hash(readFileSync('pnpm-lock.yaml')),
  runtime: process.version,
  scope:
    'ShadowClaimTable owner-file CPU A/B; same source dependency closure; 775 entities x 2 draws, 24 x 64 or 1 x 1024; immutable membership; no GPU/frame claim',
  samples,
  summary,
  retention,
  retentionSummary,
};
writeFileSync(resolve(output, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ summary, retentionSummary }, null, 2));
