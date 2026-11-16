import { requireFact } from './lib.mjs';
import {
  cpuTimelineCallTrees,
  cpuTimelineFunctionRows,
  cpuTimelineIntervalSummary,
} from './cpu_timeline_view.mjs';

/** A borrowed selection of one normalized capture; never mutate or rebuild its samples/slices. */
export function selectCpuTimeline(model, { target, fromMs, toMs, completionIndex } = {}) {
  requireFact(
    model?.kind === 'sampled-cpu-timeline' && model.schemaVersion === 1,
    'Require a normalized CPU timeline',
  );
  requireFact(
    Array.isArray(model.tracks) && Array.isArray(model.frameIntervals),
    'Invalid CPU timeline arrays',
  );
  const tracks =
    target === undefined
      ? model.tracks
      : model.tracks.filter((t) => t.name === target || t.target.targetId === target);
  requireFact(tracks.length > 0, 'Unknown or empty CPU target selection');
  let frame;
  if (completionIndex !== undefined) {
    requireFact(
      Number.isSafeInteger(completionIndex) && completionIndex >= 0,
      'Invalid completion index',
    );
    frame = model.frameIntervals[completionIndex];
    requireFact(frame !== undefined, 'Unknown completion index');
  }
  const startMs = frame?.startMs ?? model.startMs,
    endMs = frame?.endMs ?? model.endMs;
  fromMs ??= startMs;
  toMs ??= endMs;
  requireFact(
    Number.isFinite(fromMs) &&
      Number.isFinite(toMs) &&
      fromMs >= startMs &&
      toMs <= endMs &&
      fromMs < toMs,
    'Require an increasing range within the selected capture/completion interval',
  );
  return {
    model: { ...model, tracks },
    range: { fromMs, toMs },
    completion: frame ? completionRow(frame, completionIndex, fromMs, toMs) : null,
  };
}

function completionRow(frame, completionIndex, fromMs, toMs) {
  return {
    completionIndex,
    previous: frame.previous,
    current: frame.current,
    startMs: frame.startMs,
    endMs: frame.endMs,
    completionGapMs: frame.completionGapMs,
    coverage: frame.coverage,
    missingIntermediateReceipts: frame.missingIntermediateReceipts,
    overlapMs: Math.max(0, Math.min(toMs, frame.endMs) - Math.max(fromMs, frame.startMs)),
  };
}

// Half-open interval overlap; indices refer to normalized samples, not original CDP sample positions.
function sampleBounds(samples, startMs, endMs) {
  const lower = (predicate) => {
    let lo = 0,
      hi = samples.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (predicate(samples[mid])) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  return {
    fromIndex: lower((s) => s.endMs > startMs),
    toIndexExclusive: lower((s) => s.startMs >= endMs),
  };
}

function selectedCoverage(track, range) {
  const bounds = sampleBounds(track.samples, range.fromMs, range.toMs);
  return {
    ...cpuTimelineIntervalSummary(track, range.fromMs, range.toMs, { index: bounds.fromIndex }),
    name: track.name,
    sampleRange: bounds,
    reconstruction: track.audit,
    captureSampling: track.sampling,
  };
}

const label = (node) => node.source?.functionName || node.functionName || '(anonymous)';
function matchesNode(node, { nodeId, search }) {
  if (nodeId !== undefined && node.nodeId !== nodeId) return false;
  return (
    search === undefined ||
    [label(node), node.functionName, node.url, node.source?.file]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase())
  );
}

function intervalRows(selection, options) {
  const rows = [],
    { fromMs, toMs } = selection.range;
  for (const track of selection.model.tracks) {
    const nodes = new Map(track.nodes.map((n) => [n.nodeId, n]));
    for (const [sliceIndex, slice] of track.slices.entries()) {
      if (slice.endMs <= fromMs || slice.startMs >= toMs) continue;
      const node = nodes.get(slice.nodeId);
      requireFact(node, 'Unknown slice node');
      if (!matchesNode(node, options)) continue;
      const startMs = Math.max(fromMs, slice.startMs),
        endMs = Math.min(toMs, slice.endMs);
      const sampleRange = sampleBounds(track.samples, startMs, endMs);
      rows.push({
        targetId: track.target.targetId,
        sliceIndex,
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId,
        label: label(node),
        source: node.source ?? null,
        depth: slice.depth,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        originalRange: { startMs: slice.startMs, endMs: slice.endMs },
        sampleRange,
        sampleCount: sampleRange.toIndexExclusive - sampleRange.fromIndex,
      });
    }
  }
  return rows;
}

function functionRows(selection, options) {
  const { fromMs, toMs } = selection.range;
  return cpuTimelineFunctionRows(selection.model, fromMs, toMs).flatMap((track) =>
    track.rows
      .filter((node) => matchesNode(node, options))
      .map((node) => ({ ...node, targetId: track.targetId, label: label(node) })),
  );
}

function validateProjection(selection, options, view) {
  requireFact(
    ['intervals', 'functions', 'tree', 'completions'].includes(view),
    'Unknown CPU query view',
  );
  if (options.nodeId !== undefined) {
    requireFact(Number.isSafeInteger(options.nodeId) && options.nodeId >= 0, 'Invalid CPU node ID');
    requireFact(selection.model.tracks.length === 1, 'A CPU node ID requires exactly one target');
    requireFact(
      selection.model.tracks[0].nodes.some((n) => n.nodeId === options.nodeId),
      'Unknown CPU node ID',
    );
  }
  if (options.search !== undefined)
    requireFact(typeof options.search === 'string', 'Search must be text');
  if (['tree', 'completions'].includes(view))
    requireFact(
      options.nodeId === undefined && options.search === undefined,
      'Node/name filters apply to intervals and functions',
    );
  if (view !== 'tree')
    requireFact(options.direction === undefined, 'Direction applies only to tree');
}

function pageRows(rows, options, view) {
  const fields = {
    intervals: ['startMs', 'durationMs'],
    functions: ['selfMs', 'inclusiveMs'],
    completions: ['completionGapMs', 'startMs'],
  };
  const sort = options.sort ?? fields[view][0],
    offset = options.offset ?? 0,
    limit = options.limit ?? 100;
  requireFact(fields[view].includes(sort), 'Unsupported sort field for CPU query view');
  requireFact(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 1000,
    'Require offset >= 0 and limit 1..1000',
  );
  const sign = sort === 'startMs' ? 1 : -1;
  // Stable ties keep canonical track/slice/node ordering. Aggregate before paging.
  const ordered = rows.slice().sort((a, b) => sign * (a[sort] - b[sort]));
  return {
    sort,
    page: { offset, limit, total: rows.length, hasMore: offset + limit < rows.length },
    rows: ordered.slice(offset, offset + limit),
  };
}

/** Project/aggregate one selection; compose returned coordinates with another selection/query. */
export function queryCpuTimeline(selection, options = {}) {
  const view = options.view ?? 'functions';
  validateProjection(selection, options, view);
  const { model, range, completion } = selection;
  const common = {
    kind: 'cpu-timeline-query',
    schemaVersion: 1,
    view,
    timeUnit: 'ms',
    identity: model.identity,
    captureScope: model.captureScope,
    completeness: model.completeness,
    producerReportOk: model.producerReportOk,
    clock: model.clock,
    range,
    completion,
    targets: model.tracks.map((t) => selectedCoverage(t, range)),
    interpretation: model.interpretation,
    queryInterpretation:
      'Sample indices refer to timeline.json tracks[].samples, not original CDP positions or invocation counts. Function filters select displayed contexts, not a new sample population.',
  };
  if (view === 'tree') {
    requireFact(
      options.limit === undefined && options.offset === undefined && options.sort === undefined,
      'Tree retains all parent/child paths; paging and sorting apply to row views',
    );
    return {
      ...common,
      trees: cpuTimelineCallTrees(model, range.fromMs, range.toMs, {
        direction: options.direction ?? 'top-down',
      }),
    };
  }
  let rows;
  if (view === 'intervals') rows = intervalRows(selection, options);
  else if (view === 'functions') rows = functionRows(selection, options);
  else
    rows = model.frameIntervals
      .map((f, i) => completionRow(f, i, range.fromMs, range.toMs))
      .filter((f) => f.overlapMs > 0);
  return { ...common, ...pageRows(rows, options, view) };
}
