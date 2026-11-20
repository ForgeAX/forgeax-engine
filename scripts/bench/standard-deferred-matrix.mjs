// A complete ABBA block holds the physical device while its four processes run.
// Preparation, GPU queue time, serial frame latency, and GPU timing stay distinct.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withLocalGpuLease } from '../ci/local-gpu-lease.mjs';
import { runBrowserCommand } from '../ci/run-browser-gate-with-retry.mjs';
import { scenarios } from './standard-deferred-workloads.mjs';

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'all' },
    output: { type: 'string' },
    'shader-publication': { type: 'string' },
    'gpu-timing': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
});
const selected = values.scenario === 'all' ? scenarios : [values.scenario];
if (selected.some((scenario) => !scenarios.includes(scenario)))
  throw new Error(`scenario must be all or one of ${scenarios.join(', ')}`);

const warmup = 60;
const frames = 180;
const ordering = ['full', 'default', 'default', 'full'];
const benchmark = fileURLToPath(new URL('./standard-deferred.mjs', import.meta.url));
const plan = selected.map((scenario) => ({
  scenario,
  control: [{ path: 'forward', format: 'full', label: `${scenario}-forward` }],
  rounds: Array.from({ length: 4 }, (_, round) =>
    ordering.map((format, index) => ({
      path: 'deferred',
      format,
      label: `${scenario}-${round + 1}-${index + 1}-${format}`,
    })),
  ),
}));
const mode = values['gpu-timing'] ? 'gpu-timing' : 'unprofiled';
if (values['dry-run']) {
  console.log(JSON.stringify({ mode, warmup, frames, plan }, null, 2));
  process.exit(0);
}
if (values.output === undefined || values['shader-publication'] === undefined)
  throw new Error('Supply a fresh --output directory and a verified --shader-publication');
const output = resolve(values.output);
const publication = resolve(values['shader-publication']);
const manifest = await readFile(publication);
const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, 'plan.json'),
  JSON.stringify(
    { mode, warmup, frames, manifestSha256, manifestBytes: manifest.length, plan },
    null,
    2,
  ),
  { flag: 'wx' },
);

const revision = (report) =>
  JSON.stringify([report.sourceCommit, report.sourceDirty, report.renderRuntimeSha256]);
const workload = (report) =>
  JSON.stringify([
    report.scenario,
    report.domain,
    report.width,
    report.height,
    report.receivers,
    report.trianglesPerReceiver,
    report.settings,
    report.host,
    report.backend,
    report.adapter,
  ]);
const ledger = [];
const saveLedger = async () =>
  writeFile(resolve(output, 'runs.json'), JSON.stringify(ledger, null, 2));
const timed = Boolean(values['gpu-timing']);
const { halfFloat } = await import('../../packages/math/dist/index.mjs');
let sourceIdentity;

async function run(scenario, item) {
  const entry = { ...item, scenario, state: 'running' };
  ledger.push(entry);
  await saveLedger();
  const logPath = resolve(output, `${item.label}.log`);
  const args = [
    benchmark,
    item.label,
    '--scenario',
    scenario,
    '--path',
    item.path,
    '--gbuffer-format',
    item.format,
    '--warmup',
    String(warmup),
    '--frames',
    String(frames),
    '--output',
    output,
    '--shader-publication',
    publication,
    '--projected-receiver',
    ...(timed ? ['--gpu-timing'] : []),
  ];
  try {
    const native = await runBrowserCommand([process.execPath, ...args], {
      timeoutMs: 1_200_000,
      label: item.label,
    });
    await writeFile(logPath, native.output ?? '', { flag: 'wx' });
    if (native.status !== 0) throw new Error(`Exited with ${native.status}`);
    const report = JSON.parse(await readFile(resolve(output, `${item.label}.json`), 'utf8'));
    sourceIdentity ??= revision(report);
    if (
      report.sourceDirty ||
      revision(report) !== sourceIdentity ||
      report.shaderManifestSha256 !== manifestSha256 ||
      report.renderPath !== item.path ||
      report.gbufferFormat !== item.format ||
      report.scenario !== scenario ||
      report.profiled ||
      report.gpuTimed !== timed ||
      report.warmupFrames !== warmup ||
      report.timings.length !== 2 ||
      report.timings.some((row) => row.frames !== frames)
    )
      throw new Error('The run does not match the committed build and requested workload');
    entry.state = 'complete';
    return report;
  } catch (error) {
    entry.state = 'failed';
    entry.error = error.message;
    console.error(`${item.label} failed. See ${logPath}`);
    return undefined;
  } finally {
    await saveLedger();
  }
}

function nearestRank(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

async function metrics(report, moving) {
  const measure = report.timings.find((item) => item.moving === moving);
  if (measure === undefined) throw new Error('Missing motion cohort');
  if (!timed)
    return {
      cpuP50: measure.cpuSubmitMs.median,
      frameP50: measure.completionIntervalMs.median,
      frameP95: measure.completionIntervalMs.p95,
      frameP99: measure.completionIntervalMs.p99,
    };
  const raw = JSON.parse(await readFile(resolve(output, `${report.label}.gpu.json`), 'utf8'));
  const windows = raw.filter((item) => item.moving === moving);
  if (windows.length !== frames || windows.some(({ unionMs }) => !Number.isFinite(unionMs)))
    throw new Error('Incomplete GPU timing window');
  const samples = windows.map(({ unionMs }) => unionMs);
  return { unionP50: nearestRank(samples, 0.5), unionP95: nearestRank(samples, 0.95) };
}

async function pixelDelta(left, right) {
  const { format, width, height, bytesPerRow } = left.pixelMetadata;
  const peer = right.pixelMetadata;
  const rgba16f = format === 'rgba16float';
  const display8 = /^(rgba|bgra)8unorm(?:-srgb)?$/.test(format);
  if (
    (!rgba16f && !display8) ||
    format !== peer.format ||
    width !== peer.width ||
    height !== peer.height ||
    bytesPerRow !== peer.bytesPerRow ||
    width <= 0 ||
    height <= 0
  )
    throw new Error('Image metadata is incompatible');
  const [a, b] = await Promise.all(
    [left, right].map((row) => readFile(resolve(output, row.pixelFile))),
  );
  const step = rgba16f ? 2 : 1;
  if (a.length !== b.length || a.length < (height - 1) * bytesPerRow + width * step * 4)
    throw new Error('Image readback is incomplete');
  const value = rgba16f
    ? (bytes, offset) => halfFloat.f16ToF32(bytes.readUInt16LE(offset))
    : (bytes, offset) => bytes[offset] / 255;
  let total = 0;
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const offset = y * bytesPerRow + (x * 4 + channel) * step;
        const delta = Math.abs(value(a, offset) - value(b, offset));
        if (!Number.isFinite(delta)) throw new Error('Image contains non-finite radiance');
        total += delta;
        max = Math.max(max, delta);
      }
    }
  }
  return { left: left.label, right: right.label, max, mean: total / (width * height * 3) };
}

async function summarizeBlock(round, reports) {
  if (reports.some((report) => report === undefined))
    return { round, state: 'incomplete', error: 'A benchmark process failed' };
  if (new Set(reports.map(workload)).size !== 1)
    return { round, state: 'incomplete', error: 'The measured workloads differ' };
  try {
    const windows = [];
    for (const moving of [false, true]) {
      const readings = await Promise.all(reports.map((report) => metrics(report, moving)));
      const sums = Object.fromEntries(
        Object.keys(readings[0]).map((key) => {
          const full = (readings[0][key] + readings[3][key]) / 2;
          const compact = (readings[1][key] + readings[2][key]) / 2;
          return [
            key,
            {
              full,
              default: compact,
              reductionPercent: full > 0 ? 100 * (1 - compact / full) : null,
            },
          ];
        }),
      );
      windows.push({ moving, samples: readings, metrics: sums });
    }
    return {
      round,
      state: 'complete',
      windows,
      pixelDeltas: await Promise.all([
        pixelDelta(reports[0], reports[3]),
        pixelDelta(reports[1], reports[2]),
        pixelDelta(reports[0], reports[1]),
        pixelDelta(reports[3], reports[2]),
      ]),
      pixels: reports.map(({ label, pixelFile, pixelSha256, pixelMetadata }) => ({
        label,
        pixelFile,
        pixelSha256,
        pixelMetadata,
      })),
    };
  } catch (error) {
    return { round, state: 'incomplete', error: error.message };
  }
}

const groups = [];
const saveMatrix = async () =>
  writeFile(
    resolve(output, 'matrix.json'),
    JSON.stringify({ mode, sourceIdentity, groups }, null, 2),
  );
for (const { scenario, control, rounds } of plan) {
  const { report: forward } = await withLocalGpuLease(
    async () => ({ report: await run(scenario, control[0]) }),
    { label: `${scenario} Forward` },
  );
  const group = { scenario, forward: forward?.label ?? null, rounds: [] };
  groups.push(group);
  await saveMatrix();
  for (const [round, block] of rounds.entries()) {
    const { reports } = await withLocalGpuLease(
      async () => {
        const reports = [];
        for (const item of block) reports.push(await run(scenario, item));
        return { reports };
      },
      { label: `${scenario} ABBA ${round + 1}` },
    );
    group.rounds.push(await summarizeBlock(round + 1, reports));
    await saveMatrix();
  }
}
if (
  ledger.some(({ state }) => state !== 'complete') ||
  groups.some(({ rounds }) => rounds.some(({ state }) => state !== 'complete'))
)
  process.exitCode = 1;
