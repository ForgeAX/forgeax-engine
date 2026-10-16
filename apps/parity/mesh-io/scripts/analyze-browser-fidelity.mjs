import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../artifacts/asset-format-fidelity/browser-scale');
const report = JSON.parse(await readFile(resolve(destination, 'raw.json'), 'utf8'));
const percentile = values => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return { count: ordered.length, p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1) };
};
const gpuInterval = observation => {
  const timings = observation.timings;
  if (timings?.status !== 'complete') return null;
  const frame = timings.frame;
  const passes = frame.passes.filter(pass => pass.status === 'measured');
  if (passes.length !== frame.executedPassCount || !passes.length) return null;
  return summarizeGpuPassTimingIntervals(frame.passes, frame.timestampPeriodNanoseconds)
    .unwrap().envelopeNanoseconds / 1e6;
};
const summaries = [];
for (const triangles of [12, 10000, 120000]) for (const layout of ['tight', 'strided']) {
  const trials = report.raw.filter(row => row.triangles === triangles && row.layout === layout);
  if (trials.length !== 16 || trials.some(row => row.result.completedFrames !== 60)) throw new Error('incomplete eight-block ABBA trial series');
  const frames = trials.flatMap(row => row.result.rawTimings.filter(frame => frame.frame >= 10));
  const gpu = frames.map(frame => gpuInterval(frame.observation));
  const metric = (row, name) => row.browserMetrics.find(metric => metric.name === name)?.value;
  summaries.push({ triangles, layout, loadMs: percentile(trials.map(row => row.result.loadMs)), totalTrialWallMs: percentile(trials.map(row => row.totalWallMs)), frameWallMs: percentile(frames.map(frame => frame.wallMs)), gpuEnvelopeMs: percentile(gpu.filter(value => value !== null)), missingGpuIntervals: gpu.filter(value => value === null).length, browserTaskMs: percentile(trials.map(row => metric(row, 'TaskDuration') * 1000)), networkEncodedBytes: percentile(trials.map(row => row.requests.reduce((sum, request) => sum + request.encodedDataLength, 0))), sampledBrowserPeakRssBytes: Math.max(...trials.flatMap(row => row.processSamples.map(sample => sample.rssBytes))), sampledHeapPeakBytes: Math.max(...trials.flatMap(row => row.processSamples.map(sample => sample.heapBytes ?? 0))), graphEngineAllocationPeakBytes: Math.max(...frames.map(frame => frame.resources.peakBytes)), physicalResidency: 'unknown; graph allocation and sampled browser-process RSS are distinct quantities', unknownAllocationSizes: Math.max(...frames.map(frame => frame.resources.unknownByteSizeCount)) });
}
await writeFile(resolve(destination, 'summary.json'), JSON.stringify({ protocol: report.protocol, cpu: report.cpu, browser: report.browser, gpuInterval: 'max measured pass end minus min measured pass begin; overlaps retained, no pass sum; incomplete native intervals excluded and counted', summaries }, null, 2) + '\n');
console.log(JSON.stringify(summaries, null, 2));
