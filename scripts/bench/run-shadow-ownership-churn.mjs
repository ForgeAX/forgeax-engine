import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateProjectionAliases } from './state-projection-aliases.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
let ref,
  output = resolve('artifacts/shadow-ownership-churn');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline-ref') ref = args[++i];
  else if (args[i] === '--output') output = resolve(args[++i]);
  else
    throw Error(
      'usage: node scripts/bench/run-shadow-ownership-churn.mjs --baseline-ref REF [--output DIRECTORY]',
    );
}
if (!ref) throw Error('--baseline-ref is required');
mkdirSync(output, { recursive: true });
const ownerPath = 'packages/render/src/gpu-driven/shadow-ownership.ts';
const baselineSource = execFileSync('git', ['show', `${ref}:${ownerPath}`], { encoding: 'utf8' });
const sourceHash = (code) => createHash('sha256').update(code).digest('hex');
const { build } = createRequire(import.meta.resolve('tsup'))('esbuild');
for (const version of ['baseline', 'candidate']) {
  await build({
    entryPoints: ['packages/render/bench/shadow-ownership-churn.ts'],
    alias: stateProjectionAliases(root),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: resolve(output, `${version}.mjs`),
    plugins:
      version === 'baseline'
        ? [
            {
              name: 'frozen-baseline',
              setup(b) {
                b.onLoad({ filter: /\/gpu-driven\/shadow-ownership\.ts$/ }, () => ({
                  contents: baselineSource,
                  loader: 'ts',
                  resolveDir: resolve('packages/render/src/gpu-driven'),
                }));
              },
            },
          ]
        : [],
  });
}
const modules = {};
for (const version of ['baseline', 'candidate'])
  modules[version] = await import(pathToFileURL(resolve(output, `${version}.mjs`)));
const samples = [],
  counts = [];
const shape = (value) => ({
  members: value.membership,
  keys: [...value.drawKeys],
  entities: [...value.entityKeys],
});
for (const mode of modules.candidate.modes) {
  const cases = Object.fromEntries(
    Object.entries(modules).map(([v, m]) => [v, m.createCase(mode)]),
  );
  for (let i = 0; i < 4; i++)
    deepStrictEqual(shape(cases.baseline.run(1)), shape(cases.candidate.run(1)));
  for (const item of Object.values(cases)) item.run(1000);
  for (let round = 0; round < 12; round++)
    for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const item = cases[version],
        before = item.inspect(),
        iterations = 500,
        clock = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null,
        wall = performance.now();
      item.run(iterations);
      const elapsed = clock === null ? null : process.threadCpuUsage(clock),
        after = item.inspect();
      samples.push({
        mode,
        round,
        version,
        iterations,
        cpuMsPerCall: elapsed === null ? null : (elapsed.user + elapsed.system) / 1000 / iterations,
        wallMsPerCall: (performance.now() - wall) / iterations,
      });
      counts.push({
        mode,
        round,
        version,
        iterations,
        builds: after.builds - before.builds,
        rowBuilds: after.rowBuilds === undefined ? null : after.rowBuilds - before.rowBuilds,
      });
    }
}
const median = (v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
const summary = modules.candidate.modes.map((mode) => {
  const row = { mode };
  for (const version of ['baseline', 'candidate']) {
    const selected = samples.filter((x) => x.mode === mode && x.version === version);
    row[version] = {
      cpuMs: selected[0].cpuMsPerCall === null ? null : median(selected.map((x) => x.cpuMsPerCall)),
      wallMs: median(selected.map((x) => x.wallMsPerCall)),
    };
  }
  row.improvementPercent =
    row.baseline.cpuMs === null || row.candidate.cpuMs === null
      ? null
      : (100 * (row.baseline.cpuMs - row.candidate.cpuMs)) / row.baseline.cpuMs;
  return row;
});
const result = {
  baselineOwnerRef: ref,
  baselineOwnerSha256: sourceHash(baselineSource),
  candidateOwnerSha256: sourceHash(readFileSync(ownerPath, 'utf8')),
  runtime: process.version,
  scope:
    'Production ShadowCasterOwnershipProjection owner-file A/B with the same current dependency closure and compiler; fixed prebuilt inputs, no GPU or whole-frame claim',
  entities: 775,
  passesPerEntity: 2,
  pairs: 12,
  samples,
  counts,
  summary,
};
writeFileSync(resolve(output, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(summary);
