// Repeated crossover comparison of two independently built Engine checkouts.
// Run under the same qualified Dawn environment as standard-deferred.mjs.
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    output: { type: 'string', default: 'artifacts/standard-deferred-comparison' },
    pairs: { type: 'string', default: '4' },
    frames: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '60' },
    path: { type: 'string', default: 'deferred' },
  },
});
if (!values.baseline || !values.candidate)
  throw new Error('--baseline and --candidate must name independently built Engine checkouts');
const pairs = Number(values.pairs);
if (!Number.isSafeInteger(pairs) || pairs < 2 || pairs % 2 !== 0)
  throw new Error('--pairs must be an even positive integer (at least 2) for balanced AB/BA order');
if (!['forward', 'deferred'].includes(values.path))
  throw new Error('--path must be forward or deferred');
const roots = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
if (roots.baseline === roots.candidate) throw new Error('cohorts must use different checkouts');
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const script = fileURLToPath(new URL('./standard-deferred.mjs', import.meta.url));
const runs = [];
const identities = new Map();
let workload;
for (let pair = 0; pair < pairs; pair += 1) {
  const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  for (const cohort of order) {
    const label = `${values.path}-${cohort}-${pair}`;
    console.log(`Measuring ${label} (${order.join(' -> ')})`);
    const log = openSync(resolve(output, `${label}.log`), 'w');
    let processResult;
    try {
      processResult = spawnSync(
        process.execPath,
        [
          script,
          label,
          '--frames',
          values.frames,
          '--warmup',
          values.warmup,
          '--path',
          values.path,
        ],
        { cwd: roots[cohort], env: process.env, stdio: ['ignore', log, log] },
      );
    } finally {
      closeSync(log);
    }
    if (processResult.error || processResult.status !== 0)
      throw new Error(`${label} failed; inspect ${output}/${label}.log`, {
        cause: processResult.error,
      });
    const source = resolve(roots[cohort], `artifacts/standard-deferred/${label}.json`);
    const report = JSON.parse(readFileSync(source, 'utf8'));
    copyFileSync(source, resolve(output, `${label}.json`));
    copyFileSync(source.replace(/\.json$/, '.rgba16f'), resolve(output, `${label}.rgba16f`));
    if (report.profiled || report.timings.length !== 2 || !report.gpuDriven.submitted)
      throw new Error(`${label} did not execute the unprofiled GPU-driven workload`);
    const identity = JSON.stringify([
      report.sourceCommit,
      report.sourceDirty,
      report.renderRuntimeSha256,
    ]);
    if (identities.has(cohort) && identities.get(cohort) !== identity)
      throw new Error(`${cohort} changed between measured runs`);
    identities.set(cohort, identity);
    const comparisonWorkload = JSON.stringify([
      report.shaderManifestSha256,
      report.backend,
      report.renderPath,
      report.host,
      report.width,
      report.height,
      report.receivers,
      report.trianglesPerReceiver,
      report.settings,
      report.warmupFrames,
      report.timings.map((timing) => timing.frames),
      report.passes,
      report.gpuDriven.channels,
      report.pixelSha256,
    ]);
    if (workload !== undefined && workload !== comparisonWorkload)
      throw new Error(
        `${label} changed the workload, shader inputs, environment, or GPU admission`,
      );
    workload = comparisonWorkload;
    runs.push({ cohort, pair, label, report });
    console.log(
      JSON.stringify({ label, timings: report.timings.map(({ samples, ...timing }) => timing) }),
    );
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = [false, true].map((moving) => {
  const observations = Array.from({ length: pairs }, (_, pair) => {
    const timing = (cohort) =>
      runs
        .find((run) => run.cohort === cohort && run.pair === pair)
        .report.timings.find((timing) => timing.moving === moving);
    const baseline = timing('baseline');
    const candidate = timing('candidate');
    return {
      pair,
      baselineCpuMedianMs: baseline.cpuSubmitMs.median,
      candidateCpuMedianMs: candidate.cpuSubmitMs.median,
      cpuMedianReductionPercent:
        (1 - candidate.cpuSubmitMs.median / baseline.cpuSubmitMs.median) * 100,
      baselineCpuP95Ms: baseline.cpuSubmitMs.p95,
      candidateCpuP95Ms: candidate.cpuSubmitMs.p95,
      baselineCompletedFps: baseline.completedFps,
      candidateCompletedFps: candidate.completedFps,
      completedFpsIncreasePercent: (candidate.completedFps / baseline.completedFps - 1) * 100,
    };
  });
  return {
    moving,
    observations,
    pairedMedianCpuReductionPercent: median(
      observations.map((item) => item.cpuMedianReductionPercent),
    ),
    pairedCpuReductionRangePercent: [
      Math.min(...observations.map((item) => item.cpuMedianReductionPercent)),
      Math.max(...observations.map((item) => item.cpuMedianReductionPercent)),
    ],
    pairedMedianCompletedFpsIncreasePercent: median(
      observations.map((item) => item.completedFpsIncreasePercent),
    ),
  };
});
const report = {
  benchmark: 'standard-render-crossover',
  renderPath: values.path,
  pairs,
  ordering: 'alternating AB / BA; separate processes with identical per-run warmup',
  interpretation:
    'CPU submission includes JS and native driver work. Completed FPS awaits one receipt per frame. Software GPU results do not predict hardware GPU FPS.',
  cohorts: Object.fromEntries(identities),
  runs: runs.map(({ report, ...run }) => run),
  summary,
};
writeFileSync(resolve(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
