import { isDeepStrictEqual, parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { allocationTraceDistribution } from './allocation_trace.mjs';
import { heapSnapshotCensus } from './heap_snapshot_census.mjs';
import { loadJson, requireFact, runCli } from './lib.mjs';

const REALMS = ['forgeax-engine', 'forgeax-render'];

function realm(rows, name) {
  const found = rows?.filter((row) => row.name === name);
  requireFact(found?.length === 1, 'Require exactly one realm: ' + name);
  return found[0];
}

function positive(value, label) {
  requireFact(Number.isFinite(value) && value > 0, 'Require positive ' + label);
  return value;
}

function completed(value, label) {
  requireFact(Number.isSafeInteger(value), 'Require integer ' + label);
  return positive(value, label);
}

function bounds(values, label) {
  requireFact(Array.isArray(values) && values.length === 2, 'Require ' + label);
  positive(values[0], label); positive(values[1], label);
  requireFact(values[0] <= values[1], 'Unordered ' + label);
  return values;
}

/** Authenticate the exact count/snapshot artifact named by its producer. */
export async function verifiedAllocationArtifact(reference, base = '.') {
  requireFact(typeof reference?.path === 'string', 'Missing artifact path');
  const loaded = await loadJson(resolve(base, reference.path));
  requireFact(loaded.sha256 === reference.sha256, 'Artifact digest mismatch: ' + reference.path);
  return loaded.value;
}

/** One row set for the count and byte distributions, including count-heavy small rows. */
export function allocationUnion(trace, limit = 5) {
  requireFact(Number.isSafeInteger(limit) && limit > 0, 'Require positive row limit');
  const all = allocationTraceDistribution(trace, Number.MAX_SAFE_INTEGER);
  const rows = all.rows.slice(0, -1);
  const selected = new Set([...rows.slice(0, limit),
    ...rows.toSorted((a, b) => b.count - a.count).slice(0, limit)]);
  const kept = rows.filter((row) => selected.has(row));
  const rest = rows.filter((row) => !selected.has(row));
  const other = { name: '(other)', url: '', line: 0, column: 0,
    count: rest.reduce((n, row) => n + row.count, 0),
    bytes: rest.reduce((n, row) => n + row.bytes, 0) };
  other.countFraction = all.count === 0 ? 0 : other.count / all.count;
  other.byteFraction = all.bytes === 0 ? 0 : other.bytes / all.bytes;
  kept.push(other);
  requireFact(kept.reduce((n, row) => n + row.count, 0) === all.count &&
    kept.reduce((n, row) => n + row.bytes, 0) === all.bytes, 'Distribution does not conserve totals');
  return { count: all.count, bytes: all.bytes, rows: kept };
}

function ordinaryWindows(moving) {
  return moving.ordinary.map((window) => {
    const seconds = positive((window.after.now - window.before.now) / 1000, 'ordinary seconds');
    return { index: window.index, seconds,
      readyFrames: completed(window.after.ready - window.before.ready, 'ordinary ready frames'),
      readyFps: (window.after.ready - window.before.ready) / seconds };
  });
}

function sampledWindows(moving) {
  return moving.windows.map((window) => ({ index: window.index,
    realms: REALMS.map((name) => {
      const row = realm(window.realms, name);
      const seconds = bounds(row.secondsBounds, 'sampled seconds');
      const frames = bounds(row.readyFrameBounds, 'sampled ready frames');
      requireFact(Number.isFinite(row.sampledBytes) && row.sampledBytes >= 0, 'Invalid sampled bytes');
      return { name, sampledBytes: row.sampledBytes, sampledRecords: row.sampledRecords,
        secondsBounds: seconds, readyFrameBounds: frames,
        bytesPerSecondBounds: [row.sampledBytes / seconds[1], row.sampledBytes / seconds[0]],
        bytesPerReadyFrameBounds: [row.sampledBytes / frames[1], row.sampledBytes / frames[0]] };
    }) }));
}

function completedFrames(counts) {
  return {
    'forgeax-engine': completed(counts.traceAfter.execution.frame.completed -
      counts.traceBefore.execution.frame.completed, 'World completions'),
    'forgeax-render': completed(counts.traceAfter.execution.render.completedFrame -
      counts.traceBefore.execution.render.completedFrame, 'Render completions'),
  };
}

async function countPopulations(counts, readArtifact) {
  const frames = completedFrames(counts), rows = [];
  for (const name of REALMS) {
    const captured = realm(counts.realms, name);
    const distribution = allocationUnion(await readArtifact(captured.counts, 'counts'));
    requireFact(distribution.count === captured.counts.count &&
      distribution.bytes === captured.counts.bytes, 'Count receipt does not match artifact');
    rows.push({ name, ...distribution, completedFrames: frames[name],
      eventsPerFrame: distribution.count / frames[name],
      bytesPerFrame: distribution.bytes / frames[name] });
  }
  return { method: counts.method, realms: rows };
}

async function retainedPopulations(retained, readArtifact) {
  const before = retained.drained.execution.frame, after = retained.afterSnapshots.execution.frame;
  requireFact(before.inFlight === 0 && after.inFlight === 0 &&
    before.completed === after.completed, 'Retained census must remain paused and drained');
  requireFact(retained.final.execution.frame.completed > after.completed, 'Missing resumed completions');
  const rows = [];
  for (const name of REALMS) {
    const captured = realm(retained.realms, name);
    const census = heapSnapshotCensus(await readArtifact(captured.snapshot, 'retained'));
    rows.push({ name, usedJsHeapBytes: captured.before.usedSize, count: census.count,
      selfBytes: census.selfBytes, byType: census.byType,
      objectNodes: census.byType.find((row) => row.key === 'object')?.count ?? 0,
      closureNodes: census.byType.find((row) => row.key === 'closure')?.count ?? 0 });
  }
  return { pausedCompletedFrames: before.completed,
    resumedCompletedFrames: retained.final.execution.frame.completed, realms: rows };
}

function admittedWorkload(reports) {
  if (reports.every((report) => report.workload === undefined)) return undefined;
  const first = reports[0], identities = [];
  for (const report of reports) {
    requireFact(report.workload !== undefined && report.finalWorkload !== undefined,
      'Missing producer admission or final stability receipt');
    requireFact(isDeepStrictEqual(report.workload, report.finalWorkload),
      'Producer publication changed during capture');
    requireFact(typeof report.motionSha256 === 'string' && report.motionSha256.length > 0 &&
      report.motionSha256 === first.motionSha256, 'Motion cohort mismatch');
    requireFact(typeof report.workloadHelperSha256 === 'string' && report.workloadHelperSha256.length > 0 &&
      report.workloadHelperSha256 === first.workloadHelperSha256, 'Workload admission cohort mismatch');
    const { generation: _generation, entity: _entity, ...identity } = report.workload;
    identities.push(identity);
  }
  requireFact(identities.every((identity) => isDeepStrictEqual(identity, identities[0])),
    'Producer parameters or geometry differ between captures');
  return { identity: identities[0], captures: reports.map((report) => ({
    kind: report.kind, generation: report.workload.generation, entity: report.workload.entity,
  })), qualification: 'Actual producer success and stable publication/parameters/geometry. Bounds and vertex count are not a mesh-byte digest; frozen source/assets remain a separate requirement.' };
}

/** Capture receipts are distinct populations; realm order never supplies an identity. */
export async function summarizeAllocationCaptures(moving, counts, retained, readArtifact) {
  for (const report of [moving, counts, retained])
    requireFact(report?.status === 'complete', 'Require complete capture reports');
  requireFact(moving.ordinary?.length > 0 && moving.windows?.length > 0, 'Missing moving windows');
  requireFact(typeof readArtifact === 'function', 'Require authenticated artifact reader');
  return {
    kind: 'game3d-allocation-round',
    workload: admittedWorkload([moving, counts, retained]),
    qualification: 'Ordinary throughput has heap profiling off but retains the real-input driver, inspection and frame observer. Sampled byte rates are estimates under heap profiling, not exact uninstrumented rates. Cumulative V8 events and forced-GC census are separate intrusive populations. Events include VM/later-collected/control work, not logical application objects or ordinary objects/s. Snapshot self bytes are not dominator retention; native backing may already be counted.',
    ordinary: ordinaryWindows(moving), sampled: sampledWindows(moving),
    counts: await countPopulations(counts, readArtifact),
    retained: await retainedPopulations(retained, readArtifact),
  };
}

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => [
  '| ' + headers.map(cell).join(' | ') + ' |',
  '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...rows.map((row) => '| ' + row.map(cell).join(' | ') + ' |'),
].join('\n');

/** Every displayed count/byte table uses the same conserved population. */
export function allocationRoundMarkdown(summary) {
  const lines = ['# game-3d allocation populations', '', summary.qualification, '',
    '## Ordinary throughput', '',
    table(['Window', 'Seconds', 'Ready frames', 'Ready FPS'], summary.ordinary.map((row) =>
      [row.index, row.seconds.toFixed(3), row.readyFrames, row.readyFps.toFixed(3)])),
    '', '## Sampled bytes', ''];
  for (const name of REALMS) {
    lines.push(name, '', table(['Window', 'B/s bounds', 'B/ready frame bounds', 'Sampling records'],
      summary.sampled.map((row) => { const r = realm(row.realms, name); return [row.index,
        r.bytesPerSecondBounds.map((v) => v.toFixed(1)).join('..'),
        r.bytesPerReadyFrameBounds.map((v) => v.toFixed(1)).join('..'), r.sampledRecords]; })), '');
  }
  lines.push('## Cumulative V8 allocation events', '', summary.counts.method, '',
    table(['Realm', 'Completed frames', 'Events', 'Heap B', 'Events/frame', 'B/frame'],
      summary.counts.realms.map((r) => [r.name, r.completedFrames, r.count, r.bytes,
        r.eventsPerFrame.toFixed(2), r.bytesPerFrame.toFixed(2)])), '');
  for (const r of summary.counts.realms)
    lines.push(r.name, '', table(['Function', 'Events', 'Count share', 'Heap B', 'Byte share'],
      r.rows.map((row) => [row.name || '(unnamed)', row.count,
        (100 * row.countFraction).toFixed(2) + '%', row.bytes,
        (100 * row.byteFraction).toFixed(2) + '%'])), '');
  lines.push('## Forced-GC census', '',
    'Paused completions: ' + summary.retained.pausedCompletedFrames +
    '; resumed: ' + summary.retained.resumedCompletedFrames + '.', '',
    table(['Realm', 'Object nodes', 'Closure nodes', 'Used JS heap B', 'All nodes', 'Self B'],
      summary.retained.realms.map((r) => [r.name, r.objectNodes, r.closureNodes,
        r.usedJsHeapBytes, r.count, r.selfBytes])), '');
  for (const r of summary.retained.realms)
    lines.push(r.name, '', table(['Type', 'Nodes', 'Count share', 'Self B', 'Byte share'],
      r.byType.map((row) => [row.key, row.count, (100 * row.count / r.count).toFixed(2) + '%',
        row.selfBytes, (100 * row.selfBytes / r.selfBytes).toFixed(2) + '%'])), '');
  if (summary.workload)
    lines.push('## Workload admission', '', summary.workload.qualification, '',
      JSON.stringify(summary.workload.identity), '',
      table(['Capture', 'Publication generation', 'Bound entity'],
        summary.workload.captures.map((row) => [row.kind, row.generation, row.entity])), '');
  return lines.join('\n');
}

runCli(import.meta.url, async () => {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, moving: { type: 'string' }, counts: { type: 'string' },
    retained: { type: 'string' }, output: { type: 'string' }, markdown: { type: 'string' },
  } });
  if (values.help) {
    console.log('node summarize_game3d_allocations.mjs --moving report.json --counts report.json --retained report.json [--output summary.json] [--markdown summary.md]');
    return;
  }
  for (const name of ['moving', 'counts', 'retained'])
    requireFact(typeof values[name] === 'string', 'Missing --' + name);
  const reports = {};
  for (const name of ['moving', 'counts', 'retained']) reports[name] = await loadJson(values[name]);
  const summary = await summarizeAllocationCaptures(reports.moving.value, reports.counts.value,
    reports.retained.value, (reference, kind) =>
      verifiedAllocationArtifact(reference, dirname(resolve(values[kind]))));
  summary.inputs = Object.fromEntries(Object.entries(reports).map(([name, r]) =>
    [name, { path: resolve(values[name]), sha256: r.sha256 }]));
  if (values.output) await writeFile(values.output, JSON.stringify(summary, null, 2) + '\n');
  else console.log(JSON.stringify(summary, null, 2));
  if (values.markdown) await writeFile(values.markdown, allocationRoundMarkdown(summary));
});
