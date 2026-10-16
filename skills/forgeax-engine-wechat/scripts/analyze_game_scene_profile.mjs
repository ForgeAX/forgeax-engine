#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeFrameReceipts } from './analyze_frame_receipts.mjs';

const { values } = parseArgs({ options: { run: { type: 'string' }, 'source-map': { type: 'string' }, 'trace-mapping': { type: 'string' } } });
assert.ok(values.run, '--run is required');
assert.equal(!!values['source-map'], !!values['trace-mapping'], 'source-map and trace-mapping must be supplied together');
const root = resolve(values.run), result = JSON.parse(await readFile(resolve(root, 'result.json')));
const statistics = values => {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length && sorted.every(Number.isFinite));
  return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
};
const expectedFrames = result.toolVerification ? 5 : 60;
const report = { scope: result.scope, success: result.success, toolVerification: !!result.toolVerification, driver: result.inspection?.driver, phases: {}, gpu: undefined, cpu: undefined };
for (const [name, { result: phase }] of Object.entries(result.phases)) {
  if (phase.mode !== 'ordinary-app-loop') continue;
  const frames = phase.frames;
  assert.equal(frames.length, expectedFrames);
  assert.ok(frames.every((frame, index) => frame.presentation === 'ready' && frame.deviceGeneration === frames[0].deviceGeneration && (!index || frame.frameId > frames[index - 1].frameId)));
  const intervals = frames.slice(1).map((frame, index) => frame.atMs - frames[index].atMs);
  assert.ok(intervals.every(interval => interval >= 0) && frames.at(-1).atMs > phase.startedAtMs);
  report.phases[name] = { completedFrames: expectedFrames, drainedFrames: phase.drained.length, ...(result.toolVerification ? { timingAcceptance: 'not-measured-tool-verification' } : { completedFps: 60000 / (frames.at(-1).atMs - phase.startedAtMs), interCompletionMs: statistics(intervals) }) };
  if (phase.receiptObservation) report.phases[name].receipts = analyzeFrameReceipts(phase, { toolVerification: result.toolVerification });
}
if (result.mode === 'receipts') {
  for (const [name, enabled] of [['control-before', false], ['receipt-trace', true], ['control-after', false]]) assert.equal(report.phases[name]?.receipts?.enabled, enabled, `Missing receipt control: ${name}`);
  report.receiptComparison = { scope: 'Sequential disabled/enabled/disabled windows in the same ordinary App. They reveal observation sensitivity, not exclusive hook overhead; the World continues to advance. Submission callbacks run after synchronous Renderer.draw, completion callbacks after its successful receipt. Neither timestamp is GPU duration or scanout.', ...(result.toolVerification ? { timingAcceptance: 'not-measured-tool-verification' } : { completedFps: Object.fromEntries(['control-before', 'receipt-trace', 'control-after'].map(name => [name, report.phases[name].completedFps])) }) };
}
const gpu = result.phases['gpu-query']?.result;
if (gpu?.status === 'complete') assert.ok(gpu.rows.length === expectedFrames && gpu.rows.every(row => Number.isSafeInteger(row.gpuNanoseconds) && row.gpuNanoseconds > 0));
if (gpu) report.gpu = { status: gpu.status, reason: gpu.reason ?? gpu.code, scope: gpu.capability?.scope, rhiTiming: gpu.rhiTiming, ...(gpu.status === 'complete' ? { gpuIntervalMs: statistics(gpu.rows.map(row => row.gpuNanoseconds / 1e6)), synchronousSubmissionCpuMs: statistics(gpu.rows.map(row => row.submissionCpuMs)) } : {}) };
if (result.phases['cpu-profile']) {
  const bytes = await readFile(resolve(root, 'profile.cpuprofile'));
  const profile = JSON.parse(bytes);
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  assert.ok(profile.samples.length && profile.timeDeltas.every(delta => Number.isFinite(delta) && delta >= 0));
  let map, mapping;
  if (values['source-map']) {
    const mapBytes = await readFile(resolve(values['source-map']));
    assert.equal(createHash('sha256').update(mapBytes).digest('hex'), result.sourceMap?.sha256, 'Source map identity does not match the measured bundle');
    mapping = await import(pathToFileURL(resolve(values['trace-mapping'])).href);
    map = new mapping.TraceMap(JSON.parse(mapBytes));
  }
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const self = new Map(), inclusive = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], ms = profile.timeDeltas[i] / 1000;
    assert.ok(nodes.has(id)); self.set(id, (self.get(id) ?? 0) + ms);
    const seen = new Set();
    for (let next = id; next !== undefined; next = parents.get(next)) {
      assert.ok(!seen.has(next), 'CPU profile contains an ancestry cycle'); seen.add(next);
      inclusive.set(next, (inclusive.get(next) ?? 0) + ms);
    }
  }
  const locations = new Map();
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    const original = map && frame.url.endsWith('/entry.js') && frame.lineNumber >= 0 && frame.columnNumber >= 0 ? mapping.originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber }) : null;
    locations.set(node.id, { symbol: frame.functionName, url: frame.url, generatedLine: frame.lineNumber + 1, ...(original?.source ? { source: original.source, line: original.line, name: original.name } : {}) });
  }
  const top = counts => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, ms]) => ({ ms, ...locations.get(id) }));
  const owners = new Map();
  for (const [id, ms] of self) {
    const location = locations.get(id);
    const owner = location.source?.match(/packages\/([^/]+)\//)?.[1] ?? (location.url.startsWith('wasm:') ? 'wasm-unmapped' : location.symbol?.startsWith('(') ? location.symbol : 'unmapped');
    owners.set(owner, (owners.get(owner) ?? 0) + ms);
  }
  report.cpu = { profileSha256: createHash('sha256').update(bytes).digest('hex'), sampledDurationMs: (profile.endTime - profile.startTime) / 1000, startupToFirstSampleMs: profile.timeDeltas[0] / 1000, sampleCount: profile.samples.length, sourceMapped: !!map, ownerSelfMs: Object.fromEntries([...owners].sort((a, b) => b[1] - a[1])), topSelf: top(self), topInclusive: top(inclusive), limitations: ['Inclusive costs overlap.', 'The original first sample delta includes profiler startup; it is retained, not calibrated frame work.', 'Program/idle samples are unclassified, not exclusive GPU execution.', 'Do not subtract GPU query intervals from CPU-profile/control wall time; these are separate scheduling modes.'] };
}
await writeFile(resolve(root, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, cpu: report.cpu && { ...report.cpu, topSelf: report.cpu.topSelf.slice(0, 12), topInclusive: report.cpu.topInclusive.slice(0, 8) } }, null, 2));
