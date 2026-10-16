#!/usr/bin/env node
// Motion-cost matrix: runs the built Dawn smoke once per workload query and
// prints one p50 table. Diagnostic only, not a CI gate. Locally run it under
// the lavapipe wrapper, e.g.
//   with-lavapipe pnpm --filter @forgeax/perf-shadow-stress motion-matrix
// Options: --only='<case>;<case>'  --timed=<frames> (PERF_TIMED_FRAMES, default 30)
//          --warmup=<frames> (warmupFrames query, default 0; >= 150 samples the
//          settled shadow-caster classes instead of the start-up promotion)

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outputRoot = resolve(appRoot, 'artifacts', 'motion-matrix');

const QUIET = 'movers=0&characters=0';
const CASES = [
  ['static/0/0', `camera=static&${QUIET}`],
  ['static/128/4', 'camera=static&movers=128&characters=4'],
  ['orbit/0/0', `camera=orbit&${QUIET}`],
  ['orbit/128/4', 'camera=orbit&movers=128&characters=4'],
  ['orbit/1024/16', 'camera=orbit&movers=1024&characters=16'],
  ['orbit/128/4/statics=20000', 'camera=orbit&movers=128&characters=4&statics=20000'],
  ['orbit/0/0/statics=20000', `camera=orbit&${QUIET}&statics=20000`],
  ['static/128/0', 'camera=static&movers=128&characters=0'],
  ['static/0/4', 'camera=static&movers=0&characters=4'],
  ['occasional=512', `camera=static&${QUIET}&occasional=512`],
  ['occasional=512/period=150', `camera=static&${QUIET}&occasional=512&occasionalPeriod=150`],
  ['spawnStorm=64', `camera=static&${QUIET}&spawnStorm=64`],
  ['lodOscillate=1', `camera=static&${QUIET}&lodOscillate=1`],
  ['static/128/4/set', 'camera=static&movers=128&characters=4&moverWrite=set'],
  ['static/4096/0/active=1', 'camera=static&movers=4096&activeMovers=1&characters=0'],
  ['static/4096/0/active=1/set', 'camera=static&movers=4096&activeMovers=1&characters=0&moverWrite=set'],
  ['orbit/transparent=64/taa', `camera=orbit&${QUIET}&transparent=64&taa=1`],
  ['static/transparent=64/taa', `camera=static&${QUIET}&transparent=64&taa=1`],
  ['static/128/4/mobilityStatic', 'camera=static&movers=128&characters=4&mobilityStatic=1'],
  ['orbit/128/4/statics=20000/mobilityStatic', 'camera=orbit&movers=128&characters=4&statics=20000&mobilityStatic=1'],
];

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const body = arg.replace(/^--/u, '');
    const split = body.indexOf('=');
    return split < 0 ? [body, ''] : [body.slice(0, split), body.slice(split + 1)];
  }),
);
const only = args.only === undefined ? undefined : new Set(args.only.split(';'));
const timedFrames = args.timed ?? process.env.PERF_TIMED_FRAMES ?? '30';
const warmupFrames = Number(args.warmup ?? 0);
const selected = CASES.filter(([name]) => only === undefined || only.has(name));
if (selected.length === 0) {
  console.error(`[motion-matrix] no case matches --only; known: ${CASES.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
mkdirSync(outputRoot, { recursive: true });

const PREPARE = 'render/record>record/gpu-driven-prepare';
const PREPARE_CHILD = 'render/record/gpu-driven-prepare>record/gpu-driven-prepare/';
const ms = (micros) => (micros === null || micros === undefined ? '-' : (micros / 1000).toFixed(1));
const num = (value) => (value === null || value === undefined ? '-' : String(value));
const mean = (value) => (value === null || value === undefined ? '-' : value.toFixed(2));
const kib = (bytes) => (bytes === null || bytes === undefined ? '-' : (bytes / 1024).toFixed(0));

const rows = [];
let failures = 0;
for (const [name, query] of selected) {
  const slug = name.replace(/[^a-z0-9]+/giu, '-');
  const output = resolve(outputRoot, `${slug}.json`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [resolve(here, 'smoke-dawn.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      PERF_QUERY: `?${query}${warmupFrames > 0 ? `&warmupFrames=${warmupFrames}` : ''}`,
      PERF_TIMED_FRAMES: timedFrames,
      PERF_DAWN_OUTPUT: output,
      PERF_DAWN_SCREENSHOT: `${output}.png`,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (run.status !== 0) {
    failures += 1;
    const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
    console.error(`[motion-matrix] ${name} FAIL (${seconds}s): ${tail}`);
    rows.push({ name, failed: true });
    continue;
  }
  const result = JSON.parse(readFileSync(output, 'utf8'));
  const phases = result.cpuPhasesMicros;
  const gpu = result.summary.gpuDriven;
  const draw = phases['app/frame-total>renderer-draw']?.p50;
  const prepare = phases[PREPARE]?.p50;
  console.error(`[motion-matrix] ${name} ok (${seconds}s)`);
  rows.push({
    name,
    cpu: ms(result.summary.cpuFrameMicros.p50),
    synced: ms(result.summary.syncedFrameMicros.p50),
    draw: ms(draw),
    record95: ms(phases['render/renderer-draw>record']?.p95),
    prepare: ms(prepare),
    share: prepare === undefined || !draw ? '-' : `${Math.round((prepare / draw) * 100)}%`,
    // The plan phase exists only on prepared-plan cache misses; show its sample count.
    plan: `${ms(phases[`${PREPARE_CHILD}plan`]?.p50)} (${phases[`${PREPARE_CHILD}plan`]?.count ?? 0})`,
    filter: ms(phases[`${PREPARE_CHILD}filter`]?.p50),
    instances: ms(phases[`${PREPARE_CHILD}instances`]?.p50),
    shadowViews: ms(phases[`${PREPARE_CHILD}shadow-views`]?.p50),
    rebuildFrames: `${gpu.planRebuildFrames}/${gpu.frames}`,
    rebuildCandidates: num(gpu.planRebuildCandidates.p50),
    lodChanges: `${num(gpu.lodSelectionChanges.p50)}/${num(gpu.lodSelectionChanges.max)}`,
    staticMisses: mean(result.summary.shadowStaticMissCount?.mean),
    staticPartial: mean(result.summary.shadowStaticPartialCount?.mean),
    misses: mean(result.summary.shadowMissCount.mean),
    flips: `${mean(gpu.shadowCasterFlips?.mean)}/${num(gpu.shadowCasterFlips?.max)}`,
    pending: num(gpu.shadowCasterPendingPromotions?.p50),
    // Counters absent from an older engine build print '-'.
    preparedBatches: `${num(gpu.preparedBatchBuilds?.p50)}/${num(gpu.preparedBatchBuilds?.max)}`,
    filteredBatches: `${num(gpu.filteredBatchBuilds?.p50)}/${num(gpu.filteredBatchBuilds?.max)}`,
    filteredPlans: `${num(gpu.filteredPlanBuilds?.p50)}/${num(gpu.filteredPlanBuilds?.max)}`,
    rows: num(gpu.projectionRowsWritten?.p50),
    rowKiB: kib(gpu.projectionBytesWritten?.p50),
    candidateKiB: kib(gpu.candidateUploadBytes.p50),
    sceneKiB: kib(gpu.sceneTableUploadBytes.p50),
    ...Object.fromEntries(
      Object.entries(result.summary.frameCacheHitRates).map(([cache, { rate }]) => [
        `cache:${cache}`,
        rate === null ? '-' : `${(rate * 100).toFixed(1)}%`,
      ]),
    ),
  });
}

const COLUMNS = [
  ['case', 'name'],
  ['CPU frame p50', 'cpu'],
  ['synced p50', 'synced'],
  ['renderer-draw p50', 'draw'],
  ['record p95', 'record95'],
  ['prepare p50', 'prepare'],
  ['prepare/draw', 'share'],
  ['plan p50 (n)', 'plan'],
  ['filter p50', 'filter'],
  ['instances p50', 'instances'],
  ['shadow-views p50', 'shadowViews'],
  ['plan rebuild frames', 'rebuildFrames'],
  ['rebuild candidates p50', 'rebuildCandidates'],
  ['LOD changes p50/max', 'lodChanges'],
  ['static redraws/frame', 'staticMisses'],
  ['partial static redraws/frame', 'staticPartial'],
  ['view redraws/frame', 'misses'],
  ['caster flips mean/max', 'flips'],
  ['pending promotions p50', 'pending'],
  ['prepared batch builds p50/max', 'preparedBatches'],
  ['filtered batch builds p50/max', 'filteredBatches'],
  ['filtered plan builds p50/max', 'filteredPlans'],
  ['projection rows p50', 'rows'],
  ['projection KiB p50', 'rowKiB'],
  ['candidate upload KiB p50', 'candidateKiB'],
  ['scene upload KiB p50', 'sceneKiB'],
  ['visibility hit', 'cache:visibilityProjection'],
  ['residency hit', 'cache:residencyValidation'],
  ['temporal hit', 'cache:temporalSnapshots'],
  ['transparent sort hit', 'cache:transparentSort'],
  ['bundle hit', 'cache:renderBundles'],
];
console.log(
  `Times in ms; queries run through scripts/smoke-dawn.mjs with PERF_TIMED_FRAMES=${timedFrames}, warmupFrames=${warmupFrames}.\n`,
);
console.log(`| ${COLUMNS.map(([title]) => title).join(' | ')} |`);
console.log(`|${COLUMNS.map(() => '---').join('|')}|`);
for (const row of rows) {
  console.log(`| ${COLUMNS.map(([, key]) => (row.failed && key !== 'name' ? 'FAIL' : row[key])).join(' | ')} |`);
}
process.exit(failures === 0 ? 0 : 1);
